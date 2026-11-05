/**
 * A small HTTP client for the storage adapters that talk to a REST API with plain
 * `fetch` (Google Drive, Dropbox): timeouts, cancellation, retries with
 * backoff, OAuth bearer tokens, and failures turned into MongoShieldError codes.
 *
 *   const http = createHttpClient({ service: "Google Drive", auth: tokens });
 *   const response = await http.request({
 *     method: "GET",
 *     url: "https://www.googleapis.com/drive/v3/files/abc?alt=media",
 *     operation: "read backups/…/manifest.json",
 *     accept: [404],
 *     signal,
 *   });
 *
 * What it does, per request:
 * - Timeout: `timeoutMs` (default 60 s) bounds each attempt until the response
 *   HEADERS arrive. The body is not timed, so a large download may take as long as it
 *   needs; the caller's `signal` still cancels it.
 * - Retries (default 5 attempts in all) on 429, 500, 502, 503, 504, network errors and
 *   timeouts, and on responses the adapter's `isRateLimited` recognises (Google
 *   Drive's "rate limit" 403s). Waits honour `Retry-After` (seconds or an HTTP date);
 *   otherwise exponential backoff with full jitter: random(0, min(maxDelay, base × 2ⁿ)).
 *   A `Retry-After` longer than `maxRetryAfterMs` (2 min) is not waited out: the
 *   request fails at once, saying when to try again. Requests that are not idempotent
 *   (POST and PATCH unless `idempotent: true`) are only retried when the server
 *   promises it did nothing (429, 503, rate limits), never after a network error or a
 *   timeout, where the first attempt may have taken effect.
 * - Auth: with `auth`, every attempt carries `Authorization: Bearer <token>`. A 401 gets
 *   one fresh token (`forceRefresh`) and one more try.
 * - Errors: 404/410 → MS_STORAGE_NOT_FOUND, 401/403 → MS_STORAGE_FORBIDDEN, 409/412 →
 *   MS_STORAGE_PRECONDITION_FAILED, 507 → MS_STORAGE_INSUFFICIENT_SPACE, anything else
 *   (and exhausted retries) → MS_STORAGE_IO; `classifyError` overrides this per
 *   provider (Dropbox puts every endpoint error in a 409, Drive reports a full quota as
 *   a 403). A caller's abort → MS_ABORTED (or MS_TIMEOUT for a timeout signal).
 * - Secrets: messages name the service, the `operation` and the status, never the
 *   URL (query strings can carry tokens) or a header. The provider's error text is
 *   included only after every token this client sent is replaced with `***`.
 */

import { setTimeout as sleepFor } from "node:timers/promises";
import { abortError, type ErrorCode, MongoShieldError } from "../../errors.ts";
import { redactSecrets } from "../../redact.ts";

/** Retry tuning. The defaults suit interactive-rate APIs with per-user quotas. */
export interface HttpRetryOptions {
  /** Attempts in all, the first included. Default 5. `1` turns retries off. */
  readonly maxAttempts?: number;
  /** The first backoff window in milliseconds. Default 500. */
  readonly baseDelayMs?: number;
  /** The largest backoff window in milliseconds. Default 30 000. */
  readonly maxDelayMs?: number;
  /** The longest `Retry-After` that is waited out, in milliseconds. Default 120 000. */
  readonly maxRetryAfterMs?: number;
}

/** A failed response, as the classification hooks see it. */
export interface HttpErrorResponse {
  readonly status: number;
  readonly headers: Headers;
  /** The start of the body (at most 64 KiB), as text. */
  readonly bodyText: string;
  /** `bodyText` parsed as JSON, or `undefined` when it is not JSON. */
  readonly json: unknown;
}

/** Where bearer tokens come from (an OAuth access-token source, see oauth/refresh.ts). */
export interface HttpAuth {
  /**
   * A valid access token. `forceRefresh` asks for a new one even if the cached one
   * looks valid (the server just answered 401).
   */
  getAccessToken(options?: {
    readonly signal?: AbortSignal | undefined;
    readonly forceRefresh?: boolean;
  }): Promise<string>;
}

