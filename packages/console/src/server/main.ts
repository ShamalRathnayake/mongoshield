#!/usr/bin/env node
/**
 * `mongoshield-console`: starts the web console.
 *
 *   mongoshield-console                       (generates <data>/secret.key on first start)
 *   MONGOSHIELD_SECRET=$(openssl rand -hex 32) mongoshield-console
 *
 * 1. Reads the environment (config.ts). The secret comes from MONGOSHIELD_SECRET or
 *    MONGOSHIELD_SECRET_FILE, else from the data directory's generated secret.key.
 * 2. Opens the data directory (refuses if another console holds it), creates the
 *    admin from MONGOSHIELD_ADMIN_* and the "Local backups" location when they apply.
 *    A data directory the console may not write gets the `chown` that fixes it.
 * 3. Serves the API and the built UI on `::` (IPv6 and IPv4; 0.0.0.0 without IPv6),
 *    starts the plan schedules, and logs the container environment (Docker, Podman,
 *    Kubernetes, …) and whether host.docker.internal resolves.
 * 4. On first start (no admin yet), says how to create it: open the console within
 *    the setup window, or use the one-time setup link (from MONGOSHIELD_PUBLIC_URL
 *    when set; otherwise with a note that a `-p` port mapping changes it).
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
import { addHostFlag, hostAliasMissing } from "../shared/container.ts";
import { DataDirLockedError } from "../state/lock.ts";
import { loadOrCreateSecretKey, SecretKeyError } from "../state/secret-key.ts";
import { StateOpenError } from "../state/store.ts";
import { createConsoleApp } from "./app.ts";
import { EnvironmentError, readEnvironment } from "./config.ts";
import { consoleEnvironment } from "./container-environment.ts";
import { closeConsole, openConsole } from "./services.ts";
import { DataDirAccessError, dataDirAccessError, listenHost, setupLinkBase } from "./startup.ts";

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
  if (environment.oidc !== undefined) {
    // Never the client secret: issuer and client id are enough to tell what is configured.
    logger.info("OIDC sign-in enabled", {
      issuer: environment.oidc.issuer,
      clientId: environment.oidc.clientId,
      autoProvision: environment.oidc.autoProvision,
    });
  }

  // A host folder mounted at the data directory may not be writable by the image's
  // user (UID 65532): say how to fix that instead of printing an EACCES stack trace.
  const opened = await openDataDirectory(environment, logger).catch((error: unknown) => {
    throw dataDirAccessError(error, environment.dataDir) ?? error;
  });

  const { services, setupToken } = opened;
  if (opened.createdStorage !== undefined) {
    logger.info("Created the default storage location", opened.createdStorage);
  }
  if (opened.provisionedAdmin !== undefined) {
    logger.info("Created the admin from MONGOSHIELD_ADMIN_*", {
      username: opened.provisionedAdmin,
    });
  }
  if (opened.provisionedAdminIgnored === true) {
    logger.info(
      "MONGOSHIELD_ADMIN_* ignored: users already exist (the environment never changes existing accounts)",
    );
  }

  const uiDir = findUiDirectory();
  if (uiDir === undefined) logger.warn("No built UI found; serving the API only");
  const app = createConsoleApp(services, uiDir === undefined ? {} : { uiDir });
  services.schedules.start();

  // `::` (IPv6 and IPv4) unless HOST says otherwise; 0.0.0.0 without IPv6.
  const host = await listenHost(environment.host);
  const server = serve({ fetch: app.fetch, port: environment.port, hostname: host }, () => {
    logger.info("MongoShield console listening", {
      host,
      port: environment.port,
      dataDir: environment.dataDir,
    });
  });

  // Where the console runs decides what "localhost" means for connection strings; the
  // lookup of host.docker.internal now means the first page already knows the answer.
  await logContainerEnvironment(logger);

  if (setupToken !== undefined) {
    const link = setupLinkBase(environment.publicUrl, environment.port);
    process.stdout.write(setupInstructions(link.base, setupToken, opened.setupWindowEndsAt));
    if (link.note !== undefined) process.stdout.write(`${link.note}\n`);
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

/** Reads (or generates) the secret and opens the data directory: every startup write. */
async function openDataDirectory(
  environment: ReturnType<typeof readEnvironment>,
  logger: Logger,
): Promise<Awaited<ReturnType<typeof openConsole>>> {
  const secret = await resolveSecret(environment.secret, environment.dataDir, logger);
  return openConsole({
    dataDir: environment.dataDir,
    secret,
    logger,
    setupWindowMs: environment.setupWindowMs,
    defaultStorage: environment.defaultStorage,
    // A replaced container must not fail on its predecessor's lock.
    waitForPreviousLock: true,
    ...(environment.initialAdmin === undefined ? {} : { initialAdmin: environment.initialAdmin }),
    settings: {
      cookieSecure: environment.cookieSecure,
      https: environment.publicUrl?.startsWith("https://") === true,
      shutdownGraceMs: environment.shutdownGraceMs,
      ...environment.security,
      ...(environment.publicUrl === undefined ? {} : { publicUrl: environment.publicUrl }),
      ...(environment.proxySecret === undefined ? {} : { proxySecret: environment.proxySecret }),
      ...(environment.metricsToken === undefined ? {} : { metricsToken: environment.metricsToken }),
      ...(environment.oidc === undefined ? {} : { oidc: environment.oidc }),
    },
    ...(environment.webhookSecret === undefined
      ? {}
      : { webhookSecret: environment.webhookSecret }),
  });
}

