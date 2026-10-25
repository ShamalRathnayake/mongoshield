/**
 * More tests for the typed API client: every status maps to its error class, error
 * descriptions, the browser EventSource adapter, the default fetch, URL building for GET
 * links, missing path parameters, empty bodies, and late events after unsubscribing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiRequestError,
  browserEventSource,
  buildPath,
  describeError,
  type EventStreamHandlers,
  errorFromResponse,
  type FetchLike,
  isApiErrorBody,
  NetworkError,
  parseJobEvent,
  RateLimitedError,
} from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("errors", () => {
  it("maps 429 and unusual statuses to their classes", () => {
    const error = { code: "X", message: "m" };
    expect(errorFromResponse(429, { error })).toBeInstanceOf(RateLimitedError);
    const teapot = errorFromResponse(418, undefined);
    expect(teapot.constructor).toBe(ApiRequestError);
    expect(teapot.code).toBe("CONSOLE_HTTP_418");
  });

  it("describes API errors with their hint, other errors by message, and anything else as text", () => {
    expect(
      describeError(new ApiRequestError(400, { code: "X", message: "Bad.", hint: "Fix it." })),
    ).toBe("Bad. Fix it.");
    expect(describeError(new ApiRequestError(400, { code: "X", message: "Bad." }))).toBe("Bad.");
    expect(describeError(new Error("Plain."))).toBe("Plain.");
    expect(describeError(42)).toBe("42");
  });

  it("recognises only well-formed error bodies", () => {
    expect(isApiErrorBody({ error: { code: "X", message: "m" } })).toBe(true);
    expect(isApiErrorBody({ error: { code: 1, message: "m" } })).toBe(false);
    expect(isApiErrorBody({ error: null })).toBe(false);
    expect(isApiErrorBody("error")).toBe(false);
  });
});

describe("parseJobEvent", () => {
  it("ignores values that are not objects with a type", () => {
    expect(parseJobEvent("[]")).toBeUndefined();
    expect(parseJobEvent("null")).toBeUndefined();
    expect(parseJobEvent('{"type":"progress","documents":"many"}')).toBeUndefined();
  });
});

describe("URLs", () => {
  it("builds GET links with parameters and query strings", () => {
    const client = new ApiClient({
      fetch: async () => ({ status: 200, text: async () => "" }),
      baseUrl: "/base",
    });
    expect(client.url("GET /api/config/export")).toBe("/base/api/config/export");
    expect(
      client.url("GET /api/storage/:id/backups/:backupId/documents", undefined, {
        params: { id: "s 1", backupId: "b" },
        query: { ns: "a.b", limit: 5, after: undefined },
      }),
    ).toBe("/base/api/storage/s%201/backups/b/documents?ns=a.b&limit=5");
  });

  it("refuses a template with a missing parameter", () => {
    expect(() => buildPath("/api/plans/:id", {}, undefined)).toThrow('Missing path parameter "id"');
  });
});

describe("transport", () => {
  it("uses window.fetch by default and accepts an empty body", async () => {
    const fetch = vi.fn(async () => ({ status: 200, text: async () => "" }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient();
    expect(await client.call("DELETE /api/session")).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("describes transport failures that are not Errors", async () => {
    const fetch: FetchLike = async () => {
      throw "offline";
    };
    const client = new ApiClient({ fetch });
    await expect(client.call("GET /api/session")).rejects.toThrow(
      new NetworkError("Could not reach the console server (offline)."),
    );
  });

  it("drops events that arrive after unsubscribing", () => {
    let handlers: EventStreamHandlers | undefined;
    const client = new ApiClient({
      fetch: async () => ({ status: 200, text: async () => "" }),
      openEventSource: (_url, given) => {
        handlers = given;
        return { close: () => undefined };
      },
    });
    const events: unknown[] = [];
    const unsubscribe = client.subscribeToJob("j", { onEvent: (event) => events.push(event) });
    unsubscribe();
    handlers?.onMessage('{"type":"log","level":"info","message":"late"}');
    handlers?.onError(true);
    expect(events).toEqual([]);
  });
});

describe("browserEventSource", () => {
  it("adapts the browser's EventSource to the handler interface", () => {
    const instances: FakeEventSource[] = [];
    class FakeEventSource {
      static readonly CLOSED = 2;
      readonly url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const seen: string[] = [];
    const handle = browserEventSource("/api/jobs/x/events", {
      onOpen: () => seen.push("open"),
      onMessage: (data) => seen.push(`message:${data}`),
      onError: (closed) => seen.push(`error:${String(closed)}`),
    });
    const source = instances[0];
    source?.onopen?.();
    source?.onmessage?.({ data: "hello" });
    source?.onerror?.();
    if (source !== undefined) source.readyState = FakeEventSource.CLOSED;
    source?.onerror?.();
    handle.close();
    expect(seen).toEqual(["open", "message:hello", "error:false", "error:true"]);
    expect(source?.closed).toBe(true);
    expect(source?.url).toBe("/api/jobs/x/events");
  });
});
