// Unit tests for writing one backup file (backup-write.ts): which error a failed write
// reports when the source, a transform or the storage fails, and that an abort wins.

import { Readable, Transform } from "node:stream";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { writeStoredFile } from "./backup-write.ts";

function chunks(count: number): Readable {
  return Readable.from(Array.from({ length: count }, (_, index) => Buffer.from(`chunk ${index}`)));
}

function request(storage: StorageAdapter, source: Readable, transforms: Transform[] = []) {
  return {
    storage,
    key: "backups/x/app/c.bson",
    source,
    transforms,
    contentType: "application/octet-stream",
    signal: new AbortController().signal,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("writeStoredFile", () => {
  it("stores the bytes and returns their digest", async () => {
    const storage = memoryStorage();
    const digest = await writeStoredFile(request(storage, chunks(3)));
    expect(digest.size).toBe("chunk 0chunk 1chunk 2".length);
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.keys()).toEqual(["backups/x/app/c.bson"]);
  });

  it("reports the storage's error when only the put fails", async () => {
    const base = memoryStorage();
    const failing: StorageAdapter = {
      ...base,
      async put(_key, body) {
        // Read a little, then give up, as a storage losing its connection would.
        if (body instanceof Readable) for await (const _chunk of body) break;
        throw new Error("bucket is gone");
      },
    };
    const error = await errorOf(writeStoredFile(request(failing, chunks(1000))));
    expect(String(error)).toMatch(/bucket is gone/);
  });

  it("reports the transform's error, not the put that saw its body break", async () => {
    const failingTransform = new Transform({
      transform(_chunk, _encoding, callback) {
        callback(new Error("compressor exploded"));
      },
    });
    const error = await errorOf(
      writeStoredFile(request(memoryStorage(), chunks(5), [failingTransform])),
    );
    expect(String(error)).toMatch(/compressor exploded/);
  });

  it("reports a non-Error thrown by the storage as it is", async () => {
    const failing: StorageAdapter = {
      ...memoryStorage(),
      async put() {
        throw "plain string failure";
      },
    };
    const error = await errorOf(writeStoredFile(request(failing, chunks(1000))));
    expect(error).toBe("plain string failure");
  });

  it("reports an abort as the typed abort error", async () => {
    const controller = new AbortController();
    const slow = new Readable({ read() {} });
    const writing = writeStoredFile({
      ...request(memoryStorage(), slow),
      signal: controller.signal,
    });
    slow.push(Buffer.from("partial"));
    controller.abort();
    const error = await errorOf(writing);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });
});
