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
 *
 * OIDC single sign-on (all optional; ISSUER and CLIENT_ID turn it on):
 *
 *   MONGOSHIELD_OIDC_ISSUER          the provider's issuer URL (https; discovery is read from
 *                                    <issuer>/.well-known/openid-configuration)
 *   MONGOSHIELD_OIDC_CLIENT_ID       the console's client id at the provider
 *   MONGOSHIELD_OIDC_CLIENT_SECRET   its secret (omit for a public client: PKCE only)
 *   MONGOSHIELD_OIDC_REDIRECT_URL    <console>/api/oidc/callback; defaults to
 *                                    MONGOSHIELD_PUBLIC_URL + /api/oidc/callback
 *   MONGOSHIELD_OIDC_SCOPES          space-separated (default "openid profile email")
 *   MONGOSHIELD_OIDC_ROLE_CLAIM      claim with groups/roles, e.g. "groups" or "realm_access.roles"
 *   MONGOSHIELD_OIDC_ROLES_MAP       claim value → role: "ops-admins=admin,ops=operator"
 *                                    or JSON {"cn=admins,dc=example":"admin"} (values with commas)
 *   MONGOSHIELD_OIDC_DEFAULT_ROLE    role when nothing maps: viewer (default), operator,
 *                                    admin, or none (refuse sign-in)
 *   MONGOSHIELD_OIDC_AUTO_PROVISION  "false": only existing accounts may sign in (default true)
 *   MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS  tolerated clock difference (default 60, at most 300)
 */

import { ROLES, type Role } from "../shared/api.ts";
import { MIN_SECRET_LENGTH } from "../state/crypto.ts";
import { isAllowedEndpoint, isLoopbackHost } from "./oidc/provider.ts";
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_SCOPES, type OidcSettings } from "./oidc/settings.ts";

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
  /** OIDC single sign-on, when MONGOSHIELD_OIDC_ISSUER and _CLIENT_ID are set. */
  readonly oidc?: OidcSettings;
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
  const cookieSecure = env.MONGOSHIELD_COOKIE_SECURE?.toLowerCase() !== "false";
  const oidc = readOidcEnvironment(env, publicUrl?.replace(/\/+$/, ""), cookieSecure);

  return {
    secret,
    dataDir: optional(env.MONGOSHIELD_DATA_DIR) ?? "/data",
    port,
    host: optional(env.HOST) ?? "0.0.0.0",
    cookieSecure,
    shutdownGraceMs: grace * 1000,
    ...(oidc === undefined ? {} : { oidc }),
    ...(publicUrl === undefined ? {} : { publicUrl: publicUrl.replace(/\/+$/, "") }),
    ...(proxySecret === undefined ? {} : { proxySecret }),
    ...(metricsToken === undefined ? {} : { metricsToken }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  };
}

/** Every MONGOSHIELD_OIDC_* variable; anything else with that prefix is a typo and refused. */
const OIDC_VARIABLES = [
  "MONGOSHIELD_OIDC_ISSUER",
  "MONGOSHIELD_OIDC_CLIENT_ID",
  "MONGOSHIELD_OIDC_CLIENT_SECRET",
  "MONGOSHIELD_OIDC_REDIRECT_URL",
  "MONGOSHIELD_OIDC_SCOPES",
  "MONGOSHIELD_OIDC_ROLE_CLAIM",
  "MONGOSHIELD_OIDC_ROLES_MAP",
  "MONGOSHIELD_OIDC_DEFAULT_ROLE",
  "MONGOSHIELD_OIDC_AUTO_PROVISION",
  "MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS",
];

/** Largest accepted clock skew: tokens are short-lived, a bigger window weakens `exp`. */
const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * The OIDC settings, or `undefined` when no OIDC variable is set. A half-done
 * configuration (say, a client id without an issuer, or a misspelt variable)
 * stops the console at startup rather than silently disabling SSO.
 */
