/**
 * Dropbox login (`mongoshield login dropbox`) and the refresh-token exchange the
 * `dropbox://` adapter uses on every run.
 *
 *   const { refreshToken, secretName } = await loginDropbox({
 *     clientId: resolveDropboxClient(process.env).clientId,
 *     onPrompt: ({ verificationUrl }) => console.log(`Open ${verificationUrl}`),
 *     readCode: () => askTheUser(),
 *   });
 *   // store refreshToken in the MONGOSHIELD_DROPBOX_TOKEN secret
 *
 * Dropbox has no device flow, so this is the OAuth 2 authorization code flow with
 * PKCE (RFC 7636) and `token_access_type=offline`, which returns a long-lived
 * refresh token. PKCE means no client secret is needed, so the shipped app key is
 * safe to publish. Two ways to bring the code back:
 *
 * - Loopback redirect (the default on a desktop): a one-shot HTTP server on
 *   127.0.0.1 receives `?code=…&state=…`. Dropbox matches redirect URIs exactly,
 *   port and path included (the OAuth guide: "register the exact redirect URI(s)
 *   your app may use"), so a random port cannot work. The server tries the fixed
 *   ports in {@link DROPBOX_LOOPBACK_PORTS} in order; every one of them must be
 *   registered in the App Console (see {@link dropboxRedirectUri}).
 * - Pasted code (SSH, Codespaces, or when every port is busy): the authorize URL
 *   is sent without `redirect_uri`, Dropbox shows the code on its own page, and the
 *   user pastes it into `readCode`. While the loopback server waits, `readCode`
 *   also runs, so a user whose browser is on another machine can paste the code,
 *   or the whole address-bar URL of the failed redirect, instead.
 *
 * Nothing here logs. The tokens are secrets: they never appear in errors (the
 * token endpoint's response bodies are reduced to their `error` field).
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { redactSecrets } from "../redact.ts";
import { OAUTH_APPS } from "./oauth/apps.ts";

/** The repository/CI secret that holds the Dropbox refresh token. */
export const DROPBOX_SECRET_NAME = "MONGOSHIELD_DROPBOX_TOKEN";

/** Environment variable for a bring-your-own Dropbox app key. */
export const DROPBOX_CLIENT_ID_ENV = "MONGOSHIELD_DROPBOX_CLIENT_ID";

/** Environment variable for that app's secret (optional: PKCE works without one). */
export const DROPBOX_CLIENT_SECRET_ENV = "MONGOSHIELD_DROPBOX_CLIENT_SECRET";

/**
 * The app key of MongoShield's own Dropbox app, kept with the other providers' in
 * src/storage/oauth/apps.ts. Empty until the app is registered; until then users must
 * bring their own with {@link DROPBOX_CLIENT_ID_ENV}.
 */
export const DROPBOX_SHIPPED_CLIENT_ID = OAUTH_APPS.dropbox.clientId;

/**
 * The least-privilege scopes MongoShield asks for (an App folder app):
 * - `files.metadata.read`: `files/get_metadata`, `files/list_folder(/continue)`
 * - `files.content.read`: `files/download`
 * - `files.content.write`: `files/upload`, `files/upload_session/*`, `files/delete_batch(/check)`
 * - `account_info.read`: `users/get_space_usage` (every Dropbox app has it anyway)
 *
 * `files.metadata.write` is not needed: uploads create their parent folders, and
 * deleting is covered by `files.content.write`.
 */
export const DROPBOX_SCOPES = [
  "account_info.read",
  "files.content.read",
  "files.content.write",
  "files.metadata.read",
] as const;

/**
 * Fixed loopback ports, tried in order. Each needs its own registered redirect URI,
 * `http://127.0.0.1:<port>/callback` (Dropbox accepts plain http only for loopback).
 * Picked from the dynamic range and away from ports other tools use for the same
 * purpose (rclone uses 53682).
 */
