/**
 * Unit tests for the GCS adapter against an in-memory fake of the parts of
 * `@google-cloud/storage` it uses (`bucket().file()`, `getFiles()`, write and
 * read streams). They pin down request options, pagination, error mapping,
 * atomicity and cancellation. The behavioural contract against a real GCS API
 * runs in `test/integration/storage-gcs.test.ts` (fake-gcs-server in Docker).
 */

import { Readable, Writable } from "node:stream";
import type {
  CreateReadStreamOptions,
  CreateWriteStreamOptions,
  FileMetadata,
  GetFilesOptions,
  Storage,
} from "@google-cloud/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { type GcsStorageOptions, gcsStorage } from "./gcs.ts";

/** An error shaped like the SDK's `ApiError` (HTTP status in `code`). */
function apiError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

interface StoredObject {
  readonly data: Buffer;
  readonly generation: number;
  readonly updated: string;
}

/** A tiny in-memory GCS bucket with just enough behaviour for the adapter. */
class FakeGcs {
  readonly objects = new Map<string, StoredObject>();
  readonly writes: CreateWriteStreamOptions[] = [];
  readonly reads: CreateReadStreamOptions[] = [];
  readonly listCalls: GetFilesOptions[] = [];
  readonly deleteCalls: { name: string; options: unknown }[] = [];
  pageSize = 1000;
  failNext:
    | { readonly method: "write" | "read" | "metadata" | "list" | "delete"; error: Error }
    | undefined;
  deleteDelayMs = 0;
  deletesInFlight = 0;
  /** What `bucket.getMetadata()` answers: the bucket's object retention setting, or an error. */
  bucketMetadata: { objectRetention?: { mode?: string } } | Error = {
    objectRetention: { mode: "Enabled" },
  };
  bucketMetadataCalls = 0;
  maxDeletesInFlight = 0;
  private generation = 0;

  constructor(readonly bucketName: string) {}

  takeFailure(method: NonNullable<FakeGcs["failNext"]>["method"]): Error | undefined {
    if (this.failNext?.method !== method) return undefined;
    const { error } = this.failNext;
    this.failNext = undefined;
    return error;
  }

  /** A `Storage`-shaped object; only the methods the adapter calls exist. */
  client(): Storage {
    const fake = {
      bucket: (name: string) => (name === this.bucketName ? this.bucket() : undefined),
    };
    return fake as unknown as Storage;
  }

  bucket() {
    return {
      file: (name: string) => new FakeFile(this, name),
      getFiles: async (query: GetFilesOptions) => this.getFiles(query),
      getMetadata: async () => {
        this.bucketMetadataCalls++;
        if (this.bucketMetadata instanceof Error) throw this.bucketMetadata;
        return [this.bucketMetadata];
      },
    };
  }

  store(name: string, data: Buffer): StoredObject {
    const stored = { data, generation: ++this.generation, updated: "2026-11-14T03:00:04.123Z" };
    this.objects.set(name, stored);
    return stored;
  }

  metadataOf(name: string): FileMetadata {
    const stored = this.objects.get(name);
    if (!stored) throw apiError(404, `No such object: ${this.bucketName}/${name}`);
    return {
      name,
      size: String(stored.data.length),
      updated: stored.updated,
      etag: `etag-${stored.generation}`,
      generation: stored.generation,
    };
  }

  async getFiles(query: GetFilesOptions) {
    this.listCalls.push(query);
    const failure = this.takeFailure("list");
    if (failure) throw failure;
    const prefix = query.prefix ?? "";
    const names = [...this.objects.keys()].filter((name) => name.startsWith(prefix)).sort();
    const files: FakeFile[] = [];
    const prefixes = new Set<string>();
    for (const name of names) {
      const rest = name.slice(prefix.length);
      const slash = query.delimiter === undefined ? -1 : rest.indexOf(query.delimiter);
      if (slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
      else files.push(Object.assign(new FakeFile(this, name), { metadata: this.metadataOf(name) }));
    }
    // Page over files and prefixes together, like the real API.
    const entries: ({ file: FakeFile } | { prefix: string })[] = [
      ...files.map((file) => ({ file })),
      ...[...prefixes].map((value) => ({ prefix: value })),
    ];
    const start = Number(query.pageToken ?? "0");
    const page = entries.slice(start, start + this.pageSize);
    const next = start + this.pageSize < entries.length ? String(start + this.pageSize) : undefined;
    const response = {
      kind: "storage#objects",
      ...(next === undefined ? {} : { nextPageToken: next }),
      prefixes: page.flatMap((entry) => ("prefix" in entry ? [entry.prefix] : [])),
    };
    const pageFiles = page.flatMap((entry) => ("file" in entry ? [entry.file] : []));
    return [
      pageFiles,
      next === undefined ? null : { ...query, pageToken: next },
      response,
    ] as const;
  }
}

class FakeFile {
  metadata: FileMetadata = {};

