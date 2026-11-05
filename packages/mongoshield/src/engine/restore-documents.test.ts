// Unit tests for insert batching: batches are bounded by document count and by
// bytes, keep every document in order, and never split or drop one.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BatchLimits,
  batchDocuments,
  classifyDuplicateKey,
  DEFAULT_BATCH_LIMITS,
  isDuplicateIdError,
  type RawBatch,
} from "./restore-documents.ts";

/** The parts of a driver write error that decide (the driver drops `keyPattern`). */
function writeError(code: number, errmsg: string) {
  return { code, errmsg };
}

describe("isDuplicateIdError", () => {
  it("accepts duplicate _id errors, including clustered collections", () => {
    const messages = [
      "E11000 duplicate key error collection: app.users index: _id_ dup key: { _id: 1 }",
      "E11000 duplicate key error collection: app.events dup key: { _id: 1 } found value: {}",
    ];
    for (const message of messages)
      expect(isDuplicateIdError(writeError(11000, message))).toBe(true);
  });

  it("refuses duplicates on any other unique index, even one starting with _id", () => {
    const messages = [
      'E11000 duplicate key error collection: app.users index: username_1 dup key: { username: "ada" }',
      "E11000 duplicate key error collection: app.users index: _id_1_x_1 dup key: { _id: 1, x: 2 }",
    ];
    for (const message of messages) {
      expect(isDuplicateIdError(writeError(11000, message))).toBe(false);
    }
  });

  it("refuses errors that are not duplicate keys", () => {
    expect(isDuplicateIdError(writeError(121, "Document failed validation"))).toBe(false);
    expect(classifyDuplicateKey(writeError(121, "index: _id_"))).toBeUndefined();
  });
});

describe("classifyDuplicateKey", () => {
  /** An E11000 whose message names no index, as MongoDB-compatible engines word it. */
  const COSMOS =
    "E11000 duplicate key error collection: app.users Failed _id or unique index constraint";

  it("trusts keyPattern first, whatever the message says", () => {
    const onId = { code: 11000, errmsg: COSMOS, keyPattern: { _id: 1 } };
    const onEmail = {
      code: 11000,
      errmsg: "index: _id_ dup key: { _id: 1 }",
      keyPattern: { email: 1 },
    };
    const compound = { code: 11000, errmsg: COSMOS, keyPattern: { _id: 1, tenant: 1 } };
    expect(classifyDuplicateKey(onId)).toBe("id");
    expect(classifyDuplicateKey(onEmail)).toBe("other-index");
    expect(classifyDuplicateKey(compound)).toBe("other-index");
  });

  it("falls back to keyValue when there is no keyPattern", () => {
    expect(classifyDuplicateKey({ code: 11000, keyValue: { _id: "a" } })).toBe("id");
    expect(classifyDuplicateKey({ code: 11000, keyValue: { email: "a@b" } })).toBe("other-index");
  });

  it("reads keyPattern from a WriteError's raw record", () => {
    // The driver's WriteError keeps the server's record as `err` and exposes code and
    // errmsg as getters (the class itself is not exported). It drops keyPattern today;
    // should a version pass it on, it is used.
    const raw = { index: 0, code: 11000, errmsg: COSMOS, keyPattern: { _id: 1 } };
    const withPattern = { err: raw, code: raw.code, errmsg: raw.errmsg };
    expect(classifyDuplicateKey(withPattern)).toBe("id");
    const withoutPattern = { err: { ...raw, keyPattern: undefined }, code: 11000, errmsg: COSMOS };
    expect(classifyDuplicateKey(withoutPattern)).toBe("unattributed");
  });

  it("reads the index name from the message, also without a dup key part", () => {
    expect(
      classifyDuplicateKey(
        writeError(11000, "E11000 duplicate key error collection: app.c index: _id_"),
      ),
    ).toBe("id");
    expect(
      classifyDuplicateKey(writeError(11000, "E11000 duplicate key error index: email_1")),
    ).toBe("other-index");
  });

  it("reads the first field of the duplicate key when no index is named", () => {
    expect(classifyDuplicateKey(writeError(11000, "E11000 dup key: { _id: 1 }"))).toBe("id");
    expect(classifyDuplicateKey(writeError(11000, 'E11000 dup key: { "_id": 1 }'))).toBe("id");
    expect(classifyDuplicateKey(writeError(11000, 'E11000 dup key: { email: "x" }'))).toBe(
      "other-index",
    );
  });

  it("calls an E11000 that says nothing about its index unattributed, and skips it as a duplicate _id", () => {
    for (const message of [COSMOS, "E11000 duplicate key error", ""]) {
      expect(classifyDuplicateKey(writeError(11000, message))).toBe("unattributed");
      expect(isDuplicateIdError(writeError(11000, message))).toBe(true);
    }
    expect(classifyDuplicateKey({ code: 11000 })).toBe("unattributed");
  });
});

async function* from(documents: readonly Buffer[]): AsyncGenerator<Buffer> {
  yield* documents;
}

async function collect(documents: readonly Buffer[], limits: BatchLimits): Promise<RawBatch[]> {
  const batches: RawBatch[] = [];
  for await (const batch of batchDocuments(from(documents), limits)) batches.push(batch);
  return batches;
}

function documentsOfSizes(sizes: readonly number[]): Buffer[] {
  return sizes.map((size, index) => Buffer.alloc(size, index % 256));
}

describe("batchDocuments", () => {
  it("yields nothing for no documents", async () => {
    expect(await collect([], DEFAULT_BATCH_LIMITS)).toEqual([]);
  });

  it("closes a batch when it reaches the document limit", async () => {
    const batches = await collect(documentsOfSizes([10, 10, 10, 10, 10]), {
      maxDocuments: 2,
      maxBytes: 1000,
    });
    expect(batches.map((batch) => batch.documents.length)).toEqual([2, 2, 1]);
    expect(batches.map((batch) => batch.bytes)).toEqual([20, 20, 10]);
  });

  it("closes a batch before a document that would exceed the byte limit", async () => {
    const batches = await collect(documentsOfSizes([40, 40, 40]), {
      maxDocuments: 100,
      maxBytes: 100,
    });
    expect(batches.map((batch) => batch.bytes)).toEqual([80, 40]);
  });

  it("puts a document larger than the byte limit in a batch of its own", async () => {
    const batches = await collect(documentsOfSizes([10, 500, 10]), {
      maxDocuments: 100,
      maxBytes: 100,
    });
    expect(batches.map((batch) => batch.bytes)).toEqual([10, 500, 10]);
  });

  it("keeps every document, in order, within the limits", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 5, max: 300 }), { maxLength: 60 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 5, max: 600 }),
        async (sizes, maxDocuments, maxBytes) => {
          const documents = documentsOfSizes(sizes);
          const batches = await collect(documents, { maxDocuments, maxBytes });
          expect(batches.flatMap((batch) => batch.documents)).toEqual(documents);
          for (const batch of batches) {
            expect(batch.documents.length).toBeGreaterThan(0);
            expect(batch.documents.length).toBeLessThanOrEqual(maxDocuments);
            if (batch.documents.length > 1) expect(batch.bytes).toBeLessThanOrEqual(maxBytes);
          }
        },
      ),
    );
  });
});
