/**
 * Signing in to OneDrive (Microsoft identity platform) for `onedrive://` storage.
 *
 *   const { refreshToken, secretName } = await loginOneDrive({
 *     clientId: resolveOneDriveClient(process.env).clientId,
 *     onPrompt: ({ userCode, verificationUrl }) => console.log(`Open ${verificationUrl}, enter ${userCode}`),
 *   });
 *   // gh secret set MONGOSHIELD_ONEDRIVE_TOKEN --body "$refreshToken"
 *
 * Two things live here:
 * - `loginOneDrive`: the OAuth 2.0 device authorization grant (RFC 8628) against
 *   `login.microsoftonline.com/consumers` (personal Microsoft accounts), or `/common`
 *   with the experimental work-and-school opt-in. A code is shown, approved on any
 *   device, and the refresh token comes back. It works over SSH and in Codespaces.
 * - `refreshOneDriveToken`: trades a refresh token for an access token. Microsoft
 *   returns a NEW refresh token with every refresh; see onedrive-token-state.ts for
 *   why the newest one has to be kept.
 *
 * The secret (`MONGOSHIELD_ONEDRIVE_TOKEN`) is not the bare refresh token but a small
 * envelope, `onedrive1.<base64url JSON>`, holding the token, the time it was issued,
 * the tenant and the client id it belongs to. The issue time is what lets the adapter
 * warn from day 75 (Microsoft refresh tokens last 90 days from issue); the client id
 * and tenant are needed to refresh it again. A bare refresh token (from your own
 * tooling) is accepted too, with an unknown issue time.
 *
 * Scopes: `Files.ReadWrite.AppFolder` (only the app's own folder, `Apps/<app name>`,
 * never the rest of the drive) and `offline_access` (a refresh token at all).
 *
 * Every HTTP call here goes through `postForm`; nothing is ever logged, and token
 * values never appear in errors.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { redactSecrets } from "../redact.ts";
import { numberProperty, propertyOf, stringProperty } from "./adapter-utils.ts";

/** The repository secret that holds the OneDrive sign-in. */
export const ONEDRIVE_SECRET_NAME = "MONGOSHIELD_ONEDRIVE_TOKEN";

/** Environment variables for bringing your own Microsoft app registration. */
export const ONEDRIVE_CLIENT_ENV = {
  clientId: "MONGOSHIELD_ONEDRIVE_CLIENT_ID",
  clientSecret: "MONGOSHIELD_ONEDRIVE_CLIENT_SECRET",
} as const;

/**
 * The client id of MongoShield's own Microsoft app registration. Empty until the app
 * is registered and published; until then `MONGOSHIELD_ONEDRIVE_CLIENT_ID` is required.
 */
export const SHIPPED_ONEDRIVE_CLIENT_ID = "";

/** Scopes asked for at sign-in and on every refresh (space-separated, as OAuth wants). */
export const ONEDRIVE_SCOPES = "Files.ReadWrite.AppFolder offline_access";

/** Where Microsoft's sign-in endpoints live. Tests point this at a fake. */
export const DEFAULT_AUTHORITY_URL = "https://login.microsoftonline.com";

/**
 * Which Microsoft accounts may sign in:
 * - `consumers`: personal Microsoft accounts only (outlook.com, hotmail, live). The default.
 * - `common`: personal and work or school (Entra ID) accounts. Experimental: app
 *   folders on OneDrive for Business are not consistently documented and have not
 *   been tested on a real tenant yet.
 */
export type OneDriveTenant = "consumers" | "common";

/** Microsoft refresh tokens stop working this many days after they were issued. */
export const REFRESH_TOKEN_LIFETIME_DAYS = 90;

/** The prefix that marks a MongoShield OneDrive secret envelope (version 1). */
const SECRET_PREFIX = "onedrive1.";

/** RFC 8628 grant type for polling the token endpoint during a device login. */
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Poll interval when the device code response does not name one (RFC 8628 says 5 s). */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 `slow_down`: add this to the poll interval. */
const SLOW_DOWN_SECONDS = 5;

