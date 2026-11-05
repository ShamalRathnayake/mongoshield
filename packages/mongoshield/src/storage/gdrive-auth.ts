/**
 * Signing in to Google Drive for `gdrive://` storage, with plain `fetch`.
 *
 *   const { refreshToken, secretName } = await loginGdrive({
 *     ...gdriveClientCredentials(process.env),
 *     onPrompt: ({ userCode, verificationUrl }) => print(`Open ${verificationUrl}, enter ${userCode}`),
 *   });
 *   // later, on every run:
 *   const { accessToken } = await exchangeGdriveRefreshToken({ ...credentials, refreshToken });
 *
 * Login uses Google's OAuth 2.0 flow for "TVs and Limited Input devices" (a device
 * flow, RFC 8628 style): MongoShield shows a short code, the user approves it on any
 * device with a browser, and MongoShield polls the token endpoint until Google hands
 * out a refresh token. That also works over SSH and in Codespaces, where no local
 * browser can receive a redirect. Google documents this flow at
 * https://developers.google.com/identity/protocols/oauth2/limited-input-device.
 *
 * Facts this module relies on (checked against that page):
 * - Endpoints: `POST https://oauth2.googleapis.com/device/code` (client_id, scope)
 *   answers `device_code`, `user_code`, `verification_url`, `expires_in`, `interval`;
 *   `POST https://oauth2.googleapis.com/token` with
 *   `grant_type=urn:ietf:params:oauth:grant-type:device_code` is polled.
 * - While polling: `authorization_pending` (428) means "keep waiting", `slow_down`
 *   (403) means "poll less often", `access_denied` (403) means the user said no.
 * - The flow only allows a few scopes; `drive.file` is one of them. It is the least
 *   privilege Drive scope: MongoShield sees only the files it created itself.
 * - The device flow needs the OAuth client's secret. For installed apps Google
 *   says that secret is not treated as confidential, which is why a shipped client
 *   can carry one.
 *
 * The refresh token is the one secret users store (as `MONGOSHIELD_GDRIVE_TOKEN`).
 * It never appears in an error message or a log line from this module.
 */

import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { OAUTH_APPS } from "./oauth/apps.ts";

/** The only scope MongoShield asks for: files this app created, nothing else in the drive. */
export const GDRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Name of the secret (and environment variable) that holds the refresh token. */
export const GDRIVE_TOKEN_SECRET = "MONGOSHIELD_GDRIVE_TOKEN";

/** Environment variables that override the shipped OAuth client (bring your own app). */
export const GDRIVE_CLIENT_ENV = {
  clientId: "MONGOSHIELD_GDRIVE_CLIENT_ID",
  clientSecret: "MONGOSHIELD_GDRIVE_CLIENT_SECRET",
} as const;

/**
 * The OAuth client MongoShield ships, kept with the other providers' in
 * src/storage/oauth/apps.ts. Empty until the maintainer registers the Google Cloud
 * project's "TVs and Limited Input devices" client; until then users must bring
 * their own through {@link GDRIVE_CLIENT_ENV}.
 */
const SHIPPED_CLIENT_ID = OAUTH_APPS.gdrive.clientId;
/** Installed-app client secrets are not confidential (see the header comment). */
const SHIPPED_CLIENT_SECRET = OAUTH_APPS.gdrive.clientSecret;

/** Google's device authorization endpoint. */
export const GOOGLE_DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
/** Google's token endpoint (device-code polling and refresh-token exchange). */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The grant type of a device-flow token request. */
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Google's default polling interval when the response omits one, in seconds. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: after `slow_down`, poll 5 seconds less often than before. */
const SLOW_DOWN_STEP_SECONDS = 5;
/** Each token-endpoint request may take this long before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Transient token-endpoint failures (5xx, 429, network) are retried this many times. */
const TOKEN_RETRIES = 4;

/** Hint for every "the token no longer works" error. */
const LOGIN_AGAIN_HINT =
  `Run \`mongoshield login gdrive\` again and store the new token as ${GDRIVE_TOKEN_SECRET}. ` +
  "Google expires refresh tokens after 6 months without use, after 7 days while the OAuth " +
  "app is in Testing, and when the user removes MongoShield's access in their Google account.";

/** The OAuth client used to talk to Google. */
export interface GdriveClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What the user must do to approve the login, shown by the caller. */
export interface GdriveLoginPrompt {
  /** The short code to type on the verification page, e.g. `ABCD-EFGH`. */
  readonly userCode?: string;
  /** The page to open, e.g. `https://www.google.com/device`. */
  readonly verificationUrl: string;
}

