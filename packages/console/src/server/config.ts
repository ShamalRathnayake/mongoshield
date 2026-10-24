/**
 * The console's configuration, read from environment variables.
 *
 *   MONGOSHIELD_SECRET               required; ≥ 32 characters. Derives the key that encrypts
 *                                    stored secrets. Losing it makes stored secrets unreadable.
 *   MONGOSHIELD_DATA_DIR             where console.json and audit.jsonl live (default /data)
 *   PORT / HOST                      listen address (default 8080 / 0.0.0.0)
 *   MONGOSHIELD_PUBLIC_URL           e.g. https://backups.example.com: used for the setup link,
 *                                    the origin check, and HSTS when it is https
 *   MONGOSHIELD_TRUST_PROXY_SECRET   enables reverse-proxy SSO (see auth.ts); ≥ 32 characters
 *   MONGOSHIELD_METRICS_TOKEN        enables GET /metrics with this bearer token
 *   MONGOSHIELD_COOKIE_SECURE        "false" to allow plain-HTTP sessions (evaluation only)
 *   MONGOSHIELD_WEBHOOK_SECRET       signs webhook notifications, as in the CLI
 *   MONGOSHIELD_SHUTDOWN_GRACE_SECONDS  how long running jobs may finish on SIGTERM (default 60)
 */

import { MIN_SECRET_LENGTH } from "../state/crypto.ts";

/** Everything main.ts needs from the environment. */
export interface ConsoleEnvironment {
  readonly secret: string;
  readonly dataDir: string;
  readonly port: number;
  readonly host: string;
  readonly publicUrl?: string;
  readonly proxySecret?: string;
  readonly metricsToken?: string;
  readonly cookieSecure: boolean;
  readonly webhookSecret?: string;
  readonly shutdownGraceMs: number;
  /** OIDC variables that were set but are not supported yet (reported at startup). */
  readonly ignoredOidcVariables: readonly string[];
}

/** A configuration problem, explained for the operator. */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

/** Shortest accepted proxy secret and metrics token (both are bearer secrets). */
const MIN_TOKEN_LENGTH = 32;

/** Reads and checks the environment. */
export function readEnvironment(env: NodeJS.ProcessEnv): ConsoleEnvironment {
  const secret = env.MONGOSHIELD_SECRET ?? "";
  if (secret === "") {
    throw new EnvironmentError(
      [
        "MONGOSHIELD_SECRET is not set.",
        "The console encrypts the connection strings, storage credentials and passphrases it stores",
        "with a key derived from this secret, and refuses to start without one.",
        "Generate one with `openssl rand -hex 32`, keep it safe (e.g. in your secret manager),",
        "and pass the same value on every start: without it, stored secrets cannot be read.",
      ].join("\n"),
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new EnvironmentError(
      `MONGOSHIELD_SECRET must be at least ${MIN_SECRET_LENGTH} characters (use \`openssl rand -hex 32\`).`,
    );
  }

  const port = Number(env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new EnvironmentError(`PORT must be a port number, not "${env.PORT ?? ""}".`);
  }

  const publicUrl = optional(env.MONGOSHIELD_PUBLIC_URL);
  if (publicUrl !== undefined && !/^https?:\/\/[^/]+/i.test(publicUrl)) {
    throw new EnvironmentError(
      "MONGOSHIELD_PUBLIC_URL must be an http(s) URL, e.g. https://backups.example.com.",
    );
  }
  const proxySecret = optional(env.MONGOSHIELD_TRUST_PROXY_SECRET);
  if (proxySecret !== undefined && proxySecret.length < MIN_TOKEN_LENGTH) {
    throw new EnvironmentError(
      `MONGOSHIELD_TRUST_PROXY_SECRET must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  const metricsToken = optional(env.MONGOSHIELD_METRICS_TOKEN);
  if (metricsToken !== undefined && metricsToken.length < MIN_TOKEN_LENGTH) {
    throw new EnvironmentError(
      `MONGOSHIELD_METRICS_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  const grace = Number(env.MONGOSHIELD_SHUTDOWN_GRACE_SECONDS ?? "60");
  if (!Number.isFinite(grace) || grace < 0) {
    throw new EnvironmentError("MONGOSHIELD_SHUTDOWN_GRACE_SECONDS must be a number of seconds.");
  }
  const webhookSecret = optional(env.MONGOSHIELD_WEBHOOK_SECRET);

  return {
    secret,
    dataDir: optional(env.MONGOSHIELD_DATA_DIR) ?? "/data",
    port,
    host: optional(env.HOST) ?? "0.0.0.0",
    cookieSecure: env.MONGOSHIELD_COOKIE_SECURE?.toLowerCase() !== "false",
    shutdownGraceMs: grace * 1000,
    ignoredOidcVariables: Object.keys(env).filter((name) => name.startsWith("MONGOSHIELD_OIDC_")),
    ...(publicUrl === undefined ? {} : { publicUrl: publicUrl.replace(/\/+$/, "") }),
    ...(proxySecret === undefined ? {} : { proxySecret }),
    ...(metricsToken === undefined ? {} : { metricsToken }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  };
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