/** Per-request timeout for the sign-in endpoints. */
const AUTH_TIMEOUT_MS = 30_000;

/** Attempts for a token request that fails with a network error, 429 or 5xx. */
const AUTH_ATTEMPTS = 4;

/** `details.reason` of the error for a refresh token Microsoft no longer accepts. */
export const SIGN_IN_EXPIRED_REASON = "onedrive-sign-in-expired";

/** The hint for an expired or revoked sign-in. */
const LOGIN_AGAIN_HINT =
  "Sign in again with `npx mongoshield login onedrive` and replace the " +
  `${ONEDRIVE_SECRET_NAME} secret. Microsoft refresh tokens last ${REFRESH_TOKEN_LIFETIME_DAYS} days ` +
  "from issue and are revoked when the account password changes. See docs/guides/onedrive.md.";

// ---------------------------------------------------------------------------
// The secret envelope
// ---------------------------------------------------------------------------

/** What the `MONGOSHIELD_ONEDRIVE_TOKEN` secret holds. */
export interface OneDriveCredential {
  /** The refresh token itself. Secret. */
  readonly refreshToken: string;
  /** When Microsoft issued it, if known (unknown for a bare token). */
  readonly issuedAt?: Date;
  /** The tenant it was issued for. Unknown for a bare token. */
  readonly tenant?: OneDriveTenant;
  /** The app registration it belongs to. Unknown for a bare token. */
  readonly clientId?: string;
}

/** Packs a credential into the secret value `onedrive1.<base64url JSON>`. */
export function encodeOneDriveSecret(credential: OneDriveCredential): string {
  const payload = {
    rt: credential.refreshToken,
    // Whole seconds since the epoch: compact, and plenty for a 90-day lifetime.
    ...(credential.issuedAt === undefined
      ? {}
      : { iat: Math.floor(credential.issuedAt.getTime() / 1000) }),
    ...(credential.tenant === undefined ? {} : { tnt: credential.tenant }),
    ...(credential.clientId === undefined ? {} : { cid: credential.clientId }),
  };
  return SECRET_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/**
 * Reads the secret value: an `onedrive1.` envelope, or a bare refresh token.
 * Throws MS_CONFIG_INVALID (never quoting the value) when an envelope is damaged.
 */
export function parseOneDriveSecret(value: string): OneDriveCredential {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", `${ONEDRIVE_SECRET_NAME} is empty.`, {
      hint: "Run `npx mongoshield login onedrive` and store what it prints in that secret.",
    });
  }
  if (!trimmed.startsWith(SECRET_PREFIX)) return { refreshToken: trimmed };

  const damaged = () =>
    new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${ONEDRIVE_SECRET_NAME} looks like a MongoShield OneDrive token but cannot be read.`,
      {
        hint: "Copy the whole value printed by `npx mongoshield login onedrive` (it starts with onedrive1.), or sign in again.",
      },
    );
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(trimmed.slice(SECRET_PREFIX.length), "base64url").toString());
  } catch {
    throw damaged();
  }
  const refreshToken = stringProperty(payload, "rt");
  if (refreshToken === undefined || refreshToken === "") throw damaged();
  const issuedSeconds = numberProperty(payload, "iat");
  const tenant = stringProperty(payload, "tnt");
  const clientId = stringProperty(payload, "cid");
  return {
    refreshToken,
    ...(issuedSeconds === undefined ? {} : { issuedAt: new Date(issuedSeconds * 1000) }),
    ...(tenant === "consumers" || tenant === "common" ? { tenant } : {}),
    ...(clientId === undefined || clientId === "" ? {} : { clientId }),
  };
}

// ---------------------------------------------------------------------------
// Client id
// ---------------------------------------------------------------------------

/** The app registration to sign in with. */
export interface OneDriveClient {
  readonly clientId: string;
  /** Only for confidential (web) app registrations; device login does not need one. */
  readonly clientSecret?: string;
}

/**
 * The client id (and optional secret) from `MONGOSHIELD_ONEDRIVE_CLIENT_ID` /
 * `_CLIENT_SECRET`, else MongoShield's shipped app. Throws MS_CONFIG_INVALID with
 * setup instructions when neither is available.
 */
export function resolveOneDriveClient(env: NodeJS.ProcessEnv): OneDriveClient {
  const fromEnv = env[ONEDRIVE_CLIENT_ENV.clientId]?.trim() ?? "";
  const clientId = fromEnv === "" ? SHIPPED_ONEDRIVE_CLIENT_ID : fromEnv;
  if (clientId === "") throw missingOneDriveClientError();
  const clientSecret = env[ONEDRIVE_CLIENT_ENV.clientSecret]?.trim() ?? "";
  return { clientId, ...(clientSecret === "" ? {} : { clientSecret }) };
}

/** The error for a missing client id, with the steps to register an app. */
export function missingOneDriveClientError(): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    "No Microsoft app (client id) is configured for OneDrive.",
    {
      hint:
        `Set ${ONEDRIVE_CLIENT_ENV.clientId} to the Application (client) ID of your own app ` +
        'registration (Azure portal → App registrations; "Personal Microsoft accounts only", ' +
        '"Allow public client flows" on, delegated permission Files.ReadWrite.AppFolder). ' +
        "See docs/guides/onedrive.md.",
    },
  );
}

// ---------------------------------------------------------------------------
// Device login
// ---------------------------------------------------------------------------

/** Options for {@link loginOneDrive}. */
export interface LoginOneDriveOptions {
  /** The app registration's client id (see {@link resolveOneDriveClient}). */
  readonly clientId: string;
  /** A client secret, for confidential app registrations only. */
  readonly clientSecret?: string;
  /** Called once with the code to enter and the page to enter it on. */
  readonly onPrompt: (prompt: { userCode?: string; verificationUrl: string }) => void;
  readonly signal?: AbortSignal;
  /** The fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Allow work or school (Entra ID) accounts by signing in through `/common`
   * instead of `/consumers`. Experimental; see docs/guides/onedrive.md.
   */
  readonly business?: boolean;
  /** Sign-in endpoint base URL. Defaults to `https://login.microsoftonline.com`; for tests. */
  readonly authorityUrl?: string;
  /** The current time, recorded as the token's issue time. For tests. */
  readonly now?: () => Date;
}

