/**
 * The console's configuration, read from environment variables.
 *
 *   MONGOSHIELD_SECRET               ≥ 32 characters. Derives the key that encrypts stored
 *                                    secrets. Losing it makes stored secrets unreadable.
 *                                    Optional: without it (and without _FILE) the console
 *                                    generates one on first start into <data>/secret.key
 *                                    (src/state/secret-key.ts) and reuses it afterwards.
 *   MONGOSHIELD_SECRET_FILE          read the secret from this file instead (Docker and
 *                                    Kubernetes secrets); setting both is refused
 *   MONGOSHIELD_DATA_DIR             where console.json and audit.jsonl live (default /data)
 *
 * First run (see docs/console-security.md for the reasoning):
 *
 *   MONGOSHIELD_SETUP_WINDOW_MINUTES  while no admin exists, the setup page may create the
 *                                    first admin WITHOUT the setup token for this many
 *                                    minutes after start (default 15; 0 = always need the
 *                                    token; at most 1440). The token always works.
 *   MONGOSHIELD_ADMIN_USERNAME       create this admin at start when no user exists yet
 *     (or MONGOSHIELD_ADMIN_EMAIL)   (headless installs: compose, Kubernetes); needs
 *   MONGOSHIELD_ADMIN_PASSWORD       the password, ≥ 12 characters, or
 *   MONGOSHIELD_ADMIN_PASSWORD_FILE  a file containing it. Ignored once any user exists.
 *   MONGOSHIELD_DEFAULT_STORAGE      "false": do not create the "Local backups" storage
 *                                    location (<data>/backups) on a fresh data directory
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

import { readFileSync } from "node:fs";
import { ROLES, type Role } from "../shared/api.ts";
import { MIN_SECRET_LENGTH } from "../state/crypto.ts";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "../state/passwords.ts";
import { USERNAME_PATTERN } from "./auth.ts";
import { isAllowedEndpoint, isLoopbackHost } from "./oidc/provider.ts";
import { DEFAULT_CLOCK_SKEW_MS, DEFAULT_SCOPES, type OidcSettings } from "./oidc/settings.ts";

/** Everything main.ts needs from the environment. */
export interface ConsoleEnvironment {
  /**
   * The operator's secret (MONGOSHIELD_SECRET, or the contents of MONGOSHIELD_SECRET_FILE).
   * Absent: main.ts uses the data directory's generated `secret.key` instead.
   */
  readonly secret?: string;
  /** Where the secret came from, for the startup log (never the secret itself). */
  readonly secretSource: "env" | "file" | "generated";
  /** First-run setup without the token is allowed this long after start (0 = never). */
  readonly setupWindowMs: number;
  /** The admin to create at start while no user exists (MONGOSHIELD_ADMIN_*). */
  readonly initialAdmin?: InitialAdmin;
  /** Create the "Local backups" storage location on a fresh data directory. */
  readonly defaultStorage: boolean;
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

/** The first admin, provisioned from the environment (headless installs). */
export interface InitialAdmin {
  readonly username: string;
  readonly password: string;
}

/** Default setup window: 15 minutes, like Portainer's (which uses 5). */
export const DEFAULT_SETUP_WINDOW_MINUTES = 15;
/** Longest setup window: a day, the setup token's own lifetime. */
const MAX_SETUP_WINDOW_MINUTES = 24 * 60;

/** A configuration problem, explained for the operator. */
export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
}

/** Shortest accepted proxy secret and metrics token (both are bearer secrets). */
const MIN_TOKEN_LENGTH = 32;

