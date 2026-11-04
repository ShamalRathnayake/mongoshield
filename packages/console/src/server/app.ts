/**
 * The console's HTTP application (Hono): middleware, the `/api` routes, health,
 * and optionally the built UI.
 *
 * Request pipeline, outermost first:
 *
 *   security headers  every response (CSP, frame deny, no-referrer, HSTS on TLS, no-store for /api)
 *   body limit        /api: 64 KiB (the largest legitimate body is a plan with a few keys);
 *                     /api/live: 1 MiB + 64 KiB (a document being edited, as Extended JSON)
 *   client            who is asking: socket address, or a trusted proxy's forwarding headers
 *   allowed hosts     /api: refuse unknown Host names (DNS rebinding, see hosts.ts)
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
import { getPath } from "hono/utils/url";
import type { PreviewLimits } from "../shared/api.ts";
import { authenticate, csrfProtection } from "./auth.ts";
import type { AppEnv, ConsoleServices } from "./context.ts";
import { describeError, isKnownError, notFound, statusOf } from "./errors.ts";
import { basePathOf } from "./hosts.ts";
import { auditRoutes } from "./routes/audit.ts";
import { backupRoutes } from "./routes/backups.ts";
import { browseExtrasRoutes } from "./routes/browse-extras.ts";
import { configRoutes } from "./routes/config.ts";
import { type ConnectionRouteOptions, connectionRoutes } from "./routes/connections.ts";
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
import { allowedHostsOnly, resolveClient, sameOriginOnly, securityHeaders } from "./security.ts";

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
  /** How saved connections are tested (tests replace the container detection). */
  readonly connections?: ConnectionRouteOptions;
}

/** Builds the console's HTTP app. */
export function createConsoleApp(
  services: ConsoleServices,
  options: ConsoleAppOptions = {},
): Hono<AppEnv> {
  // Served under a sub-path (MONGOSHIELD_PUBLIC_URL=https://example.com/mongoshield), the
  // console routes `/mongoshield/api/…` like `/api/…`, so it works both behind a proxy
  // that strips the prefix and one that passes it on.
  const basePath = basePathOf(services.settings.publicUrl);
  const app = new Hono<AppEnv>(
    basePath === "" ? {} : { getPath: (request) => withoutBasePath(getPath(request), basePath) },
  );

  if (basePath !== "") {
    // `/mongoshield` → `/mongoshield/`: the UI's assets and API calls are relative to the
    // page's directory, which needs the trailing slash.
    app.use("*", async (c, next) => {
      const requested = new URL(c.req.url);
      if (requested.pathname !== basePath) return next();
      return c.redirect(`${basePath}/${requested.search}`, 308);
    });
  }
  // Who is asking (behind trusted proxies), before anything else looks at the request.
  app.use("*", resolveClient(services.settings));
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
  app.use("/api/*", allowedHostsOnly(services.settings));
  app.use("/api/*", sameOriginOnly(services.settings));
  app.use("/api/*", authenticate(services));
  app.use("/api/*", csrfProtection());

  sessionRoutes(app, services);
  oidcRoutes(app, services);
  userRoutes(app, services);
  connectionRoutes(app, services, options.connections);
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
        path: c.req.path,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    }
    return c.json({ error: describeError(error, services.knownSecrets()) }, statusOf(error));
  });

  return app;
}

/**
 * `/mongoshield/api/session` → `/api/session` for the base path `/mongoshield`; paths
 * outside it (a proxy that already stripped the prefix) are routed as they are.
 */
function withoutBasePath(path: string, basePath: string): string {
  if (path === basePath) return "/";
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}