/** What a successful login returns: the secret value and the secret's name. */
export interface OneDriveLoginResult {
  /** The value to store in the secret (an `onedrive1.` envelope). Secret. */
  readonly refreshToken: string;
  /** `MONGOSHIELD_ONEDRIVE_TOKEN`. */
  readonly secretName: string;
}

/**
 * Signs in with the device code flow and returns the secret to store.
 *
 * Polls the token endpoint at the interval Microsoft names until the user approves,
 * declines, or the code expires (about 15 minutes).
 */
export async function loginOneDrive(options: LoginOneDriveOptions): Promise<OneDriveLoginResult> {
  const { signal } = options;
  const fetchImpl = options.fetch ?? fetch;
  const tenant: OneDriveTenant = options.business === true ? "common" : "consumers";
  const base = `${trimSlash(options.authorityUrl ?? DEFAULT_AUTHORITY_URL)}/${tenant}/oauth2/v2.0`;
  const now = options.now ?? (() => new Date());
  if (options.clientId.trim() === "") throw missingOneDriveClientError();

  // 1. Ask for a device code and a user code.
  const codeResponse = await postForm(
    fetchImpl,
    `${base}/devicecode`,
    { client_id: options.clientId, scope: ONEDRIVE_SCOPES },
    signal,
  );
  if (!codeResponse.ok) throw authError(codeResponse.body, "start the OneDrive sign-in", []);
  const deviceCode = stringProperty(codeResponse.body, "device_code");
  const userCode = stringProperty(codeResponse.body, "user_code");
  const verificationUrl = stringProperty(codeResponse.body, "verification_uri");
  if (deviceCode === undefined || verificationUrl === undefined) {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      "Microsoft's sign-in service sent an unexpected answer (no device code).",
    );
  }
  let intervalSeconds =
    numberProperty(codeResponse.body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const expiresInSeconds = numberProperty(codeResponse.body, "expires_in") ?? 900;
  const deadline = Date.now() + expiresInSeconds * 1000;
  options.onPrompt({ ...(userCode === undefined ? {} : { userCode }), verificationUrl });

  // 2. Poll until the user has approved (or not) on their device.
  const secrets = [deviceCode];
  while (Date.now() < deadline) {
    await sleepFor(intervalSeconds * 1000, signal);
    const tokenResponse = await postForm(
      fetchImpl,
      `${base}/token`,
      {
        grant_type: DEVICE_CODE_GRANT,
        client_id: options.clientId,
        device_code: deviceCode,
        ...(options.clientSecret === undefined ? {} : { client_secret: options.clientSecret }),
      },
      signal,
    );
    if (tokenResponse.ok) {
      const refreshToken = stringProperty(tokenResponse.body, "refresh_token");
      if (refreshToken === undefined || refreshToken === "") {
        throw new MongoShieldError(
          "MS_STORAGE_FORBIDDEN",
          "Microsoft signed you in but returned no refresh token.",
          {
            hint: "The app registration must allow the offline_access permission; sign in again.",
          },
        );
      }
      const secret = encodeOneDriveSecret({
        refreshToken,
        issuedAt: now(),
        tenant,
        clientId: options.clientId,
      });
      return { refreshToken: secret, secretName: ONEDRIVE_SECRET_NAME };
    }
    const code = stringProperty(tokenResponse.body, "error");
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalSeconds += SLOW_DOWN_SECONDS;
      continue;
    }
    if (code === "authorization_declined") {
      throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "The OneDrive sign-in was declined.", {
        hint: "Run `npx mongoshield login onedrive` again and approve the request.",
      });
    }
    if (code === "expired_token") break;
    throw authError(tokenResponse.body, "finish the OneDrive sign-in", secrets);
  }
  throw new MongoShieldError(
    "MS_TIMEOUT",
    "The OneDrive sign-in code expired before it was used.",
    {
      hint: "Run `npx mongoshield login onedrive` again and enter the code within 15 minutes.",
    },
  );
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** Options for {@link refreshOneDriveToken}. */
export interface RefreshOneDriveTokenOptions {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly tenant: OneDriveTenant;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Sign-in endpoint base URL. Defaults to `https://login.microsoftonline.com`. */
  readonly authorityUrl?: string;
}