/** Options for {@link createHttpClient}. */
export interface HttpClientOptions {
  /** The service's name in messages, e.g. `"Google Drive"`. */
  readonly service: string;
  /** Adds `Authorization: Bearer …` to every request. */
  readonly auth?: HttpAuth;
  /**
   * The hint for 401/403 failures, e.g. "Run `mongoshield login gdrive` again and
   * update MONGOSHIELD_GDRIVE_TOKEN." Without one a generic hint is used.
   */
  readonly authHint?: string;
  /** Per-attempt timeout until the response headers arrive. Default 60 000 ms. */
  readonly timeoutMs?: number;
  readonly retry?: HttpRetryOptions;
  /** True for provider-specific "slow down" answers that are not a 429 (Drive's 403s). */
  readonly isRateLimited?: (response: HttpErrorResponse) => boolean;
  /** The error code for a failed response, overriding the status mapping (see the header). */
  readonly classifyError?: (response: HttpErrorResponse) => ErrorCode | undefined;
  /**
   * The provider's own explanation for a failure, for the message. Defaults to the
   * usual JSON shapes (`error.message`, `error_description`, `error_summary`, `message`).
   */
  readonly errorDetail?: (response: HttpErrorResponse) => string | undefined;
  /** The `fetch` to use. Defaults to the global one (tests inject fakes). */
  readonly fetch?: typeof fetch;
  /** Waits between retries; injectable so tests do not sleep. Must reject on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** Source of jitter in [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
  /** The clock, for HTTP-date `Retry-After` values. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** One request. */
export interface HttpRequest {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The full URL. Never shown in messages. */
  readonly url: string | URL;
  readonly headers?: Readonly<Record<string, string>>;
  /** A body that can be sent again on a retry. Stream large uploads in chunks (chunks.ts). */
  readonly body?: string | Uint8Array | URLSearchParams;
  /** What the request does, safe to show: `"upload backups/…/manifest.json"`. */
  readonly operation: string;
  /** Non-2xx statuses to return instead of throwing, e.g. `[404]` for a lookup, `[308]`. */
  readonly accept?: readonly number[];
  /** May the request be sent twice? Default: yes, except POST and PATCH. */
  readonly idempotent?: boolean;
  /** Overrides the client's per-attempt timeout (large chunk uploads need more). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
}

/** What {@link createHttpClient} returns. */
export interface HttpClient {
  /** Sends a request (with retries); resolves with a 2xx or an `accept`ed response. */
  request(request: HttpRequest): Promise<Response>;
  /** Like `request`, then parses the body as JSON (`undefined` for an empty body). */
  requestJson(request: HttpRequest): Promise<unknown>;
}

/** Defaults; see {@link HttpRetryOptions} and {@link HttpClientOptions}. */
export const HTTP_DEFAULTS = {
  timeoutMs: 60_000,
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
} as const;

/** How much of an error body is read: enough for any JSON error, little memory. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** How much of the provider's error text goes into a message. */
const MAX_DETAIL_LENGTH = 300;

/** Statuses that mean "try again later" for any request. */
const RETRY_ANY = new Set([429, 503]);

/** Statuses that are worth retrying for idempotent requests only (the server may have acted). */
const RETRY_IDEMPOTENT = new Set([500, 502, 504]);

/** Creates a client; see the file header. */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const retry = {
    maxAttempts: Math.max(1, options.retry?.maxAttempts ?? HTTP_DEFAULTS.maxAttempts),
    baseDelayMs: options.retry?.baseDelayMs ?? HTTP_DEFAULTS.baseDelayMs,
    maxDelayMs: options.retry?.maxDelayMs ?? HTTP_DEFAULTS.maxDelayMs,
    maxRetryAfterMs: options.retry?.maxRetryAfterMs ?? HTTP_DEFAULTS.maxRetryAfterMs,
  };
  // Every bearer token this client sent, so provider messages that echo one are scrubbed.
  const sentTokens = new Set<string>();

