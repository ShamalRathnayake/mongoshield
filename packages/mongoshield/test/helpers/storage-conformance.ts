/**
 * Shared conformance suite for `StorageAdapter` implementations.
 *
 * Every adapter (memory, file, s3, and any third-party one) must pass the same
 * tests, so the engine can rely on one contract. Call it from a test file:
 *
 *   import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
 *   describeStorageConformance("memory", async () => ({
 *     storage: memoryStorage(),
 *     cleanup: async () => {},
 *   }));
 *
 * `setup` runs before every test and must return an empty store (for shared
 * backends, use a unique prefix per call). Tests that need an optional
 * capability (`conditionalWrites`, `rangeReads`) are skipped when the adapter
 * does not declare it.
 *
 * Write-once retention (`retainUntil`) is checked in every case:
 * - `objectLock: false`: a retained put fails with MS_CONFIG_INVALID before the
 *   body is read, and stores nothing.
 * - `objectLock: true` but the bucket is not prepared (`objectLockConfigured: false`
 *   in the fixture, e.g. an emulator bucket without Object Lock): the same error.
 * - `objectLock: true` and prepared (the default): retained objects can be read
 *   but not deleted or overwritten before they expire. Stores that hide a locked
 *   object behind a delete marker instead of refusing (S3) set
 *   `lockedDeletes: "hidden"`, which skips the refusal tests.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ErrorCode, isMongoShieldError } from "../../src/errors.ts";
import type { ObjectInfo, StorageAdapter } from "../../src/storage/types.ts";

/** What `setup` returns: a fresh, empty adapter and a function that disposes of it. */
export interface StorageConformanceFixture {
  readonly storage: StorageAdapter;
  readonly cleanup: () => Promise<void>;
  /**
   * Object lock adapters only: whether the bucket/container behind `storage` is
   * set up for retention (S3 Object Lock, GCS object retention, Azure version-level
   * immutability). Defaults to `true`.
   */
  readonly objectLockConfigured?: boolean;
  /** How the store treats deleting or overwriting a locked object. Defaults to `"refused"`. */
  readonly lockedDeletes?: "refused" | "hidden";
  /**
   * Emulators only: behaviour the real service has but the emulator lacks. Each entry
   * says why, and skips exactly the test that checks it instead of failing on a gap in
   * the emulator. Real services must pass everything, so never set these for them.
   */
  readonly emulatorGaps?: {
    /** `ifNoneMatch` is not enforced on streamed (resumable) uploads. */
    readonly streamedConditionalCreates?: string;
    /** Concurrent conditional creates are not atomic: more than one can win. */
    readonly racingConditionalCreates?: string;
  };
}