/** Reads and checks the environment. */
export function readEnvironment(env: NodeJS.ProcessEnv): ConsoleEnvironment {
  const secret = readSecret(env);

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

  const initialAdmin = readInitialAdmin(env);
  return {
    ...(secret === undefined ? {} : { secret: secret.value }),
    secretSource: secret?.source ?? "generated",
    setupWindowMs: readSetupWindowMinutes(env) * 60_000,
    defaultStorage: readBoolean(env, "MONGOSHIELD_DEFAULT_STORAGE", true),
    ...(initialAdmin === undefined ? {} : { initialAdmin }),
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

/**
 * The operator's secret from MONGOSHIELD_SECRET or MONGOSHIELD_SECRET_FILE, or
 * `undefined` when neither is set (the data directory's generated key is used then).
 * Both at once is refused: it is unclear which one the operator meant.
 */
function readSecret(
  env: NodeJS.ProcessEnv,
): { readonly value: string; readonly source: "env" | "file" } | undefined {
  // Used exactly as given, never trimmed: the key derived from it must not change
  // for consoles that have been running with it (a stray space is part of the secret).
  const direct = env.MONGOSHIELD_SECRET === "" ? undefined : env.MONGOSHIELD_SECRET;
  const file = optional(env.MONGOSHIELD_SECRET_FILE);
  if (direct !== undefined && file !== undefined) {
    throw new EnvironmentError(
      "Set either MONGOSHIELD_SECRET or MONGOSHIELD_SECRET_FILE, not both.",
    );
  }
  if (direct === undefined && file === undefined) return undefined;
  const value = direct ?? readSecretFile("MONGOSHIELD_SECRET_FILE", file ?? "").trim();
  if (value.length < MIN_SECRET_LENGTH) {
    throw new EnvironmentError(
      `${direct === undefined ? "The file in MONGOSHIELD_SECRET_FILE" : "MONGOSHIELD_SECRET"} must hold at least ${MIN_SECRET_LENGTH} characters (use \`openssl rand -hex 32\`).`,
    );
  }
  return { value, source: direct === undefined ? "file" : "env" };
}

/**
 * Reads a `*_FILE` variable's file. Docker and Kubernetes mount secrets as files, often
 * readable by everyone in the container (mode 0444/0644); that is their own access
 * control, so the console does not insist on 0600 here (unlike its own secret.key).
 */
function readSecretFile(variable: string, path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error ? String(Reflect.get(error, "code") ?? "") : "";
    throw new EnvironmentError(
      `${variable}: cannot read ${path}${code === "" ? "" : ` (${code})`}.`,
    );
  }
}

/** MONGOSHIELD_SETUP_WINDOW_MINUTES: a whole number of minutes, 0 to turn the window off. */
function readSetupWindowMinutes(env: NodeJS.ProcessEnv): number {
  const raw = optional(env.MONGOSHIELD_SETUP_WINDOW_MINUTES);
  if (raw === undefined) return DEFAULT_SETUP_WINDOW_MINUTES;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SETUP_WINDOW_MINUTES) {
    throw new EnvironmentError(
      `MONGOSHIELD_SETUP_WINDOW_MINUTES must be a whole number of minutes from 0 (always require the setup token) to ${MAX_SETUP_WINDOW_MINUTES}.`,
    );
  }
  return minutes;
}

/**
 * MONGOSHIELD_ADMIN_USERNAME (or its alias MONGOSHIELD_ADMIN_EMAIL) together with
 * MONGOSHIELD_ADMIN_PASSWORD or MONGOSHIELD_ADMIN_PASSWORD_FILE. Half a pair is refused:
 * an operator who set one of them expects an admin, and silently getting the setup
 * page instead would leave the console open to whoever finds it first.
 */
function readInitialAdmin(env: NodeJS.ProcessEnv): InitialAdmin | undefined {
  const byName = optional(env.MONGOSHIELD_ADMIN_USERNAME);
  const byEmail = optional(env.MONGOSHIELD_ADMIN_EMAIL);
  if (byName !== undefined && byEmail !== undefined && byName !== byEmail) {
    throw new EnvironmentError(
      "Set MONGOSHIELD_ADMIN_USERNAME or MONGOSHIELD_ADMIN_EMAIL, not two different values.",
    );
  }
  const username = byName ?? byEmail;
  const direct = env.MONGOSHIELD_ADMIN_PASSWORD;
  const file = optional(env.MONGOSHIELD_ADMIN_PASSWORD_FILE);
  const hasPassword = (direct !== undefined && direct !== "") || file !== undefined;
  if (username === undefined && !hasPassword) return undefined;
  if (username === undefined || !hasPassword) {
    throw new EnvironmentError(
      "To create the first admin from the environment, set both MONGOSHIELD_ADMIN_USERNAME (or MONGOSHIELD_ADMIN_EMAIL) and MONGOSHIELD_ADMIN_PASSWORD (or MONGOSHIELD_ADMIN_PASSWORD_FILE).",
    );
  }
  if (direct !== undefined && direct !== "" && file !== undefined) {
    throw new EnvironmentError(
      "Set either MONGOSHIELD_ADMIN_PASSWORD or MONGOSHIELD_ADMIN_PASSWORD_FILE, not both.",
    );
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new EnvironmentError(
      "MONGOSHIELD_ADMIN_USERNAME must be 1-64 characters: letters, digits, dots, dashes, underscores or @.",
    );
  }
  // A password file usually ends with a newline that is not part of the password.
  const password =
    file === undefined
      ? (direct ?? "")
      : readSecretFile("MONGOSHIELD_ADMIN_PASSWORD_FILE", file).replace(/\r?\n$/, "");
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new EnvironmentError(
      `The admin password from the environment must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters long.`,
    );
  }
  return { username, password };
}

/** A "true"/"false" variable (case-insensitive), with a default when unset. */
function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optional(env[name])?.toLowerCase();
  if (raw === undefined) return fallback;
  if (raw !== "true" && raw !== "false") {
    throw new EnvironmentError(`${name} must be "true" or "false".`);
  }
  return raw === "true";
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
