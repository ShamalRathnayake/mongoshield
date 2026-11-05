/**
 * Talking to an OAuth 2.0 token endpoint (RFC 6749 §5): one form-encoded POST, a JSON
 * answer that is either a token set or an `{ error, error_description }` object.
 * Shared by the device flow, the browser flow and refreshes.
 *
 * OAuth error answers (400/401 with an `error` field) come back as values, because
 * the device flow treats `authorization_pending` and `slow_down` as normal steps;
 * everything else (5xx after retries, a network failure, a body that is not JSON)
 * throws MS_STORAGE_IO from the HTTP client.
 */

import { MongoShieldError } from "../../errors.ts";
import { createHttpClient, type HttpClientOptions } from "../http/client.ts";
import type { OAuthClient } from "./apps.ts";

/** The tokens an endpoint issued. */
export interface OAuthTokenSet {
  /** Short-lived; sent as `Authorization: Bearer …`. A secret. */
  readonly accessToken: string;
  /** Long-lived; what `mongoshield login` prints and adapters refresh with. A secret. */
  readonly refreshToken?: string;
  /** When the access token expires (milliseconds since the epoch), if the server said. */
  readonly expiresAt?: number;
  /** The scopes granted, space-separated, if the server said. */
  readonly scope?: string;
  readonly tokenType: string;
}

/** A token endpoint's answer: tokens, or an OAuth error code. */
export type TokenEndpointResult =
  | { readonly ok: true; readonly tokens: OAuthTokenSet }
  | {
      readonly ok: false;
      /** The OAuth error code, e.g. `authorization_pending`, `invalid_grant`. */
      readonly error: string;
      readonly description: string | undefined;
      readonly status: number;
    };

/** Shared options for calls to a token endpoint. */
export interface TokenEndpointOptions {
  /** The provider's name for messages. */
  readonly service: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal | undefined;
  /** The clock, for `expiresAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Retry tuning for the POST (tests turn the waits off). */
  readonly http?: Pick<HttpClientOptions, "retry" | "sleep" | "random" | "timeoutMs">;
}

/**
 * POSTs `parameters` (plus the client id, and the secret when there is one) to
 * `tokenUrl` and reads the answer.
 *
 * @param idempotent whether the request may be repeated after a network error: true
 *   for device polling, false for one-time codes and refreshes.
 */
export async function requestTokens(
  tokenUrl: string,
  client: OAuthClient,
  parameters: Readonly<Record<string, string>>,
  options: TokenEndpointOptions & { readonly idempotent: boolean; readonly operation: string },
): Promise<TokenEndpointResult> {
  const http = createHttpClient({
    service: options.service,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...options.http,
  });
  const body = new URLSearchParams({ ...parameters, client_id: client.clientId });
  if (client.clientSecret !== undefined) body.set("client_secret", client.clientSecret);
  const response = await http.request({
    method: "POST",
    url: tokenUrl,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    operation: options.operation,
    // OAuth errors are 400 (RFC 6749 §5.2), some servers use 401 for invalid_client.
    accept: [400, 401],
    idempotent: options.idempotent,
    signal: options.signal,
  });
  const json = await readJson(response, options.service);
  if (!response.ok) {
    const error = stringField(json, "error");
    if (error === undefined) {
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `${options.service}: could not ${options.operation} (HTTP ${response.status}).`,
        { details: { service: options.service, status: response.status } },
      );
    }
    return {
      ok: false,
      error,
      description: stringField(json, "error_description"),
      status: response.status,
    };
  }
  return { ok: true, tokens: tokenSetOf(json, options) };
}

/** The token set in a successful answer. */
function tokenSetOf(json: unknown, options: TokenEndpointOptions): OAuthTokenSet {
  const accessToken = stringField(json, "access_token");
  if (accessToken === undefined) {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `${options.service} answered without an access token.`,
      { details: { service: options.service } },
    );
  }
  const refreshToken = stringField(json, "refresh_token");
  const scope = stringField(json, "scope");
  const expiresIn = numberField(json, "expires_in");
  const now = options.now ?? Date.now;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: now() + expiresIn * 1000 }),
    ...(scope === undefined ? {} : { scope }),
    tokenType: stringField(json, "token_type") ?? "Bearer",
  };
}

async function readJson(response: Response, service: string): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The body may hold tokens, so it is never quoted.
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `${service}'s token endpoint answered HTTP ${response.status} with a body that is not JSON.`,
      { details: { service, status: response.status } },
    );
  }
}

/** A string property of a JSON object. */
export function stringField(json: unknown, name: string): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const value = (json as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A number property of a JSON object; numeric strings count too (some servers send them). */
export function numberField(json: unknown, name: string): number | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const value = (json as Record<string, unknown>)[name];
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}