export const DROPBOX_LOOPBACK_PORTS = [53917, 53918] as const;

/** The path the loopback server answers on. Part of the registered redirect URI. */
const CALLBACK_PATH = "/callback";

/** Dropbox's OAuth endpoints. The authorize page is the only one on www.dropbox.com. */
export const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
/** The token endpoint, for code exchange and refresh. */
export const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

/** How long a login waits for the user before giving up (10 minutes). */
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** The redirect URI for one loopback port, exactly as it must be registered. */
export function dropboxRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/** The app key (and optional secret) to use, from the environment or the shipped one. */
export interface DropboxClient {
  readonly clientId: string;
  readonly clientSecret?: string;
}

/**
 * Picks the Dropbox app: `MONGOSHIELD_DROPBOX_CLIENT_ID` (and `_CLIENT_SECRET`) when
 * set, otherwise MongoShield's shipped app key. Fails with a hint while no app key
 * is available at all.
 */
export function resolveDropboxClient(env: NodeJS.ProcessEnv): DropboxClient {
  const clientId = env[DROPBOX_CLIENT_ID_ENV]?.trim() || DROPBOX_SHIPPED_CLIENT_ID;
  if (clientId === "") throw missingClientIdError();
  const clientSecret = env[DROPBOX_CLIENT_SECRET_ENV]?.trim();
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

/** The error for a missing app key, with how to bring one. */
function missingClientIdError(): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", "No Dropbox app key is configured.", {
    hint:
      `Create a Dropbox app with "App folder" access (see docs/guides/dropbox.md) and set ` +
      `${DROPBOX_CLIENT_ID_ENV} to its app key.`,
  });
}

/** What `onPrompt` receives: the page the user must open, and how the code comes back. */
export interface DropboxLoginPrompt {
  /** Always undefined: Dropbox has no device codes. Present for the shared login shape. */
  readonly userCode?: string;
  /** The Dropbox authorization page to open in a browser. */
  readonly verificationUrl: string;
  /**
   * `"loopback"`: the browser returns to this machine by itself (pasting the code or
   * the redirected URL into `readCode` also works). `"paste"`: Dropbox shows a code
   * that the user must paste into `readCode`.
   */
  readonly mode: "loopback" | "paste";
}

/** Options for {@link loginDropbox}. */
export interface DropboxLoginOptions {
  /** The Dropbox app key, usually from {@link resolveDropboxClient}. */
  readonly clientId: string;
  /** The app secret, only for bring-your-own apps that do not allow public clients. */
  readonly clientSecret?: string;
  /** Shows the authorization URL to the user (print it, open a browser). Called once. */
  readonly onPrompt: (prompt: DropboxLoginPrompt) => void;
  /**
   * Reads what the user pastes: the code Dropbox showed, or the full URL the browser
   * was redirected to. Required for `mode: "paste"`; optional otherwise. The signal
   * fires when the login no longer needs the answer (the loopback won).
   */
  readonly readCode?: (options: { readonly signal: AbortSignal }) => Promise<string>;
  /**
   * `"auto"` (default): loopback, unless this looks like an SSH session or Codespace
   * (then paste), or every loopback port is busy (then paste). `"loopback"` fails
   * instead of falling back; `"paste"` never starts a server.
   */
  readonly mode?: "auto" | "loopback" | "paste";
  /** Loopback ports to try in order. Defaults to {@link DROPBOX_LOOPBACK_PORTS}. */
  readonly ports?: readonly number[];
  /** Gives up after this long (default 10 minutes) with MS_TIMEOUT. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** `fetch` to use (default: the global one). */
  readonly fetch?: typeof fetch;
  /** Environment used for the SSH/Codespaces check (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Authorize page (tests point this at a fake). */
  readonly authorizeUrl?: string;
  /** Token endpoint (tests point this at a fake). */
  readonly tokenUrl?: string;
}

/** What a successful login returns: the refresh token and the secret to store it in. */
export interface DropboxLoginResult {
  readonly refreshToken: string;
  readonly secretName: string;
}

