/**
 * The OAuth 2.0 authorization code grant with PKCE (RFC 7636) and a loopback redirect
 * (RFC 8252 §7.3), for providers without a device flow (Dropbox).
 *
 *   1. listen on http://127.0.0.1:<port><callbackPath> (a random free port by default)
 *   2. hand the authorization URL to `onAuthorizationUrl` (the CLI prints it and may
 *      open a browser); it carries the S256 code challenge and a random `state`
 *   3. the provider redirects the browser back with `?code=…&state=…`
 *   4. exchange the code (with the PKCE verifier) for tokens at the token endpoint
 *
 * The listener accepts exactly ONE callback and then closes, whatever it contained:
 * a wrong `state` (a request this login did not start, possibly forged) fails the
 * login instead of waiting for another try. Requests to other paths (a browser's
 * `/favicon.ico`) get a 404 and do not count. It listens on 127.0.0.1 only, never on
 * every interface, so nothing else on the network can reach it.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { abortError, MongoShieldError, throwIfAborted } from "../../errors.ts";
import type { OAuthClient } from "./apps.ts";
import { oauthError } from "./device-flow.ts";
import { type OAuthTokenSet, requestTokens, type TokenEndpointOptions } from "./token-endpoint.ts";

/** How long the person has to finish in the browser. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** The loopback address. Not `localhost`, which may resolve to ::1 or something else. */
const LOOPBACK_HOST = "127.0.0.1";

/** Options for {@link runBrowserFlow}. */
export interface BrowserFlowOptions extends TokenEndpointOptions {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  /** Scopes to ask for; omitted from the URL when empty (the app's own scopes apply). */
  readonly scopes: readonly string[];
  /** Extra authorization parameters, e.g. `{ token_access_type: "offline" }` for Dropbox. */
  readonly authorizationParams?: Readonly<Record<string, string>>;
  /** Shows (or opens) the URL the person must visit. */
  readonly onAuthorizationUrl: (url: string) => void | Promise<void>;
  /** The port to listen on; `0` (default) picks a free one. Some providers need a fixed one. */
  readonly port?: number;
  /** The redirect path. Default `/callback`. */
  readonly callbackPath?: string;
  /** How long to wait for the redirect. Default 5 minutes. */
  readonly timeoutMs?: number;
}

/** A PKCE verifier and its S256 challenge. */
export interface PkcePair {
  /** 43 base64url characters (32 random bytes); stays on this machine until the exchange. */
  readonly verifier: string;
  /** base64url(SHA-256(verifier)), sent in the authorization URL. */
  readonly challenge: string;
}

/** A fresh PKCE pair (RFC 7636 §4.1–4.2, method S256). */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * Runs the browser flow to the end and returns the tokens.
 *
 * @throws MS_STORAGE_FORBIDDEN when the person declines or the callback's `state` does
 *   not match; MS_TIMEOUT when no callback arrives in time; MS_CONFIG_INVALID for a
 *   client the provider refuses; MS_ABORTED on Ctrl-C; MS_STORAGE_IO for network failures.
 */
export async function runBrowserFlow(options: BrowserFlowOptions): Promise<OAuthTokenSet> {
  const { service, signal } = options;
  throwIfAborted(signal);
  const callbackPath = options.callbackPath ?? "/callback";
  const pkce = createPkcePair();
  const state = randomBytes(24).toString("base64url");

  const listener = await listen(options.port ?? 0);
  try {
    const redirectUri = `http://${LOOPBACK_HOST}:${listener.port}${callbackPath}`;
    const url = new URL(options.authorizationUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", options.client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    if (options.scopes.length > 0) url.searchParams.set("scope", options.scopes.join(" "));
    for (const [name, value] of Object.entries(options.authorizationParams ?? {})) {
      url.searchParams.set(name, value);
    }

    const callback = listener.nextCallback(callbackPath);
    await options.onAuthorizationUrl(url.href);
    const query = await withTimeout(
      callback,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      service,
      signal,
    );

    if (query.get("state") !== state) {
      throw new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `The ${service} sign-in returned to MongoShield with the wrong state; it was not the sign-in this login started.`,
        { hint: "Run the login again, and use only the link it prints." },
      );
    }
    const error = query.get("error");
    if (error !== null) {
      if (error === "access_denied") {
        throw new MongoShieldError("MS_STORAGE_FORBIDDEN", `The ${service} sign-in was declined.`, {
          hint: "Run the login again and choose Allow.",
        });
      }
      throw oauthError(service, error, query.get("error_description") ?? undefined);
    }
    const code = query.get("code");
    if (code === null || code === "") {
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `${service} returned without an authorization code.`,
      );
    }

    const result = await requestTokens(
      options.tokenUrl,
      options.client,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      },
      // A code is single-use: never send it twice.
      { ...options, idempotent: false, operation: "finish the sign-in" },
    );
    if (!result.ok) throw oauthError(service, result.error, result.description);
    return result.tokens;
  } finally {
    await listener.close();
  }
}

/** A loopback HTTP listener that hands out the query of the first callback request. */
interface CallbackListener {
  readonly port: number;
  /** Resolves with the query of the first request to `path`. */
  nextCallback(path: string): Promise<URLSearchParams>;
  close(): Promise<void>;
}

/** Starts the loopback listener. */
async function listen(port: number): Promise<CallbackListener> {
  let resolveCallback: ((query: URLSearchParams) => void) | undefined;
  let callbackPath = "/callback";
  let answered = false;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== callbackPath || answered || request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    // One callback only, whatever it says (see the file header).
    answered = true;
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
      .end(
        "<!doctype html><meta charset=utf-8><title>MongoShield</title>" +
          "<p>MongoShield received the answer. You can close this tab and return to the terminal.</p>",
      );
    resolveCallback?.(url.searchParams);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new MongoShieldError(
          "MS_CONFIG_INVALID",
          `Could not listen on ${LOOPBACK_HOST}:${port} for the sign-in.`,
          {
            cause: error,
            hint: "Free that port, or let MongoShield pick one (port 0).",
          },
        ),
      ),
    );
    server.listen(port, LOOPBACK_HOST, () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    nextCallback(path) {
      callbackPath = path;
      return new Promise((resolve) => {
        resolveCallback = resolve;
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Waits for `promise`, failing with MS_TIMEOUT after `ms` or MS_ABORTED on abort. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  service: string,
  signal: AbortSignal | undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new MongoShieldError(
            "MS_TIMEOUT",
            `No answer from the ${service} sign-in within ${Math.round(ms / 1000)} s.`,
            {
              hint: "Run the login again and finish it in the browser within a few minutes.",
            },
          ),
        ),
      ms,
    );
    if (signal !== undefined) {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}