  constructor(
    private readonly gcs: FakeGcs,
    readonly name: string,
  ) {}

  createWriteStream(options: CreateWriteStreamOptions): Writable {
    this.gcs.writes.push(options);
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        chunks.push(chunk);
        callback();
      },
      // The object only appears when the upload is finalized, as on real GCS.
      final: (callback) => {
        const failure = this.gcs.takeFailure("write");
        if (failure) return callback(failure);
        const exists = this.gcs.objects.has(this.name);
        if (options.preconditionOpts?.ifGenerationMatch === 0 && exists) {
          return callback(
            apiError(412, "At least one of the pre-conditions you specified did not hold."),
          );
        }
        this.gcs.store(this.name, Buffer.concat(chunks));
        this.metadata = this.gcs.metadataOf(this.name);
        callback();
      },
    });
  }

  /** Like the SDK, nothing happens until the stream is read. */
  createReadStream(options: CreateReadStreamOptions): Readable {
    this.gcs.reads.push(options);
    let started = false;
    const readable = new Readable({
      read: () => {
        if (started) return;
        started = true;
        const failure = this.gcs.takeFailure("read");
        const stored = this.gcs.objects.get(this.name);
        if (failure) return void readable.destroy(failure);
        if (!stored) return void readable.destroy(apiError(404, `No such object: ${this.name}`));
        const start = options.start ?? 0;
        if (start > 0 && start >= stored.data.length) {
          return void readable.destroy(apiError(416, "Requested range not satisfiable"));
        }
        const end = options.end === undefined ? stored.data.length : options.end + 1;
        readable.push(stored.data.subarray(start, end));
        readable.push(null);
      },
    });
    return readable;
  }

  async getMetadata(): Promise<[FileMetadata]> {
    const failure = this.gcs.takeFailure("metadata");
    if (failure) throw failure;
    return [this.gcs.metadataOf(this.name)];
  }

  async delete(options: { ignoreNotFound?: boolean }) {
    this.gcs.deleteCalls.push({ name: this.name, options });
    this.gcs.deletesInFlight++;
    this.gcs.maxDeletesInFlight = Math.max(this.gcs.maxDeletesInFlight, this.gcs.deletesInFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.gcs.deleteDelayMs));
      const failure = this.gcs.takeFailure("delete");
      if (failure) throw failure;
      const existed = this.gcs.objects.delete(this.name);
      if (!existed && !options.ignoreNotFound) throw apiError(404, "No such object");
      return [{}];
    } finally {
      this.gcs.deletesInFlight--;
    }
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const piece of stream) chunks.push(Buffer.from(piece));
  return Buffer.concat(chunks).toString();
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("gcsStorage", () => {
  let gcs: FakeGcs;

  beforeEach(() => {
    gcs = new FakeGcs("bkt");
  });

  function storage(options: Partial<GcsStorageOptions> = {}) {
    return gcsStorage({ bucket: "bkt", prefix: "base", storage: gcs.client(), ...options });
  }

  describe("configuration", () => {
    it("normalizes the prefix and shows it in the location", () => {
      expect(storage({ prefix: "/prod/mongo/" }).location).toBe("gs://bkt/prod/mongo/");
      expect(storage({ prefix: "" }).location).toBe("gs://bkt/");
      expect(gcsStorage({ bucket: "bkt" }).location).toBe("gs://bkt/");
      expect(storage().kind).toBe("gcs");
    });

    it("declares conditional writes, range reads and object lock", () => {
      expect(storage().capabilities).toEqual({
        conditionalWrites: true,
        rangeReads: true,
        objectLock: true,
      });
    });

    it.each<[string, Partial<GcsStorageOptions>]>([
      ["an empty bucket", { bucket: "" }],
      ["a bucket with a slash", { bucket: "a/b" }],
      ["a prefix with ..", { prefix: "a/../b" }],
      ["a chunk size that is not a multiple of 256 KiB", { chunkSize: 1000 }],
      ["a zero delete concurrency", { deleteConcurrency: 0 }],
      ["an unknown retention mode", { retention: { mode: "legal" as "compliance" } }],
    ])("rejects %s with MS_CONFIG_INVALID", (_label, options) => {
      expect(() => storage(options)).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    });
  });

  describe("put", () => {
    it("uploads a Buffer in one request with CRC32C validation", async () => {
      const info = await storage().put("dir/a.json", Buffer.from("{}"), {
        contentType: "application/json",
      });
      expect(info).toMatchObject({ key: "dir/a.json", size: 2, etag: "etag-1" });
      expect(info.lastModified.toISOString()).toBe("2026-11-14T03:00:04.123Z");
      expect(gcs.writes[0]).toEqual({
        contentType: "application/json",
        resumable: false,
        validation: "crc32c",
        gzip: false,
      });
      expect(gcs.objects.get("base/dir/a.json")?.data.toString()).toBe("{}");
    });

    it("uploads a stream as a resumable upload in 16 MiB chunks and counts its bytes", async () => {
      const info = await storage().put(
        "s.bin",
        Readable.from([Buffer.from("ab"), Buffer.from("cde")]),
      );
      expect(info.size).toBe(5);
      expect(gcs.writes[0]).toMatchObject({
        contentType: "application/octet-stream",
        resumable: true,
        chunkSize: 16 * 1024 * 1024,
      });
    });

    it("passes the configured chunk size and validation, and omits chunkSize when it is 0", async () => {
      await storage({ chunkSize: 512 * 1024, validation: "md5" }).put("a", Readable.from(["x"]));
      await storage({ chunkSize: 0, validation: false }).put("b", Readable.from(["x"]));
      expect(gcs.writes[0]).toMatchObject({ chunkSize: 512 * 1024, validation: "md5" });
      expect(gcs.writes[1]).not.toHaveProperty("chunkSize");
      expect(gcs.writes[1]).toMatchObject({ validation: false });
    });

    it("sends ifGenerationMatch: 0 for conditional writes and maps 412", async () => {
      const adapter = storage();
      await adapter.put("lock", Buffer.from("1"), { ifNoneMatch: "*" });
      expect(gcs.writes[0]?.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
      const error = await rejection(adapter.put("lock", Buffer.from("2"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_PRECONDITION_FAILED")).toBe(true);
      expect(gcs.objects.get("base/lock")?.data.toString()).toBe("1");
    });

    it("stores nothing when the body stream fails midway", async () => {
      async function* failing() {
        yield Buffer.from("partial");
        throw new Error("source died");
      }
      const error = await rejection(storage().put("broken", Readable.from(failing())));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
      expect(String(error)).toContain("gs://bkt/base/broken");
      expect(gcs.objects.size).toBe(0);
    });

    it("maps an upload hash mismatch to MS_INTEGRITY_FAILED", async () => {
      gcs.failNext = {
        method: "write",
        error: Object.assign(new Error("The uploaded data did not match"), {
          code: "FILE_NO_UPLOAD",
        }),
      };
      const error = await rejection(storage().put("a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    });

    it("rejects with MS_ABORTED and stores nothing when aborted mid-stream", async () => {
      const controller = new AbortController();
      async function* slow() {
        yield Buffer.from("a");
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield Buffer.from("b");
      }
      const error = await rejection(
        storage().put("a", Readable.from(slow()), { signal: controller.signal }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(gcs.objects.size).toBe(0);
    });

    it("rejects with MS_ABORTED without uploading when already aborted", async () => {
      const error = await rejection(
        storage().put("a", Buffer.from("x"), { signal: AbortSignal.abort() }),
      );
      expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
      expect(gcs.writes).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("reads the prefixed object with hash validation", async () => {
      gcs.store("base/a.txt", Buffer.from("hello"));
      expect(await readAll(await storage().get("a.txt"))).toBe("hello");
      expect(gcs.reads[0]).toEqual({ validation: "crc32c" });
    });

    it("sends ranges without validation, which the SDK refuses for partial reads", async () => {
      gcs.store("base/a.txt", Buffer.from("0123456789"));
      const adapter = storage();
      expect(await readAll(await adapter.get("a.txt", { range: { start: 2, end: 5 } }))).toBe(
        "2345",
      );
      expect(await readAll(await adapter.get("a.txt", { range: { start: 7 } }))).toBe("789");
      expect(gcs.reads).toEqual([{ start: 2, end: 5 }, { start: 7 }]);
    });

    it("returns an empty stream for a range past the end (416)", async () => {
      gcs.store("base/a.txt", Buffer.from("abc"));
      expect(await readAll(await storage().get("a.txt", { range: { start: 10 } }))).toBe("");
    });

    it("reports a missing object eagerly as MS_STORAGE_NOT_FOUND", async () => {
      const error = await rejection(storage().get("missing"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });

    it("maps a missing bucket to MS_STORAGE_NOT_FOUND with a hint naming the bucket", async () => {
      gcs.failNext = {
        method: "read",
        error: apiError(404, "The specified bucket does not exist."),
      };
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
      expect(isMongoShieldError(error) && error.hint).toContain('"bkt"');
    });

    it.each([
      [403, "MS_STORAGE_FORBIDDEN"],
      [401, "MS_STORAGE_FORBIDDEN"],
      [500, "MS_STORAGE_IO"],
    ])("maps HTTP %i to %s", async (status, code) => {
      gcs.store("base/a", Buffer.from("x"));
      gcs.failNext = { method: "read", error: apiError(status, "nope") };
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error) && error.code).toBe(code);
    });

    it("maps a download hash mismatch to MS_INTEGRITY_FAILED", async () => {
      gcs.store("base/a", Buffer.from("x"));
      gcs.failNext = {
        method: "read",
        error: Object.assign(new Error("mismatch"), { code: "CONTENT_DOWNLOAD_MISMATCH" }),
      };
      const error = await rejection(storage().get("a"));
      expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
    });
  });

  describe("head", () => {
    it("converts GCS's string sizes and RFC 3339 times", async () => {
      gcs.store("base/a", Buffer.alloc(42));
      expect(await storage().head("a")).toEqual({
        key: "a",
        size: 42,
        lastModified: new Date("2026-11-14T03:00:04.123Z"),
        etag: "etag-1",
      });
    });

    it("returns undefined for a missing object", async () => {
      expect(await storage().head("missing")).toBeUndefined();
    });

    it("still reports a missing bucket as an error", async () => {
      gcs.failNext = {
        method: "metadata",
        error: apiError(404, "The specified bucket does not exist."),
      };
      const error = await rejection(storage().head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });
  });

  describe("list", () => {
    it("follows page tokens, strips the prefix and skips folder markers", async () => {
      gcs.pageSize = 2;
      for (const name of ["base/a", "base/b/c", "base/d", "base/folder/", "other/x"]) {
        gcs.store(name, Buffer.from(name));
      }
      const infos = await collect(storage().list(""));
      expect(infos.map((info) => info.key)).toEqual(["a", "b/c", "d"]);
      expect(infos[0]?.size).toBe(6);
      expect(gcs.listCalls).toHaveLength(2);
      expect(gcs.listCalls[0]).toEqual({ prefix: "base/", autoPaginate: false, maxResults: 1000 });
      expect(gcs.listCalls[1]?.pageToken).toBe("2");
    });

    it("works without a base prefix", async () => {
      gcs.store("x/y", Buffer.from("1"));
      expect((await collect(storage({ prefix: "" }).list("x/"))).map((info) => info.key)).toEqual([
        "x/y",
      ]);
    });

    it("maps listing errors", async () => {
      gcs.failNext = { method: "list", error: apiError(403, "denied") };
      const error = await rejection(collect(storage().list("")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });
  });

  describe("listPrefixes", () => {
    it("uses the / delimiter, paginates and strips the prefix", async () => {
      gcs.pageSize = 1;
      for (const name of ["base/b1/x", "base/b2/y/z", "base/top.json", "base/b3/w"]) {
        gcs.store(name, Buffer.from("1"));
      }
      expect(await collect(storage().listPrefixes(""))).toEqual(["b1/", "b2/", "b3/"]);
      expect(gcs.listCalls.every((call) => call.delimiter === "/")).toBe(true);
      expect(gcs.listCalls.length).toBeGreaterThan(1);
    });
  });

  describe("delete", () => {
    it("deletes every key with ignoreNotFound and bounded concurrency", async () => {
      const keys = Array.from({ length: 20 }, (_, index) => `k${index}`);
      for (const key of keys) gcs.store(`base/${key}`, Buffer.from("1"));
      gcs.deleteDelayMs = 2;
      await storage({ deleteConcurrency: 3 }).delete([...keys, "missing"]);
      expect(gcs.objects.size).toBe(0);
      expect(gcs.maxDeletesInFlight).toBe(3);
      expect(gcs.deleteCalls[0]).toEqual({ name: "base/k0", options: { ignoreNotFound: true } });
    });

    it("sends nothing for an empty key list", async () => {
      await storage().delete([]);
      expect(gcs.deleteCalls).toHaveLength(0);
    });

    it("validates every key before deleting anything", async () => {
      gcs.store("base/a", Buffer.from("1"));
      await expect(storage().delete(["a", "../b"])).rejects.toThrow(/Invalid storage key/);
      expect(gcs.objects.size).toBe(1);
    });

    it("maps delete failures", async () => {
      gcs.store("base/a", Buffer.from("1"));
      gcs.failNext = { method: "delete", error: apiError(403, "denied") };
      const error = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain("gs://bkt/base/a");
    });
  });

  describe("object retention (immutable backups)", () => {
    const retainUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    it("sets Locked retention in the upload metadata by default", async () => {
      await storage().put("b/manifest.json", Buffer.from("{}"), { retainUntil });
      expect(gcs.writes[0]?.metadata).toEqual({
        retention: { mode: "Locked", retainUntilTime: retainUntil.toISOString() },
      });
      // The content type is still passed (the SDK merges it into the same metadata).
      expect(gcs.writes[0]?.contentType).toBe("application/octet-stream");
    });

    it("uses Unlocked retention in governance mode, for streams too", async () => {
      await storage({ retention: { mode: "governance" } }).put(
        "s",
        Readable.from([Buffer.from("x")]),
        { retainUntil },
      );
      expect(gcs.writes[0]?.metadata?.retention).toEqual({
        mode: "Unlocked",
        retainUntilTime: retainUntil.toISOString(),
      });
    });

    it("sends no retention and reads no bucket metadata for ordinary puts", async () => {
      await storage().put("a", Buffer.from("x"));
      expect(gcs.writes[0]?.metadata).toBeUndefined();
      expect(gcs.bucketMetadataCalls).toBe(0);
    });

    it("checks the bucket once per adapter", async () => {
      const adapter = storage();
      await adapter.put("a", Buffer.from("a"), { retainUntil });
      await adapter.put("b", Buffer.from("b"), { retainUntil });
      expect(gcs.bucketMetadataCalls).toBe(1);
    });

    it("fails with MS_CONFIG_INVALID before uploading when object retention is off", async () => {
      gcs.bucketMetadata = {};
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
      expect(isMongoShieldError(failure) && failure.hint).toContain(
        "--enable-per-object-retention",
      );
      expect(gcs.writes).toHaveLength(0);
    });

    it("skips the check without storage.buckets.get and maps GCS's 400 to MS_CONFIG_INVALID", async () => {
      gcs.bucketMetadata = apiError(403, "does not have storage.buckets.get access");
      gcs.failNext = {
        method: "write",
        error: apiError(400, "Object retention is not enabled for this bucket."),
      };
      const failure = await rejection(storage().put("a", Buffer.from("x"), { retainUntil }));
      expect(isMongoShieldError(failure, "MS_CONFIG_INVALID"), String(failure)).toBe(true);
      expect(gcs.writes).toHaveLength(1);
    });

    it("maps a refused delete of a retained object to an objectLocked MS_STORAGE_FORBIDDEN", async () => {
      gcs.store("base/a", Buffer.from("x"));
      gcs.failNext = {
        method: "delete",
        error: apiError(
          403,
          "Object 'bkt/base/a' is subject to object retention and cannot be deleted or overwritten until 2026-11-21.",
        ),
      };
      const failure = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(failure, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(isMongoShieldError(failure) && failure.details?.objectLocked).toBe(true);
    });

    it("keeps the IAM hint for ordinary 403s", async () => {
      gcs.failNext = { method: "delete", error: apiError(403, "Permission denied") };
      const failure = await rejection(storage().delete(["a"]));
      expect(isMongoShieldError(failure) && failure.details?.objectLocked).toBeUndefined();
      expect(isMongoShieldError(failure) && failure.hint).toContain("roles/storage.objectAdmin");
    });
  });

  it("can be closed more than once", async () => {
    const adapter = storage();
    await adapter.close?.();
    await adapter.close?.();
  });
});
