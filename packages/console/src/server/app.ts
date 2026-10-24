/**
 * The console's HTTP application (Hono): middleware, the `/api` routes, health,
 * and optionally the built UI.
 *
 * Request pipeline, outermost first:
 *
 *   security headers  every response (CSP, frame deny, no-referrer, HSTS on TLS, no-store for /api)
 *   body limit        /api: 64 KiB (the largest legitimate body is a plan with a few keys);
 *                     /api/live: 1 MiB + 64 KiB (a document being edited, as Extended JSON)
 *   same origin       /api state-changing requests: refuse a foreign `Origin`
 *   authenticate      /api: cookie session or trusted proxy → `principal`
 *   CSRF              /api state-changing requests of signed-in principals
 *   route             role check (requireRole) → validation → work → audit entry
 *   errors            uniform `ApiError` bodies; unexpected errors are logged, never echoed
 *
 * `createConsoleApp` takes already-opened services (services.ts), so tests run
 * the app in-process with `app.request(…)` against a temporary data directory.
 */

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PreviewLimits } from "../shared/api.ts";
import { openConnectionUri, openPlanIdentity, openPlanPassphrase } from "../state/secrets.ts";
import { authenticate, csrfProtection } from "./auth.ts";
import type { AppEnv, ConsoleServices } from "./context.ts";
import { describeError, isKnownError, notFound, statusOf } from "./errors.ts";
import { auditRoutes } from "./routes/audit.ts";
import { backupRoutes } from "./routes/backups.ts";
import { browseExtrasRoutes } from "./routes/browse-extras.ts";
import { configRoutes } from "./routes/config.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { healthRoutes, type JournalStatusReader } from "./routes/health.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { liveRoutes } from "./routes/live.ts";
import { oidcRoutes } from "./routes/oidc.ts";
import { type OnboardingRouteOptions, onboardingRoutes } from "./routes/onboarding.ts";
import { planRoutes } from "./routes/plans.ts";
import { restoreRoutes } from "./routes/restore.ts";
import { restorePreviewRoutes } from "./routes/restore-preview.ts";
import { sessionRoutes } from "./routes/session.ts";
import { storageRoutes } from "./routes/storage.ts";
import { userRoutes } from "./routes/users.ts";
import { sameOriginOnly, securityHeaders } from "./security.ts";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Largest body of the live data routes: one document of up to 1 MiB of Extended JSON, plus the rest. */
export const MAX_LIVE_BODY_BYTES = 1024 * 1024 + MAX_BODY_BYTES;

/** Options for {@link createConsoleApp}. */
export interface ConsoleAppOptions {
  /** Directory of the built UI (dist/ui). Omit to serve the API only (tests, API-only deployments). */
  readonly uiDir?: string;
  /** SSE heartbeat interval; tests shorten it. */
  readonly heartbeatMs?: number;
  /** Reads journal status for /metrics; tests replace it to simulate failures. */
  readonly readJournalStatus?: JournalStatusReader;
  /** Bounds of restore previews (sampling, listed ids, time); tests make them small. */
  readonly previewLimits?: PreviewLimits;
  /** The onboarding routes' network and container detection; tests replace them. */
  readonly onboarding?: OnboardingRouteOptions;
}

/** Builds the console's HTTP app. */
export function createConsoleApp(
  services: ConsoleServices,
  options: ConsoleAppOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders(services.settings));
  const bodyLimitOf = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "CONSOLE_BODY_TOO_LARGE",
              message: `Request bodies are limited to ${maxSize / 1024} KiB.`,
            },
          },
          413,
        ),
    });
  const defaultBodyLimit = bodyLimitOf(MAX_BODY_BYTES);
  const liveBodyLimit = bodyLimitOf(MAX_LIVE_BODY_BYTES);
  // Live document edits carry a whole document; everything else stays at 64 KiB.
  app.use("/api/*", (c, next) =>
    c.req.path.startsWith("/api/live/") ? liveBodyLimit(c, next) : defaultBodyLimit(c, next),
  );
  app.use("/api/*", sameOriginOnly(services.settings));
  app.use("/api/*", authenticate(services));
  app.use("/api/*", csrfProtection());

  sessionRoutes(app, services);
  oidcRoutes(app, services);
  userRoutes(app, services);
  connectionRoutes(app, services);
  // The welcome flow: check a pasted connection string, public IP, "Back up now".
  onboardingRoutes(app, services, options.onboarding);
  storageRoutes(app, services);
  planRoutes(app, services);
  backupRoutes(app, services);
  restoreRoutes(app, services);
  liveRoutes(app, services);
  // Samples and exports of live collections and backups (document viewer).
  browseExtrasRoutes(app, services);
  restorePreviewRoutes(app, services, options.previewLimits);
  jobRoutes(
    app,
    services,
    options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs },
  );
  auditRoutes(app, services);
  configRoutes(app, services);
  healthRoutes(
    app,
    services,
    options.readJournalStatus === undefined ? {} : { readJournalStatus: options.readJournalStatus },
  );

  // Unknown API paths are a JSON 404, never the UI's index.html.
  app.all("/api/*", () => {
    throw notFound("The API endpoint");
  });

  if (options.uiDir !== undefined) {
    app.use("*", serveStatic({ root: options.uiDir }));
    // Single-page app: every other GET is a client-side route, answered with index.html.
    app.get("*", serveStatic({ root: options.uiDir, path: "index.html" }));
  }

  app.notFound((c) => c.json({ error: { code: "CONSOLE_NOT_FOUND", message: "Not found." } }, 404));

  app.onError((error, c) => {
    if (!isKnownError(error)) {
      services.logger.error("Unexpected error while handling a request", {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
    return c.json({ error: describeError(error, knownSecrets(services)) }, statusOf(error));
  });

  return app;
}

/**
 * Every stored secret, for scrubbing error messages (defense in depth: the
 * library and driver should never put them there, but if one ever does, it is
 * replaced with `***` before the response leaves the server).
 */
function knownSecrets(services: ConsoleServices): string[] {
  const { store } = services;
  const secrets: string[] = [];
  for (const connection of store.current.connections) {
    try {
      const uri = openConnectionUri(store, connection);
      secrets.push(uri);
      // The password alone, in case a message quotes it outside the URI.
      const password = /^mongodb(?:\+srv)?:\/\/[^:@/]*:([^@/]+)@/i.exec(uri)?.[1];
      if (password !== undefined) secrets.push(password, decodeURIComponent(password));
    } catch {
      // An unreadable secret cannot leak either.
    }
  }
  for (const plan of store.current.plans) {
    try {
      const passphrase = openPlanPassphrase(store, plan);
      if (passphrase !== undefined) secrets.push(passphrase);
      const identity = openPlanIdentity(store, plan);
      if (identity !== undefined) secrets.push(identity);
    } catch {
      // As above.
    }
  }
  return secrets;
}
