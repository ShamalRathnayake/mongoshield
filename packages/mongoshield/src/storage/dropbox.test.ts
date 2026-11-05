/**
 * Tests for the `dropbox://` adapter against the in-process fake Dropbox API
 * (test/helpers/fake-dropbox-server.ts): the shared storage conformance suite, run
 * twice (default settings, and small chunks/pages with Dropbox's quirks switched on),
 * plus the Dropbox-specific behaviour the suite cannot see: upload sessions,
 * header escaping, retries, token renewal, error mapping, free space and URL parsing.
 */

import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropboxContentHash,
  type FakeDropboxServer,
  startFakeDropboxServer,
} from "../../test/helpers/fake-dropbox-server.ts";
import { withoutShippedClient } from "../../test/helpers/no-shipped-client.ts";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import {
  type DropboxStorageOptions,
  dropboxStorage,
  dropboxStorageFromUrl,
  headerSafeJson,
} from "./dropbox.ts";

const MiB = 1024 * 1024;

/** Every test gets its own folder, so one server serves the whole file. */
let folderCounter = 0;
function uniqueFolder(): string {
  folderCounter++;
  return `test-${folderCounter}`;
}

/** An adapter on `server` with fast retries; `overrides` win. */
function adapterOn(server: FakeDropboxServer, overrides: Partial<DropboxStorageOptions> = {}) {
  return dropboxStorage({
    folder: uniqueFolder(),
    refreshToken: server.issueRefreshToken(),
    clientId: server.clientId,
    endpoints: server.endpoints,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** The error a promise rejects with (fails the test if it resolves). */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

function codeOf(error: unknown): string | undefined {
  return isMongoShieldError(error) ? error.code : undefined;
}

/** Endpoints of the API requests made since `from` (an index into server.requests). */
function endpointsSince(server: FakeDropboxServer, from: number): string[] {
  return server.requests.slice(from).map((request) => request.endpoint);
}

/** Answers one endpoint's requests itself (it may still forward them with the real fetch). */
type FetchOverride = (input: string, init: RequestInit | undefined) => Promise<Response>;

/**
 * A fetch that sends every request on to the fake, except those for an endpoint in
 * `overrides` (`files/upload`, `/oauth2/token`, …): those go through the override,
 * which can change the request or the answer, or fail like a broken network.
 */
function fetchWith(overrides: Readonly<Record<string, FetchOverride>>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const endpoint = new URL(url).pathname.replace(/^\/2\//, "");
    const override = overrides[endpoint];
    return override ? override(url, init) : fetch(url, init);
  };
}

/** `response` with its `Dropbox-API-Result` header replaced (`null` removes it). */
function withResultHeader(response: Response, value: string | null): Response {
  const headers = new Headers(response.headers);
  if (value === null) headers.delete("dropbox-api-result");
  else headers.set("dropbox-api-result", value);
  return new Response(response.body, { status: response.status, headers });
}

/** Counts the requests to `endpoint` since `from`. */
function countSince(server: FakeDropboxServer, from: number, endpoint: string): number {
  return endpointsSince(server, from).filter((name) => name === endpoint).length;
}

describe("dropbox storage", () => {
  let server: FakeDropboxServer;
  let quirky: FakeDropboxServer;

  beforeAll(async () => {
    server = await startFakeDropboxServer();
    // Small pages, async deletes and lower-cased parents in path_display, all at once.
    quirky = await startFakeDropboxServer({
      pageSize: 3,
      asyncDeletePolls: 1,
      lowercaseParentsInDisplay: true,
    });
  });

  afterAll(async () => {
    await server.close();
    await quirky.close();
  });

  describeStorageConformance("dropbox", async () => ({
    storage: adapterOn(server),
    cleanup: async () => {},
  }));

  describeStorageConformance("dropbox (4 MiB chunks, paging, async deletes)", async () => ({
    storage: adapterOn(quirky, { chunkSize: 4 * MiB }),
    cleanup: async () => {},
  }));

  describe("uploads", () => {
    it("sends objects up to chunkSize in one files/upload request", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      const start = server.requests.length;
      await storage.put("small.bin", Buffer.alloc(4 * MiB - 1, 1));
      const uploads = endpointsSince(server, start).filter((endpoint) =>
        endpoint.startsWith("files/"),
      );
      expect(uploads).toEqual(["files/upload"]);
    });

    it("streams larger objects through an upload session, one chunk per request", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      const size = 9 * MiB + 5;
      const start = server.requests.length;
      // Many small pieces, so the adapter has to assemble the chunks itself.
      const pieces = Array.from({ length: Math.ceil(size / 65_536) }, (_, index) =>
        Buffer.alloc(Math.min(65_536, size - index * 65_536), index % 251),
      );
      const info = await storage.put("big.bin", Readable.from(pieces));
      expect(info.size).toBe(size);
      const calls = server.requests
        .slice(start)
        .filter((request) => request.endpoint.startsWith("files/"));
      expect(calls.map((call) => [call.endpoint, call.bodyBytes])).toEqual([
        ["files/upload_session/start", 4 * MiB],
        ["files/upload_session/append_v2", 4 * MiB],
        ["files/upload_session/finish", MiB + 5],
      ]);
      expect((await readAll(await storage.get("big.bin"))).equals(Buffer.concat(pieces))).toBe(
        true,
      );
    });

    it("uses the default 8 MiB chunk size", async () => {
      const storage = adapterOn(server);
      const start = server.requests.length;
      await storage.put("default.bin", Buffer.alloc(8 * MiB + 1));
      const calls = server.requests
        .slice(start)
        .filter((request) => request.endpoint.startsWith("files/upload"));
      expect(calls.map((call) => call.bodyBytes)).toEqual([8 * MiB, 1]);
    });

    it("commits conditional writes with mode add + strict_conflict and others with overwrite", async () => {
      const storage = adapterOn(server);
      const start = server.requests.length;
      await storage.put("lock", Buffer.from("a"), { ifNoneMatch: "*" });
      await storage.put("plain", Buffer.from("b"));
      const [conditional, plain] = server.requests
        .slice(start)
        .filter((request) => request.endpoint === "files/upload")
        .map((request) => request.arg as Record<string, unknown>);
      expect(conditional).toMatchObject({ mode: "add", strict_conflict: true, autorename: false });
      expect(plain).toMatchObject({ mode: "overwrite", strict_conflict: false });
    });

    it("refuses a conditional create over identical content (strict_conflict)", async () => {
      const storage = adapterOn(server);
      await storage.put("same", Buffer.from("x"), { ifNoneMatch: "*" });
      const error = await rejectionOf(storage.put("same", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(codeOf(error)).toBe("MS_STORAGE_PRECONDITION_FAILED");
    });

    it("sends the Dropbox content hash of each request's data", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      const data = Buffer.alloc(5 * MiB, 7);
      const start = server.requests.length;
      await storage.put("hashed.bin", data);
      const hashes = server.requests
        .slice(start)
        .filter((request) => request.endpoint.startsWith("files/upload"))
        .map((request) => (request.arg as Record<string, unknown>).content_hash);
      expect(hashes).toEqual([
        dropboxContentHash(data.subarray(0, 4 * MiB)),
        dropboxContentHash(data.subarray(4 * MiB)),
      ]);
    });

    it("succeeds when a conditional commit's answer is lost and the retry conflicts with itself", async () => {
      const storage = adapterOn(server);
      server.fail("files/upload", { status: 500, afterHandling: true });
      const info = await storage.put("lost/lock", Buffer.from("mine"), { ifNoneMatch: "*" });
      expect(info.size).toBe(4);
      expect((await readAll(await storage.get("lost/lock"))).toString()).toBe("mine");
    });

    it("succeeds when a session finish's answer is lost and the retry finds no session", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      const data = Buffer.alloc(5 * MiB, 9);
      for (const conditional of [false, true]) {
        server.fail("files/upload_session/finish", { status: 500, afterHandling: true });
        const key = `lost-finish/${conditional}`;
        const info = await storage.put(key, data, conditional ? { ifNoneMatch: "*" } : {});
        expect(info.size).toBe(data.length);
        expect((await readAll(await storage.get(key))).equals(data)).toBe(true);
      }
    });

    it("still fails a retried conditional commit when someone else's file is there", async () => {
      const storage = adapterOn(server);
      await storage.put("taken/lock", Buffer.from("theirs"));
      server.fail("files/upload", { status: 503 });
      const error = await rejectionOf(
        storage.put("taken/lock", Buffer.from("mine"), { ifNoneMatch: "*" }),
      );
      expect(codeOf(error)).toBe("MS_STORAGE_PRECONDITION_FAILED");
    });

    it("carries on when an append's answer is lost after Dropbox stored the chunk", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      server.fail("files/upload_session/append_v2", { status: 500, afterHandling: true });
      const data = Buffer.alloc(10 * MiB, 3);
      await storage.put("resumed.bin", data);
      expect((await readAll(await storage.get("resumed.bin"))).equals(data)).toBe(true);
    });

    it("maps insufficient_space to MS_STORAGE_INSUFFICIENT_SPACE", async () => {
      const small = await startFakeDropboxServer({ allocated: 10 });
      try {
        const storage = adapterOn(small);
        const error = await rejectionOf(storage.put("too-big", Buffer.alloc(11)));
        expect(codeOf(error)).toBe("MS_STORAGE_INSUFFICIENT_SPACE");
      } finally {
        await small.close();
      }
    });

    it("rejects invalid chunk sizes", () => {
      for (const chunkSize of [0, MiB, 5 * MiB, 152 * MiB, 4.5 * MiB]) {
        expect(() => adapterOn(server, { chunkSize })).toThrow(/chunkSize/);
      }
      expect(() => adapterOn(server, { chunkSize: 148 * MiB })).not.toThrow();
    });
  });

  describe("names and paths", () => {
    it("escapes non-ASCII characters in Dropbox-API-Arg as \\uXXXX", async () => {
      const storage = adapterOn(server);
      const key = "données/naïve 😀.bin";
      const start = server.requests.length;
      await storage.put(key, Buffer.from("unicode"));
      const upload = server.requests
        .slice(start)
        .find((request) => request.endpoint === "files/upload");
      expect(upload?.rawArg).toMatch(/^[\x20-\x7e]+$/);
      expect(upload?.rawArg).toContain("donn\\u00e9es/na\\u00efve \\ud83d\\ude00.bin");
      expect((await readAll(await storage.get(key))).toString()).toBe("unicode");
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual([key]);
    });

    it("escapes exactly the characters from 0x7F up", () => {
      expect(headerSafeJson({ path: "/a\u007fb~é" })).toBe('{"path":"/a\\u007fb~\\u00e9"}');
    });

    it("maps keys to /<folder>/<key>", async () => {
      const storage = adapterOn(server, { folder: "nested/backups" });
      await storage.put("a/b.bin", Buffer.from("x"));
      expect(server.filePaths()).toContain("/nested/backups/a/b.bin");
      expect(storage.location).toBe("dropbox://nested/backups/");
    });

    it("lists keys in the case they were written, even when path_display is lower-cased", async () => {
      const storage = adapterOn(quirky);
      const keys = ["Backups/App/Users.bson", "Backups/App/manifest.json", "Backups/Zeta.json"];
      for (const key of keys) await storage.put(key, Buffer.from(key));
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual([...keys].sort());
      expect(await collect(storage.listPrefixes("Backups/"))).toEqual(["Backups/App/"]);
    });

    it("leaves emptied folders on Dropbox but never lists them as prefixes", async () => {
      const storage = adapterOn(server);
      await storage.put("gone/deep/x", Buffer.from("x"));
      await storage.delete(["gone/deep/x"]);
      expect(server.folderPaths().some((path) => path.endsWith("/gone/deep"))).toBe(true);
      expect(await collect(storage.listPrefixes(""))).toEqual([]);
    });

    it("pages through list_folder/continue", async () => {
      const storage = adapterOn(quirky);
      for (let index = 0; index < 7; index++) await storage.put(`page/${index}`, Buffer.from("x"));
      const start = quirky.requests.length;
      expect(await collect(storage.list("page/"))).toHaveLength(7);
      expect(
        endpointsSince(quirky, start).filter((name) => name === "files/list_folder/continue")
          .length,
      ).toBeGreaterThan(1);
    });
  });

  describe("reads", () => {
    it("sends a Range header for range reads", async () => {
      const storage = adapterOn(server);
      await storage.put("range.txt", Buffer.from("0123456789"));
      const start = server.requests.length;
      expect(
        (await readAll(await storage.get("range.txt", { range: { start: 3, end: 6 } }))).toString(),
      ).toBe("3456");
      const download = server.requests
        .slice(start)
        .find((request) => request.endpoint === "files/download");
      expect(download?.headers.range).toBe("bytes=3-6");
    });

    it("cuts the range out itself when the server ignores Range", async () => {
      const ignoring = await startFakeDropboxServer({ ignoreRange: true });
      try {
        const storage = adapterOn(ignoring);
        await storage.put("range.txt", Buffer.from("0123456789"));
        const read = (range: { start: number; end?: number }) =>
          storage.get("range.txt", { range }).then(readAll);
        expect((await read({ start: 3, end: 6 })).toString()).toBe("3456");
        expect((await read({ start: 8 })).toString()).toBe("89");
      } finally {
        await ignoring.close();
      }
    });

    it("fails a full download whose bytes do not match the content hash (through the fetch option)", async () => {
      const corrupting: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!String(input).endsWith("/2/files/download")) return response;
        const bytes = Buffer.from(await response.arrayBuffer());
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return new Response(bytes, { status: response.status, headers: response.headers });
      };
      const storage = adapterOn(server, { fetch: corrupting });
      await storage.put("corrupt.bin", Buffer.from("payload"));
      const error = await rejectionOf(storage.get("corrupt.bin").then(readAll));
      expect(codeOf(error)).toBe("MS_INTEGRITY_FAILED");
    });
  });

  describe("retries", () => {
    it("retries 429 and waits for Retry-After", async () => {
      const storage = adapterOn(server);
      server.fail("files/upload", {
        status: 429,
        headers: { "retry-after": "1" },
        body: {
          error_summary: "too_many_write_operations/..",
          error: { reason: { ".tag": "too_many_write_operations" }, retry_after: 1 },
        },
      });
      const started = Date.now();
      await storage.put("rate-limited", Buffer.from("x"));
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(await storage.head("rate-limited")).toBeDefined();
    });

    it("retries a write refused with path/too_many_write_operations (409)", async () => {
      const storage = adapterOn(server);
      server.fail("files/upload", {
        status: 409,
        body: {
          error_summary: "path/too_many_write_operations/...",
          error: { ".tag": "path", reason: { ".tag": "too_many_write_operations" } },
        },
      });
      await storage.put("write-locked", Buffer.from("x"));
      expect(await storage.head("write-locked")).toBeDefined();
    });

    it("gives up after maxRetries with MS_STORAGE_IO", async () => {
      const storage = adapterOn(server, { maxRetries: 2 });
      server.fail("files/get_metadata", { status: 500 }, 3);
      const start = server.requests.length;
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(
        endpointsSince(server, start).filter((name) => name === "files/get_metadata"),
      ).toHaveLength(3);
    });

    it("does not retry with maxRetries 0", async () => {
      const storage = adapterOn(server, { maxRetries: 0 });
      server.fail("files/get_metadata", { status: 503 });
      expect(codeOf(await rejectionOf(storage.head("x")))).toBe("MS_STORAGE_IO");
    });

    it("waits retryBaseDelayMs (with jitter) before the first retry", async () => {
      const storage = adapterOn(server, { retryBaseDelayMs: 400 });
      server.fail("files/get_metadata", { status: 500 });
      const started = Date.now();
      await storage.head("x");
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    });

    it("times out a request that gets no answer within requestTimeoutMs, then retries it", async () => {
      const storage = adapterOn(server, { requestTimeoutMs: 200 });
      server.stall("files/get_metadata");
      await storage.put("slow", Buffer.from("x"));
      expect(await storage.head("slow")).toBeDefined();

      const impatient = adapterOn(server, { requestTimeoutMs: 200, maxRetries: 0 });
      server.stall("files/get_metadata");
      const error = await rejectionOf(impatient.head("slow"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/no answer within 200 ms/);
    });
  });

  describe("tokens", () => {
    it("renews an expired access token from the refresh token", async () => {
      const storage = adapterOn(server);
      await storage.put("token/a", Buffer.from("a"));
      server.expireAccessTokens();
      const start = server.requests.length;
      expect(await storage.head("token/a")).toBeDefined();
      expect(endpointsSince(server, start)).toEqual([
        "files/get_metadata",
        "/oauth2/token",
        "files/get_metadata",
      ]);
    });

    it("shares one token refresh between concurrent requests", async () => {
      const storage = adapterOn(server);
      const start = server.requests.length;
      await Promise.all(
        Array.from({ length: 5 }, (_, index) => storage.head(`concurrent-${index}`)),
      );
      expect(endpointsSince(server, start).filter((name) => name === "/oauth2/token")).toHaveLength(
        1,
      );
    });

    it("fails with MS_STORAGE_FORBIDDEN and a login hint when the refresh token is revoked", async () => {
      const refreshToken = server.issueRefreshToken();
      server.revokeRefreshToken(refreshToken);
      const storage = adapterOn(server, { refreshToken });
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
      expect(isMongoShieldError(error) && error.hint).toMatch(/mongoshield login dropbox/);
      expect(String(error)).not.toContain(refreshToken);
    });

    it("uses a fixed accessToken without an app key, and maps its rejection to MS_STORAGE_FORBIDDEN", async () => {
      const storage = dropboxStorage({
        folder: "fixed",
        accessToken: "sl.not-a-real-token",
        endpoints: server.endpoints,
      });
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
      expect(String(error)).not.toContain("sl.not-a-real-token");
    });

    it("never puts a token into an error message", async () => {
      // Make Dropbox echo the access token in an error, as a misbehaving proxy might.
      const storage = adapterOn(server, { maxRetries: 0 });
      await storage.head("warm-up");
      const issued = server.requests
        .filter((request) => request.endpoint === "files/get_metadata")
        .at(-1);
      const token = String(issued?.headers.authorization).replace("Bearer ", "");
      server.fail("files/get_metadata", {
        status: 400,
        body: { error_summary: `bad request with ${token}` },
      });
      const error = await rejectionOf(storage.head("x"));
      expect(String(error)).not.toContain(token);
      expect(String(error)).toContain("***");
    });

    it("needs exactly one of refreshToken and accessToken", () => {
      const base = { folder: "x", endpoints: server.endpoints, clientId: server.clientId };
      expect(() => dropboxStorage(base)).toThrow(/refresh token/);
      expect(() => dropboxStorage({ ...base, refreshToken: "r", accessToken: "a" })).toThrow(
        /not both/,
      );
    });

    it("sends the clientSecret with the refresh when given", async () => {
      const storage = adapterOn(server, { clientSecret: "app-secret" });
      const start = server.requests.length;
      await storage.head("x");
      const refresh = server.requests
        .slice(start)
        .find((request) => request.endpoint === "/oauth2/token");
      expect(refresh?.arg).toMatchObject({ client_secret: "app-secret" });
    });
  });

  describe("deletes", () => {
    it("retries entries refused with too_many_write_operations", async () => {
      const storage = adapterOn(server);
      await storage.put("busy/a", Buffer.from("a"));
      await storage.put("busy/b", Buffer.from("b"));
      const path = server.filePaths().find((candidate) => candidate.endsWith("/busy/a"));
      server.lockPathForDeletes(path ?? "", 2);
      await storage.delete(["busy/a", "busy/b"]);
      expect(await collect(storage.list("busy/"))).toEqual([]);
    });

    it("sends at most 1000 paths per delete_batch", async () => {
      const storage = adapterOn(server);
      const keys = Array.from({ length: 1001 }, (_, index) => `missing/${index}`);
      const start = server.requests.length;
      await storage.delete(keys);
      const batches = server.requests
        .slice(start)
        .filter((request) => request.endpoint === "files/delete_batch")
        .map((request) => ((request.arg as { entries: unknown[] }).entries ?? []).length);
      expect(batches).toEqual([1000, 1]);
    });
  });

  describe("space", () => {
    it("reports quota, usage and free space of an individual account", async () => {
      const own = await startFakeDropboxServer({ allocated: 1000 });
      try {
        const storage = adapterOn(own);
        await storage.put("a", Buffer.alloc(100));
        expect(await storage.space()).toEqual({ totalBytes: 1000, usedBytes: 100, freeBytes: 900 });
      } finally {
        await own.close();
      }
    });

    it("uses the tighter of the member limit and the team pool on team accounts", async () => {
      const team = await startFakeDropboxServer({
        spaceAllocation: {
          ".tag": "team",
          allocated: 10_000,
          used: 9_950,
          user_within_team_space_allocated: 500,
          user_within_team_space_limit_type: { ".tag": "stop_sync" },
          user_within_team_space_used_cached: 0,
        },
      });
      try {
        const storage = adapterOn(team);
        expect(await storage.space()).toEqual({ totalBytes: 500, usedBytes: 0, freeBytes: 50 });
      } finally {
        await team.close();
      }
    });

    it("rejects with MS_ABORTED when the signal is already aborted", async () => {
      const storage = adapterOn(server);
      expect(codeOf(await rejectionOf(storage.space({ signal: AbortSignal.abort() })))).toBe(
        "MS_ABORTED",
      );
    });
  });

  describe("upload edge cases", () => {
    it("assembles chunks from stream pieces that straddle chunk boundaries", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      const pieces = [1, 2, 3].map((fill) => Buffer.alloc(3 * MiB, fill));
      const start = server.requests.length;
      await storage.put("straddle.bin", Readable.from(pieces));
      const sizes = server.requests
        .slice(start)
        .filter((request) => request.endpoint.startsWith("files/upload"))
        .map((request) => request.bodyBytes);
      expect(sizes).toEqual([4 * MiB, 4 * MiB, MiB]);
      const stored = await readAll(await storage.get("straddle.bin"));
      expect(stored.equals(Buffer.concat(pieces))).toBe(true);
    });

    it("fails with MS_STORAGE_IO when Dropbox starts no upload session", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      server.fail("files/upload_session/start", { status: 200, body: {} });
      const error = await rejectionOf(storage.put("no-session.bin", Buffer.alloc(5 * MiB)));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/started no upload session/);
    });

    it("fails an append that Dropbox places at another offset, and destroys the source stream", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      server.fail("files/upload_session/append_v2", {
        status: 409,
        body: {
          error_summary: "incorrect_offset/..",
          error: { ".tag": "incorrect_offset", correct_offset: 1 },
        },
      });
      // One 10 MiB piece: the adapter has to split it and keep the rest for later chunks.
      const source = Readable.from([Buffer.alloc(10 * MiB, 4)]);
      const error = await rejectionOf(storage.put("misplaced.bin", source));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(source.destroyed).toBe(true);
      expect(await storage.head("misplaced.bin")).toBeUndefined();
    });

    it("maps an upload corrupted in transit (content_hash_mismatch) to MS_INTEGRITY_FAILED", async () => {
      const corrupting = fetchWith({
        "files/upload": (url, init) => {
          const body = Buffer.from(init?.body as Uint8Array);
          body[0] = (body[0] ?? 0) ^ 0xff;
          return fetch(url, { ...init, body });
        },
      });
      const storage = adapterOn(server, { fetch: corrupting });
      const error = await rejectionOf(storage.put("garbled.bin", Buffer.from("payload")));
      expect(codeOf(error)).toBe("MS_INTEGRITY_FAILED");
      expect(await storage.head("garbled.bin")).toBeUndefined();
    });

    it("maps a session finish that finds no session on its first attempt to MS_STORAGE_IO, not NOT_FOUND", async () => {
      const storage = adapterOn(server, { chunkSize: 4 * MiB });
      server.fail("files/upload_session/finish", {
        status: 409,
        body: {
          error_summary: "lookup_failed/not_found/..",
          error: { ".tag": "lookup_failed", lookup_failed: { ".tag": "not_found" } },
        },
      });
      const error = await rejectionOf(storage.put("expired.bin", Buffer.alloc(5 * MiB)));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
    });

    it("maps a write without permission to MS_STORAGE_FORBIDDEN", async () => {
      const storage = adapterOn(server);
      server.fail("files/upload", {
        status: 409,
        body: {
          error_summary: "path/no_write_permission/..",
          error: { ".tag": "path", reason: { ".tag": "no_write_permission" } },
        },
      });
      const error = await rejectionOf(storage.put("read-only", Buffer.from("x")));
      expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
    });
  });

  describe("read edge cases", () => {
    it("cuts a range out of a full answer that arrives in many pieces", async () => {
      const ignoring = await startFakeDropboxServer({ ignoreRange: true });
      try {
        const storage = adapterOn(ignoring);
        const data = Buffer.from(Array.from({ length: 1_000_000 }, (_, index) => index % 251));
        await storage.put("big-range.bin", data);
        const read = await readAll(
          await storage.get("big-range.bin", { range: { start: 700_000, end: 700_009 } }),
        );
        expect(read.equals(data.subarray(700_000, 700_010))).toBe(true);
      } finally {
        await ignoring.close();
      }
    });

    it("reads a download without a usable Dropbox-API-Result header, unchecked", async () => {
      for (const header of [null, "{not json"]) {
        const storage = adapterOn(server, {
          fetch: fetchWith({
            "files/download": async (url, init) => withResultHeader(await fetch(url, init), header),
          }),
        });
        await storage.put("no-result.txt", Buffer.from("still here"));
        expect((await readAll(await storage.get("no-result.txt"))).toString()).toBe("still here");
      }
    });

    it("reads an empty file when the download answer has no body at all", async () => {
      const storage = adapterOn(server, {
        fetch: fetchWith({
          "files/download": async (url, init) => {
            const response = await fetch(url, init);
            return new Response(null, { status: response.status, headers: response.headers });
          },
        }),
      });
      await storage.put("empty.bin", Buffer.alloc(0));
      expect(await readAll(await storage.get("empty.bin"))).toHaveLength(0);
    });

    it("maps reading a folder (not_file) to MS_STORAGE_NOT_FOUND", async () => {
      const storage = adapterOn(server);
      await storage.put("folder/inner", Buffer.from("x"));
      expect(codeOf(await rejectionOf(storage.get("folder")))).toBe("MS_STORAGE_NOT_FOUND");
    });
  });

  describe("listing edge cases", () => {
    it("lists only well-formed files from a list_folder answer, with defaults for missing fields", async () => {
      const storage = adapterOn(server);
      const folder = storage.location.slice("dropbox://".length, -1);
      const base = `/${folder}`;
      server.fail("files/list_folder", {
        status: 200,
        body: {
          entries: [
            // No size, rev or server_modified.
            { ".tag": "file", name: "plain.bin", path_lower: `${base}/plain.bin` },
            {
              ".tag": "folder",
              name: "Sub",
              path_lower: `${base}/sub`,
              path_display: `${base}/sub`,
            },
            {
              ".tag": "file",
              name: "Deep.bin",
              path_lower: `${base}/sub/deep.bin`,
              path_display: `${base}/sub/Deep.bin`,
              size: 5,
              rev: "015f",
              server_modified: "2026-01-02T03:04:05Z",
            },
            // Unusable: no path, no name, not a valid key, deleted, outside the folder.
            { ".tag": "file", name: "no-path.bin" },
            { ".tag": "file", path_lower: `${base}/nameless.bin` },
            { ".tag": "file", name: "back\\slash", path_lower: `${base}/back\\slash` },
            { ".tag": "deleted", name: "gone", path_lower: `${base}/gone` },
            { ".tag": "file", name: "outside", path_lower: "/outside" },
          ],
          cursor: "cursor-1",
          has_more: false,
        },
      });
      const listed = await collect(storage.list(""));
      expect(listed.map((info) => info.key)).toEqual(["Sub/Deep.bin", "plain.bin"]);
      const [deep, plain] = listed;
      expect(deep).toMatchObject({ size: 5, etag: "015f" });
      expect(deep?.lastModified.toISOString()).toBe("2026-01-02T03:04:05.000Z");
      expect(plain?.size).toBe(0);
      expect(plain?.etag).toBeUndefined();
      expect(plain?.lastModified).toBeInstanceOf(Date);
    });

    it("treats a list_folder answer without an entries array as an empty folder", async () => {
      const storage = adapterOn(server);
      server.fail("files/list_folder", { status: 200, body: { entries: "none", has_more: false } });
      expect(await collect(storage.list(""))).toEqual([]);
    });

    it("refuses a listPrefixes prefix that does not end in a slash", async () => {
      const storage = adapterOn(server);
      const error = await rejectionOf(collect(storage.listPrefixes("backups")));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/ending in "\/"/);
    });
  });

  describe("delete edge cases", () => {
    it("sends the whole batch again when the delete job failed on Dropbox's write lock", async () => {
      const storage = adapterOn(server);
      await storage.put("job-locked/a", Buffer.from("a"));
      server.fail("files/delete_batch", {
        status: 200,
        body: { ".tag": "failed", failed: { ".tag": "too_many_write_operations" } },
      });
      const start = server.requests.length;
      await storage.delete(["job-locked/a"]);
      expect(countSince(server, start, "files/delete_batch")).toBe(2);
      expect(await storage.head("job-locked/a")).toBeUndefined();
    });

    it("fails when a whole delete job fails for another reason", async () => {
      const storage = adapterOn(server);
      server.fail("files/delete_batch", {
        status: 200,
        body: { ".tag": "failed", failed: { ".tag": "too_many_files" } },
      });
      const error = await rejectionOf(storage.delete(["a"]));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/could not delete 1 files/);
    });

    it("maps a delete refused for permission to MS_STORAGE_FORBIDDEN and other refusals to MS_STORAGE_IO", async () => {
      const storage = adapterOn(server);
      const refusal = (failure: unknown) => ({
        status: 200,
        body: { ".tag": "complete", entries: [{ ".tag": "failure", failure }] },
      });
      server.fail(
        "files/delete_batch",
        refusal({ ".tag": "path_write", path_write: { ".tag": "no_write_permission" } }),
      );
      const forbidden = await rejectionOf(storage.delete(["protected"]));
      expect(codeOf(forbidden)).toBe("MS_STORAGE_FORBIDDEN");
      expect(String(forbidden)).toMatch(/refused to delete ".*\/protected" \(path_write\/no_write/);

      server.fail(
        "files/delete_batch",
        refusal({ ".tag": "path_lookup", path_lookup: { ".tag": "restricted_content" } }),
      );
      const refused = await rejectionOf(storage.delete(["restricted"]));
      expect(codeOf(refused)).toBe("MS_STORAGE_IO");
      expect(String(refused)).toMatch(/could not delete ".*\/restricted"/);
    });

    it("gives up after maxRetries when Dropbox keeps write-locking a path", async () => {
      const storage = adapterOn(server, { maxRetries: 1 });
      await storage.put("stuck", Buffer.from("x"));
      const folder = storage.location.slice("dropbox://".length, -1);
      server.lockPathForDeletes(`/${folder}/stuck`, 5);
      const error = await rejectionOf(storage.delete(["stuck"]));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/kept refusing to delete 1 files/);
    });

    it("gives up on a delete job that is still running after 10 minutes", async () => {
      const slow = await startFakeDropboxServer({ asyncDeletePolls: 1_000 });
      // The clock jumps 11 minutes at every status check, so no test waits that long.
      const realNow = Date.now.bind(Date);
      let skipped = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skipped);
      try {
        const storage = adapterOn(slow, {
          fetch: fetchWith({
            "files/delete_batch/check": (url, init) => {
              skipped += 11 * 60_000;
              return fetch(url, init);
            },
          }),
        });
        await storage.put("slow-delete", Buffer.from("x"));
        const error = await rejectionOf(storage.delete(["slow-delete"]));
        expect(codeOf(error)).toBe("MS_STORAGE_IO");
        expect(String(error)).toMatch(/did not finish in 10 minutes/);
      } finally {
        clock.mockRestore();
        await slow.close();
      }
    });
  });

  describe("error answers", () => {
    it("maps HTTP 403 to MS_STORAGE_FORBIDDEN without retrying", async () => {
      const storage = adapterOn(server);
      server.fail("files/get_metadata", { status: 403, body: { error_summary: "no_access/.." } });
      const start = server.requests.length;
      expect(codeOf(await rejectionOf(storage.head("x")))).toBe("MS_STORAGE_FORBIDDEN");
      expect(countSince(server, start, "files/get_metadata")).toBe(1);
    });

    it("gives up on a rate limit after maxRetries with a try-again-later hint", async () => {
      const storage = adapterOn(server, { maxRetries: 0 });
      server.fail("files/get_metadata", {
        status: 429,
        body: { error_summary: "too_many_requests/.." },
      });
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(isMongoShieldError(error) && error.hint).toMatch(/rate-limiting/);
    });

    it("retries at once when Retry-After is a past date or unreadable, or retry_after is 0", async () => {
      const storage = adapterOn(server);
      const pastDate = new Date(Date.now() - 60_000).toUTCString();
      server.fail("files/get_metadata", { status: 429, headers: { "retry-after": pastDate } });
      server.fail("files/get_metadata", { status: 429, headers: { "retry-after": "soon" } });
      server.fail("files/get_metadata", {
        status: 429,
        body: {
          error_summary: "too_many_requests/..",
          error: { ".tag": "too_many_requests", retry_after: 0 },
        },
      });
      const start = server.requests.length;
      const began = Date.now();
      expect(await storage.head("x")).toBeUndefined();
      expect(countSince(server, start, "files/get_metadata")).toBe(4);
      expect(Date.now() - began).toBeLessThan(1000);
    });

    it("names the operation when listing, deleting or reading the free space fails", async () => {
      const storage = adapterOn(server, { maxRetries: 0 });
      server.fail("files/list_folder", { status: 500 });
      const listError = await rejectionOf(collect(storage.list("")));
      expect(codeOf(listError)).toBe("MS_STORAGE_IO");
      expect(String(listError)).toMatch(/Cannot list dropbox:\/\//);

      server.fail("files/delete_batch", { status: 500 });
      expect(String(await rejectionOf(storage.delete(["a"])))).toMatch(
        /Cannot delete objects from dropbox:\/\//,
      );

      server.fail("users/get_space_usage", { status: 500 });
      expect(String(await rejectionOf(storage.space()))).toMatch(
        /Cannot read the free space of dropbox:\/\//,
      );
    });

    it("describes an error answer whose body cannot be read by its HTTP status", async () => {
      const storage = adapterOn(server, {
        maxRetries: 0,
        fetch: fetchWith({
          "files/get_metadata": async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("connection reset"));
                },
              }),
              { status: 502 },
            ),
        }),
      });
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/Dropbox said HTTP 502/);
    });

    it("fails with MS_STORAGE_IO when a successful answer is not JSON", async () => {
      const storage = adapterOn(server, {
        fetch: fetchWith({
          "users/get_space_usage": async () => new Response("<html>oops</html>", { status: 200 }),
        }),
      });
      const error = await rejectionOf(storage.space());
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/not JSON/);
    });
  });

  describe("network failures and cancellation", () => {
    it("retries network errors and reports the last one without any token in it", async () => {
      let attempts = 0;
      const storage = dropboxStorage({
        folder: uniqueFolder(),
        accessToken: "sl.fixed-secret-token",
        endpoints: server.endpoints,
        retryBaseDelayMs: 1,
        maxRetries: 1,
        fetch: async () => {
          attempts++;
          throw new TypeError("fetch failed (Bearer sl.fixed-secret-token)");
        },
      });
      const error = await rejectionOf(storage.head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(attempts).toBe(2);
      expect(String(error)).toContain("***");
      expect(String(error)).not.toContain("sl.fixed-secret-token");
    });

    it("fails a put whose append keeps failing on the network", async () => {
      const storage = adapterOn(server, {
        chunkSize: 4 * MiB,
        maxRetries: 0,
        fetch: fetchWith({
          "files/upload_session/append_v2": async () => {
            throw new TypeError("socket hang up");
          },
        }),
      });
      const error = await rejectionOf(storage.put("offline.bin", Buffer.alloc(9 * MiB)));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(String(error)).toMatch(/socket hang up/);
    });

    it("rejects with MS_ABORTED when the signal fires while a request waits for its answer", async () => {
      const controller = new AbortController();
      const storage = adapterOn(server, {
        fetch: fetchWith({
          "files/get_metadata": (url, init) => {
            const answer = fetch(url, init);
            controller.abort();
            return answer;
          },
        }),
      });
      const error = await rejectionOf(storage.head("x", { signal: controller.signal }));
      expect(codeOf(error)).toBe("MS_ABORTED");
    });

    it("rejects with MS_ABORTED when the signal fires during a retry backoff", async () => {
      const controller = new AbortController();
      const storage = adapterOn(server, {
        // A backoff far longer than the test may take.
        retryBaseDelayMs: 60_000,
        fetch: fetchWith({
          "files/get_metadata": async (url, init) => {
            const answer = await fetch(url, init);
            controller.abort();
            return answer;
          },
        }),
      });
      server.fail("files/get_metadata", { status: 500 });
      const error = await rejectionOf(storage.head("x", { signal: controller.signal }));
      expect(codeOf(error)).toBe("MS_ABORTED");
    });

    it("stops one caller waiting for a token refresh on abort, while others still get the token", async () => {
      let releaseToken = () => {};
      const tokenHeld = new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
      let refreshStarted = () => {};
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      const storage = adapterOn(server, {
        fetch: fetchWith({
          "/oauth2/token": async (url, init) => {
            refreshStarted();
            await tokenHeld;
            return fetch(url, init);
          },
        }),
      });
      const controller = new AbortController();
      const abandoned = storage.head("x", { signal: controller.signal });
      const patient = storage.head("y");
      await started;
      controller.abort();
      expect(codeOf(await rejectionOf(abandoned))).toBe("MS_ABORTED");
      releaseToken();
      expect(await patient).toBeUndefined();
    });
  });

  describe("token edge cases", () => {
    it("retries the token refresh after a network error, up to maxRetries", async () => {
      let tokenCalls = 0;
      const flaky = fetchWith({
        "/oauth2/token": async (url, init) => {
          tokenCalls++;
          if (tokenCalls === 1) throw new TypeError("socket hang up");
          return fetch(url, init);
        },
      });
      expect(await adapterOn(server, { fetch: flaky }).head("x")).toBeUndefined();
      expect(tokenCalls).toBe(2);

      let downCalls = 0;
      const down = fetchWith({
        "/oauth2/token": async () => {
          downCalls++;
          throw new TypeError("connect ECONNREFUSED");
        },
      });
      const error = await rejectionOf(adapterOn(server, { fetch: down, maxRetries: 1 }).head("x"));
      expect(codeOf(error)).toBe("MS_STORAGE_IO");
      expect(downCalls).toBe(2);
    });

    it("passes a refused token refresh through to a caller with a signal", async () => {
      const refreshToken = server.issueRefreshToken();
      server.revokeRefreshToken(refreshToken);
      const storage = adapterOn(server, { refreshToken });
      const error = await rejectionOf(storage.head("x", { signal: new AbortController().signal }));
      expect(codeOf(error)).toBe("MS_STORAGE_FORBIDDEN");
    });

    it("renews an expired token once when several requests find it expired together", async () => {
      const storage = adapterOn(server);
      await storage.head("warm-up");
      server.expireAccessTokens();
      const start = server.requests.length;
      await Promise.all([storage.head("a"), storage.head("b"), storage.head("c")]);
      expect(countSince(server, start, "/oauth2/token")).toBe(1);
    });

    it("takes the app key from MONGOSHIELD_DROPBOX_CLIENT_ID when no clientId is given", async () => {
      vi.stubEnv("MONGOSHIELD_DROPBOX_CLIENT_ID", server.clientId);
      try {
        const storage = dropboxStorage({
          folder: uniqueFolder(),
          refreshToken: server.issueRefreshToken(),
          endpoints: server.endpoints,
        });
        const start = server.requests.length;
        expect(await storage.head("x")).toBeUndefined();
        const refresh = server.requests
          .slice(start)
          .find((request) => request.endpoint === "/oauth2/token");
        expect(refresh?.arg).toMatchObject({ client_id: server.clientId });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("space edge cases", () => {
    it("reports the team pool when a team member has no limit of their own", async () => {
      const team = await startFakeDropboxServer({
        spaceAllocation: {
          ".tag": "team",
          allocated: 10_000,
          used: 4_000,
          user_within_team_space_allocated: 0,
        },
      });
      try {
        expect(await adapterOn(team).space()).toEqual({
          totalBytes: 10_000,
          usedBytes: 4_000,
          freeBytes: 6_000,
        });
      } finally {
        await team.close();
      }
    });

    it("reports only the usage for an unknown allocation kind, and nothing without figures", async () => {
      const other = await startFakeDropboxServer({ spaceAllocation: { ".tag": "other" } });
      try {
        const storage = adapterOn(other);
        await storage.put("a", Buffer.alloc(100));
        expect(await storage.space()).toEqual({ usedBytes: 100 });
        other.fail("users/get_space_usage", { status: 200, body: null });
        expect(await storage.space()).toBeUndefined();
        const silent = adapterOn(other, {
          fetch: fetchWith({
            "users/get_space_usage": async () => new Response("", { status: 200 }),
          }),
        });
        expect(await silent.space()).toBeUndefined();
      } finally {
        await other.close();
      }
    });
  });

  describe("options", () => {
    it("rejects negative or fractional retry and timeout settings", () => {
      const invalid: [Partial<DropboxStorageOptions>, string][] = [
        [{ maxRetries: -1 }, "maxRetries"],
        [{ retryBaseDelayMs: 1.5 }, "retryBaseDelayMs"],
        [{ requestTimeoutMs: Number.NaN }, "requestTimeoutMs"],
      ];
      for (const [options, name] of invalid) {
        expect(() => adapterOn(server, options)).toThrow(new RegExp(`Invalid Dropbox ${name}`));
      }
      expect(() =>
        adapterOn(server, { maxRetries: 0, retryBaseDelayMs: 0, requestTimeoutMs: 0 }),
      ).not.toThrow();
    });
  });

  describe("dropboxStorageFromUrl", () => {
    const env = (extra: Record<string, string> = {}) => ({
      MONGOSHIELD_DROPBOX_TOKEN: "refresh-token",
      MONGOSHIELD_DROPBOX_CLIENT_ID: "my-app-key",
      ...extra,
    });

    it("reads the folder from the URL and the token from MONGOSHIELD_DROPBOX_TOKEN", () => {
      const storage = dropboxStorageFromUrl(new URL("dropbox://prod/My%20Backups"), env());
      expect(storage.kind).toBe("dropbox");
      expect(storage.location).toBe("dropbox://prod/My Backups/");
      expect(storage.location).not.toContain("refresh-token");
      expect(storage.capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: false,
      });
    });

    it("refreshes with MONGOSHIELD_DROPBOX_TOKEN, _CLIENT_ID and _CLIENT_SECRET", async () => {
      const own = await startFakeDropboxServer({ clientId: "my-app-key" });
      // The URL form always talks to the real Dropbox hosts; send those requests to the fake.
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        return realFetch(`${own.url}${url.pathname}`, init);
      });
      try {
        const refreshToken = own.issueRefreshToken();
        const storage = dropboxStorageFromUrl(
          new URL("dropbox://from-url"),
          env({
            MONGOSHIELD_DROPBOX_TOKEN: refreshToken,
            MONGOSHIELD_DROPBOX_CLIENT_SECRET: "s3cret",
          }),
        );
        await storage.put("x", Buffer.from("x"));
        expect(own.filePaths()).toEqual(["/from-url/x"]);
        const refresh = own.requests.find((request) => request.endpoint === "/oauth2/token");
        expect(refresh?.arg).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: "my-app-key",
          client_secret: "s3cret",
        });
      } finally {
        vi.unstubAllGlobals();
        await own.close();
      }
    });

    it("fails with a login hint when MONGOSHIELD_DROPBOX_TOKEN is missing", () => {
      const error = (() => {
        try {
          dropboxStorageFromUrl(new URL("dropbox://backups"), {
            MONGOSHIELD_DROPBOX_CLIENT_ID: "x",
          });
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(codeOf(error)).toBe("MS_CONFIG_INVALID");
      expect(isMongoShieldError(error) && error.hint).toMatch(/mongoshield login dropbox/);
    });

    it("fails with a hint when no app key is shipped or configured", async () => {
      const fresh = await withoutShippedClient("dropbox", () => import("./dropbox.ts"));
      expect(() =>
        fresh.dropboxStorageFromUrl(new URL("dropbox://backups"), {
          MONGOSHIELD_DROPBOX_TOKEN: "t",
        }),
      ).toThrow(/No Dropbox app key/);
    });

    it("refuses a URL of another scheme", () => {
      expect(() => dropboxStorageFromUrl(new URL("gdrive://backups"), env())).toThrow(
        /Not a dropbox:\/\/ URL/,
      );
    });

    it("rejects credentials, unknown parameters and an empty folder", () => {
      expect(() => dropboxStorageFromUrl(new URL("dropbox://user:pass@backups"), env())).toThrow(
        /credentials/,
      );
      expect(() => dropboxStorageFromUrl(new URL("dropbox://backups?token=x"), env())).toThrow(
        /Unknown/,
      );
      expect(() => dropboxStorageFromUrl(new URL("dropbox://"), env())).toThrow(/folder is empty/);
      expect(() => dropboxStorageFromUrl(new URL("dropbox://a/../b"), env())).not.toThrow();
      expect(() => dropboxStorageFromUrl(new URL("dropbox://a%2F..%2Fb"), env())).toThrow(
        /Invalid Dropbox folder/,
      );
    });
  });
});