/**
 * Detects where the console runs (container-environment.ts), logs it, and warns when
 * the name for the host machine does not resolve (Linux Docker Engine without
 * `--add-host`): pages will not offer it, and this says how to make it work.
 */
async function logContainerEnvironment(logger: Logger): Promise<void> {
  const container = await consoleEnvironment.fresh();
  logger.info("Container environment", {
    kind: container.kind,
    ...(container.hostAlias === undefined
      ? {}
      : { hostAlias: container.hostAlias, hostAliasResolves: container.hostAliasResolves }),
  });
  if (container.hostAlias !== undefined && hostAliasMissing(container)) {
    logger.warn(
      `${container.hostAlias} does not resolve in this container, so databases on the host machine cannot be reached by that name. On Linux, start the console with ${addHostFlag(container.hostAlias)}.`,
    );
  }
}

/**
 * The secret for this start: the operator's (environment or file), else the data
 * directory's generated key. A newly generated key is announced on stdout, where the
 * setup instructions go too, because it changes what a copy of the volume contains.
 */
async function resolveSecret(
  fromEnvironment: string | undefined,
  dataDir: string,
  logger: Logger,
): Promise<string> {
  if (fromEnvironment !== undefined) return fromEnvironment;
  const key = await loadOrCreateSecretKey(dataDir);
  if (!key.created) {
    logger.info("Using the generated secret key", { path: key.path });
    return key.secret;
  }
  logger.warn("Generated a new secret key", { path: key.path });
  process.stdout.write(
    [
      "",
      "  MongoShield console: generated a new secret key (MONGOSHIELD_SECRET was not set).",
      "",
      `    ${key.path}   (mode 0600, readable only by the console's user)`,
      "",
      "  It encrypts the connection strings, storage credentials and backup keys the",
      "  console stores, and it lives in the same volume as them: a backup or copy of",
      `  ${dataDir} now includes the key. Keep such copies as private as the databases.`,
      "",
      "  To keep the secret elsewhere, start a fresh volume with MONGOSHIELD_SECRET, or",
      "  MONGOSHIELD_SECRET_FILE=/run/secrets/<name> for Docker or Kubernetes secrets.",
      "",
    ].join("\n"),
  );
  return key.secret;
}

/**
 * What to tell the operator while no admin exists: open the console within the setup
 * window (no token needed), or use the one-time link, which works with or without it.
 */
function setupInstructions(base: string, token: string, windowEndsAt: Date | undefined): string {
  const link = `${base}/setup?token=${token}`;
  if (windowEndsAt === undefined) {
    return [
      "",
      "  MongoShield console: no admin account exists yet.",
      "  Open this one-time link within 1 hour to create it:",
      "",
      `    ${link}`,
      "",
      "  (A new link is printed at every start until setup is done.)",
      "",
    ].join("\n");
  }
  const minutes = Math.round((windowEndsAt.getTime() - Date.now()) / 60_000);
  return [
    "",
    "  MongoShield console: no admin account exists yet.",
    `  Open ${base} within ${minutes} minutes (until ${windowEndsAt.toISOString()})`,
    "  and create it there: whoever opens it first becomes the admin.",
    "",
    "  After that, use this one-time link (valid 1 hour), or restart the console:",
    "",
    `    ${link}`,
    "",
    "  (MONGOSHIELD_SETUP_WINDOW_MINUTES=0 always requires the link.)",
    "",
  ].join("\n");
}

main().catch((error: unknown) => {
  // Known startup problems get their message only; anything else gets the stack.
  const known =
    error instanceof EnvironmentError ||
    error instanceof SecretKeyError ||
    error instanceof StateOpenError ||
    error instanceof DataDirLockedError ||
    error instanceof DataDirAccessError;
  const text =
    known && error instanceof Error
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  process.stderr.write(`mongoshield-console: ${text}\n`);
  process.exit(1);
});