export function readOidcEnvironment(
  env: NodeJS.ProcessEnv,
  publicUrl: string | undefined,
  cookieSecure: boolean,
): OidcSettings | undefined {
  const present = Object.keys(env).filter(
    (name) => name.startsWith("MONGOSHIELD_OIDC_") && optional(env[name]) !== undefined,
  );
  if (present.length === 0) return undefined;
  const unknown = present.filter((name) => !OIDC_VARIABLES.includes(name));
  if (unknown.length > 0) {
    throw new EnvironmentError(
      `Unknown OIDC setting ${unknown.join(", ")}. Known settings: ${OIDC_VARIABLES.join(", ")}.`,
    );
  }

  const issuer = optional(env.MONGOSHIELD_OIDC_ISSUER);
  const clientId = optional(env.MONGOSHIELD_OIDC_CLIENT_ID);
  if (issuer === undefined || clientId === undefined) {
    throw new EnvironmentError(
      "OIDC needs both MONGOSHIELD_OIDC_ISSUER and MONGOSHIELD_OIDC_CLIENT_ID.",
    );
  }
  if (!isAllowedEndpoint(issuer)) {
    throw new EnvironmentError(
      "MONGOSHIELD_OIDC_ISSUER must be an https URL (http only for localhost).",
    );
  }

  const redirectUrl =
    optional(env.MONGOSHIELD_OIDC_REDIRECT_URL) ??
    (publicUrl === undefined ? undefined : `${publicUrl}/api/oidc/callback`);
  if (redirectUrl === undefined) {
    throw new EnvironmentError(
      "Set MONGOSHIELD_OIDC_REDIRECT_URL (or MONGOSHIELD_PUBLIC_URL) so the provider knows where to send people back.",
    );
  }
  checkRedirectUrl(redirectUrl, cookieSecure);

  const scopes = (
    optional(env.MONGOSHIELD_OIDC_SCOPES)?.split(/\s+/) ?? [...DEFAULT_SCOPES]
  ).filter((scope) => scope !== "");
  if (!scopes.includes("openid")) scopes.unshift("openid");

  const skewSeconds = Number(
    optional(env.MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS) ?? String(DEFAULT_CLOCK_SKEW_MS / 1000),
  );
  if (!Number.isFinite(skewSeconds) || skewSeconds < 0 || skewSeconds > MAX_CLOCK_SKEW_SECONDS) {
    throw new EnvironmentError(
      `MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS must be between 0 and ${MAX_CLOCK_SKEW_SECONDS}.`,
    );
  }

  const autoProvision = optional(env.MONGOSHIELD_OIDC_AUTO_PROVISION)?.toLowerCase() ?? "true";
  if (autoProvision !== "true" && autoProvision !== "false") {
    throw new EnvironmentError('MONGOSHIELD_OIDC_AUTO_PROVISION must be "true" or "false".');
  }

  const clientSecret = optional(env.MONGOSHIELD_OIDC_CLIENT_SECRET);
  const roleClaim = optional(env.MONGOSHIELD_OIDC_ROLE_CLAIM);
  return {
    issuer,
    clientId,
    redirectUrl,
    scopes,
    rolesMap: parseRolesMap(optional(env.MONGOSHIELD_OIDC_ROLES_MAP)),
    defaultRole: parseDefaultRole(optional(env.MONGOSHIELD_OIDC_DEFAULT_ROLE)),
    autoProvision: autoProvision === "true",
    clockSkewMs: skewSeconds * 1000,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(roleClaim === undefined ? {} : { roleClaim }),
  };
}

/**
 * The redirect URL must point at this console's callback, over https unless the
 * console runs on loopback or plain HTTP was chosen explicitly (cookies not Secure).
 */
function checkRedirectUrl(value: string, cookieSecure: boolean): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvironmentError("MONGOSHIELD_OIDC_REDIRECT_URL must be a URL.");
  }
  const plainHttpAllowed = isLoopbackHost(url.hostname) || !cookieSecure;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainHttpAllowed)) {
    throw new EnvironmentError("MONGOSHIELD_OIDC_REDIRECT_URL must be an https URL.");
  }
  if (url.pathname !== "/api/oidc/callback") {
    throw new EnvironmentError(
      "MONGOSHIELD_OIDC_REDIRECT_URL must end in /api/oidc/callback, e.g. https://backups.example.com/api/oidc/callback.",
    );
  }
}

/**
 * `a=admin,b=operator` or `{"a":"admin"}` → map. Unknown roles are refused. Claim
 * values containing commas (LDAP DNs) need the JSON form.
 */
function parseRolesMap(value: string | undefined): ReadonlyMap<string, Role> {
  const map = new Map<string, Role>();
  if (value === undefined) return map;
  let pairs: [string, unknown][];
  if (value.startsWith("{") || value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new EnvironmentError("MONGOSHIELD_OIDC_ROLES_MAP is not valid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EnvironmentError("MONGOSHIELD_OIDC_ROLES_MAP must be a JSON object.");
    }
    pairs = Object.entries(parsed);
  } else {
    pairs = value
      .split(",")
      .filter((entry) => entry.trim() !== "")
      .map((entry) => {
        // Split at the LAST "=": group names may contain "=" (LDAP DNs), roles never do.
        const at = entry.lastIndexOf("=");
        return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
      });
  }
  for (const [claimValue, role] of pairs) {
    const known = ROLES.find((candidate) => candidate === role);
    if (claimValue === "" || known === undefined) {
      throw new EnvironmentError(
        `MONGOSHIELD_OIDC_ROLES_MAP: map each claim value to viewer, operator or admin (got ${JSON.stringify(`${claimValue}=${String(role)}`)}).`,
      );
    }
    map.set(claimValue, known);
  }
  return map;
}

function parseDefaultRole(value: string | undefined): Role | "none" {
  if (value === undefined) return "viewer";
  if (value === "none") return "none";
  const known = ROLES.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new EnvironmentError(
      "MONGOSHIELD_OIDC_DEFAULT_ROLE must be viewer, operator, admin or none.",
    );
  }
  return known;
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