/** A fresh access token, and the refresh token to use next time. */
export interface OneDriveTokens {
  /** A bearer token for Microsoft Graph, valid for about an hour. Secret. */
  readonly accessToken: string;
  /** The refresh token Microsoft returned with it (or the old one, if none came back). */
  readonly refreshToken: string;
  /** True when Microsoft returned a new refresh token. */
  readonly rotated: boolean;
  /** Seconds until the access token expires. */
  readonly expiresInSeconds: number;
}

/**
 * Exchanges a refresh token for an access token (and, normally, a new refresh token).
 * An expired or revoked refresh token fails with MS_STORAGE_FORBIDDEN whose
 * `details.reason` is {@link SIGN_IN_EXPIRED_REASON}.
 */
export async function refreshOneDriveToken(
  options: RefreshOneDriveTokenOptions,
): Promise<OneDriveTokens> {
  const base = trimSlash(options.authorityUrl ?? DEFAULT_AUTHORITY_URL);
  const response = await postForm(
    options.fetch ?? fetch,
    `${base}/${options.tenant}/oauth2/v2.0/token`,
    {
      grant_type: "refresh_token",
      client_id: options.clientId,
      refresh_token: options.refreshToken,
      scope: ONEDRIVE_SCOPES,
      ...(options.clientSecret === undefined ? {} : { client_secret: options.clientSecret }),
    },
    options.signal,
  );
  const secrets = [options.refreshToken, options.clientSecret];
  if (!response.ok) throw authError(response.body, "refresh the OneDrive sign-in", secrets);
  const accessToken = stringProperty(response.body, "access_token");
  if (accessToken === undefined || accessToken === "") {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      "Microsoft's sign-in service sent an unexpected answer (no access token).",
    );
  }
  const newRefreshToken = stringProperty(response.body, "refresh_token");
  const rotated = newRefreshToken !== undefined && newRefreshToken !== "";
  return {
    accessToken,
    refreshToken: rotated ? newRefreshToken : options.refreshToken,
    rotated,
    expiresInSeconds: numberProperty(response.body, "expires_in") ?? 3600,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** A token endpoint answer: whether it was 2xx, and its JSON body (or undefined). */
interface FormResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

/**
 * POSTs an `application/x-www-form-urlencoded` body and parses the JSON answer.
 * Retries network errors, 429 and 5xx a few times with a growing pause (honouring
 * Retry-After); OAuth errors (400 with `error`) are returned, not thrown.
 */
async function postForm(
  fetchImpl: typeof fetch,
  url: string,
  fields: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): Promise<FormResponse> {
  let lastProblem = "";
  for (let attempt = 1; attempt <= AUTH_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(fields).toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        // The sign-in endpoints never redirect; a redirect would carry our form elsewhere.
        redirect: "error",
      });
      const text = await response.text();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < AUTH_ATTEMPTS) {
        lastProblem = `HTTP ${response.status}`;
        await sleepFor(retryDelayMs(response.headers.get("retry-after"), attempt), signal);
        continue;
      }
      return { ok: response.ok, status: response.status, body: parseJson(text) };
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (error instanceof MongoShieldError) throw error;
      // Network errors and timeouts. fetch's messages never include the form body.
      lastProblem = error instanceof Error ? error.message : String(error);
      if (attempt < AUTH_ATTEMPTS) await sleepFor(retryDelayMs(null, attempt), signal);
    }
  }
  throw new MongoShieldError(
    "MS_STORAGE_IO",
    `Could not reach Microsoft's sign-in service: ${lastProblem}`,
    { hint: "Check the network connection, then try again." },
  );
}

