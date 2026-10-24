/**
 * The browser's typed client for the console API (contract: src/shared/api.ts).
 *
 * `client.call("PUT /api/plans/:id", body, { params: { id } })` is checked against
 * `ApiRoutes`: the body, the path parameters and the response type all come from the
 * route string, so the UI cannot call an endpoint the server does not have.
 *
 * The client also:
 * - remembers the CSRF token from every `SessionInfo` it sees and sends it as
 *   `x-csrf-token` on state-changing requests,
 * - turns error responses into typed exceptions (`UnauthorizedError`, `ConflictError`, …),
 * - streams job events over Server-Sent Events with automatic reconnect.
 *
 * The network is injected (`fetch` and an EventSource factory), which is how mock mode
 * (src/ui/mock) and the tests run the exact same client code without a server.
 */

import type {
  ApiError,
  ApiRoutes,
  JobEvent,
  JobStatus,
  JobSummary,
  SessionInfo,
} from "../shared/api.ts";

// ---------------------------------------------------------------------------
// Route typing
// ---------------------------------------------------------------------------

/** Every route key, e.g. `"GET /api/plans"`. */
export type RouteKey = keyof ApiRoutes;

/** The JSON body a route expects (`undefined` for routes without a body). */
export type RequestOf<Route extends RouteKey> = ApiRoutes[Route]["request"];

/** The JSON body a route returns. */
export type ResponseOf<Route extends RouteKey> = ApiRoutes[Route]["response"];

/** `"GET /api/plans/:id"` → `"/api/plans/:id"`. */
type PathOf<Route extends string> = Route extends `${string} ${infer Path}` ? Path : never;

/** `"/api/storage/:id/backups/:backupId"` → `"id" | "backupId"`. */
type ParamNames<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | ParamNames<Rest>
  : Path extends `${string}:${infer Param}`
    ? Param
    : never;

/** The path parameter names of a route (`never` when it has none). */
export type ParamsOf<Route extends RouteKey> = ParamNames<PathOf<Route>>;

/** Query string values; `undefined` entries are left out. */
export type QueryValues = Readonly<Record<string, string | number | undefined>>;

/** Options every call accepts. */
interface BaseCallOptions {
  readonly query?: QueryValues;
  readonly signal?: AbortSignal;
}

/** Call options; `params` is required exactly when the route has path parameters. */
export type CallOptions<Route extends RouteKey> = [ParamsOf<Route>] extends [never]
  ? BaseCallOptions
  : BaseCallOptions & { readonly params: Readonly<Record<ParamsOf<Route>, string>> };

/**
 * The arguments after the route string:
 * - routes with path parameters: `(body, { params })` (body may be `undefined`),
 * - routes without a body: `()` or `(undefined, options)`,
 * - routes with a body: `(body, options?)`.
 */
export type CallArgs<Route extends RouteKey> = [ParamsOf<Route>] extends [never]
  ? RequestOf<Route> extends undefined
    ? [body?: undefined, options?: CallOptions<Route>]
    : [body: RequestOf<Route>, options?: CallOptions<Route>]
  : [body: RequestOf<Route>, options: CallOptions<Route>];

/** What `call` needs from the arguments once their route-specific types have been checked. */
type UntypedCallArgs = readonly [
  body?: unknown,
  options?: BaseCallOptions & { readonly params?: Readonly<Record<string, string>> },
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A request that reached the server and failed with an `ApiError` body (or no usable body). */
export class ApiRequestError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** `MS_…` or `CONSOLE_…` code from the server, or `CONSOLE_HTTP_<status>` if it sent none. */
  readonly code: string;
  /** How to fix it, when the server knows. */
  readonly hint: string | undefined;

  constructor(status: number, error: ApiError["error"]) {
    super(error.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = error.code;
    this.hint = error.hint;
  }
}

/** 401: not signed in, or the session expired. The app sends the user to the login page. */
export class UnauthorizedError extends ApiRequestError {
  override readonly name = "UnauthorizedError";
}

/** 403: signed in, but the role does not allow this (or the CSRF token was rejected). */
export class ForbiddenError extends ApiRequestError {
  override readonly name = "ForbiddenError";
}

/** 404: the resource does not exist (any more). */
export class NotFoundError extends ApiRequestError {
  override readonly name = "NotFoundError";
}

/** 409: the request conflicts with current state, e.g. a job is already running. */
export class ConflictError extends ApiRequestError {
  override readonly name = "ConflictError";
}

/** 400 / 422: the request body or query was invalid. The message says which field. */
export class ValidationError extends ApiRequestError {
  override readonly name = "ValidationError";
}

/** 429: too many attempts (login is rate-limited). */
export class RateLimitedError extends ApiRequestError {
  override readonly name = "RateLimitedError";
}

/** 5xx: the server failed. */
export class ServerError extends ApiRequestError {
  override readonly name = "ServerError";
}

/** The request never got an HTTP response (offline, DNS, server down, aborted). */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
}

