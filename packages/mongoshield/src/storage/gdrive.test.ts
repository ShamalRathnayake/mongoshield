/**
 * Tests for the `gdrive://` adapter against an in-process fake of the Drive API
 * (test/helpers/fake-gdrive-server.ts), over real HTTP: the storage conformance
 * suite, then the Drive-specific behaviour (app folder, folder mapping, uploads,
 * duplicate names, retries, quota, tokens and URL parsing).
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type FakeGdriveServer,
  startFakeGdriveServer,
} from "../../test/helpers/fake-gdrive-server.ts";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import { isConditionalWritesUnsupported } from "./conditional-writes.ts";
import { type GdriveStorageOptions, gdriveStorage, gdriveStorageFromUrl } from "./gdrive.ts";

const KIB = 1024;
const CHUNK = 256 * KIB;
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

describeStorageConformance("gdrive", async () => {
  const server = await startFakeGdriveServer();
  // Small pages and chunks, so paging and multi-chunk uploads are exercised throughout.
  server.pageSizeLimit = 3;
  const storage = gdriveStorage({
    folder: "conformance",
    chunkSize: CHUNK,
    ...server.adapterOptions(),
  });
  return { storage, cleanup: () => server.close() };
});

/** Reads a whole stream into one buffer. */
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

/** The error a promise rejects with. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/** One request the adapter makes, as an interceptor sees it. */
interface Intercepted {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly init: RequestInit | undefined;
  /** Sends the request (or a changed copy of it) on to the fake server. */
  forward(init?: RequestInit): Promise<Response>;
}

/**
 * A `fetch` in front of the fake server, for answers the fake does not give by itself
 * (odd JSON, lost connections, a server that ignores `Range`). `around` returns its
 * own Response, or `request.forward()` to pass the request through.
 */
function interceptedFetch(around: (request: Intercepted) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    return around({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      init,
      forward: (changed) => fetch(url, changed ?? init),
    });
  };
}

/** A copy of a JSON response with its body changed by `change`. */
async function withJson(
  response: Response,
  change: (body: Record<string, unknown>) => unknown,
): Promise<Response> {
  const body = (await response.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(change(body)), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

/** Changes every file resource of a `files.list` answer. */
function mapListedFiles(
  body: Record<string, unknown>,
  change: (file: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const files = Array.isArray(body.files) ? (body.files as Record<string, unknown>[]) : [];
  return { ...body, files: files.map(change) };
}

/** True for a `files.list` request. */
function isList(request: Intercepted): boolean {
  return request.method === "GET" && request.url.pathname === "/drive/v3/files";
}

/** True for a resumable-upload chunk (a PUT with a body; status queries send none). */
function isChunk(request: Intercepted): boolean {
  return (
    request.method === "PUT" && !/^bytes \*\//.test(request.headers.get("content-range") ?? "")
  );
}

/** A body stream that fails at once, like a connection reset mid-response. */
function brokenBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error("socket hang up"));
    },
  });
}