/** Pause before retry `attempt` (1-based): Retry-After when given, else 1 s, 2 s, 4 s … */
function retryDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

/** Sleeps, turning an abort into MS_ABORTED. */
async function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Turns an OAuth error answer into a MongoShieldError. `invalid_grant` (an expired,
 * revoked or already-replaced refresh token) becomes MS_STORAGE_FORBIDDEN with the
 * "sign in again" hint; anything else MS_STORAGE_FORBIDDEN (client problems) or
 * MS_STORAGE_IO. Only Microsoft's error code and the first line of its description
 * are kept, with any of our secrets redacted.
 */
function authError(
  body: unknown,
  action: string,
  secrets: readonly (string | undefined)[],
): MongoShieldError {
  const code = stringProperty(body, "error") ?? "unknown_error";
  const description = redactSecrets(
    (stringProperty(body, "error_description") ?? "").split(/\r?\n/)[0] ?? "",
    secrets,
  );
  const errorCodes = propertyOf(body, "error_codes");
  const details = {
    oauthError: code,
    ...(Array.isArray(errorCodes)
      ? { microsoftErrorCodes: errorCodes.filter(Number.isFinite) }
      : {}),
  };
  const message = `Could not ${action}: ${code}${description === "" ? "" : ` (${description})`}`;
  if (code === "invalid_grant" || code === "interaction_required") {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      details: { ...details, reason: SIGN_IN_EXPIRED_REASON },
      hint: LOGIN_AGAIN_HINT,
    });
  }
  if (code === "invalid_client" || code === "unauthorized_client" || code === "invalid_scope") {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      details,
      hint:
        `Check ${ONEDRIVE_CLIENT_ENV.clientId}: the app registration must allow personal Microsoft ` +
        'accounts, have "Allow public client flows" on and the delegated permission ' +
        "Files.ReadWrite.AppFolder. See docs/guides/onedrive.md.",
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", message, { details });
}