/** Options for {@link loginGdrive}. */
export interface GdriveLoginOptions {
  readonly clientId: string;
  /** Required by Google's device flow; see the header comment. */
  readonly clientSecret?: string;
  /** Called once with the code to show the user. */
  readonly onPrompt: (prompt: GdriveLoginPrompt) => void;
  readonly signal?: AbortSignal;
  /** A `fetch` to use instead of the global one (tests). */
  readonly fetch?: typeof fetch;
  /** Endpoint overrides, for tests against a fake server. */
  readonly deviceCodeUrl?: string;
  readonly tokenUrl?: string;
  /** Waits between polls; replaceable so tests do not wait for real. */
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** What a successful login returns: the token to store, and where to store it. */
export interface GdriveLoginResult {
  readonly refreshToken: string;
  readonly secretName: string;
}

/** Options for {@link exchangeGdriveRefreshToken}. */
export interface GdriveRefreshOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly tokenUrl?: string;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** A short-lived access token and when it stops working. */
export interface GdriveAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

/**
 * The OAuth client to use: `MONGOSHIELD_GDRIVE_CLIENT_ID` / `_CLIENT_SECRET` when
 * set, otherwise the client MongoShield ships. Fails with a hint when neither exists.
 */
export function gdriveClientCredentials(env: NodeJS.ProcessEnv): GdriveClientCredentials {
  const clientId = nonEmpty(env[GDRIVE_CLIENT_ENV.clientId]) ?? SHIPPED_CLIENT_ID;
  const clientSecret = nonEmpty(env[GDRIVE_CLIENT_ENV.clientSecret]) ?? SHIPPED_CLIENT_SECRET;
  if (clientId === "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "No Google OAuth client is configured for Google Drive storage.",
      {
        hint:
          `Set ${GDRIVE_CLIENT_ENV.clientId} and ${GDRIVE_CLIENT_ENV.clientSecret} to an OAuth client ` +
          'of type "TVs and Limited Input devices" with the Drive API enabled. See docs/guides/google-drive.md.',
      },
    );
  }
  return { clientId, clientSecret };
}

/**
 * Runs the device flow: asks Google for a code, shows it through `onPrompt`, then
 * polls until the user approves (or declines, or the code expires).
 */
export async function loginGdrive(options: GdriveLoginOptions): Promise<GdriveLoginResult> {
  const { signal } = options;
  throwIfAborted(signal);
  const sleep = options.sleep ?? abortableSleep;
  const device = await requestDeviceCode(options);
  options.onPrompt({ userCode: device.userCode, verificationUrl: device.verificationUrl });

  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalSeconds = device.intervalSeconds;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000, signal);
    throwIfAborted(signal);
    const answer = await postForm(options.tokenUrl ?? GOOGLE_TOKEN_URL, options, {
      client_id: options.clientId,
      ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
      device_code: device.deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    });
    if (answer.ok) {
      const refreshToken = stringField(answer.body, "refresh_token");
      if (!refreshToken) {
        throw new MongoShieldError(
          "MS_STORAGE_IO",
          "Google approved the login but sent no refresh token.",
          { hint: "Run `mongoshield login gdrive` again." },
        );
      }
      return { refreshToken, secretName: GDRIVE_TOKEN_SECRET };
    }
    const error = stringField(answer.body, "error");
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSeconds += SLOW_DOWN_STEP_SECONDS;
      continue;
    }
    throw pollingError(error, answer.status, stringField(answer.body, "error_description"));
  }
  throw new MongoShieldError(
    "MS_TIMEOUT",
    "The Google login code expired before it was approved.",
    {
      hint: "Run `mongoshield login gdrive` again and approve the code within a few minutes.",
    },
  );
}

/**
 * Exchanges a refresh token for an access token (valid about an hour). Transient
 * failures are retried; a revoked or expired token fails with MS_STORAGE_FORBIDDEN.
 */