/**
 * Runs the Dropbox authorization code flow with PKCE and returns a refresh token.
 * See the file header for the loopback and pasted-code variants.
 */
export async function loginDropbox(options: DropboxLoginOptions): Promise<DropboxLoginResult> {
  throwIfAborted(options.signal);
  if (options.clientId.trim() === "") throw missingClientIdError();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const pkce = createPkce();
  const state = base64url(randomBytes(16));

  const listener = await startListenerFor(options);
  try {
    const redirectUri = listener ? dropboxRedirectUri(listener.port) : undefined;
    const verificationUrl = authorizeUrlFor(options, pkce.challenge, state, redirectUri);
    options.onPrompt({ verificationUrl, mode: listener ? "loopback" : "paste" });
    const code = await waitForCode(options, listener, state, signal);
    const refreshToken = await exchangeCode(options, code, pkce.verifier, redirectUri, signal);
    return { refreshToken, secretName: DROPBOX_SECRET_NAME };
  } catch (error) {
    throw signal.aborted && !(error instanceof MongoShieldError) ? abortError(signal) : error;
  } finally {
    await listener?.close();
  }
}

/** Options for {@link refreshDropboxAccessToken}. */
export interface DropboxRefreshOptions {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly tokenUrl?: string;
}

/** A short-lived access token and when it stops working. */
export interface DropboxAccessToken {
  readonly accessToken: string;
  readonly expiresAt: Date;
}

/**
 * Exchanges a refresh token for a short-lived access token (about 4 hours). A
 * revoked or unknown refresh token fails with MS_STORAGE_FORBIDDEN and a hint to
 * log in again; network trouble and Dropbox outages with MS_STORAGE_IO.
 */
export async function refreshDropboxAccessToken(
  options: DropboxRefreshOptions,
): Promise<DropboxAccessToken> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  });
  if (options.clientSecret) form.set("client_secret", options.clientSecret);
  const body = await postTokenForm(options, form, [options.refreshToken, options.clientSecret]);
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new MongoShieldError("MS_STORAGE_IO", "Dropbox returned no access token.");
  }
  // `expires_in` is in seconds; assume the documented ~4 hours if it is missing.
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 4 * 60 * 60;
  return { accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}

/** A PKCE verifier (43 URL-safe characters) and its S256 challenge. */
function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** The `/oauth2/authorize` URL the user opens. */
function authorizeUrlFor(
  options: DropboxLoginOptions,
  challenge: string,
  state: string,
  redirectUri: string | undefined,
): string {
  const url = new URL(options.authorizeUrl ?? DROPBOX_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Without this Dropbox returns only a short-lived access token, useless for CI.
  url.searchParams.set("token_access_type", "offline");
  url.searchParams.set("scope", DROPBOX_SCOPES.join(" "));
  url.searchParams.set("state", state);
  if (redirectUri) url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

/** True when the browser the user sees is probably not on this machine. */
function looksRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.CODESPACES);
}

/** A loopback server waiting for one redirect. */
interface LoopbackListener {
  readonly port: number;
  /** Resolves with the code from the first redirect whose `state` matches. */
  readonly code: (state: string) => Promise<string>;
  readonly close: () => Promise<void>;
}

/**
 * Starts the loopback server for the chosen mode, or returns undefined for the
 * pasted-code flow. Fails early when paste mode has no way to read a code.
 */
