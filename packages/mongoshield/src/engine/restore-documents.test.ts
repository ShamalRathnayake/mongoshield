// Unit tests for insert batching: batches are bounded by document count and by
// bytes, keep every document in order, and never split or drop one.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type BatchLimits,
  batchDocuments,
  DEFAULT_BATCH_LIMITS,
  type RawBatch,
} from "./restore-documents.ts";

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