describe("gdrive storage", () => {
  let server: FakeGdriveServer;

  beforeEach(async () => {
    server = await startFakeGdriveServer();
  });
  afterEach(async () => {
    await server.close();
  });

  function storageFor(extra: Partial<GdriveStorageOptions> = {}) {
    return gdriveStorage({ folder: "prod", ...server.adapterOptions(), ...extra });
  }

  /** Files (not folders) stored under a name. */
  function filesNamed(name: string) {
    return [...server.files.values()].filter(
      (file) => file.name === name && file.mimeType !== FOLDER_MIME_TYPE,
    );
  }

  function requestsMatching(method: string, path: string) {
    return server.requests.filter((request) => request.method === method && request.path === path);
  }

  describe("identity", () => {
    it("is kind gdrive at gdrive://<folder>/ and has no conditional writes or storage lock", () => {
      const storage = storageFor({ folder: "acme/prod" });
      expect(storage.kind).toBe("gdrive");
      expect(storage.location).toBe("gdrive://acme/prod/");
      expect(storage.capabilities).toEqual({
        conditionalWrites: false,
        rangeReads: true,
        objectLock: false,
        storageLock: false,
      });
    });

    it("never puts the token in the location", () => {
      expect(storageFor().location).not.toContain(server.refreshToken);
    });
  });

  describe("the app folder", () => {
    it("is created once in My Drive with a private marker", async () => {
      const storage = storageFor();
      await storage.put("a.txt", Buffer.from("a"));
      await storage.put("b.txt", Buffer.from("b"));
      const appFolders = [...server.files.values()].filter((file) => file.name === "MongoShield");
      expect(appFolders).toHaveLength(1);
      expect(appFolders[0]?.parents).toEqual(["root-folder"]);
      expect(appFolders[0]?.appProperties).toEqual({ mongoshield: "app-folder" });
    });

    it("is found again by its marker, even after the user renames it", async () => {
      await storageFor().put("a.txt", Buffer.from("first run"));
      const appFolder = [...server.files.values()].find((file) => file.name === "MongoShield");
      if (!appFolder) throw new Error("no app folder");
      server.files.set(appFolder.id, { ...appFolder, name: "My backups" });

      // A new adapter instance (a later run) keeps no state from the first one.
      const later = storageFor();
      expect((await readAll(await later.get("a.txt"))).toString()).toBe("first run");
      expect([...server.files.values()].filter((file) => file.name === "MongoShield")).toHaveLength(
        0,
      );
    });

    it("uses the appFolderName option for a new app folder", async () => {
      await storageFor({ appFolderName: "Backups by MongoShield" }).put("a", Buffer.from("x"));
      expect(
        [...server.files.values()].some((file) => file.name === "Backups by MongoShield"),
      ).toBe(true);
    });
  });

  describe("keys and folders", () => {
    it("maps each key to nested folders plus a file", async () => {
      const storage = storageFor({ folder: "acme/prod" });
      await storage.put("backups/2026-11-05T03-00-00Z_abcdef/app/users.bson.zst", Buffer.from("x"));
      const [file] = filesNamed("users.bson.zst");
      if (!file) throw new Error("no file");
      expect(server.pathOf(file.id)).toBe(
        "MongoShield/acme/prod/backups/2026-11-05T03-00-00Z_abcdef/app/users.bson.zst",
      );
      for (const id of file.parents) expect(server.files.get(id)?.mimeType).toBe(FOLDER_MIME_TYPE);
    });

    it("looks folders up once per adapter instance", async () => {
      const storage = storageFor();
      await storage.put("backups/one/a.bin", Buffer.from("a"));
      const listsAfterFirst = requestsMatching("GET", "/drive/v3/files").length;
      await storage.put("backups/one/b.bin", Buffer.from("b"));
      // Only the duplicate check of the new file's name; no folder lookups.
      expect(requestsMatching("GET", "/drive/v3/files").length - listsAfterFirst).toBe(1);
    });

    it("creates a folder once when puts into it run concurrently", async () => {
      const storage = storageFor();
      await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          storage.put(`shared/dir/object-${index}`, Buffer.from(String(index))),
        ),
      );
      const dirs = [...server.files.values()].filter((file) => file.name === "dir");
      expect(dirs).toHaveLength(1);
    });

    it("reads duplicate folders (from two runs racing) as one", async () => {
      const storage = storageFor();
      await storage.put("backups/a/one.bin", Buffer.from("1"));
      const [backups] = [...server.files.values()].filter((file) => file.name === "backups");
      if (!backups) throw new Error("no backups folder");
      // Another process created a second "backups" folder and wrote into it.
      const duplicate = server.addFile({ name: "backups", parents: backups.parents });
      const sub = server.addFile({ name: "b", parents: [duplicate.id] });
      server.addFile({ name: "two.bin", parents: [sub.id], data: Buffer.from("2") });

      const fresh = storageFor();
      expect((await collect(fresh.list("backups/"))).map((info) => info.key)).toEqual([
        "backups/a/one.bin",
        "backups/b/two.bin",
      ]);
      expect(await collect(fresh.listPrefixes("backups/"))).toEqual(["backups/a/", "backups/b/"]);
      expect((await readAll(await fresh.get("backups/b/two.bin"))).toString()).toBe("2");
    });

    it("does not report empty folders as prefixes", async () => {
      const storage = storageFor();
      await storage.put("keep/x.bin", Buffer.from("x"));
      const [keep] = [...server.files.values()].filter((file) => file.name === "keep");
      if (!keep) throw new Error("no folder");
      server.addFile({ name: "empty", parents: keep.parents });
      expect(await collect(storage.listPrefixes(""))).toEqual(["keep/"]);
    });
  });

  describe("uploads", () => {
    it("sends small objects as one multipart request", async () => {
      await storageFor().put("small.bin", Buffer.alloc(1000, 1));
      const uploads = server.requests.filter(
        (request) => request.path === "/upload/drive/v3/files",
      );
      expect(uploads.map((request) => request.query.get("uploadType"))).toEqual(["multipart"]);
    });

    it("sends small streams as one multipart request too", async () => {
      await storageFor().put("small.bin", Readable.from([Buffer.from("a"), Buffer.from("b")]));
      const uploads = server.requests.filter(
        (request) => request.path === "/upload/drive/v3/files",
      );
      expect(uploads.map((request) => request.query.get("uploadType"))).toEqual(["multipart"]);
    });

    it("uploads large objects resumably in chunks of chunkSize, a multiple of 256 KiB", async () => {
      const storage = storageFor({ chunkSize: 2 * CHUNK });
      const data = Buffer.alloc(6 * 1024 * KIB + 123, 7);
      const info = await storage.put("big.bin", data);
      expect(info.size).toBe(data.length);
      const ranges = server.requests
        .filter((request) => request.method === "PUT")
        .map((request) => request.headers["content-range"]);
      expect(ranges[0]).toBe(`bytes 0-${2 * CHUNK - 1}/*`);
      expect(ranges.at(-1)).toBe(`bytes ${24 * CHUNK}-${data.length - 1}/${data.length}`);
      expect(ranges).toHaveLength(13);
      expect((await readAll(await storage.get("big.bin"))).equals(data)).toBe(true);
    });

    it("streams with backpressure, never reading far ahead of what Drive has", async () => {
      const total = 4 * 1024 * KIB;
      let produced = 0;
      let maxAhead = 0;
      const body = new Readable({
        highWaterMark: 64 * KIB,
        read() {
          if (produced >= total) {
            this.push(null);
            return;
          }
          produced += 64 * KIB;
          this.push(Buffer.alloc(64 * KIB, 3));
        },
      });
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: async (input, init) => {
          const range = new Headers(init?.headers).get("content-range");
          const sentUpTo = Number(/^bytes \d+-(\d+)/.exec(range ?? "")?.[1] ?? -1) + 1;
          if (sentUpTo > 0) maxAhead = Math.max(maxAhead, produced - sentUpTo);
          return fetch(input, init);
        },
      });
      await storage.put("streamed.bin", body);
      // One chunk in flight plus the stream's own small buffer, never the whole object.
      expect(maxAhead).toBeLessThanOrEqual(CHUNK + 4 * 64 * KIB);
      expect((await storage.head("streamed.bin"))?.size).toBe(total);
    });

    it("sends again the part of a chunk Drive did not keep", async () => {
      server.failNext({
        match: (request) => request.method === "PUT",
        keepPartialChunk: true,
      });
      const storage = storageFor({ chunkSize: 4 * CHUNK });
      const data = Buffer.from(Array.from({ length: 9 * CHUNK }, (_, index) => index % 251));
      await storage.put("partial.bin", data);
      expect((await readAll(await storage.get("partial.bin"))).equals(data)).toBe(true);
      const ranges = server.requests
        .filter((request) => request.method === "PUT")
        .map((request) => request.headers["content-range"]);
      expect(ranges[1]).toBe(`bytes ${CHUNK}-${4 * CHUNK - 1}/*`);
    });

    it("asks Drive how much it has after a failed chunk, then resumes", async () => {
      server.failNext({
        match: (request) => request.method === "PUT" && request.headers["content-length"] !== "0",
        status: 503,
      });
      const storage = storageFor({ chunkSize: CHUNK });
      const data = Buffer.alloc(3 * CHUNK, 9);
      await storage.put("resumed.bin", data);
      expect((await readAll(await storage.get("resumed.bin"))).equals(data)).toBe(true);
      const ranges = server.requests
        .filter((request) => request.method === "PUT")
        .map((request) => request.headers["content-range"]);
      expect(ranges[1]).toBe("bytes */*");
    });

    it("stores the content type it is given", async () => {
      await storageFor().put("doc.json", Buffer.from("{}"), { contentType: "application/json" });
      expect(filesNamed("doc.json")[0]?.mimeType).toBe("application/json");
    });

    it("fails a conditional put with the 'conditional writes unsupported' error, unread", async () => {
      let read = false;
      const body = new Readable({
        read() {
          read = true;
          this.push(null);
        },
      });
      const error = await rejectionOf(storageFor().put("lock", body, { ifNoneMatch: "*" }));
      expect(isConditionalWritesUnsupported(error)).toBe(true);
      expect(read).toBe(false);
      expect(filesNamed("lock")).toHaveLength(0);
    });

    it("reports a full drive as MS_STORAGE_INSUFFICIENT_SPACE", async () => {
      server.quota.limit = 100;
      const error = await rejectionOf(storageFor().put("big.bin", Buffer.alloc(500)));
      expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    });
  });

  describe("duplicate names", () => {
    it("keeps exactly one file after an overwrite", async () => {
      const storage = storageFor();
      await storage.put("manifest.json", Buffer.from("old"));
      await storage.put("manifest.json", Buffer.from("new"));
      expect(filesNamed("manifest.json")).toHaveLength(1);
      expect((await readAll(await storage.get("manifest.json"))).toString()).toBe("new");
    });

    it("reads the newest of several same-named files, and lists the key once", async () => {
      const storage = storageFor();
      await storage.put("state.json", Buffer.from("older"));
      const [first] = filesNamed("state.json");
      if (!first) throw new Error("no file");
      server.addFile({ name: "state.json", parents: first.parents, data: Buffer.from("newer!") });

      expect((await readAll(await storage.get("state.json"))).toString()).toBe("newer!");
      expect((await storage.head("state.json"))?.size).toBe(6);
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual(["state.json"]);
    });

    it("deletes every copy of a key", async () => {
      const storage = storageFor();
      await storage.put("dup.bin", Buffer.from("1"));
      const [first] = filesNamed("dup.bin");
      if (!first) throw new Error("no file");
      server.addFile({ name: "dup.bin", parents: first.parents, data: Buffer.from("2") });
      await storage.delete(["dup.bin"]);
      expect(filesNamed("dup.bin")).toHaveLength(0);
      expect(await storage.head("dup.bin")).toBeUndefined();
    });

    it("keeps the newest when concurrent overwrites of one key race", async () => {
      const storage = storageFor();
      await Promise.all(
        ["a", "b", "c", "d"].map((value) => storage.put("race.txt", Buffer.from(value))),
      );
      expect(filesNamed("race.txt")).toHaveLength(1);
    });
  });

  describe("reads", () => {
    it("reads ranges with alt=media and a Range header", async () => {
      const storage = storageFor();
      await storage.put("digits.txt", Buffer.from("0123456789"));
      const part = await readAll(await storage.get("digits.txt", { range: { start: 3, end: 6 } }));
      expect(part.toString()).toBe("3456");
      const download = server.requests.find((request) => request.query.get("alt") === "media");
      expect(download?.headers.range).toBe("bytes=3-6");
    });

    it("returns nothing for a range past the end", async () => {
      const storage = storageFor();
      await storage.put("short.txt", Buffer.from("abc"));
      expect(await readAll(await storage.get("short.txt", { range: { start: 10 } }))).toHaveLength(
        0,
      );
    });

    it("lists across many pages in key order", async () => {
      server.pageSizeLimit = 2;
      const storage = storageFor();
      const keys = Array.from({ length: 9 }, (_, index) => `many/item-${index}.bin`);
      for (const key of [...keys].reverse()) await storage.put(key, Buffer.from(key));
      expect((await collect(storage.list("many/"))).map((info) => info.key)).toEqual(keys);
    });

    it("reports md5Checksum as the etag", async () => {
      const storage = storageFor();
      const info = await storage.put("hashed.txt", Buffer.from("hello"));
      expect(info.etag).toBe("5d41402abc4b2a76b9719d911017c592");
    });
  });

  describe("deletes", () => {
    it("deletes permanently and removes folders it left empty, except the first level", async () => {
      const storage = storageFor();
      await storage.put("backups/2026-a/app/users.bson", Buffer.from("u"));
      await storage.put("backups/2026-a/manifest.json", Buffer.from("m"));
      await storage.put("backups/2026-b/manifest.json", Buffer.from("m"));
      await storage.delete(["backups/2026-a/app/users.bson", "backups/2026-a/manifest.json"]);

      const names = [...server.files.values()].map((file) => file.name);
      expect(names).not.toContain("2026-a");
      expect(names).not.toContain("app");
      expect(names).toContain("2026-b");
      await storage.delete(["backups/2026-b/manifest.json"]);
      expect([...server.files.values()].map((file) => file.name)).toContain("backups");
      // Deletes go straight to files.delete (permanent), never to the trash.
      expect(server.requests.some((request) => request.method === "PATCH")).toBe(false);
    });

    it("can write again into a folder it removed", async () => {
      const storage = storageFor();
      await storage.put("x/y/z.bin", Buffer.from("1"));
      await storage.delete(["x/y/z.bin"]);
      await storage.put("x/y/z.bin", Buffer.from("2"));
      expect((await readAll(await storage.get("x/y/z.bin"))).toString()).toBe("2");
    });
  });

  describe("rate limits and retries", () => {
    it("retries 403 userRateLimitExceeded and rateLimitExceeded", async () => {
      server.failNext({ status: 403, reason: "userRateLimitExceeded" });
      server.failNext({ status: 403, reason: "rateLimitExceeded" });
      await storageFor().put("a.bin", Buffer.from("a"));
      expect(filesNamed("a.bin")).toHaveLength(1);
    });

    it("retries 429 and waits as long as Retry-After says", async () => {
      server.failNext({ status: 429, retryAfter: "0" });
      server.failNext({ status: 500 });
      expect(await storageFor().head("missing")).toBeUndefined();
    });

    it("gives up after `retries` attempts with the rate-limit hint", async () => {
      server.failNext({ status: 403, reason: "userRateLimitExceeded", times: 10 });
      const error = await rejectionOf(storageFor({ retries: 2 }).head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/quota/);
    });

    it("does not retry other 403s", async () => {
      server.failNext({ status: 403, reason: "insufficientFilePermissions" });
      const error = await rejectionOf(storageFor().head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });
  });

  describe("tokens", () => {
    it("exchanges the refresh token once and reuses the access token", async () => {
      const storage = storageFor();
      await storage.put("a", Buffer.from("a"));
      await storage.put("b", Buffer.from("b"));
      expect(requestsMatching("POST", "/token")).toHaveLength(1);
    });

    it("gets a new access token after a 401", async () => {
      const storage = storageFor();
      await storage.put("a", Buffer.from("a"));
      server.expireAccessTokens();
      expect(await storage.head("a")).toBeDefined();
      expect(requestsMatching("POST", "/token")).toHaveLength(2);
    });

    it("fails with MS_STORAGE_FORBIDDEN and a login hint when the token was revoked", async () => {
      const storage = storageFor();
      server.revokeRefreshToken();
      const error = await rejectionOf(storage.head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/mongoshield login gdrive/);
      expect(String(error)).not.toContain(server.refreshToken);
    });

    it("accepts an access token function instead of a refresh token", async () => {
      const issued = await fetch(server.tokenUrl, {
        method: "POST",
        body: new URLSearchParams({
          client_id: server.clientId,
          client_secret: server.clientSecret,
          refresh_token: server.refreshToken,
          grant_type: "refresh_token",
        }),
      }).then((response) => response.json() as Promise<{ access_token: string }>);
      const storage = gdriveStorage({
        folder: "prod",
        apiUrl: server.endpoint,
        accessToken: async () => issued.access_token,
      });
      await storage.put("a", Buffer.from("a"));
      expect(await storage.head("a")).toBeDefined();
    });
  });

  describe("space", () => {
    it("reports the quota from about.get, with the trash", async () => {
      server.quota = { limit: 15_000, otherUsage: 1_000, trash: 500 };
      const storage = storageFor();
      await storage.put("a.bin", Buffer.alloc(200));
      expect(await storage.space()).toEqual({
        totalBytes: 15_000,
        usedBytes: 1_700,
        freeBytes: 13_300,
        trashBytes: 500,
      });
    });

    it("omits total and free for unlimited accounts", async () => {
      expect(await storageFor().space()).toEqual({ usedBytes: 0, trashBytes: 0 });
    });
  });

  describe("cancellation", () => {
    it("rejects with MS_ABORTED when aborted before a request", async () => {
      const error = await rejectionOf(storageFor().space({ signal: AbortSignal.abort() }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });
  });

  describe("options", () => {
    it("rejects a chunk size that is not a multiple of 256 KiB", () => {
      expect(() => storageFor({ chunkSize: 300 * KIB })).toThrow(/multiple of 256 KiB/);
    });

    it("rejects invalid folders", () => {
      expect(() => storageFor({ folder: "../escape" })).toThrow(/Invalid Google Drive folder/);
      expect(() => storageFor({ folder: "" })).toThrow(/Invalid Google Drive folder/);
    });

    it("needs a refresh token and client id, or an access token", () => {
      expect(() => gdriveStorage({ folder: "x" })).toThrow(/refreshToken/);
    });

    it("rejects invalid retry and concurrency settings", () => {
      expect(() => storageFor({ retries: -1 })).toThrow(/retries/);
      expect(() => storageFor({ deleteConcurrency: 0 })).toThrow(/deleteConcurrency/);
    });

    it("rejects invalid timeouts, backoff and chunk sizes with MS_CONFIG_INVALID", () => {
      const invalid: Partial<GdriveStorageOptions>[] = [
        { requestTimeoutMs: 0 },
        { requestTimeoutMs: 1.5 },
        { retryBaseMs: -1 },
        { retryBaseMs: Number.NaN },
        { deleteConcurrency: 2.5 },
        { chunkSize: 0 },
        { chunkSize: -CHUNK },
        { chunkSize: Number.POSITIVE_INFINITY },
      ];
      for (const extra of invalid) {
        const error = (() => {
          try {
            storageFor(extra);
          } catch (caught) {
            return caught;
          }
          return undefined;
        })();
        expect(isMongoShieldError(error, "MS_CONFIG_INVALID"), JSON.stringify(extra)).toBe(true);
      }
    });

    it("rejects a folder that is not a string", () => {
      expect(() => storageFor({ folder: 42 as never })).toThrow(/Invalid Google Drive folder "42"/);
    });

    it("trims slashes around the folder", () => {
      expect(storageFor({ folder: "/acme/prod/" }).location).toBe("gdrive://acme/prod/");
    });
  });

  describe("resumable upload recovery", () => {
    /** Three chunks of CHUNK bytes, with a pattern so lost or doubled bytes show. */
    const data = Buffer.from(Array.from({ length: 3 * CHUNK }, (_, index) => index % 253));

    /** The Content-Range of every upload PUT the adapter sent (forwarded or not). */
    function recordRanges(ranges: string[], request: Intercepted) {
      if (request.method === "PUT") ranges.push(request.headers.get("content-range") ?? "");
    }

    it("resumes from what Drive has after a chunk is lost on the network", async () => {
      const ranges: string[] = [];
      let dropped = false;
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: interceptedFetch(async (request) => {
          recordRanges(ranges, request);
          // The second chunk never arrives: the connection drops.
          if (
            !dropped &&
            isChunk(request) &&
            request.headers.get("content-range")?.startsWith(`bytes ${CHUNK}-`)
          ) {
            dropped = true;
            throw new TypeError("fetch failed");
          }
          return request.forward();
        }),
      });
      await storage.put("lost.bin", data);
      expect((await readAll(await storage.get("lost.bin"))).equals(data)).toBe(true);
      expect(ranges).toEqual([
        `bytes 0-${CHUNK - 1}/*`,
        `bytes ${CHUNK}-${2 * CHUNK - 1}/*`,
        "bytes */*",
        `bytes ${CHUNK}-${2 * CHUNK - 1}/*`,
        `bytes ${2 * CHUNK}-${3 * CHUNK - 1}/${3 * CHUNK}`,
      ]);
    });

    it("fails with MS_STORAGE_IO when a chunk is lost and no retries are allowed", async () => {
      const storage = storageFor({
        chunkSize: CHUNK,
        retries: 0,
        fetch: interceptedFetch(async (request) => {
          if (isChunk(request)) throw new TypeError("fetch failed");
          return request.forward();
        }),
      });
      const error = await rejectionOf(storage.put("lost.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/Could not reach Google Drive: fetch failed/);
      expect(filesNamed("lost.bin")).toHaveLength(0);
    });

    it("gives up after `retries` failed attempts at one chunk", async () => {
      server.failNext({
        match: (request) => request.method === "PUT" && request.headers["content-length"] !== "0",
        status: 503,
        times: 10,
      });
      const error = await rejectionOf(
        storageFor({ chunkSize: CHUNK, retries: 2 }).put("x.bin", data),
      );
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      // The first try and two retries, each retry after asking Drive what it has.
      const chunkAttempts = server.requests.filter(
        (request) => request.method === "PUT" && request.headers["content-length"] !== "0",
      );
      expect(chunkAttempts).toHaveLength(3);
      expect(filesNamed("x.bin")).toHaveLength(0);
    });

    it("does not retry a chunk Drive refuses outright", async () => {
      server.failNext({
        match: (request) => request.method === "PUT",
        status: 403,
        reason: "insufficientFilePermissions",
      });
      const error = await rejectionOf(storageFor({ chunkSize: CHUNK }).put("x.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(server.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
    });

    it("fails with the status query's error when the upload session is gone", async () => {
      server.failNext({
        match: (request) => request.method === "PUT" && request.headers["content-length"] !== "0",
        status: 503,
      });
      server.failNext({
        match: (request) => request.method === "PUT" && request.headers["content-length"] === "0",
        status: 404,
        reason: "notFound",
      });
      const error = await rejectionOf(storageFor({ chunkSize: CHUNK }).put("x.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(String(error)).toMatch(/Could not write gdrive:\/\/prod\/x\.bin/);
    });

    it("asks for the file when Drive confirms every byte of the last chunk without finishing", async () => {
      const ranges: string[] = [];
      let answeredIncomplete = false;
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: interceptedFetch(async (request) => {
          recordRanges(ranges, request);
          const range = request.headers.get("content-range") ?? "";
          const response = await request.forward();
          if (!answeredIncomplete && isChunk(request) && /\/\d+$/.test(range)) {
            answeredIncomplete = true;
            // A 308 for the final chunk, even claiming more bytes than were sent.
            await response.body?.cancel();
            return new Response(null, {
              status: 308,
              headers: { range: `bytes=0-${3 * CHUNK + 99}` },
            });
          }
          return response;
        }),
      });
      await storage.put("final.bin", data);
      expect(ranges.at(-1)).toBe(`bytes */${3 * CHUNK}`);
      expect((await readAll(await storage.get("final.bin"))).equals(data)).toBe(true);
    });

    it("fails with MS_STORAGE_IO when Drive never finishes the upload", async () => {
      const storage = storageFor({
        chunkSize: CHUNK,
        retries: 2,
        fetch: interceptedFetch(async (request) => {
          const range = request.headers.get("content-range") ?? "";
          // Every answer for the final chunk is "everything received, not done".
          if (request.method === "PUT" && /\/\d+$/.test(range)) {
            return new Response(null, {
              status: 308,
              headers: { range: `bytes=0-${3 * CHUNK - 1}` },
            });
          }
          return request.forward();
        }),
      });
      const error = await rejectionOf(storage.put("never.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/Drive did not finish the upload/);
    });

    it("fails with MS_STORAGE_IO when Drive starts no upload session", async () => {
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: interceptedFetch(async (request) => {
          if (
            request.url.searchParams.get("uploadType") === "resumable" &&
            request.method === "POST"
          ) {
            const response = await request.forward();
            await response.body?.cancel();
            return new Response(null, { status: 200 });
          }
          return request.forward();
        }),
      });
      const error = await rejectionOf(storage.put("x.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/Drive sent no upload session/);
    });

    it("maps a refused upload session to the Drive error", async () => {
      server.failNext({
        match: (request) => request.query.get("uploadType") === "resumable",
        status: 403,
        reason: "storageQuotaExceeded",
      });
      const error = await rejectionOf(storageFor({ chunkSize: CHUNK }).put("x.bin", data));
      expect(isMongoShieldError(error, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
    });
  });

  describe("integrity", () => {
    /** Answers the upload that creates a file with a changed file resource. */
    function corruptingFetch(change: (file: Record<string, unknown>) => Record<string, unknown>) {
      return interceptedFetch(async (request) => {
        const response = await request.forward();
        const createsFile =
          request.url.pathname === "/upload/drive/v3/files" &&
          (request.url.searchParams.get("uploadType") === "multipart" ||
            (isChunk(request) && /\/\d+$/.test(request.headers.get("content-range") ?? "")));
        return createsFile && response.status === 200 ? withJson(response, change) : response;
      });
    }

    it("fails with MS_INTEGRITY_FAILED and deletes the new file when Drive's MD5 differs", async () => {
      const storage = storageFor({
        fetch: corruptingFetch((file) => ({ ...file, md5Checksum: "0".repeat(32) })),
      });
      const error = await rejectionOf(storage.put("bad.bin", Buffer.from("payload")));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/corrupted in transit/);
      expect(filesNamed("bad.bin")).toHaveLength(0);
    });

    it("still reports MS_INTEGRITY_FAILED when the corrupted file cannot be deleted", async () => {
      server.failNext({
        match: (request) => request.method === "DELETE",
        status: 403,
        reason: "insufficientFilePermissions",
      });
      const storage = storageFor({
        fetch: corruptingFetch((file) => ({ ...file, md5Checksum: "0".repeat(32) })),
      });
      const error = await rejectionOf(storage.put("bad.bin", Buffer.from("payload")));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    });

    it("checks the MD5 of a resumable upload too", async () => {
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: corruptingFetch((file) => ({ ...file, md5Checksum: "f".repeat(32) })),
      });
      const error = await rejectionOf(storage.put("bad.bin", Buffer.alloc(2 * CHUNK + 1, 5)));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
      expect(filesNamed("bad.bin")).toHaveLength(0);
    });

    it("fails when Drive reports a different size, even with a matching MD5", async () => {
      const storage = storageFor({ fetch: corruptingFetch((file) => ({ ...file, size: "1" })) });
      const error = await rejectionOf(storage.put("short.bin", Buffer.from("payload")));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    });

    it("leaves the old object in place when a corrupted overwrite is refused", async () => {
      await storageFor().put("state.json", Buffer.from("old"));
      const storage = storageFor({
        fetch: corruptingFetch((file) => ({ ...file, md5Checksum: "0".repeat(32) })),
      });
      await rejectionOf(storage.put("state.json", Buffer.from("new")));
      expect(filesNamed("state.json")).toHaveLength(1);
      expect((await readAll(await storageFor().get("state.json"))).toString()).toBe("old");
    });

    it("accepts an upload Drive reports without an MD5 or size, and uses the bytes sent", async () => {
      const storage = storageFor({
        fetch: corruptingFetch(({ md5Checksum: _md5, size: _size, ...file }) => file),
      });
      const info = await storage.put("plain.bin", Buffer.from("12345"));
      expect(info.size).toBe(5);
      expect(info.etag).toBeUndefined();
    });
  });

  describe("range reads", () => {
    /** 300 KiB, so a download arrives in several pieces. */
    const data = Buffer.from(Array.from({ length: 300 * KIB }, (_, index) => index % 249));

    /** A fetch whose downloads ignore Range, as some proxies do: always the whole file. */
    function rangeIgnoringFetch() {
      return interceptedFetch(async (request) => {
        if (request.url.searchParams.get("alt") !== "media") return request.forward();
        const headers = new Headers(request.headers);
        headers.delete("range");
        return request.forward({ ...request.init, headers });
      });
    }

    it("cuts the range out itself when Drive sends the whole file", async () => {
      await storageFor().put("big.bin", data);
      const storage = storageFor({ fetch: rangeIgnoringFetch() });
      const middle = await readAll(
        await storage.get("big.bin", { range: { start: 100_000, end: 200_000 } }),
      );
      expect(middle.equals(data.subarray(100_000, 200_001))).toBe(true);
      const tail = await readAll(await storage.get("big.bin", { range: { start: 250_000 } }));
      expect(tail.equals(data.subarray(250_000))).toBe(true);
      const head = await readAll(await storage.get("big.bin", { range: { start: 0, end: 9 } }));
      expect(head.equals(data.subarray(0, 10))).toBe(true);
    });

    it("returns nothing when Drive answers 416 for a range the listing said was there", async () => {
      await storageFor().put("shrunk.bin", Buffer.from("0123456789"));
      server.failNext({ match: (request) => request.query.get("alt") === "media", status: 416 });
      const part = await readAll(await storageFor().get("shrunk.bin", { range: { start: 5 } }));
      expect(part).toHaveLength(0);
    });

    it("reports a file deleted between lookup and download as MS_STORAGE_NOT_FOUND", async () => {
      await storageFor().put("gone.bin", Buffer.from("x"));
      server.failNext({
        match: (request) => request.query.get("alt") === "media",
        status: 404,
        reason: "notFound",
      });
      const error = await rejectionOf(storageFor().get("gone.bin"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(String(error)).toMatch(/Could not read gdrive:\/\/prod\/gone\.bin/);
    });

    it("reads a range that ends past the end up to the last byte", async () => {
      await storageFor().put("digits.txt", Buffer.from("0123456789"));
      const part = await readAll(
        await storageFor().get("digits.txt", { range: { start: 7, end: 1000 } }),
      );
      expect(part.toString()).toBe("789");
    });

    it("reads an empty file as an empty stream", async () => {
      await storageFor().put("empty.bin", Buffer.alloc(0));
      expect(await readAll(await storageFor().get("empty.bin"))).toHaveLength(0);
    });

    it("fails with MS_STORAGE_NOT_FOUND for a missing key", async () => {
      const error = await rejectionOf(storageFor().get("nothing-here"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });
  });

  describe("paging", () => {
    it("finds and deletes every copy of a key across pages", async () => {
      server.pageSizeLimit = 2;
      const storage = storageFor();
      await storage.put("dup.bin", Buffer.from("0"));
      const [first] = filesNamed("dup.bin");
      if (!first) throw new Error("no file");
      for (let index = 1; index <= 4; index++) {
        server.addFile({
          name: "dup.bin",
          parents: first.parents,
          data: Buffer.from(String(index)),
        });
      }
      // The newest copy wins even when it is on another page.
      expect((await readAll(await storage.get("dup.bin"))).toString()).toBe("4");
      await storage.delete(["dup.bin"]);
      expect(filesNamed("dup.bin")).toHaveLength(0);
      expect(server.requests.some((request) => request.query.has("pageToken"))).toBe(true);
    });

    it("lists prefixes across pages", async () => {
      server.pageSizeLimit = 2;
      const storage = storageFor();
      for (const name of ["e", "c", "a", "d", "b"])
        await storage.put(`${name}/x.bin`, Buffer.from(name));
      expect(await collect(storage.listPrefixes(""))).toEqual(["a/", "b/", "c/", "d/", "e/"]);
    });
  });

  describe("duplicate folders", () => {
    it("writes new files into the oldest of two same-named folders", async () => {
      await storageFor().put("backups/one.bin", Buffer.from("1"));
      const [original] = [...server.files.values()].filter((file) => file.name === "backups");
      if (!original) throw new Error("no backups folder");
      server.addFile({ name: "backups", parents: original.parents });

      await storageFor().put("backups/two.bin", Buffer.from("2"));
      expect(filesNamed("two.bin")[0]?.parents).toEqual([original.id]);
    });

    it("reads two app folders (from two first runs racing) as one, and writes into the oldest", async () => {
      await storageFor().put("first.bin", Buffer.from("1"));
      const [appFolder] = [...server.files.values()].filter((file) => file.name === "MongoShield");
      if (!appFolder) throw new Error("no app folder");
      const second = server.addFile({
        name: "MongoShield",
        parents: appFolder.parents,
        appProperties: { mongoshield: "app-folder" },
      });
      const prod = server.addFile({ name: "prod", parents: [second.id] });
      server.addFile({ name: "second.bin", parents: [prod.id], data: Buffer.from("2") });

      const fresh = storageFor();
      expect((await collect(fresh.list(""))).map((info) => info.key)).toEqual([
        "first.bin",
        "second.bin",
      ]);
      await fresh.put("third.bin", Buffer.from("3"));
      const [third] = filesNamed("third.bin");
      expect(server.pathOf(third?.id ?? "")).toBe("MongoShield/prod/third.bin");
      expect(third?.parents).not.toEqual([prod.id]);
    });

    it("removes every one of duplicate folders a delete left empty", async () => {
      const storage = storageFor();
      await storage.put("backups/run/a.bin", Buffer.from("a"));
      const [run] = [...server.files.values()].filter((file) => file.name === "run");
      if (!run) throw new Error("no run folder");
      const twin = server.addFile({ name: "run", parents: run.parents });
      server.addFile({ name: "b.bin", parents: [twin.id], data: Buffer.from("b") });

      await storageFor().delete(["backups/run/a.bin", "backups/run/b.bin"]);
      expect([...server.files.values()].filter((file) => file.name === "run")).toHaveLength(0);
    });
  });

  describe("deletes and empty folders", () => {
    function folderNames() {
      return [...server.files.values()]
        .filter((file) => file.mimeType === FOLDER_MIME_TYPE)
        .map((file) => file.name);
    }

    it("removes every folder level a delete emptied, up to the first level", async () => {
      const storage = storageFor();
      await storage.put("backups/a/b/c/d.bin", Buffer.from("d"));
      await storage.delete(["backups/a/b/c/d.bin"]);
      expect(folderNames()).toEqual(["MongoShield", "prod", "backups"]);
    });

    it("keeps a folder that still holds another file", async () => {
      const storage = storageFor();
      await storage.put("backups/a/one.bin", Buffer.from("1"));
      await storage.put("backups/a/sub/two.bin", Buffer.from("2"));
      await storage.delete(["backups/a/one.bin"]);
      expect(folderNames()).toContain("a");
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual([
        "backups/a/sub/two.bin",
      ]);
    });

    it("never removes a folder a put in progress writes into", async () => {
      const storage = storageFor();
      await storage.put("backups/x/other.bin", Buffer.from("o"));
      await storage.put("backups/y/other.bin", Buffer.from("o"));
      // Two puts that wait for their data: one into x, one into a folder below y.
      const intoX = new Readable({ read() {} });
      const belowY = new Readable({ read() {} });
      const putX = storage.put("backups/x/slow.bin", intoX);
      const putY = storage.put("backups/y/deep/slow.bin", belowY);

      await storage.delete(["backups/x/other.bin", "backups/y/other.bin"]);
      expect(folderNames()).toEqual(expect.arrayContaining(["x", "y"]));

      intoX.push("late");
      intoX.push(null);
      belowY.push("late");
      belowY.push(null);
      await Promise.all([putX, putY]);
      expect((await readAll(await storage.get("backups/x/slow.bin"))).toString()).toBe("late");
      expect((await readAll(await storage.get("backups/y/deep/slow.bin"))).toString()).toBe("late");
    });

    it("treats keys whose folders do not exist as already deleted", async () => {
      const storage = storageFor();
      await storage.put("keep.bin", Buffer.from("k"));
      await storage.delete(["no/such/folder/file.bin"]);
      expect(server.requests.some((request) => request.method === "DELETE")).toBe(false);
    });

    it("sends nothing for an empty list of keys", async () => {
      await storageFor().delete([]);
      expect(server.requests).toHaveLength(0);
    });

    it("deletes nothing when one key of the batch is invalid", async () => {
      const storage = storageFor();
      await storage.put("a.bin", Buffer.from("a"));
      const error = await rejectionOf(storage.delete(["a.bin", "../escape"]));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(filesNamed("a.bin")).toHaveLength(1);
    });

    it("treats a file that is already gone (404) as deleted", async () => {
      const storage = storageFor();
      await storage.put("racing.bin", Buffer.from("r"));
      server.failNext({
        match: (request) => request.method === "DELETE",
        status: 404,
        reason: "notFound",
      });
      await storage.delete(["racing.bin"]);
    });

    it("fails with the mapped error when Drive refuses to delete a file", async () => {
      const storage = storageFor();
      await storage.put("kept.bin", Buffer.from("k"));
      server.failNext({
        match: (request) => request.method === "DELETE",
        status: 403,
        reason: "insufficientFilePermissions",
      });
      const error = await rejectionOf(storage.delete(["kept.bin"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toMatch(/Could not delete gdrive:\/\/prod\/kept\.bin/);
      expect(filesNamed("kept.bin")).toHaveLength(1);
    });

    it("fails with the mapped error when looking up a key fails", async () => {
      const storage = storageFor();
      await storage.put("a/b.bin", Buffer.from("b"));
      server.failNext({
        match: (request) => request.method === "GET",
        status: 400,
        reason: "invalid",
      });
      const error = await rejectionOf(storage.delete(["a/b.bin"]));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("still succeeds when cleaning up empty folders fails, leaving them in place", async () => {
      const storage = storageFor();
      await storage.put("backups/a/one.bin", Buffer.from("1"));
      await storage.put("backups/b/two.bin", Buffer.from("2"));
      // The check of whether "a" is empty fails…
      server.failNext({
        match: (request) =>
          request.method === "GET" && !(request.query.get("q") ?? "").includes("name ="),
        status: 403,
        reason: "insufficientFilePermissions",
      });
      await storage.delete(["backups/a/one.bin"]);
      expect(folderNames()).toContain("a");
      // …and so does removing "b" once it is empty (only the file's delete succeeds).
      let deletes = 0;
      server.failNext({
        match: (request) => request.method === "DELETE" && deletes++ === 1,
        status: 403,
        reason: "insufficientFilePermissions",
      });
      await storage.delete(["backups/b/two.bin"]);
      expect(filesNamed("two.bin")).toHaveLength(0);
      expect(folderNames()).toContain("b");
    });
  });

  describe("listing", () => {
    it("lists only names that start with a partial prefix", async () => {
      const storage = storageFor();
      for (const key of [
        "backups/2025-12/a",
        "backups/2026-01/a",
        "backups/2026-02/a",
        "backups/x",
      ]) {
        await storage.put(key, Buffer.from(key));
      }
      expect((await collect(storage.list("backups/2026"))).map((info) => info.key)).toEqual([
        "backups/2026-01/a",
        "backups/2026-02/a",
      ]);
      expect(await collect(storage.listPrefixes("backups/2026"))).toEqual([
        "backups/2026-01/",
        "backups/2026-02/",
      ]);
    });

    it("lists nothing under a folder that does not exist", async () => {
      expect(await collect(storageFor().list("nowhere/"))).toEqual([]);
      expect(await collect(storageFor().listPrefixes("nowhere/"))).toEqual([]);
    });

    it("reports a folder whose files are only in deeper folders, but not one with only empty folders", async () => {
      const storage = storageFor();
      await storage.put("deep/a/b/c.bin", Buffer.from("c"));
      await storage.put("hollow/keep.bin", Buffer.from("k"));
      const [hollow] = [...server.files.values()].filter((file) => file.name === "hollow");
      if (!hollow) throw new Error("no folder");
      // An empty folder tree next to it, as a failed upload would leave.
      const shell = server.addFile({ name: "shell", parents: hollow.parents });
      server.addFile({ name: "inner", parents: [shell.id] });
      expect(await collect(storage.listPrefixes(""))).toEqual(["deep/", "hollow/"]);
    });

    it("skips names that are not valid keys (made outside MongoShield)", async () => {
      const storage = storageFor();
      await storage.put("ok/file.bin", Buffer.from("x"));
      const [ok] = [...server.files.values()].filter((file) => file.name === "ok");
      if (!ok) throw new Error("no folder");
      server.addFile({ name: "back\\slash.bin", parents: [ok.id], data: Buffer.from("y") });
      const dotDot = server.addFile({ name: "..", parents: ok.parents });
      server.addFile({ name: "hidden.bin", parents: [dotDot.id], data: Buffer.from("z") });
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual(["ok/file.bin"]);
      expect(await collect(storage.listPrefixes(""))).toEqual(["ok/"]);
    });

    it("fails a listing with the mapped Drive error", async () => {
      const storage = storageFor();
      await storage.put("a/b.bin", Buffer.from("b"));
      server.failNext({
        match: (request) => request.method === "GET",
        status: 403,
        reason: "forbidden",
      });
      expect(
        isMongoShieldError(await rejectionOf(collect(storage.list(""))), "MS_STORAGE_FORBIDDEN"),
      ).toBe(true);
      server.failNext({
        match: (request) => request.method === "GET",
        status: 403,
        reason: "forbidden",
      });
      expect(
        isMongoShieldError(
          await rejectionOf(collect(storage.listPrefixes(""))),
          "MS_STORAGE_FORBIDDEN",
        ),
      ).toBe(true);
    });

    it("picks the copy with the larger id when two copies were created at the same moment", async () => {
      const storage = storageFor();
      await storage.put("tie.bin", Buffer.from("first"));
      const [first] = filesNamed("tie.bin");
      if (!first) throw new Error("no file");
      const second = server.addFile({
        name: "tie.bin",
        parents: first.parents,
        data: Buffer.from("second"),
      });
      server.files.set(second.id, { ...second, createdTime: first.createdTime });
      expect((await readAll(await storage.get("tie.bin"))).toString()).toBe("second");
      expect((await collect(storage.list(""))).map((info) => info.size)).toEqual([6]);
    });

    it("counts a copy with an unreadable createdTime as the oldest", async () => {
      const storage = storageFor();
      await storage.put("odd.bin", Buffer.from("real"));
      const [real] = filesNamed("odd.bin");
      if (!real) throw new Error("no file");
      const odd = server.addFile({
        name: "odd.bin",
        parents: real.parents,
        data: Buffer.from("odd"),
      });
      server.files.set(odd.id, { ...odd, createdTime: "not a date" });
      expect((await readAll(await storage.get("odd.bin"))).toString()).toBe("real");
    });
  });

  describe("odd answers from Drive", () => {
    /** An adapter whose `files.list` answers are changed by `change`. */
    function storageWithListedFiles(
      change: (file: Record<string, unknown>) => Record<string, unknown>,
    ) {
      return storageFor({
        fetch: interceptedFetch(async (request) => {
          const response = await request.forward();
          if (!isList(request) || !response.ok) return response;
          return withJson(response, (body) => mapListedFiles(body, change));
        }),
      });
    }

    it("falls back to createdTime, then to now, for a missing or unreadable modifiedTime", async () => {
      await storageFor().put("t.bin", Buffer.from("t"));
      const [stored] = filesNamed("t.bin");
      const fromCreated = await storageWithListedFiles(
        ({ modifiedTime: _m, ...file }) => file,
      ).head("t.bin");
      expect(fromCreated?.lastModified.toISOString()).toBe(stored?.createdTime);

      const before = Date.now();
      const neither = await storageWithListedFiles(
        ({ modifiedTime: _m, createdTime: _c, ...file }) => file,
      ).head("t.bin");
      expect(neither?.lastModified.getTime()).toBeGreaterThanOrEqual(before);
      const unreadable = await storageWithListedFiles((file) => ({
        ...file,
        modifiedTime: "soon",
      })).head("t.bin");
      expect(unreadable?.lastModified.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("reads a missing or unreadable size as 0 and a missing MD5 as no etag", async () => {
      await storageFor().put("s.bin", Buffer.from("sized"));
      const noSize = await storageWithListedFiles(
        ({ size: _s, md5Checksum: _m, ...file }) => file,
      ).head("s.bin");
      expect(noSize).toMatchObject({ key: "s.bin", size: 0 });
      expect(noSize?.etag).toBeUndefined();
      const badSize = await storageWithListedFiles((file) => ({ ...file, size: "lots" })).head(
        "s.bin",
      );
      expect(badSize?.size).toBe(0);
      // Drive sends int64 as strings, but a number is read the same way.
      const numeric = await storageWithListedFiles((file) => ({ ...file, size: 5 })).head("s.bin");
      expect(numeric?.size).toBe(5);
    });

    it("reads a file without a size as empty", async () => {
      await storageFor().put("n.bin", Buffer.from("data"));
      const storage = storageWithListedFiles(({ size: _s, ...file }) => file);
      expect(await readAll(await storage.get("n.bin", { range: { start: 1 } }))).toHaveLength(0);
    });

    it("fills in a missing name and MIME type", async () => {
      // A listing entry without a name never matches a key, so the listing is empty,
      // and one without a MIME type counts as a file, not a folder.
      await storageFor().put("m.bin", Buffer.from("m"));
      const noName = storageWithListedFiles(({ name: _n, ...file }) => file);
      expect(await collect(noName.list(""))).toEqual([]);
      const noType = storageWithListedFiles(({ mimeType: _t, ...file }) => file);
      expect((await noType.head("m.bin"))?.size).toBe(1);
    });

    it("treats a listing without a files array as empty", async () => {
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          const response = await request.forward();
          return isList(request) ? withJson(response, () => ({ files: "none" })) : response;
        }),
      });
      expect(await storage.head("a")).toBeUndefined();
    });

    it("writes into the folders it just created even when the listing lags behind", async () => {
      // Every files.list answer is empty, as a listing that has not caught up yet.
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          const response = await request.forward();
          return isList(request) ? withJson(response, () => ({ files: [] })) : response;
        }),
      });
      await storage.put("backups/a.bin", Buffer.from("a"));
      const [file] = filesNamed("a.bin");
      expect(server.pathOf(file?.id ?? "")).toBe("MongoShield/prod/backups/a.bin");
    });

    it("fails with MS_STORAGE_IO for a file resource without an id", async () => {
      const storage = storageWithListedFiles(({ id: _id, ...file }) => file);
      await storageFor().put("x.bin", Buffer.from("x"));
      const error = await rejectionOf(storage.head("x.bin"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/sent a file without an id/);
    });

    it("wraps an answer that is not JSON as MS_STORAGE_IO for the operation", async () => {
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          if (!isList(request)) return request.forward();
          return new Response("<html>proxy</html>", { status: 200 });
        }),
      });
      const error = await rejectionOf(storage.head("x.bin"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/Could not stat gdrive:\/\/prod\/x\.bin/);
    });
  });

  describe("error mapping", () => {
    /** An adapter whose `files.list` requests get `response` instead of the fake's answer. */
    function storageAnswering(response: () => Response, extra: Partial<GdriveStorageOptions> = {}) {
      return storageFor({
        ...extra,
        fetch: interceptedFetch(async (request) =>
          isList(request) ? response() : request.forward(),
        ),
      });
    }

    it("maps 404 to MS_STORAGE_NOT_FOUND and other statuses to MS_STORAGE_IO, with Drive's message and status", async () => {
      const notFound = await rejectionOf(
        storageAnswering(() =>
          Response.json(
            { error: { message: "File not found: x.", errors: [{ reason: "notFound" }] } },
            { status: 404 },
          ),
        ).head("a"),
      );
      expect(isMongoShieldError(notFound, "MS_STORAGE_NOT_FOUND")).toBe(true);
      // The failing call is the app folder lookup, a listing of the storage root.
      expect(String(notFound)).toMatch(/Could not list gdrive:\/\/prod\/: File not found: x\./);
      expect((notFound as { details?: unknown }).details).toEqual({
        httpStatus: 404,
        reasons: ["notFound"],
      });

      const badRequest = await rejectionOf(
        storageAnswering(() =>
          Response.json({ error: { message: "Invalid Value" } }, { status: 400 }),
        ).head("a"),
      );
      expect(isMongoShieldError(badRequest, "MS_STORAGE_IO")).toBe(true);
      expect((badRequest as { details?: unknown }).details).toEqual({ httpStatus: 400 });
    });

    it("uses the HTTP status when the error body is not Drive's JSON", async () => {
      for (const body of [
        "<html>Bad Gateway</html>",
        JSON.stringify({ error: { errors: "x" } }),
        "null",
      ]) {
        const error = await rejectionOf(
          storageAnswering(() => new Response(body, { status: 400 })).head("a"),
        );
        expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
        expect(String(error)).toMatch(/: HTTP 400$/);
      }
    });

    it("uses the HTTP status when the error body breaks off", async () => {
      const error = await rejectionOf(
        storageAnswering(() => new Response(brokenBody(), { status: 400 })).head("a"),
      );
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/: HTTP 400$/);
    });

    it("explains a 403 that is not a rate limit with the Drive API hint", async () => {
      server.failNext({ status: 403, reason: "insufficientFilePermissions" });
      const error = await rejectionOf(storageFor().head("a"));
      expect((error as { hint?: string }).hint).toMatch(/Drive API is enabled/);
    });

    it("fails with MS_STORAGE_FORBIDDEN and the login hint for an access token Drive refuses, without echoing it", async () => {
      const storage = gdriveStorage({
        folder: "prod",
        apiUrl: server.endpoint,
        accessToken: "ya29.never-issued",
      });
      const error = await rejectionOf(storage.head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect((error as { hint?: string }).hint).toMatch(/mongoshield login gdrive/);
      expect(String(error)).not.toContain("ya29.never-issued");
      // A fixed token cannot be refreshed: one retry after the 401, then the error.
      expect(server.requests.filter((request) => request.path === "/drive/v3/files")).toHaveLength(
        2,
      );
    });

    it("reports a failed quota read as 'Could not read the quota of'", async () => {
      server.failNext({
        match: (request) => request.path === "/drive/v3/about",
        status: 403,
        reason: "forbidden",
      });
      const error = await rejectionOf(storageFor().space());
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toMatch(/Could not read the quota of gdrive:\/\/prod\//);
    });

    it("lets a later put create a folder whose creation failed", async () => {
      const storage = storageFor();
      await storage.put("root.bin", Buffer.from("r"));
      server.failNext({
        match: (request) => request.method === "POST" && request.path === "/drive/v3/files",
        status: 403,
        reason: "insufficientFilePermissions",
      });
      expect(
        isMongoShieldError(
          await rejectionOf(storage.put("sub/a.bin", Buffer.from("a"))),
          "MS_STORAGE_FORBIDDEN",
        ),
      ).toBe(true);
      await storage.put("sub/a.bin", Buffer.from("a"));
      expect((await readAll(await storage.get("sub/a.bin"))).toString()).toBe("a");
    });

    it("refuses a conditional put of a buffer like one of a stream", async () => {
      const error = await rejectionOf(
        storageFor().put("lock", Buffer.from("x"), { ifNoneMatch: "*" }),
      );
      expect(isConditionalWritesUnsupported(error)).toBe(true);
    });
  });

  describe("timeouts and backoff", () => {
    /** Never answers; rejects once the request's signal fires (timeout or abort). */
    function hang(request: Intercepted): Promise<Response> {
      return new Promise((_, reject) => {
        const signal = request.init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }

    it("retries a request that gets no answer within requestTimeoutMs", async () => {
      let hung = 0;
      const storage = storageFor({
        requestTimeoutMs: 20,
        fetch: interceptedFetch(async (request) => {
          if (isList(request) && hung === 0) {
            hung++;
            return hang(request);
          }
          return request.forward();
        }),
      });
      expect(await storage.head("a")).toBeUndefined();
      expect(hung).toBe(1);
    });

    it("fails with MS_STORAGE_IO once a request times out and no retries are left", async () => {
      const storage = storageFor({
        requestTimeoutMs: 20,
        retries: 0,
        fetch: interceptedFetch(async (request) =>
          isList(request) ? hang(request) : request.forward(),
        ),
      });
      const error = await rejectionOf(storage.head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toMatch(/Could not reach Google Drive: request timed out/);
      expect((error as { hint?: string }).hint).toMatch(/network connection/);
    });

    it("honours a Retry-After date and ignores one it cannot read", async () => {
      server.failNext({ status: 429, retryAfter: new Date(Date.now() - 5000).toUTCString() });
      server.failNext({ status: 503, retryAfter: "whenever" });
      expect(await storageFor({ retryBaseMs: 0 }).head("a")).toBeUndefined();
    });
  });

  describe("abort", () => {
    function hang(request: Intercepted): Promise<Response> {
      return new Promise((_, reject) => {
        const signal = request.init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }

    it("stops a request in flight with MS_ABORTED, without retrying it", async () => {
      const controller = new AbortController();
      let lists = 0;
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          if (!isList(request)) return request.forward();
          lists++;
          setTimeout(() => controller.abort(), 5);
          return hang(request);
        }),
      });
      const error = await rejectionOf(storage.head("a", { signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(lists).toBe(1);
    });

    it("stops waiting out a long Retry-After when cancelled", async () => {
      const controller = new AbortController();
      server.failNext({ status: 503, retryAfter: "30" });
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      const error = await rejectionOf(storageFor().space({ signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it("reports MS_ABORTED, not the Drive error, for a failure answered after cancelling", async () => {
      const controller = new AbortController();
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          if (!isList(request)) return request.forward();
          controller.abort();
          return Response.json({ error: { message: "Backend Error" } }, { status: 400 });
        }),
      });
      const error = await rejectionOf(storage.head("a", { signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });

    it("stops a listing between pages", async () => {
      server.pageSizeLimit = 1;
      const storage = storageFor();
      await storage.put("a.bin", Buffer.from("a"));
      await storage.put("b.bin", Buffer.from("b"));
      const controller = new AbortController();
      const listing = storageFor({
        fetch: interceptedFetch(async (request) => {
          if (isList(request) && request.url.searchParams.has("pageToken")) controller.abort();
          return request.forward();
        }),
      });
      const error = await rejectionOf(collect(listing.list("", { signal: controller.signal })));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });

    it("stops a resumable upload between chunks, destroys the body and leaves no file", async () => {
      const controller = new AbortController();
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: interceptedFetch(async (request) => {
          if (isChunk(request)) controller.abort();
          return request.forward();
        }),
      });
      const body = Readable.from([
        Buffer.alloc(CHUNK, 1),
        Buffer.alloc(CHUNK, 2),
        Buffer.alloc(CHUNK, 3),
      ]);
      const error = await rejectionOf(storage.put("big.bin", body, { signal: controller.signal }));
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(body.destroyed).toBe(true);
      expect(filesNamed("big.bin")).toHaveLength(0);
    });

    it("stops a resumable upload whose chunk is in flight", async () => {
      const controller = new AbortController();
      const storage = storageFor({
        chunkSize: CHUNK,
        fetch: interceptedFetch(async (request) => {
          if (!isChunk(request)) return request.forward();
          setTimeout(() => controller.abort(), 5);
          return hang(request);
        }),
      });
      const error = await rejectionOf(
        storage.put("big.bin", Buffer.alloc(3 * CHUNK), { signal: controller.signal }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    });

    it("rejects every operation with MS_ABORTED for a signal that already fired", async () => {
      const storage = storageFor();
      const signal = AbortSignal.abort();
      const attempts: Promise<unknown>[] = [
        storage.put("a", Buffer.from("a"), { signal }),
        storage.get("a", { signal }),
        storage.head("a", { signal }),
        collect(storage.list("", { signal })),
        collect(storage.listPrefixes("", { signal })),
        storage.delete(["a"], { signal }),
      ];
      for (const attempt of attempts) {
        expect(isMongoShieldError(await rejectionOf(attempt), "MS_ABORTED")).toBe(true);
      }
      expect(server.requests).toHaveLength(0);
    });

    it("fails a download stream with MS_ABORTED when cancelled while reading", async () => {
      await storageFor().put("big.bin", Buffer.alloc(300 * KIB, 4));
      const controller = new AbortController();
      const stream = await storageFor().get("big.bin", { signal: controller.signal });
      controller.abort();
      expect(isMongoShieldError(await rejectionOf(readAll(stream)), "MS_ABORTED")).toBe(true);
    });
  });

  describe("access tokens", () => {
    /** An access token the fake accepts, minted outside the adapter. */
    async function issuedAccessToken(): Promise<string> {
      const answer = await fetch(server.tokenUrl, {
        method: "POST",
        body: new URLSearchParams({
          client_id: server.clientId,
          client_secret: server.clientSecret,
          refresh_token: server.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      return ((await answer.json()) as { access_token: string }).access_token;
    }

    it("calls an access token function again after a 401, with the operation's signal", async () => {
      const valid = await issuedAccessToken();
      const given = ["ya29.stale"];
      const signals: (AbortSignal | undefined)[] = [];
      const storage = gdriveStorage({
        folder: "prod",
        apiUrl: server.endpoint,
        accessToken: async ({ signal }) => {
          signals.push(signal);
          return given.shift() ?? valid;
        },
      });
      const controller = new AbortController();
      expect(await storage.head("a", { signal: controller.signal })).toBeUndefined();
      expect(signals.length).toBeGreaterThanOrEqual(2);
      expect(signals.every((signal) => signal === controller.signal)).toBe(true);
    });

    it("exchanges the refresh token again before the access token expires", async () => {
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          const response = await request.forward();
          // Google says the token lasts 30 s, less than the 60 s safety margin.
          return request.url.pathname === "/token"
            ? withJson(response, (body) => ({ ...body, expires_in: 30 }))
            : response;
        }),
      });
      await storage.put("a", Buffer.from("a"));
      await storage.head("a");
      expect(requestsMatching("POST", "/token").length).toBeGreaterThan(2);
    });

    it("does not hand a failed exchange to a request that was waiting for it", async () => {
      let exchanges = 0;
      const storage = storageFor({
        fetch: interceptedFetch(async (request) => {
          if (request.url.pathname !== "/token") return request.forward();
          exchanges++;
          if (exchanges === 1) {
            // Slow enough that the second request starts waiting on this exchange.
            await new Promise((resolve) => setTimeout(resolve, 30));
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return request.forward();
        }),
      });
      const [space, head] = await Promise.allSettled([storage.space(), storage.head("a")]);
      expect(
        space.status === "rejected" && isMongoShieldError(space.reason, "MS_STORAGE_FORBIDDEN"),
      ).toBe(true);
      expect(head).toEqual({ status: "fulfilled", value: undefined });
      expect(exchanges).toBe(2);
    });

    it("uses Google's token endpoint by default, sending no secret when none is given", async () => {
      const sent: { url: string; form: URLSearchParams }[] = [];
      const storage = gdriveStorage({
        folder: "prod",
        apiUrl: server.endpoint,
        clientId: server.clientId,
        refreshToken: server.refreshToken,
        retryBaseMs: 1,
        fetch: interceptedFetch(async (request) => {
          if (request.url.origin !== "https://oauth2.googleapis.com") return request.forward();
          sent.push({
            url: request.url.href,
            form: new URLSearchParams(String(request.init?.body)),
          });
          return fetch(server.tokenUrl, request.init);
        }),
      });
      // The fake requires the secret, so the client is refused.
      const error = await rejectionOf(storage.head("a"));
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect(sent[0]?.url).toBe("https://oauth2.googleapis.com/token");
      expect(sent[0]?.form.has("client_secret")).toBe(false);
    });
  });

  describe("space, odd quotas", () => {
    function storageWithAbout(answer: () => Response) {
      return storageFor({
        fetch: interceptedFetch(async (request) =>
          request.url.pathname === "/drive/v3/about" ? answer() : request.forward(),
        ),
      });
    }

    it("is undefined when Drive reports no quota at all", async () => {
      expect(
        await storageWithAbout(() => new Response("", { status: 200 })).space(),
      ).toBeUndefined();
      expect(await storageWithAbout(() => Response.json({ storageQuota: "n/a" })).space()).toEqual(
        {},
      );
    });

    it("reads numbers as well as strings, and leaves out what Drive does not report", async () => {
      expect(
        await storageWithAbout(() =>
          Response.json({ storageQuota: { limit: 1000, usage: "250" } }),
        ).space(),
      ).toEqual({ totalBytes: 1000, usedBytes: 250, freeBytes: 750 });
      expect(
        await storageWithAbout(() => Response.json({ storageQuota: { limit: "1000" } })).space(),
      ).toEqual({
        totalBytes: 1000,
      });
    });

    it("never reports negative free space when usage is over the limit", async () => {
      expect(
        await storageWithAbout(() =>
          Response.json({ storageQuota: { limit: "100", usage: "150" } }),
        ).space(),
      ).toEqual({ totalBytes: 100, usedBytes: 150, freeBytes: 0 });
    });
  });

  describe("close", () => {
    it("forgets the folder ids, so the next call looks them up again", async () => {
      const storage = storageFor();
      await storage.put("a/b.bin", Buffer.from("b"));
      await storage.head("a/b.bin");
      const before = requestsMatching("GET", "/drive/v3/files").length;
      await storage.head("a/b.bin");
      const cached = requestsMatching("GET", "/drive/v3/files").length - before;
      await storage.close?.();
      const afterClose = requestsMatching("GET", "/drive/v3/files").length;
      await storage.head("a/b.bin");
      const uncached = requestsMatching("GET", "/drive/v3/files").length - afterClose;
      // Cached: only the file lookup. After close: the app folder, prod, a, then the file.
      expect(cached).toBe(1);
      expect(uncached).toBe(4);
    });
  });
});

describe("gdriveStorageFromUrl", () => {
  const env = {
    MONGOSHIELD_GDRIVE_TOKEN: "1//refresh",
    MONGOSHIELD_GDRIVE_CLIENT_ID: "id.apps.googleusercontent.com",
    MONGOSHIELD_GDRIVE_CLIENT_SECRET: "secret",
  };

  it("reads the folder from the URL and the token from MONGOSHIELD_GDRIVE_TOKEN", () => {
    const storage = gdriveStorageFromUrl(new URL("gdrive://my-app"), env);
    expect(storage.location).toBe("gdrive://my-app/");
  });

  it("accepts nested folders and keeps their case", () => {
    expect(gdriveStorageFromUrl(new URL("gdrive://Acme/Prod%20DB"), env).location).toBe(
      "gdrive://Acme/Prod DB/",
    );
  });

  it("accepts chunkSizeMiB and rejects other parameters", () => {
    expect(() => gdriveStorageFromUrl(new URL("gdrive://a?chunkSizeMiB=16"), env)).not.toThrow();
    expect(() => gdriveStorageFromUrl(new URL("gdrive://a?chunkSizeMiB=0"), env)).toThrow(
      /chunkSizeMiB/,
    );
    expect(() => gdriveStorageFromUrl(new URL("gdrive://a?region=x"), env)).toThrow(
      /Unknown gdrive:\/\/ URL parameter "region"/,
    );
  });

  it("refuses credentials in the URL", () => {
    expect(() => gdriveStorageFromUrl(new URL("gdrive://user:pw@a"), env)).toThrow(
      /must not contain credentials/,
    );
    expect(() => gdriveStorageFromUrl(new URL("gdrive://:pw@a"), env)).toThrow(
      /must not contain credentials/,
    );
  });

  it("rejects a chunkSizeMiB that is not a positive whole number, with MS_CONFIG_INVALID", () => {
    for (const value of ["abc", "1.5", "-4", "", "1e400"]) {
      const error = (() => {
        try {
          gdriveStorageFromUrl(new URL(`gdrive://a?chunkSizeMiB=${value}`), env);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID"), value).toBe(true);
      expect(String(error)).toMatch(/chunkSizeMiB must be a positive whole number/);
    }
  });

  it("rejects an unknown parameter even next to chunkSizeMiB, and says which ones exist", () => {
    const error = (() => {
      try {
        gdriveStorageFromUrl(new URL("gdrive://a?chunkSizeMiB=8&token=x"), env);
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as { hint?: string }).hint).toBe("Supported parameters: chunkSizeMiB.");
  });

  it("treats a token of only whitespace as missing", () => {
    expect(() =>
      gdriveStorageFromUrl(new URL("gdrive://a"), { ...env, MONGOSHIELD_GDRIVE_TOKEN: "  \n" }),
    ).toThrow(/needs a token in MONGOSHIELD_GDRIVE_TOKEN/);
  });

  it("rejects a folder path with an empty segment", () => {
    expect(() => gdriveStorageFromUrl(new URL("gdrive://a//b"), env)).toThrow(
      /Invalid Google Drive folder/,
    );
  });

  it("fails with a login hint when the token is missing", () => {
    const error = (() => {
      try {
        gdriveStorageFromUrl(new URL("gdrive://a"), { ...env, MONGOSHIELD_GDRIVE_TOKEN: "" });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect((error as { hint?: string }).hint).toMatch(/mongoshield login gdrive/);
  });

  it("fails clearly when no OAuth client is configured", () => {
    expect(() =>
      gdriveStorageFromUrl(new URL("gdrive://a"), { MONGOSHIELD_GDRIVE_TOKEN: "1//refresh" }),
    ).toThrow(/No Google OAuth client/);
  });
});
