/**
 * The console's HTTP application (Hono): middleware, the `/api` routes, health,
 * and optionally the built UI.
 *
 * Request pipeline, outermost first:
 *
 *   security headers  every response (CSP, frame deny, no-referrer, HSTS on TLS, no-store for /api)
 *   body limit        /api: 64 KiB (the largest legitimate body is a plan with a few keys)
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
import { openConnectionUri, openPlanPassphrase } from "../state/secrets.ts";
import { authenticate, csrfProtection } from "./auth.ts";
import type { AppEnv, ConsoleServices } from "./context.ts";
import { describeError, isKnownError, notFound, statusOf } from "./errors.ts";
import { auditRoutes } from "./routes/audit.ts";
import { backupRoutes } from "./routes/backups.ts";
import { configRoutes } from "./routes/config.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { healthRoutes } from "./routes/health.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { planRoutes } from "./routes/plans.ts";
import { restoreRoutes } from "./routes/restore.ts";
import { sessionRoutes } from "./routes/session.ts";
import { storageRoutes } from "./routes/storage.ts";
import { userRoutes } from "./routes/users.ts";
import { sameOriginOnly, securityHeaders } from "./security.ts";

/** Largest accepted request body. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Options for {@link createConsoleApp}. */
export interface ConsoleAppOptions {
  /** Directory of the built UI (dist/ui). Omit to serve the API only (tests, API-only deployments). */
  readonly uiDir?: string;
  /** SSE heartbeat interval; tests shorten it. */
  readonly heartbeatMs?: number;
}

/** Builds the console's HTTP app. */
export function createConsoleApp(
  services: ConsoleServices,
  options: ConsoleAppOptions = {},
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", securityHeaders(services.settings));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "CONSOLE_BODY_TOO_LARGE",
              message: `Request bodies are limited to ${MAX_BODY_BYTES / 1024} KiB.`,
            },
          },
          413,
        ),
    }),
  );
  app.use("/api/*", sameOriginOnly(services.settings));
  app.use("/api/*", authenticate(services));
  app.use("/api/*", csrfProtection());

  sessionRoutes(app, services);
  userRoutes(app, services);
  connectionRoutes(app, services);
  storageRoutes(app, services);
  planRoutes(app, services);
  backupRoutes(app, services);
  restoreRoutes(app, services);
  jobRoutes(
    app,
    services,
    options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs },
  );
  auditRoutes(app, services);
  configRoutes(app, services);
  healthRoutes(app, services);

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
    } catch {
      // As above.
    }
  }
  return secrets;
}
