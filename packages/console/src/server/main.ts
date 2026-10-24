#!/usr/bin/env node
/**
 * `mongoshield-console`: starts the web console.
 *
 *   MONGOSHIELD_SECRET=$(openssl rand -hex 32) mongoshield-console
 *
 * 1. Reads the environment (config.ts); refuses to start without MONGOSHIELD_SECRET.
 * 2. Opens the data directory (refuses if another console holds it).
 * 3. Serves the API and the built UI, starts the plan schedules.
 * 4. On first start (no admin yet), prints the one-time setup link.
 * 5. On SIGTERM/SIGINT: stops accepting connections and schedules, lets running
 *    jobs finish within the grace period (then aborts them), releases the data
 *    directory and exits.
 *
 * Logs are JSON lines on stderr; the setup link goes to stdout as plain text so
 * it is easy to spot in `docker logs`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { LogFields, Logger } from "mongoshield";
import { DataDirLockedError } from "../state/lock.ts";
import { StateOpenError } from "../state/store.ts";
import { createConsoleApp } from "./app.ts";
import { EnvironmentError, readEnvironment } from "./config.ts";
import { closeConsole, openConsole } from "./services.ts";

/** A logger writing one JSON object per line to stderr. */
function jsonLogger(): Logger {
  const write = (level: string, message: string, fields?: LogFields): void => {
    process.stderr.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`,
    );
  };
  return {
    debug: () => {},
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

/**
 * Where the built UI is: `dist/ui` next to `dist/server/main.mjs`. Running from
 * source (`pnpm dev:server`) there is no built UI; the Vite dev server serves it.
 */
function findUiDirectory(): string | undefined {
  const directory = fileURLToPath(new URL("../ui", import.meta.url));
  return existsSync(join(directory, "index.html")) ? directory : undefined;
}

async function main(): Promise<void> {
  const logger = jsonLogger();
  const environment = readEnvironment(process.env);
  if (environment.ignoredOidcVariables.length > 0) {
    logger.warn(
      "OIDC is not supported yet; use a reverse proxy with MONGOSHIELD_TRUST_PROXY_SECRET",
      {
        ignored: environment.ignoredOidcVariables,
      },
    );
  }

  const { services, setupToken } = await openConsole({
    dataDir: environment.dataDir,
    secret: environment.secret,
    logger,
    settings: {
      cookieSecure: environment.cookieSecure,
      https: environment.publicUrl?.startsWith("https://") === true,
      shutdownGraceMs: environment.shutdownGraceMs,
      ...(environment.publicUrl === undefined ? {} : { publicUrl: environment.publicUrl }),
      ...(environment.proxySecret === undefined ? {} : { proxySecret: environment.proxySecret }),
      ...(environment.metricsToken === undefined ? {} : { metricsToken: environment.metricsToken }),
    },
    ...(environment.webhookSecret === undefined
      ? {}
      : { webhookSecret: environment.webhookSecret }),
  });

  const uiDir = findUiDirectory();
  if (uiDir === undefined) logger.warn("No built UI found; serving the API only");
  const app = createConsoleApp(services, uiDir === undefined ? {} : { uiDir });
  services.schedules.start();

  const server = serve(
    { fetch: app.fetch, port: environment.port, hostname: environment.host },
    () => {
      logger.info("MongoShield console listening", {
        host: environment.host,
        port: environment.port,
        dataDir: environment.dataDir,
      });
    },
  );

  if (setupToken !== undefined) {
    const base = environment.publicUrl ?? `http://localhost:${environment.port}`;
    process.stdout.write(
      [
        "",
        "  MongoShield console: no admin account exists yet.",
        "  Open this one-time link within 24 hours to create it:",
        "",
        `    ${base}/setup?token=${setupToken}`,
        "",
        "  (A new link is printed at every start until setup is done.)",
        "",
      ].join("\n"),
    );
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    logger.info("Shutting down", { signal, graceMs: environment.shutdownGraceMs });
    // Stop accepting new connections; open SSE streams end when the process exits.
    server.close();
    closeConsole(services)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error("Shutdown failed", { error: String(error) });
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  // Known startup problems get their message only; anything else gets the stack.
  const known =
    error instanceof EnvironmentError ||
    error instanceof StateOpenError ||
    error instanceof DataDirLockedError;
  const text =
    known && error instanceof Error
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  process.stderr.write(`mongoshield-console: ${text}\n`);
  process.exit(1);
});
