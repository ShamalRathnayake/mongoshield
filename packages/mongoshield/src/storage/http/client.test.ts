/**
 * Tests for the fetch wrapper of the REST adapters (client.ts), against a local fake
 * server: retries and their waits, Retry-After, timeouts, cancellation, bearer tokens
 * and the 401 refresh, the status → error code mapping, and that no token or URL
 * ever reaches an error.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeHttpServer,
  type FakeResponse,
  type RecordedRequest,
  startFakeHttpServer,
} from "../../../test/helpers/fake-http-server.ts";
import { isMongoShieldError } from "../../errors.ts";
import {
  codeForStatus,
  createHttpClient,
  defaultErrorDetail,
  type HttpClientOptions,
  retryAfterMs,
} from "./client.ts";

let server: FakeHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Starts a server answering with `answers` in turn (the last one repeats). */
async function serve(
  ...answers: (FakeResponse | ((request: RecordedRequest) => FakeResponse))[]
): Promise<FakeHttpServer> {
  let index = 0;
  server = await startFakeHttpServer((request) => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 200 };
    index += 1;
    return typeof answer === "function" ? answer(request) : answer;
  });
  return server;
}

/** A client whose waits are recorded instead of slept. */
function client(overrides: Partial<HttpClientOptions> = {}) {
  const waits: number[] = [];
  const http = createHttpClient({
    service: "Test Drive",
    sleep: async (ms) => {
      waits.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { http, waits };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("createHttpClient", () => {
  it("returns 2xx responses and statuses the caller accepts", async () => {
    const fake = await serve({ status: 200, json: { ok: true } }, { status: 404 });
    const { http } = client();
    expect(
      await http.requestJson({ method: "GET", url: `${fake.url}/a`, operation: "read a" }),
    ).toEqual({
      ok: true,
    });
    const missing = await http.request({
      method: "GET",
      url: `${fake.url}/b`,
      operation: "read b",
      accept: [404],
    });
    expect(missing.status).toBe(404);
  });

  it("retries 429, 5xx and network errors with exponential backoff and jitter", async () => {
    const fake = await serve(
      { status: 503 },
      { status: 500 },
      { destroy: true },
      { status: 429 },
      { status: 200, body: "done" },
    );
    const { http, waits } = client();
    const response = await http.request({ method: "GET", url: fake.url, operation: "read" });
    expect(await response.text()).toBe("done");
    expect(fake.requests).toHaveLength(5);
    // random() = 0.5 → half of 500, 1000, 2000, 4000 ms.
    expect(waits).toEqual([250, 500, 1000, 2000]);
  });

  it("caps the backoff window at maxDelayMs", async () => {
    const fake = await serve({ status: 503 });
    const { http, waits } = client({
      random: () => 0.999,
      retry: { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 3000 },
    });
    await failure(http.request({ method: "GET", url: fake.url, operation: "read" }));
    expect(waits).toEqual([999, 1998, 2997, 2997, 2997]);
  });

  it("honours Retry-After in seconds and as an HTTP date", async () => {
    const now = Date.parse("2026-11-05T10:00:00Z");
    const fake = await serve(
      { status: 429, headers: { "retry-after": "3" } },
      { status: 503, headers: { "retry-after": "Thu, 05 Nov 2026 10:00:07 GMT" } },
      { status: 200 },
    );
    const { http, waits } = client({ now: () => now });
    await http.request({ method: "GET", url: fake.url, operation: "read" });
    expect(waits).toEqual([3000, 7000]);
  });

  it("does not wait out a Retry-After longer than maxRetryAfterMs, and says when to retry", async () => {
    const fake = await serve({ status: 429, headers: { "retry-after": "3600" } });
    const { http, waits } = client();
    const error = await failure(
      http.request({ method: "GET", url: fake.url, operation: "list files" }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(waits).toEqual([]);
    expect(isMongoShieldError(error) && error.hint).toContain("wait 3600 s");
    expect(isMongoShieldError(error) && error.details).toMatchObject({ retryAfterMs: 3_600_000 });
  });

  it("retries provider rate-limit answers the adapter recognises (Drive's 403s)", async () => {
    const rateLimited = {
      status: 403,
      json: { error: { errors: [{ reason: "userRateLimitExceeded" }], message: "Rate limit" } },
    };
    const fake = await serve(rateLimited, { status: 200 });
    const { http, waits } = client({
      isRateLimited: (response) => JSON.stringify(response.json).includes("RateLimitExceeded"),
    });
    await http.request({ method: "GET", url: fake.url, operation: "read" });
    expect(fake.requests).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  it("gives up after maxAttempts with MS_STORAGE_IO, a rate-limit hint and the attempt count", async () => {
    const fake = await serve({ status: 429 });
    const { http } = client({ retry: { maxAttempts: 3 } });
    const error = await failure(
      http.request({ method: "GET", url: fake.url, operation: "list files" }),
    );
    expect(fake.requests).toHaveLength(3);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toContain("Test Drive: could not list files (HTTP 429). Tried 3 times.");
    expect(isMongoShieldError(error) && error.hint).toContain("own OAuth client id");
  });

  it("retries POST only when the server promises it did nothing (429, 503)", async () => {
    const fake = await serve({ status: 503 }, { status: 500 });
    const { http } = client();
    const error = await failure(
      http.request({ method: "POST", url: fake.url, operation: "create a file", body: "x" }),
    );
    // 503 retried, 500 not: the first POST may have created the file.
    expect(fake.requests).toHaveLength(2);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
  });

  it("never repeats a POST after a network error, unless it is marked idempotent", async () => {
    const fake = await serve({ destroy: true }, { status: 200 });
    const { http } = client();
    const error = await failure(
      http.request({ method: "POST", url: fake.url, operation: "create" }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toContain("network error");
    expect(fake.requests).toHaveLength(1);

    const retried = await http.request({
      method: "POST",
      url: fake.url,
      operation: "poll",
      idempotent: true,
    });
    expect(retried.status).toBe(200);
  });

  it("times out an attempt that gets no headers, and retries it", async () => {
    const fake = await serve({ delayMs: 500 }, { status: 200 });
    const { http, waits } = client({ timeoutMs: 50 });
    const response = await http.request({ method: "GET", url: fake.url, operation: "read" });
    expect(response.status).toBe(200);
    expect(waits).toHaveLength(1);
  });

  it("reports a timeout after the last attempt as MS_STORAGE_IO 'timed out'", async () => {
    const fake = await serve({ delayMs: 500 });
    const { http } = client({ timeoutMs: 30, retry: { maxAttempts: 2 } });
    const error = await failure(http.request({ method: "GET", url: fake.url, operation: "read" }));
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toContain("timed out");
    expect(isMongoShieldError(error) && error.details?.timedOut).toBe(true);
  });

  it("does not time out a slow body once the headers arrived", async () => {
    // Headers at once, the body 150 ms later: three times the timeout.
    const slow = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first ");
      setTimeout(() => response.end("last"), 150);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = slow.address() as AddressInfo;
      const { http } = client({ timeoutMs: 50 });
      const response = await http.request({
        method: "GET",
        url: `http://127.0.0.1:${port}/`,
        operation: "read",
      });
      expect(await response.text()).toBe("first last");
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  });

  it("rejects with MS_ABORTED when the caller aborts, during a request or a wait", async () => {
    const fake = await serve({ delayMs: 1000 });
    const { http } = client();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const during = await failure(
      http.request({ method: "GET", url: fake.url, operation: "read", signal: controller.signal }),
    );
    expect(isMongoShieldError(during, "MS_ABORTED")).toBe(true);

    const waiting = createHttpClient({ service: "Test Drive" });
    const fake2 = await startFakeHttpServer(() => ({
      status: 503,
      headers: { "retry-after": "30" },
    }));
    try {
      const second = new AbortController();
      setTimeout(() => second.abort(), 50);
      const inWait = await failure(
        waiting.request({
          method: "GET",
          url: fake2.url,
          operation: "read",
          signal: second.signal,
        }),
      );
      expect(isMongoShieldError(inWait, "MS_ABORTED")).toBe(true);
    } finally {
      await fake2.close();
    }

    const already = await failure(
      http.request({
        method: "GET",
        url: fake.url,
        operation: "read",
        signal: AbortSignal.abort(),
      }),
    );
    expect(isMongoShieldError(already, "MS_ABORTED")).toBe(true);
  });

  it("sends a bearer token and refreshes it once after a 401", async () => {
    const fake = await serve({ status: 401 }, { status: 200 });
    const calls: { forceRefresh: boolean | undefined }[] = [];
    let current = "token-1";
    const { http } = client({
      auth: {
        async getAccessToken(options) {
          calls.push({ forceRefresh: options?.forceRefresh });
          if (options?.forceRefresh === true) current = "token-2";
          return current;
        },
      },
    });
    await http.request({ method: "GET", url: fake.url, operation: "read" });
    expect(fake.requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    expect(calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
  });

  it("fails a second 401 with MS_STORAGE_FORBIDDEN and the adapter's auth hint", async () => {
    const fake = await serve({ status: 401, json: { error: { message: "Invalid Credentials" } } });
    const { http } = client({
      auth: { getAccessToken: async () => "tok" },
      authHint: "Run `mongoshield login gdrive` again.",
    });
    const error = await failure(http.request({ method: "GET", url: fake.url, operation: "read" }));
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBe("Run `mongoshield login gdrive` again.");
    expect(fake.requests).toHaveLength(2);
  });

  it.each([
    [404, "MS_STORAGE_NOT_FOUND"],
    [410, "MS_STORAGE_NOT_FOUND"],
    [403, "MS_STORAGE_FORBIDDEN"],
    [409, "MS_STORAGE_PRECONDITION_FAILED"],
    [412, "MS_STORAGE_PRECONDITION_FAILED"],
    [507, "MS_STORAGE_INSUFFICIENT_SPACE"],
    [400, "MS_STORAGE_IO"],
    [413, "MS_STORAGE_IO"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const fake = await serve({ status });
    const { http } = client();
    const error = await failure(http.request({ method: "GET", url: fake.url, operation: "read" }));
    expect(isMongoShieldError(error) && error.code).toBe(code);
    expect(codeForStatus(status)).toBe(code);
    expect(fake.requests).toHaveLength(1);
  });

  it("lets the adapter classify errors itself (Dropbox's 409s, Drive's full quota)", async () => {
    const fake = await serve({
      status: 409,
      json: { error_summary: "path/not_found/..", error: { ".tag": "path" } },
    });
    const { http } = client({
      classifyError: (response) =>
        String(defaultErrorDetail(response)).startsWith("path/not_found")
          ? "MS_STORAGE_NOT_FOUND"
          : undefined,
    });
    const error = await failure(
      http.request({ method: "POST", url: fake.url, operation: "download" }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    expect(String(error)).toContain("path/not_found");
  });

  it("never puts the URL, its query or a token into an error", async () => {
    const token = "ya29.secret-access-token";
    const fake = await serve({
      status: 400,
      json: { error: { message: `bad request for token ${token}` } },
    });
    const { http } = client({ auth: { getAccessToken: async () => token } });
    const error = await failure(
      http.request({
        method: "GET",
        url: `${fake.url}/files?access_token=query-secret&key=api-secret`,
        operation: "read backups/x/manifest.json",
      }),
    );
    const text = `${String(error)} ${isMongoShieldError(error) ? `${error.hint} ${JSON.stringify(error.details)}` : ""}`;
    expect(text).toContain(
      "could not read backups/x/manifest.json (HTTP 400: bad request for token ***)",
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain("query-secret");
    expect(text).not.toContain("api-secret");
    expect(text).not.toContain(fake.url);
  });

  it("names the network failure without the URL", async () => {
    // A port nothing listens on: connection refused.
    const closed = await startFakeHttpServer(() => ({}));
    const url = `${closed.url}/x?token=hidden`;
    await closed.close();
    const { http } = client({ retry: { maxAttempts: 2 } });
    const error = await failure(http.request({ method: "GET", url, operation: "read" }));
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toContain("Test Drive: could not read (network error");
    expect(String(error)).toContain("Tried 2 times");
    expect(String(error)).not.toContain("hidden");
  });

  it("fails requestJson on a body that is not JSON, and returns undefined for an empty one", async () => {
    const fake = await serve({ status: 200, body: "<html>" }, { status: 204 });
    const { http } = client();
    const error = await failure(
      http.requestJson({ method: "GET", url: fake.url, operation: "read" }),
    );
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(await http.requestJson({ method: "GET", url: fake.url, operation: "read" })).toBe(
      undefined,
    );
  });
});

describe("retryAfterMs", () => {
  it.each([
    [null, undefined],
    ["", undefined],
    ["soon", undefined],
    ["0", 0],
    ["12", 12_000],
    ["Thu, 05 Nov 2026 10:00:30 GMT", 30_000],
    ["Thu, 05 Nov 2026 09:00:00 GMT", 0],
  ])("reads %j as %j", (header, expected) => {
    expect(retryAfterMs(header, Date.parse("2026-11-05T10:00:00Z"))).toBe(expected);
  });
});

describe("defaultErrorDetail", () => {
  it.each([
    [{ error: { message: "Google style" } }, "Google style"],
    [{ error: "invalid_grant", error_description: "OAuth style" }, "OAuth style"],
    [{ error_summary: "path/not_found/.." }, "path/not_found/.."],
    [{ error: "plain_code" }, "plain_code"],
    [{ message: "plain message" }, "plain message"],
    ["not an object", undefined],
  ])("reads %j", (json, expected) => {
    expect(defaultErrorDetail({ status: 400, headers: new Headers(), bodyText: "", json })).toBe(
      expected,
    );
  });
});