/** Registers the conformance tests for one adapter. */
export function describeStorageConformance(
  name: string,
  setup: () => Promise<StorageConformanceFixture>,
): void {
  describe(`${name} storage conformance`, () => {
    let storage: StorageAdapter;
    let cleanup: () => Promise<void>;
    let objectLockConfigured: boolean;
    let lockedDeletes: "refused" | "hidden";
    let emulatorGaps: NonNullable<StorageConformanceFixture["emulatorGaps"]>;

    beforeEach(async () => {
      const fixture = await setup();
      ({ storage, cleanup } = fixture);
      objectLockConfigured = fixture.objectLockConfigured ?? true;
      lockedDeletes = fixture.lockedDeletes ?? "refused";
      emulatorGaps = fixture.emulatorGaps ?? {};
    });

    /** True when retained puts are expected to succeed on this fixture. */
    function canLock(): boolean {
      return storage.capabilities.objectLock && objectLockConfigured;
    }

    afterEach(async () => {
      await cleanup();
    });

    describe("identity", () => {
      it("has a kind, a location and capability flags", () => {
        expect(storage.kind).toMatch(/^[a-z0-9-]+$/);
        expect(storage.location.length).toBeGreaterThan(0);
        expect(typeof storage.capabilities.conditionalWrites).toBe("boolean");
        expect(typeof storage.capabilities.rangeReads).toBe("boolean");
        expect(typeof storage.capabilities.objectLock).toBe("boolean");
      });
    });

    describe("put and get", () => {
      it("round-trips a Buffer and reports its size", async () => {
        const data = Buffer.from("hello, storage");
        const info = await storage.put("dir/hello.txt", data, { contentType: "text/plain" });
        expect(info.key).toBe("dir/hello.txt");
        expect(info.size).toBe(data.length);
        expect(info.lastModified).toBeInstanceOf(Date);
        expect(await readObject(storage, "dir/hello.txt")).toEqual(data);
      });

      it("round-trips a plain Uint8Array", async () => {
        const data = new Uint8Array([0, 1, 2, 250, 255]);
        await storage.put("bytes.bin", data);
        expect(await readObject(storage, "bytes.bin")).toEqual(Buffer.from(data));
      });

      it("round-trips a multi-chunk Readable", async () => {
        const chunks = ["first ", "second ", "third"].map((text) => Buffer.from(text));
        const info = await storage.put("multi.txt", Readable.from(chunks));
        expect(info.size).toBe(18);
        expect((await readObject(storage, "multi.txt")).toString()).toBe("first second third");
      });

      it("stores empty objects from a Buffer and from a stream", async () => {
        await storage.put("empty-buffer", Buffer.alloc(0));
        await storage.put("empty-stream", Readable.from([]));
        expect(await readObject(storage, "empty-buffer")).toHaveLength(0);
        expect(await readObject(storage, "empty-stream")).toHaveLength(0);
        expect((await storage.head("empty-stream"))?.size).toBe(0);
      });

      it("streams an object larger than 10 MiB without corrupting it", async () => {
        const size = 10 * 1024 * 1024 + 12_345;
        const expectedHash = createHash("sha256");
        const info = await storage.put("large/object.bin", patternStream(size, expectedHash));
        expect(info.size).toBe(size);

        const actualHash = createHash("sha256");
        let actualSize = 0;
        for await (const chunk of await storage.get("large/object.bin")) {
          const buffer = toBuffer(chunk);
          actualSize += buffer.length;
          actualHash.update(buffer);
        }
        expect(actualSize).toBe(size);
        expect(actualHash.digest("hex")).toBe(expectedHash.digest("hex"));
      }, 60_000);

      it("replaces an existing object on overwrite", async () => {
        await storage.put("overwrite.txt", Buffer.from("old content, longer"));
        await storage.put("overwrite.txt", Buffer.from("new"));
        expect((await readObject(storage, "overwrite.txt")).toString()).toBe("new");
        expect((await storage.head("overwrite.txt"))?.size).toBe(3);
      });

      it("throws MS_STORAGE_NOT_FOUND when getting a missing object", async () => {
        await expectStorageError(storage.get("missing/object.bin"), "MS_STORAGE_NOT_FOUND");
      });
    });

    describe("atomicity", () => {
      it("leaves no object, temp file or directory when the body stream fails midway", async () => {
        const failing = failingStream([Buffer.from("partial "), Buffer.from("data")]);
        await expect(storage.put("broken/object.bin", failing)).rejects.toThrow();

        expect(await storage.head("broken/object.bin")).toBeUndefined();
        expect(await collectKeys(storage.list(""))).toEqual([]);
        expect(await collect(storage.listPrefixes(""))).toEqual([]);
      });

      it("keeps the previous version when an overwrite fails midway", async () => {
        await storage.put("keep.txt", Buffer.from("original"));
        await expect(storage.put("keep.txt", failingStream([Buffer.from("x")]))).rejects.toThrow();
        expect((await readObject(storage, "keep.txt")).toString()).toBe("original");
        expect(await collectKeys(storage.list(""))).toEqual(["keep.txt"]);
      });
    });

    describe("conditional writes", () => {
      it("rejects a second create with MS_STORAGE_PRECONDITION_FAILED", async ({ skip }) => {
        if (!storage.capabilities.conditionalWrites) skip();
        await storage.put("locks/run.lock", Buffer.from("first"), { ifNoneMatch: "*" });
        await expectStorageError(
          storage.put("locks/run.lock", Buffer.from("second"), { ifNoneMatch: "*" }),
          "MS_STORAGE_PRECONDITION_FAILED",
        );
        expect((await readObject(storage, "locks/run.lock")).toString()).toBe("first");
        expect(await collectKeys(storage.list(""))).toEqual(["locks/run.lock"]);
      });

      it("supports conditional creates from a stream", async ({ skip }) => {
        if (!storage.capabilities.conditionalWrites) skip();
        if (emulatorGaps.streamedConditionalCreates) skip(emulatorGaps.streamedConditionalCreates);
        await storage.put("locks/stream.lock", Readable.from([Buffer.from("a")]), {
          ifNoneMatch: "*",
        });
        await expectStorageError(
          storage.put("locks/stream.lock", Readable.from([Buffer.from("b")]), { ifNoneMatch: "*" }),
          "MS_STORAGE_PRECONDITION_FAILED",
        );
        expect((await readObject(storage, "locks/stream.lock")).toString()).toBe("a");
      });

      it("lets exactly one of several racing conditional creates win", async ({ skip }) => {
        if (!storage.capabilities.conditionalWrites) skip();
        if (emulatorGaps.racingConditionalCreates) skip(emulatorGaps.racingConditionalCreates);
        const attempts = Array.from({ length: 8 }, (_, index) =>
          storage.put("locks/race.lock", Buffer.from(`writer-${index}`), { ifNoneMatch: "*" }),
        );
        const results = await Promise.allSettled(attempts);
        const winners = results.filter((result) => result.status === "fulfilled");
        expect(winners).toHaveLength(1);
        for (const result of results) {
          if (result.status === "rejected") {
            expect(errorCode(result.reason)).toBe("MS_STORAGE_PRECONDITION_FAILED");
          }
        }
      });

      it("allows a conditional create again after the object is deleted", async ({ skip }) => {
        if (!storage.capabilities.conditionalWrites) skip();
        await storage.put("locks/again.lock", Buffer.from("1"), { ifNoneMatch: "*" });
        await storage.delete(["locks/again.lock"]);
        await storage.put("locks/again.lock", Buffer.from("2"), { ifNoneMatch: "*" });
        expect((await readObject(storage, "locks/again.lock")).toString()).toBe("2");
      });
    });

    describe("head", () => {
      it("returns key, size and last-modified time for an existing object", async () => {
        const before = Date.now();
        await storage.put("info/object.bin", Buffer.alloc(42, 7));
        const info = await storage.head("info/object.bin");
        expect(info?.key).toBe("info/object.bin");
        expect(info?.size).toBe(42);
        expect(info?.lastModified).toBeInstanceOf(Date);
        // Generous window: remote stores may have whole-second precision and clock skew.
        expect(info?.lastModified.getTime()).toBeGreaterThan(before - 5 * 60_000);
      });

      it("returns undefined for a missing object and for a 'directory'", async () => {
        await storage.put("info/nested/object.bin", Buffer.from("x"));
        expect(await storage.head("info/missing.bin")).toBeUndefined();
        expect(await storage.head("info/nested")).toBeUndefined();
      });
    });

    describe("range reads", () => {
      const digits = Buffer.from("0123456789");

      it("returns an inclusive byte range", async ({ skip }) => {
        if (!storage.capabilities.rangeReads) skip();
        await storage.put("range.txt", digits);
        expect(await readObject(storage, "range.txt", { start: 2, end: 5 })).toEqual(
          Buffer.from("2345"),
        );
      });

      it("reads to the end when no end is given", async ({ skip }) => {
        if (!storage.capabilities.rangeReads) skip();
        await storage.put("range.txt", digits);
        expect(await readObject(storage, "range.txt", { start: 7 })).toEqual(Buffer.from("789"));
      });

      it("reads a single byte", async ({ skip }) => {
        if (!storage.capabilities.rangeReads) skip();
        await storage.put("range.txt", digits);
        expect(await readObject(storage, "range.txt", { start: 0, end: 0 })).toEqual(
          Buffer.from("0"),
        );
        expect(await readObject(storage, "range.txt", { start: 9, end: 9 })).toEqual(
          Buffer.from("9"),
        );
      });
    });

    describe("list", () => {
      // Deliberately tricky: `-` (0x2d) and `.` (0x2e) sort before `/` (0x2f),
      // so a directory walk in name order would get this wrong.
      const keys = [
        "a/b",
        "a-c",
        "a.b/x",
        "a0",
        "a/z/deep.bin",
        "b",
        "backups/2026-01-01/manifest.json",
        "backups/2026-01-01/app/users.bson",
        "backups/2026-02-01/manifest.json",
        "backups/2026.json",
        "backups/other/manifest.json",
      ];

      beforeEach(async () => {
        for (const key of shuffled(keys)) await storage.put(key, Buffer.from(key));
      });

      it("lists every object recursively in lexicographic key order", async () => {
        expect(await collectKeys(storage.list(""))).toEqual([...keys].sort());
      });

      it("reports the size of each object", async () => {
        const infos = await collect(storage.list("backups/"));
        for (const info of infos) expect(info.size).toBe(Buffer.byteLength(info.key));
      });

      it("filters by a directory prefix", async () => {
        expect(await collectKeys(storage.list("backups/2026-01-01/"))).toEqual([
          "backups/2026-01-01/app/users.bson",
          "backups/2026-01-01/manifest.json",
        ]);
      });

      it("filters by a prefix that ends in a partial name", async () => {
        expect(await collectKeys(storage.list("backups/2026"))).toEqual([
          "backups/2026-01-01/app/users.bson",
          "backups/2026-01-01/manifest.json",
          "backups/2026-02-01/manifest.json",
          "backups/2026.json",
        ]);
        expect(await collectKeys(storage.list("a"))).toEqual([
          "a-c",
          "a.b/x",
          "a/b",
          "a/z/deep.bin",
          "a0",
        ]);
      });

      it("returns nothing for a prefix with no objects", async () => {
        expect(await collectKeys(storage.list("nothing/here/"))).toEqual([]);
        expect(await collectKeys(storage.list("backups/2027"))).toEqual([]);
      });

      it("treats an exact key as a prefix of itself", async () => {
        expect(await collectKeys(storage.list("backups/2026.json"))).toEqual(["backups/2026.json"]);
      });
    });

    describe("listPrefixes", () => {
      beforeEach(async () => {
        const keys = [
          "backups/2026-01-01/manifest.json",
          "backups/2026-01-01/app/users.bson",
          "backups/2026-02-01/manifest.json",
          "backups/latest.json",
          "locks/run.lock",
          "top.json",
        ];
        for (const key of shuffled(keys)) await storage.put(key, Buffer.from("x"));
      });

      it("lists only immediate sub-directories, each with a trailing slash", async () => {
        expect(await collect(storage.listPrefixes(""))).toEqual(["backups/", "locks/"]);
        expect(await collect(storage.listPrefixes("backups/"))).toEqual([
          "backups/2026-01-01/",
          "backups/2026-02-01/",
        ]);
        expect(await collect(storage.listPrefixes("backups/2026-01-01/"))).toEqual([
          "backups/2026-01-01/app/",
        ]);
      });

      it("returns nothing when there are no sub-directories", async () => {
        expect(await collect(storage.listPrefixes("locks/"))).toEqual([]);
        expect(await collect(storage.listPrefixes("missing/"))).toEqual([]);
      });
    });

    describe("delete", () => {
      it("removes objects and ignores missing keys", async () => {
        await storage.put("del/a", Buffer.from("a"));
        await storage.put("del/b", Buffer.from("b"));
        await storage.put("keep/c", Buffer.from("c"));
        await storage.delete(["del/a", "del/missing", "never/existed"]);
        expect(await collectKeys(storage.list(""))).toEqual(["del/b", "keep/c"]);
      });

      it("accepts an empty list", async () => {
        await storage.delete([]);
      });

      it("makes an emptied 'directory' disappear from listPrefixes", async () => {
        await storage.put("gone/deep/x", Buffer.from("x"));
        await storage.put("stays/y", Buffer.from("y"));
        await storage.delete(["gone/deep/x"]);
        expect(await collect(storage.listPrefixes(""))).toEqual(["stays/"]);
      });

      it("deletes many keys in one call", async () => {
        const keys = Array.from({ length: 50 }, (_, index) => `many/${index}.bin`);
        await Promise.all(keys.map((key) => storage.put(key, Buffer.from(key))));
        await storage.delete(keys);
        expect(await collectKeys(storage.list(""))).toEqual([]);
      });
    });

    describe("write-once retention", () => {
      /** Retention long enough to outlive the test, short enough to cost nothing on a real bucket. */
      const inOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

      it("rejects retainUntil with MS_CONFIG_INVALID before reading the body when it cannot lock", async ({
        skip,
      }) => {
        if (canLock()) skip();
        const body = untouchedStream();
        await expectStorageError(
          storage.put("locked/a.bin", body.stream, { retainUntil: inOneDay() }),
          "MS_CONFIG_INVALID",
        );
        // Unprepared buckets are detected before the upload starts, so nothing is read.
        expect(body.wasRead()).toBe(false);
        expect(await collectKeys(storage.list(""))).toEqual([]);
      });

      it("stores a retained object that reads back normally", async ({ skip }) => {
        if (!canLock()) skip();
        const info = await storage.put("locked/a.bin", Buffer.from("immutable"), {
          retainUntil: inOneDay(),
        });
        expect(info.size).toBe(9);
        expect((await readObject(storage, "locked/a.bin")).toString()).toBe("immutable");
        expect(await collectKeys(storage.list("locked/"))).toEqual(["locked/a.bin"]);
      });

      it("retains streamed objects too", async ({ skip }) => {
        if (!canLock()) skip();
        await storage.put("locked/s.bin", Readable.from([Buffer.from("a"), Buffer.from("b")]), {
          retainUntil: inOneDay(),
        });
        expect((await readObject(storage, "locked/s.bin")).toString()).toBe("ab");
      });

      it("rejects a retainUntil in the past with MS_CONFIG_INVALID", async ({ skip }) => {
        if (!storage.capabilities.objectLock) skip();
        await expectStorageError(
          storage.put("locked/past.bin", Buffer.from("x"), { retainUntil: new Date(0) }),
          "MS_CONFIG_INVALID",
        );
        expect(await collectKeys(storage.list(""))).toEqual([]);
      });

      it("refuses to delete a locked object, flagging the error as objectLocked", async ({
        skip,
      }) => {
        if (!canLock() || lockedDeletes !== "refused") skip();
        await storage.put("locked/a.bin", Buffer.from("keep me"), { retainUntil: inOneDay() });
        const error = await storage.delete(["locked/a.bin"]).then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(errorCode(error), String(error)).toBe("MS_STORAGE_FORBIDDEN");
        expect(isMongoShieldError(error) && error.details?.objectLocked).toBe(true);
        expect((await readObject(storage, "locked/a.bin")).toString()).toBe("keep me");
      });

      it("refuses to overwrite a locked object", async ({ skip }) => {
        if (!canLock() || lockedDeletes !== "refused") skip();
        await storage.put("locked/a.bin", Buffer.from("first"), { retainUntil: inOneDay() });
        await expectStorageError(
          storage.put("locked/a.bin", Buffer.from("second")),
          "MS_STORAGE_FORBIDDEN",
        );
        expect((await readObject(storage, "locked/a.bin")).toString()).toBe("first");
      });

      it("still deletes objects written without retention", async ({ skip }) => {
        if (!canLock()) skip();
        await storage.put("plain/a.bin", Buffer.from("x"));
        await storage.delete(["plain/a.bin"]);
        expect(await collectKeys(storage.list(""))).toEqual([]);
      });
    });

    describe("key validation", () => {
      const invalidKeys = ["", "/absolute", "../escape", "a/../../b", "a//b", "a\\b", "a/./b"];

      it.each(invalidKeys)("rejects the invalid key %j everywhere", async (key) => {
        await expect(storage.put(key, Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
        await expect(storage.get(key)).rejects.toThrow(/Invalid storage key/);
        await expect(storage.head(key)).rejects.toThrow(/Invalid storage key/);
        await expect(storage.delete([key])).rejects.toThrow(/Invalid storage key/);
      });

      it("rejects invalid listing prefixes", async () => {
        await expect(collect(storage.list("../"))).rejects.toThrow(/Invalid storage key/);
        await expect(collect(storage.listPrefixes("/abs/"))).rejects.toThrow(/Invalid storage key/);
      });
    });

    describe("cancellation", () => {
      it("rejects every operation with MS_ABORTED when the signal is already aborted", async () => {
        await storage.put("abort/existing", Buffer.from("x"));
        const signal = AbortSignal.abort();
        await expectStorageError(
          storage.put("abort/new", Buffer.from("x"), { signal }),
          "MS_ABORTED",
        );
        await expectStorageError(storage.get("abort/existing", { signal }), "MS_ABORTED");
        await expectStorageError(storage.head("abort/existing", { signal }), "MS_ABORTED");
        await expectStorageError(collect(storage.list("", { signal })), "MS_ABORTED");
        await expectStorageError(collect(storage.listPrefixes("", { signal })), "MS_ABORTED");
        await expectStorageError(storage.delete(["abort/existing"], { signal }), "MS_ABORTED");

        expect(await storage.head("abort/new")).toBeUndefined();
        expect(await storage.head("abort/existing")).toBeDefined();
      });

      it("rejects with MS_ABORTED and stores nothing when aborted during a streamed put", async () => {
        const controller = new AbortController();
        const body = slowStream(controller);
        await expectStorageError(
          storage.put("abort/streamed", body, { signal: controller.signal }),
          "MS_ABORTED",
        );
        expect(await storage.head("abort/streamed")).toBeUndefined();
        expect(await collectKeys(storage.list(""))).toEqual([]);
      });
    });

    describe("concurrency and reuse", () => {
      it("handles concurrent puts to different keys", async () => {
        const keys = Array.from(
          { length: 24 },
          (_, index) => `concurrent/${index % 3}/object-${index}.bin`,
        );
        await Promise.all(
          keys.map((key) => storage.put(key, Readable.from([Buffer.from(key), Buffer.from("!")]))),
        );
        expect(await collectKeys(storage.list("concurrent/"))).toEqual([...keys].sort());
        for (const key of keys) {
          expect((await readObject(storage, key)).toString()).toBe(`${key}!`);
        }
      });

      it("serves consecutive runs from one instance without per-run state", async () => {
        for (const run of ["run-1", "run-2", "run-3"]) {
          await storage.put(`backups/${run}/data.bin`, Readable.from([Buffer.from(run)]));
          await storage.put(`backups/${run}/manifest.json`, Buffer.from(`{"run":"${run}"}`));
          expect(await collectKeys(storage.list(`backups/${run}/`))).toEqual([
            `backups/${run}/data.bin`,
            `backups/${run}/manifest.json`,
          ]);
        }
        expect(await collect(storage.listPrefixes("backups/"))).toEqual([
          "backups/run-1/",
          "backups/run-2/",
          "backups/run-3/",
        ]);
        await storage.delete(["backups/run-1/data.bin", "backups/run-1/manifest.json"]);
        expect(await collect(storage.listPrefixes("backups/"))).toEqual([
          "backups/run-2/",
          "backups/run-3/",
        ]);
        expect((await readObject(storage, "backups/run-3/data.bin")).toString()).toBe("run-3");
      });

      it("can be closed more than once", async () => {
        await storage.close?.();
        await storage.close?.();
      });
    });
  });
}

/** Reads a whole object (or a range of it) into memory. Test objects are small. */
async function readObject(
  storage: StorageAdapter,
  key: string,
  range?: { start: number; end?: number },
): Promise<Buffer> {
  const stream = await storage.get(key, range ? { range } : {});
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(toBuffer(chunk));
  return Buffer.concat(chunks);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function collectKeys(iterable: AsyncIterable<ObjectInfo>): Promise<string[]> {
  return (await collect(iterable)).map((info) => info.key);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

function errorCode(error: unknown): string | undefined {
  return isMongoShieldError(error) ? error.code : undefined;
}

/** Asserts that a promise rejects with a `MongoShieldError` carrying `code`. */
async function expectStorageError(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error, `expected a rejection with ${code}`).toBeDefined();
  expect(errorCode(error), String(error)).toBe(code);
}

/**
 * A stream of `size` deterministic, non-repeating-looking bytes in 64 KiB
 * chunks, generated lazily so the test never holds the whole object in memory.
 * Every chunk is also fed into `hash` so the caller can verify the read-back.
 */
function patternStream(size: number, hash: ReturnType<typeof createHash>): Readable {
  const chunkSize = 64 * 1024;
  async function* generate() {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const chunk = Buffer.alloc(length);
      for (let index = 0; index < length; index++) {
        chunk[index] = ((offset + index) * 31 + ((offset + index) >> 11)) & 0xff;
      }
      hash.update(chunk);
      offset += length;
      yield chunk;
    }
  }
  return Readable.from(generate());
}

/**
 * A stream that records whether anyone ever pulled data from it, to prove an
 * adapter rejected a put before reading the body.
 */
function untouchedStream(): { stream: Readable; wasRead: () => boolean } {
  let read = false;
  const stream = new Readable({
    read() {
      read = true;
      this.push(Buffer.from("data"));
      this.push(null);
    },
  });
  return { stream, wasRead: () => read };
}

/** Emits the given chunks, then fails, like a source whose database cursor died. */
function failingStream(chunks: readonly Buffer[]): Readable {
  async function* generate() {
    for (const chunk of chunks) yield chunk;
    throw new Error("source stream failed");
  }
  return Readable.from(generate());
}

/**
 * Emits one chunk, aborts the controller, then emits one more chunk and ends.
 * Ending after the abort keeps adapters that only check the signal once the
 * body is fully read from hanging, while still exercising a mid-stream abort.
 */
function slowStream(controller: AbortController): Readable {
  async function* generate() {
    yield Buffer.from("before abort ");
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    yield Buffer.from("after abort");
  }
  return Readable.from(generate());
}

/** Fisher-Yates shuffle, so insertion order never accidentally matches key order. */
function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    const current = copy[index] as T;
    copy[index] = copy[other] as T;
    copy[other] = current;
  }
  return copy;
}