/** True when `value` has the `ApiError` shape. Bodies come from the network, so check. */
export function isApiErrorBody(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error: unknown = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string"
  );
}

/** Maps an HTTP status and response body to the matching typed exception. */
export function errorFromResponse(status: number, body: unknown): ApiRequestError {
  const error: ApiError["error"] = isApiErrorBody(body)
    ? body.error
    : { code: `CONSOLE_HTTP_${status}`, message: `The server answered with HTTP ${status}.` };
  if (status === 401) return new UnauthorizedError(status, error);
  if (status === 403) return new ForbiddenError(status, error);
  if (status === 404) return new NotFoundError(status, error);
  if (status === 409) return new ConflictError(status, error);
  if (status === 400 || status === 422) return new ValidationError(status, error);
  if (status === 429) return new RateLimitedError(status, error);
  if (status >= 500) return new ServerError(status, error);
  return new ApiRequestError(status, error);
}

/** A one-line description of any thrown value, for toasts and inline errors. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// Transport (injected so mock mode and tests can replace the network)
// ---------------------------------------------------------------------------

/** The part of a fetch `Response` the client reads. */
export interface HttpResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

/** The part of `RequestInit` the client sends. */
export interface HttpRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly credentials: "same-origin";
  readonly signal?: AbortSignal;
}

/** `window.fetch`, or anything that behaves like it for JSON requests. */
export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponseLike>;

/** Callbacks an event stream reports to. `closed` is true when it will not retry by itself. */
export interface EventStreamHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onError(closed: boolean): void;
}

/** Opens a Server-Sent Events stream. Returns a handle to close it. */
export type EventSourceFactory = (url: string, handlers: EventStreamHandlers) => { close(): void };

/** The real browser `EventSource`, adapted to `EventSourceFactory`. */
export const browserEventSource: EventSourceFactory = (url, handlers) => {
  const source = new EventSource(url);
  source.onopen = () => handlers.onOpen();
  source.onmessage = (event) => handlers.onMessage(String(event.data));
  source.onerror = () => handlers.onError(source.readyState === EventSource.CLOSED);
  return { close: () => source.close() };
};

// ---------------------------------------------------------------------------
// Job event streams
// ---------------------------------------------------------------------------

/** Job states after which no more events come. */
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

/** True when the job has finished (successfully or not). */
export function isJobFinished(job: Pick<JobSummary, "status">): boolean {
  return FINISHED_JOB_STATUSES.includes(job.status);
}

/** Connection state of a job event stream, shown next to live progress. */
export type StreamState = "connecting" | "live" | "reconnecting" | "closed";

/** What `subscribeToJob` reports. */
export interface JobSubscriptionHandlers {
  onEvent(event: JobEvent): void;
  onStateChange?(state: StreamState): void;
}

/**
 * Parses one SSE `data` payload. Returns undefined for anything that is not a JobEvent
 * (a newer server may send event types this UI does not know; those are ignored).
 */
export function parseJobEvent(data: string): JobEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  if (value.type === "status" && "job" in value && typeof value.job === "object") {
    return value as JobEvent;
  }
  if (value.type === "progress" && "documents" in value && typeof value.documents === "number") {
    return value as JobEvent;
  }
  if (value.type === "log" && "message" in value && typeof value.message === "string") {
    return value as JobEvent;
  }
  return undefined;
}

/** Reconnect delays after the stream closes: 1 s, 2 s, 4 s … capped at 15 s. */
function reconnectDelayMs(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** attempt);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Everything the client needs from its environment. */
export interface ApiClientOptions {
  /** Defaults to `window.fetch`. */
  readonly fetch?: FetchLike;
  /** Defaults to the browser's `EventSource`. */
  readonly openEventSource?: EventSourceFactory;
  /** Prefix for every URL; empty when the UI is served by the console itself. */
  readonly baseUrl?: string;
  /** Called when a request fails with 401 so the app can show the login page. */
  readonly onUnauthorized?: () => void;
}

/** Methods that never change state and therefore need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Typed access to every console endpoint. One instance per page load. */
export class ApiClient {
  private csrfToken: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly openEventSource: EventSourceFactory;
  private readonly baseUrl: string;
  /** Replaceable after construction because the app wires it up once React has mounted. */
  onUnauthorized: (() => void) | undefined;