  async function request(input: HttpRequest): Promise<Response> {
    const { signal } = input;
    const idempotent = input.idempotent ?? (input.method !== "POST" && input.method !== "PATCH");
    let refreshedAfter401 = false;

    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      const headers = new Headers(input.headers);
      if (options.auth !== undefined) {
        const token = await options.auth.getAccessToken({
          signal,
          forceRefresh: refreshedAfter401,
        });
        sentTokens.add(token);
        headers.set("authorization", `Bearer ${token}`);
      }

      const outcome = await sendOnce(input, headers);
      const isLast = attempt >= retry.maxAttempts;

      if (outcome.kind === "network") {
        if (!idempotent || isLast) throw networkError(input, outcome, attempt);
        await wait(backoffDelay(attempt), signal);
        continue;
      }

      const response = outcome.response;
      if (response.ok || input.accept?.includes(response.status)) return response;

      const failure = await errorResponseOf(response);
      // A 401 usually means the cached access token expired early: refresh once.
      if (response.status === 401 && options.auth !== undefined && !refreshedAfter401) {
        refreshedAfter401 = true;
        continue;
      }
      const retryable =
        RETRY_ANY.has(response.status) ||
        (idempotent && RETRY_IDEMPOTENT.has(response.status)) ||
        options.isRateLimited?.(failure) === true;
      if (!retryable || isLast) throw responseError(input, failure, attempt);

      const retryAfter = retryAfterMs(response.headers.get("retry-after"), now());
      if (retryAfter !== undefined && retryAfter > retry.maxRetryAfterMs) {
        throw responseError(input, failure, attempt, retryAfter);
      }
      await wait(retryAfter ?? backoffDelay(attempt), signal);
    }
  }

  /** Sleeps between attempts; an abort during the wait becomes MS_ABORTED / MS_TIMEOUT. */
  async function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await sleep(ms, signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal);
      throw error;
    }
  }

  /** One attempt: the response, or why there was none. */
  async function sendOnce(
    input: HttpRequest,
    headers: Headers,
  ): Promise<
    | { kind: "response"; response: Response }
    | { kind: "network"; error: unknown; timedOut: boolean }
  > {
    const timeout = new AbortController();
    const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? HTTP_DEFAULTS.timeoutMs;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    // AbortSignal.any holds its sources weakly, so a long-lived caller signal does not
    // collect one listener per request.
    const signal =
      input.signal === undefined ? timeout.signal : AbortSignal.any([input.signal, timeout.signal]);
    try {
      const response = await fetchImpl(input.url, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: input.body }),
        signal,
      });
      return { kind: "response", response };
    } catch (error) {
      if (input.signal?.aborted) throw abortError(input.signal);
      return { kind: "network", error, timedOut: timeout.signal.aborted };
    } finally {
      // Only the wait for the headers is timed; the body may take as long as it needs.
      clearTimeout(timer);
    }
  }

  /** Full jitter: a random wait in [0, min(maxDelay, base × 2^(attempt-1))). */
  function backoffDelay(attempt: number): number {
    const window = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(random() * window);
  }

  /** The error for a failed response, with the provider's (scrubbed) explanation. */
  function responseError(
    input: HttpRequest,
    failure: HttpErrorResponse,
    attempts: number,
    retryAfter?: number,
  ): MongoShieldError {
    const code = options.classifyError?.(failure) ?? codeForStatus(failure.status);
    const detail = scrub((options.errorDetail ?? defaultErrorDetail)(failure));
    const rateLimited = RETRY_ANY.has(failure.status) || options.isRateLimited?.(failure) === true;
    const message =
      `${options.service}: could not ${input.operation} (HTTP ${failure.status}` +
      `${detail === undefined ? "" : `: ${detail}`}).` +
      (attempts > 1 ? ` Tried ${attempts} times.` : "");
    return new MongoShieldError(code, message, {
      hint: hintFor(code, rateLimited, retryAfter),
      details: {
        service: options.service,
        status: failure.status,
        attempts,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
      },
    });
  }

  /** The error when no response arrived (DNS, refused connection, reset, timeout). */
  function networkError(
    input: HttpRequest,
    outcome: { error: unknown; timedOut: boolean },
    attempts: number,
  ): MongoShieldError {
    const code = networkCode(outcome.error);
    const reason = outcome.timedOut
      ? "timed out"
      : code === ""
        ? "network error"
        : `network error ${code}`;
    return new MongoShieldError(
      "MS_STORAGE_IO",
      `${options.service}: could not ${input.operation} (${reason}).` +
        (attempts > 1 ? ` Tried ${attempts} times.` : ""),
      {
        // The cause is kept for --verbose; fetch errors carry no URL or header.
        cause: outcome.error,
        hint: `Check the network connection to ${options.service}, then try again.`,
        details: { service: options.service, attempts, timedOut: outcome.timedOut },
      },
    );
  }

  /** The hint for an error code. */
  function hintFor(code: ErrorCode, rateLimited: boolean, retryAfter?: number): string {
    if (retryAfter !== undefined) {
      return `${options.service} asked to wait ${Math.ceil(retryAfter / 1000)} s before retrying; run the backup again later.`;
    }
    if (rateLimited) {
      return `${options.service} is limiting requests. Try again later, or use your own OAuth client id (MONGOSHIELD_<PROVIDER>_CLIENT_ID) for a quota of your own.`;
    }
    switch (code) {
      case "MS_STORAGE_FORBIDDEN":
        return options.authHint ?? `Check that the credentials for ${options.service} are valid.`;
      case "MS_STORAGE_INSUFFICIENT_SPACE":
        return `Free up space in ${options.service} (empty its trash too), or use a larger quota.`;
      default:
        return `Try again; if it keeps failing, check ${options.service}'s status page.`;
    }
  }

  function scrub(text: string | undefined): string | undefined {
    if (text === undefined) return undefined;
    const clean = redactSecrets(text, [...sentTokens])
      .replace(/\s+/g, " ")
      .trim();
    if (clean === "") return undefined;
    return clean.length > MAX_DETAIL_LENGTH ? `${clean.slice(0, MAX_DETAIL_LENGTH)}…` : clean;
  }

  return {
    request,
    async requestJson(input) {
      const response = await request(input);
      const text = await response.text();
      if (text.trim() === "") return undefined;
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new MongoShieldError(
          "MS_STORAGE_IO",
          `${options.service}: could not ${input.operation} (the response was not JSON).`,
          { cause: error, details: { service: options.service, status: response.status } },
        );
      }
    },
  };
}

