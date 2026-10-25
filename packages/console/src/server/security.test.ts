/**
 * Tests for the HTTP hardening middleware in isolation: the same-origin check
 * (own host, the configured public URL, malformed and foreign origins, missing
 * Host) and the JSON-only body reader.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv, ConsoleSettings } from "./context.ts";
import { describeError, statusOf } from "./errors.ts";
import { readJson, sameOriginOnly } from "./security.ts";

/** Settings without a public URL: only the Host header defines the console's origin. */
const hostOnly: ConsoleSettings = { cookieSecure: true, https: false, shutdownGraceMs: 0 };
const settings: ConsoleSettings = { ...hostOnly, publicUrl: "https://backups.example.com" };

/** A tiny app with only the middleware under test and one echo route. */
function app(options: ConsoleSettings = settings): Hono<AppEnv> {
  const server = new Hono<AppEnv>();
  server.use("*", sameOriginOnly(options));
  server.post("/echo", async (c) => c.json({ received: await readJson(c) }));
  server.get("/echo", (c) => c.json({ ok: true }));
  server.onError((error, c) => c.json({ error: describeError(error) }, statusOf(error)));
  return server;
}

async function post(
  server: Hono<AppEnv>,
  headers: Record<string, string>,
  body = "{}",
): Promise<{ status: number; code: string | undefined }> {
  const response = await server.request("/echo", { method: "POST", headers, body });
  const parsed: unknown = await response.json();
  const error =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "error") : undefined;
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return { status: response.status, code: typeof code === "string" ? code : undefined };
}

const json = { "content-type": "application/json" };

describe("sameOriginOnly", () => {
  it("accepts the request's own host, the public URL, and requests without an Origin", async () => {
    const server = app();
    expect(
      (await post(server, { ...json, host: "localhost", origin: "http://localhost" })).status,
    ).toBe(200);
    expect(
      (
        await post(server, {
          ...json,
          host: "internal:8080",
          origin: "https://backups.example.com",
        })
      ).status,
    ).toBe(200);
    expect((await post(server, json)).status).toBe(200);
  });

  it("refuses foreign and malformed origins, and origins it cannot compare with a host", async () => {
    const server = app(hostOnly);
    for (const headers of [
      { host: "localhost", origin: "https://evil.example" },
      { host: "localhost", origin: "not a url" },
      { origin: "http://localhost" },
    ]) {
      const result = await post(server, { ...json, ...headers });
      expect(result).toEqual({ status: 403, code: "CONSOLE_BAD_ORIGIN" });
    }
  });

  it("never checks safe methods", async () => {
    const response = await app().request("/echo", { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(200);
  });
});

describe("readJson", () => {
  it("accepts application/json with parameters and refuses other types", async () => {
    const server = app();
    expect((await post(server, { "content-type": "application/json; charset=utf-8" })).status).toBe(
      200,
    );
    expect(await post(server, { "content-type": "text/plain" })).toEqual({
      status: 415,
      code: "CONSOLE_UNSUPPORTED_MEDIA_TYPE",
    });
    expect(await post(server, {})).toEqual({ status: 415, code: "CONSOLE_UNSUPPORTED_MEDIA_TYPE" });
  });

  it("answers a body that is not JSON with a validation error", async () => {
    expect(await post(app(), json, "{ broken")).toEqual({
      status: 400,
      code: "CONSOLE_VALIDATION",
    });
  });
});