  constructor(options: ApiClientOptions = {}) {
    // `fetch` must be called with `window` as `this`, hence the wrapper.
    this.fetchImpl = options.fetch ?? ((url, init) => window.fetch(url, init));
    this.openEventSource = options.openEventSource ?? browserEventSource;
    this.baseUrl = options.baseUrl ?? "";
    this.onUnauthorized = options.onUnauthorized;
  }

  /** Stores the CSRF token from a session response (login, setup, `GET /api/session`). */
  rememberSession(session: SessionInfo): void {
    this.csrfToken = session.csrfToken;
  }

  /** Forgets the CSRF token, e.g. after logging out. */
  forgetSession(): void {
    this.csrfToken = undefined;
  }

  /**
   * Calls one endpoint and returns its typed JSON response.
   *
   * @throws ApiRequestError (or a subclass) for error responses, NetworkError when no
   *   response arrived.
   */
  async call<Route extends RouteKey>(
    route: Route,
    ...args: CallArgs<Route>
  ): Promise<ResponseOf<Route>> {
    const [body, options]: UntypedCallArgs = args;
    const [method, pathTemplate] = splitRoute(route);
    const url = this.baseUrl + buildPath(pathTemplate, options?.params, options?.query);

    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (!SAFE_METHODS.has(method) && this.csrfToken !== undefined) {
      headers["x-csrf-token"] = this.csrfToken;
    }

    let response: HttpResponseLike;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: "same-origin",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw new NetworkError(
        `Could not reach the console server (${error instanceof Error ? error.message : String(error)}).`,
      );
    }

    const text = await response.text();
    const parsed = parseJsonOrUndefined(text);
    if (response.status < 200 || response.status >= 300) {
      const error = errorFromResponse(response.status, parsed);
      // A 401 on the session endpoints is a normal "please log in", not an expiry.
      if (error instanceof UnauthorizedError && !pathTemplate.startsWith("/api/session")) {
        this.onUnauthorized?.();
      }
      throw error;
    }
    if (isSessionInfo(parsed)) this.rememberSession(parsed);
    // The server is the other half of a shared, type-checked contract (src/shared/api.ts),
    // so its JSON is trusted to have the declared shape.
    return parsed as ResponseOf<Route>;
  }

  /** The URL of a GET route, e.g. for links that download a file. */
  url<Route extends RouteKey>(route: Route, ...args: CallArgs<Route>): string {
    const [, options]: UntypedCallArgs = args;
    const [, pathTemplate] = splitRoute(route);
    return this.baseUrl + buildPath(pathTemplate, options?.params, options?.query);
  }

  /**
   * Streams a job's events (`GET /api/jobs/:id/events`). When the stream drops it is
   * reopened with backoff until the job reports a finished status. Returns `unsubscribe`.
   */
  subscribeToJob(jobId: string, handlers: JobSubscriptionHandlers): () => void {
    const url = `${this.baseUrl}/api/jobs/${encodeURIComponent(jobId)}/events`;
    let attempt = 0;
    let stopped = false;
    let stream: { close(): void } | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const setState = (state: StreamState) => handlers.onStateChange?.(state);
    const stop = () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      stream?.close();
      setState("closed");
    };

    const open = () => {
      if (stopped) return;
      setState(attempt === 0 ? "connecting" : "reconnecting");
      stream = this.openEventSource(url, {
        onOpen: () => {
          attempt = 0;
          setState("live");
        },
        onMessage: (data) => {
          const event = parseJobEvent(data);
          if (event === undefined || stopped) return;
          handlers.onEvent(event);
          // A finished job sends nothing more; closing stops the browser's own retries.
          if (event.type === "status" && isJobFinished(event.job)) stop();
        },
        onError: (closed) => {
          if (stopped) return;
          if (!closed) {
            // The browser is already retrying on its own.
            setState("reconnecting");
            return;
          }
          stream?.close();
          setState("reconnecting");
          retryTimer = setTimeout(open, reconnectDelayMs(attempt));
          attempt += 1;
        },
      });
    };

    open();
    return stop;
  }
}

/** `"PUT /api/plans/:id"` → `["PUT", "/api/plans/:id"]`. */
function splitRoute(route: string): [string, string] {
  const space = route.indexOf(" ");
  return [route.slice(0, space), route.slice(space + 1)];
}

/** Fills `:name` segments from `params` (URL-encoded) and appends the query string. */
export function buildPath(
  template: string,
  params: Readonly<Record<string, string>> | undefined,
  query: QueryValues | undefined,
): string {
  const path = template.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${template}.`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const queryString = search.toString();
  return queryString === "" ? path : `${path}?${queryString}`;
}

function parseJsonOrUndefined(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Session responses are recognised by shape, wherever they come from. */
function isSessionInfo(value: unknown): value is SessionInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    "setupComplete" in value &&
    typeof value.setupComplete === "boolean" &&
    "authMethods" in value
  );
}