async function startListenerFor(
  options: DropboxLoginOptions,
): Promise<LoopbackListener | undefined> {
  const mode = options.mode ?? "auto";
  const usePaste = mode === "paste" || (mode === "auto" && looksRemote(options.env ?? process.env));
  if (!usePaste) {
    const listener = await listenOnFirstFreePort(options.ports ?? DROPBOX_LOOPBACK_PORTS);
    if (listener) return listener;
    if (mode === "loopback") {
      const ports = (options.ports ?? DROPBOX_LOOPBACK_PORTS).join(", ");
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Cannot start the Dropbox login callback: ports ${ports} on 127.0.0.1 are all in use.`,
        { hint: "Free one of those ports, or log in with the pasted-code flow." },
      );
    }
  }
  if (!options.readCode) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The Dropbox login needs to read a pasted code, but no readCode function was given.",
      { hint: "Run the login in an interactive terminal." },
    );
  }
  return undefined;
}

/** Tries each port in order; undefined when every one is taken. */
async function listenOnFirstFreePort(
  ports: readonly number[],
): Promise<LoopbackListener | undefined> {
  for (const port of ports) {
    const listener = await listenOn(port);
    if (listener) return listener;
  }
  return undefined;
}

/** Listens on 127.0.0.1:`port`; undefined when the port is in use or not allowed. */
function listenOn(port: number): Promise<LoopbackListener | undefined> {
  // Callbacks registered by `code()`; the request handler settles the first match.
  const waiting: {
    state: string;
    resolve: (code: string) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const server = createServer((request, response) => {
    handleCallback(request, response, waiting);
  });
  return new Promise((resolve) => {
    server.once("error", () => resolve(undefined));
    // 127.0.0.1, not localhost: the redirect URI names the IPv4 loopback, and a
    // server on every interface would let other machines on the network reach it.
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        code: (state) =>
          new Promise<string>((resolveCode, rejectCode) => {
            waiting.push({ state, resolve: resolveCode, reject: rejectCode });
          }),
        close: () => closeServer(server),
      });
    });
  });
}

/**
 * Handles one browser request to the loopback server. Only `GET /callback` with the
 * expected `state` counts; anything else (a favicon request, a stale tab from an
 * earlier login, a forged request) gets an error page and the server keeps waiting.
 * The pages never echo request data, so nothing the request carries is reflected.
 */
function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  waiting: { state: string; resolve: (code: string) => void; reject: (e: unknown) => void }[],
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const pending = waiting[0];
  if (request.method !== "GET" || url.pathname !== CALLBACK_PATH || !pending) {
    sendPage(response, 404, "Not found.");
    return;
  }
  if (url.searchParams.get("state") !== pending.state) {
    sendPage(response, 400, "This login link is out of date. Start the login again.");
    return;
  }
  waiting.shift();
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error || !code) {
    sendPage(response, 400, "Dropbox did not authorize MongoShield. You can close this tab.");
    pending.reject(
      new MongoShieldError("MS_STORAGE_FORBIDDEN", "The Dropbox authorization was not granted.", {
        // `error` is an OAuth error code such as access_denied, never a secret.
        details: { error: error ?? "missing_code" },
        hint: "Run the login again and choose Allow on the Dropbox page.",
      }),
    );
    return;
  }
  sendPage(response, 200, "MongoShield is connected to Dropbox. You can close this tab.");
  pending.resolve(code);
}

function sendPage(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // The page must not be cached or framed; it is shown once and closed.
    "cache-control": "no-store",
    "x-frame-options": "DENY",
  });
  response.end(`<!doctype html><title>MongoShield</title><p>${message}</p>`);
}

/** Stops the server, dropping any keep-alive connection the browser left open. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/**
 * Waits for the authorization code: from the loopback server, from `readCode`, or
 * whichever comes first when both are available.
 */
async function waitForCode(
  options: DropboxLoginOptions,
  listener: LoopbackListener | undefined,
  state: string,
  signal: AbortSignal,
): Promise<string> {
  const stopReading = new AbortController();
  const readSignal = AbortSignal.any([signal, stopReading.signal]);
  const candidates: Promise<string>[] = [];
  if (listener) candidates.push(listener.code(state));
  if (options.readCode) {
    const read = options
      .readCode({ signal: readSignal })
      .then((input) => codeFromInput(input, state));
    // A loopback login must not fail because the optional prompt was closed (no
    // terminal, Ctrl-D): the browser can still come back. A pasted value that is
    // not a valid code or redirect URL does fail, so the user is not left waiting.
    const tolerant = read.catch((error: unknown) => {
      if (error instanceof MongoShieldError && error.code === "MS_CONFIG_INVALID") throw error;
      return new Promise<string>(() => {});
    });
    candidates.push(listener ? tolerant : read);
  }
  candidates.push(rejectOnAbort(signal));
  try {
    return await Promise.race(candidates);
  } finally {
    stopReading.abort();
  }
}

/**
 * Accepts either the bare code Dropbox displayed or the whole redirected URL from
 * the browser's address bar (`http://127.0.0.1:53917/callback?code=…&state=…`).
 * A pasted URL must carry the right `state`, like a real redirect.
 */
function codeFromInput(input: string, state: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    const url = new URL(text);
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "The pasted URL is not the redirect of this Dropbox login.",
        { hint: "Paste the address the browser shows after you choose Allow, or just the code." },
      );
    }
    return code;
  }
  if (text === "" || /\s/.test(text)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The pasted Dropbox code is empty or invalid.",
      {
        hint: "Copy the code Dropbox shows after you choose Allow, and paste it as one line.",
      },
    );
  }
  return text;
}