export async function exchangeGdriveRefreshToken(
  options: GdriveRefreshOptions,
): Promise<GdriveAccessToken> {
  const { signal } = options;
  throwIfAborted(signal);
  const answer = await postForm(options.tokenUrl ?? GOOGLE_TOKEN_URL, options, {
    client_id: options.clientId,
    ...(options.clientSecret ? { client_secret: options.clientSecret } : {}),
    refresh_token: options.refreshToken,
    grant_type: "refresh_token",
  });
  if (answer.ok) {
    const accessToken = stringField(answer.body, "access_token");
    const expiresIn = numberField(answer.body, "expires_in") ?? 3600;
    if (!accessToken) {
      throw new MongoShieldError("MS_STORAGE_IO", "Google's token endpoint sent no access token.");
    }
    return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }
  const error = stringField(answer.body, "error");
  if (error === "invalid_grant") {
    throw new MongoShieldError(
      "MS_STORAGE_FORBIDDEN",
      `Google refused the Google Drive token (${GDRIVE_TOKEN_SECRET}): it was revoked or has expired.`,
      { hint: LOGIN_AGAIN_HINT, details: { httpStatus: answer.status } },
    );
  }
  if (error === "invalid_client" || error === "unauthorized_client") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Google refused the OAuth client used for Google Drive storage.",
      {
        hint:
          `The token must come from the same OAuth client: check ${GDRIVE_CLIENT_ENV.clientId} and ` +
          `${GDRIVE_CLIENT_ENV.clientSecret}, or run \`mongoshield login gdrive\` again with the current client.`,
        details: { httpStatus: answer.status },
      },
    );
  }
  throw new MongoShieldError(
    "MS_STORAGE_IO",
    `Could not refresh the Google Drive access token (HTTP ${answer.status}${error ? `, ${error}` : ""}).`,
    { details: { httpStatus: answer.status } },
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** The parts of a device-code response we use. */
interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

/** Step 1 of the device flow: get a device code and the user code to show. */
async function requestDeviceCode(options: GdriveLoginOptions): Promise<DeviceCode> {
  const answer = await postForm(options.deviceCodeUrl ?? GOOGLE_DEVICE_CODE_URL, options, {
    client_id: options.clientId,
    scope: GDRIVE_SCOPE,
  });
  const deviceCode = stringField(answer.body, "device_code");
  const userCode = stringField(answer.body, "user_code");
  // Google says `verification_url`; RFC 8628 says `verification_uri`. Accept both.
  const verificationUrl =
    stringField(answer.body, "verification_url") ?? stringField(answer.body, "verification_uri");
  if (!answer.ok || !deviceCode || !userCode || !verificationUrl) {
    const error = stringField(answer.body, "error");
    if (error === "invalid_client" || error === "unauthorized_client") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "Google refused the OAuth client for the device login.",
        {
          hint:
            'The client must be of type "TVs and Limited Input devices", with the Google Drive API ' +
            `enabled in its project. Check ${GDRIVE_CLIENT_ENV.clientId}.`,
          details: { httpStatus: answer.status },
        },
      );
    }
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `Could not start the Google login (HTTP ${answer.status}${error ? `, ${error}` : ""}).`,
      { details: { httpStatus: answer.status } },
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUrl,
    expiresInSeconds: numberField(answer.body, "expires_in") ?? 1800,
    intervalSeconds: numberField(answer.body, "interval") ?? DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

/** The error for a polling answer that is neither success nor "keep waiting". */
function pollingError(
  error: string | undefined,
  status: number,
  description: string | undefined,
): MongoShieldError {
  const details = { httpStatus: status };
  if (error === "access_denied") {
    return new MongoShieldError("MS_ABORTED", "The Google login was declined.", {
      hint: "Run `mongoshield login gdrive` again and choose Allow.",
      details,
    });
  }
  if (error === "expired_token") {
    return new MongoShieldError("MS_TIMEOUT", "The Google login code expired.", {
      hint: "Run `mongoshield login gdrive` again.",
      details,
    });
  }
  if (error === "admin_policy_enforced" || error === "org_internal") {
    return new MongoShieldError(
      "MS_STORAGE_FORBIDDEN",
      `Google refused the login: ${description ?? error}.`,
      {
        hint: "A Google Workspace policy blocks this app. Ask the admin to allow it, or bring your own OAuth client.",
        details,
      },
    );
  }
  return new MongoShieldError(
    "MS_STORAGE_IO",
    `The Google login failed (HTTP ${status}${error ? `, ${error}` : ""}).`,
    { hint: "Run `mongoshield login gdrive` again.", details },
  );
}

/** A token-endpoint answer: the HTTP status and the parsed JSON body (or `{}`). */
interface FormAnswer {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

/** Network options shared by both flows. */
interface PostOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * POSTs a form to a Google OAuth endpoint and parses the JSON answer. 5xx, 429 and
 * network failures are retried with backoff; every other answer is returned as is,
 * because OAuth errors (400/401/403/428) carry meaning the caller interprets.
 */
async function postForm(
  url: string,
  options: PostOptions,
  form: Record<string, string>,
): Promise<FormAnswer> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const { signal } = options;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      if (attempt >= TOKEN_RETRIES) {
        throw new MongoShieldError("MS_STORAGE_IO", "Could not reach Google's sign-in service.", {
          cause: error,
          hint: "Check the network connection and try again.",
        });
      }
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < TOKEN_RETRIES) {
      await response.body?.cancel().catch(() => {});
      await sleep(backoffMs(attempt), signal);
      continue;
    }
    const text = await response.text().catch(() => "");
    return { ok: response.ok, status: response.status, body: parseJson(text) };
  }
}

/** 1 s, 2 s, 4 s, … with up to 1 s of random jitter, capped at 32 s. */
function backoffMs(attempt: number): number {
  return Math.min(32_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000);
}

/** `setTimeout` as a promise that rejects with MS_ABORTED when the signal fires. */
export function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Parses JSON, or returns `{}` for bodies that are not JSON (an HTML error page). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** A string property of an unknown JSON value. */
function stringField(value: unknown, name: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[name];
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** A number property of an unknown JSON value (Google sends some as strings). */
function numberField(value: unknown, name: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[name];
  const number = typeof field === "string" ? Number(field) : field;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** The trimmed value, or `undefined` for unset and blank variables. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