/** The error code for an HTTP status (see the file header). */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
    case 403:
      return "MS_STORAGE_FORBIDDEN";
    case 404:
    case 410:
      return "MS_STORAGE_NOT_FOUND";
    case 409:
    case 412:
      return "MS_STORAGE_PRECONDITION_FAILED";
    case 507:
      return "MS_STORAGE_INSUFFICIENT_SPACE";
    default:
      return "MS_STORAGE_IO";
  }
}

/**
 * A `Retry-After` header in milliseconds: delta-seconds (`120`) or an HTTP date
 * (`Wed, 21 Oct 2026 07:28:00 GMT`). `undefined` when absent or unreadable.
 */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

/** Reads the start of a failed response's body and parses it if it is JSON. */
async function errorResponseOf(response: Response): Promise<HttpErrorResponse> {
  const bodyText = await readBoundedText(response, MAX_ERROR_BODY_BYTES);
  let json: unknown;
  try {
    json = bodyText === "" ? undefined : (JSON.parse(bodyText) as unknown);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, bodyText, json };
}

/** At most `limit` bytes of the body as UTF-8 text; the rest is discarded unread. */
async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
  } catch {
    // A body that breaks off still leaves the status to report.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/**
 * The provider's explanation from the common JSON error shapes: Google and Graph
 * (`{ error: { message, code } }`), OAuth (`{ error, error_description }`), Dropbox
 * (`{ error_summary }`) and plain `{ message }`.
 */
export function defaultErrorDetail(response: HttpErrorResponse): string | undefined {
  const body = response.json;
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof record.error_description === "string") return record.error_description;
  if (typeof record.error_summary === "string") return record.error_summary;
  if (typeof error === "string") return error;
  if (typeof record.message === "string") return record.message;
  return undefined;
}

/** `ECONNREFUSED`-style code of a fetch failure (undici puts it on `cause`), or "". */
function networkCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" ? `(${code})` : "";
}

/** The default sleep: setTimeout that rejects when the signal fires. */
async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await sleepFor(ms, undefined, signal === undefined ? {} : { signal });
}