/** A promise that only ever rejects, when `signal` aborts (login timeout or cancel). */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(abortError(signal));
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

/** Trades the authorization code (plus the PKCE verifier) for the refresh token. */
async function exchangeCode(
  options: DropboxLoginOptions,
  code: string,
  verifier: string,
  redirectUri: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const form = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    code_verifier: verifier,
    client_id: options.clientId,
  });
  // Must repeat the redirect_uri of the authorize request, and only if one was sent.
  if (redirectUri) form.set("redirect_uri", redirectUri);
  if (options.clientSecret) form.set("client_secret", options.clientSecret);
  const body = await postTokenForm({ ...options, signal }, form, [
    code,
    verifier,
    options.clientSecret,
  ]);
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") {
    throw new MongoShieldError("MS_STORAGE_IO", "Dropbox returned no refresh token.", {
      hint: "The authorization must ask for offline access; check the app's OAuth settings.",
    });
  }
  return refreshToken;
}

/**
 * POSTs a form to the token endpoint and returns the JSON body. Errors keep only
 * the OAuth `error` code (`invalid_grant`, …) and status, never the response text,
 * which could echo a token. `secrets` are also scrubbed from network error messages.
 */
async function postTokenForm(
  options: { signal?: AbortSignal; fetch?: typeof fetch; tokenUrl?: string },
  form: URLSearchParams,
  secrets: readonly (string | undefined)[],
): Promise<Record<string, unknown>> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(options.tokenUrl ?? DROPBOX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal);
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `Cannot reach the Dropbox token endpoint: ${message}`,
    );
  }
  const body = await jsonObjectOf(response);
  if (response.ok) return body;
  const oauthError = typeof body.error === "string" ? body.error : undefined;
  if (response.status === 400 || response.status === 401) {
    // invalid_grant: revoked, expired or mistyped token/code; invalid_client: wrong app key.
    throw new MongoShieldError(
      "MS_STORAGE_FORBIDDEN",
      `Dropbox rejected the login (${oauthError ?? `HTTP ${response.status}`}).`,
      {
        details: { status: response.status, ...(oauthError ? { error: oauthError } : {}) },
        hint:
          `Run \`mongoshield login dropbox\` again and update ${DROPBOX_SECRET_NAME}. ` +
          `If you use your own app, check ${DROPBOX_CLIENT_ID_ENV}.`,
      },
    );
  }
  throw new MongoShieldError(
    "MS_STORAGE_IO",
    `The Dropbox token endpoint failed with HTTP ${response.status}.`,
    { details: { status: response.status } },
  );
}

/** Parses a JSON object body; anything else (HTML error pages, empty) becomes `{}`. */
async function jsonObjectOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
