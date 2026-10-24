/**
 * Tests for the typed API client: URLs and path parameters, the CSRF header, mapping
 * error responses to typed exceptions, and job event streams with reconnect.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobEvent, SessionInfo } from "../shared/api.ts";
import {
  ApiClient,
  ConflictError,
  type EventStreamHandlers,
  type FetchLike,
  ForbiddenError,
  type HttpRequestInit,
  NetworkError,
  NotFoundError,
  parseJobEvent,
  ServerError,
  type StreamState,
  UnauthorizedError,
  ValidationError,
} from "./api.ts";

/** A fetch that records requests and answers from a queue of `[status, body]`. */
function fakeFetch(responses: [number, unknown][]) {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = responses.shift() ?? [200, {}];
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { status, text: async () => text };
  };
  return { fetch, calls };
}

const SESSION: SessionInfo = {
  setupComplete: true,
  authMethods: ["password"],
  csrfToken: "csrf-123",
  user: {
    id: "u1",
    username: "admin",
    role: "admin",
    signIn: "password",
    createdAt: "2026-01-01T00:00:00Z",
  },
};

describe("ApiClient.call", () => {
  it("fills path parameters (URL-encoded) and appends query parameters, skipping undefined ones", async () => {
    const { fetch, calls } = fakeFetch([[200, { documents: [] }]]);
    const client = new ApiClient({ fetch });
    await client.call("GET /api/storage/:id/backups/:backupId/documents", undefined, {
      params: { id: "s3 main", backupId: "2026-10-21T02-00-04Z_7f3a9c" },
      query: { ns: "shop.users", limit: 20, after: undefined },
    });
    expect(calls[0]?.url).toBe(
      "/api/storage/s3%20main/backups/2026-10-21T02-00-04Z_7f3a9c/documents?ns=shop.users&limit=20",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("sends JSON bodies with a content type", async () => {
    const { fetch, calls } = fakeFetch([[200, SESSION]]);
    const client = new ApiClient({ fetch });
    await client.call("POST /api/session", { username: "admin", password: "pw" });
    expect(calls[0]?.init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.init.body ?? "")).toEqual({ username: "admin", password: "pw" });
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  it("remembers the CSRF token from a session response and sends it only on state-changing requests", async () => {
    const { fetch, calls } = fakeFetch([
      [200, SESSION],
      [200, []],
      [200, { id: "job-1", kind: "backup", status: "running", startedBy: "admin" }],
    ]);
    const client = new ApiClient({ fetch });
    await client.call("GET /api/session");
    await client.call("GET /api/plans");
    await client.call("POST /api/plans/:id/run", undefined, { params: { id: "p1" } });
    expect(calls[1]?.init.headers["x-csrf-token"]).toBeUndefined();
    expect(calls[2]?.init.headers["x-csrf-token"]).toBe("csrf-123");
  });

  describe("a stale CSRF token", () => {
    const CSRF_REFUSAL = {
      error: { code: "CONSOLE_CSRF", message: "The request is missing a valid CSRF token." },
    };
    const JOB = { id: "job-1", kind: "backup", status: "running", startedBy: "admin" };

    it("is refreshed from the current session and the request retried once", async () => {
      const { fetch, calls } = fakeFetch([
        [200, SESSION],
        [403, CSRF_REFUSAL],
        [200, { ...SESSION, csrfToken: "csrf-new" }],
        [200, JOB],
      ]);
      const client = new ApiClient({ fetch });
      await client.call("GET /api/session");
      const job = await client.call("POST /api/plans/:id/run", undefined, { params: { id: "p1" } });
      expect(job.id).toBe("job-1");
      expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
        "GET /api/session",
        "POST /api/plans/p1/run",
        "GET /api/session",
        "POST /api/plans/p1/run",
      ]);
      expect(calls[3]?.init.headers["x-csrf-token"]).toBe("csrf-new");
    });

    it("is retried only once", async () => {
      const { fetch, calls } = fakeFetch([
        [200, SESSION],
        [403, CSRF_REFUSAL],
        [200, SESSION],
        [403, CSRF_REFUSAL],
      ]);
      const client = new ApiClient({ fetch });
      await client.call("GET /api/session");
      await expect(
        client.call("POST /api/plans/:id/run", undefined, { params: { id: "p1" } }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(calls).toHaveLength(4);
    });

    it("is not retried when the cookie now belongs to someone else; the app signs out instead", async () => {
      const other = {
        ...SESSION,
        csrfToken: "csrf-other",
        user: { ...SESSION.user, username: "eve" },
      };
      const { fetch, calls } = fakeFetch([
        [200, SESSION],
        [403, CSRF_REFUSAL],
        [200, other],
      ]);
      const onUnauthorized = vi.fn();
      const client = new ApiClient({ fetch, onUnauthorized });
      await client.call("GET /api/session");
      await expect(
        client.call("POST /api/plans/:id/run", undefined, { params: { id: "p1" } }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(calls).toHaveLength(3);
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });

    it("does not affect other refusals", async () => {
      const { fetch, calls } = fakeFetch([
        [200, SESSION],
        [403, { error: { code: "CONSOLE_FORBIDDEN", message: "Needs the admin role." } }],
      ]);
      const client = new ApiClient({ fetch });
      await client.call("GET /api/session");
      await expect(
        client.call("POST /api/plans/:id/run", undefined, { params: { id: "p1" } }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(calls).toHaveLength(2);
    });
  });

  it("stops sending the CSRF token after forgetSession()", async () => {
    const { fetch, calls } = fakeFetch([
      [200, SESSION],
      [200, { ok: true }],
    ]);
    const client = new ApiClient({ fetch });
    await client.call("GET /api/session");
    client.forgetSession();
    await client.call("DELETE /api/session");
    expect(calls[1]?.init.headers["x-csrf-token"]).toBeUndefined();
  });

  it.each([
    [400, ValidationError],
    [422, ValidationError],
    [403, ForbiddenError],
    [404, NotFoundError],
    [409, ConflictError],
    [500, ServerError],
    [503, ServerError],
  ])(
    "maps HTTP %i to a typed error carrying the server's code, message and hint",
    async (status, ErrorClass) => {
      const { fetch } = fakeFetch([
        [status, { error: { code: "MS_EXAMPLE", message: "It broke.", hint: "Fix it." } }],
      ]);
      const client = new ApiClient({ fetch });
      const error = await client.call("GET /api/plans").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ErrorClass);
      expect(error).toMatchObject({
        status,
        code: "MS_EXAMPLE",
        message: "It broke.",
        hint: "Fix it.",
      });
    },
  );

  it("reports a generic code when the error body is not an ApiError", async () => {
    const { fetch } = fakeFetch([[502, "<html>Bad gateway</html>"]]);
    const client = new ApiClient({ fetch });
    await expect(client.call("GET /api/plans")).rejects.toMatchObject({
      code: "CONSOLE_HTTP_502",
      status: 502,
    });
  });

  it("calls onUnauthorized for a 401 on normal routes, but not for a failed login", async () => {
    const onUnauthorized = vi.fn();
    const body = { error: { code: "CONSOLE_UNAUTHENTICATED", message: "Sign in." } };
    const { fetch } = fakeFetch([
      [401, body],
      [401, body],
    ]);
    const client = new ApiClient({ fetch, onUnauthorized });
    await expect(client.call("GET /api/plans")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(
      client.call("POST /api/session", { username: "a", password: "b" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("wraps transport failures in NetworkError", async () => {
    const client = new ApiClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(client.call("GET /api/plans")).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("parseJobEvent", () => {
  it("accepts the three event types and ignores anything else", () => {
    expect(parseJobEvent('{"type":"log","level":"info","message":"hi"}')).toEqual({
      type: "log",
      level: "info",
      message: "hi",
    });
    expect(
      parseJobEvent('{"type":"progress","documents":1,"estimatedDocuments":2,"bytes":3}'),
    ).toMatchObject({ type: "progress" });
    expect(parseJobEvent('{"type":"heartbeat"}')).toBeUndefined();
    expect(parseJobEvent("not json")).toBeUndefined();
  });
});

describe("ApiClient.subscribeToJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A controllable EventSource factory: records each opened stream's handlers. */
  function fakeStreams() {
    const opened: { url: string; handlers: EventStreamHandlers; closed: boolean }[] = [];
    const openEventSource = (url: string, handlers: EventStreamHandlers) => {
      const entry = { url, handlers, closed: false };
      opened.push(entry);
      return { close: () => (entry.closed = true) };
    };
    return { opened, openEventSource };
  }

  it("delivers parsed events and closes the stream when the job finishes", () => {
    const { opened, openEventSource } = fakeStreams();
    const client = new ApiClient({ fetch: fakeFetch([]).fetch, openEventSource });
    const events: JobEvent[] = [];
    const states: StreamState[] = [];
    client.subscribeToJob("job 1", {
      onEvent: (event) => events.push(event),
      onStateChange: (state) => states.push(state),
    });

    const stream = opened[0];
    expect(stream?.url).toBe("/api/jobs/job%201/events");
    stream?.handlers.onOpen();
    stream?.handlers.onMessage('{"type":"log","level":"info","message":"started"}');
    stream?.handlers.onMessage(
      JSON.stringify({
        type: "status",
        job: { id: "job 1", kind: "backup", status: "succeeded", startedBy: "admin" },
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["log", "status"]);
    expect(stream?.closed).toBe(true);
    expect(states).toEqual(["connecting", "live", "closed"]);
  });

  it("reopens a closed stream with backoff until unsubscribed", () => {
    vi.useFakeTimers();
    const { opened, openEventSource } = fakeStreams();
    const client = new ApiClient({ fetch: fakeFetch([]).fetch, openEventSource });
    const unsubscribe = client.subscribeToJob("job-1", { onEvent: () => {} });

    opened[0]?.handlers.onError(true);
    expect(opened).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(2);

    // The second failure waits twice as long.
    opened[1]?.handlers.onError(true);
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(opened).toHaveLength(3);

    unsubscribe();
    opened[2]?.handlers.onError(true);
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(3);
    expect(opened[2]?.closed).toBe(true);
  });

  it("leaves retrying to the browser when the stream is not closed", () => {
    vi.useFakeTimers();
    const { opened, openEventSource } = fakeStreams();
    const states: StreamState[] = [];
    const client = new ApiClient({ fetch: fakeFetch([]).fetch, openEventSource });
    client.subscribeToJob("job-1", {
      onEvent: () => {},
      onStateChange: (state) => states.push(state),
    });
    opened[0]?.handlers.onError(false);
    vi.advanceTimersByTime(30_000);
    expect(opened).toHaveLength(1);
    expect(states.at(-1)).toBe("reconnecting");
  });
});
