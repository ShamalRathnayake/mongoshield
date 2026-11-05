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
