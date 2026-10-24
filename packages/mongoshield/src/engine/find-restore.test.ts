// Unit tests for how single-document restore groups matching documents into write
// batches (find-restore.ts). Writing them is tested against a real server in
// test/integration/find.test.ts and find-restore-edges.test.ts.

import { describe, expect, it } from "vitest";
import type { MatchedDocument } from "./find.ts";
import { batchMatches } from "./find-restore.ts";

async function* matches(sizes: readonly number[]): AsyncGenerator<MatchedDocument> {
  for (const [index, bytes] of sizes.entries()) yield { document: { _id: index }, bytes };
}

async function batchIds(sizes: readonly number[], maxDocuments: number, maxBytes: number) {
  const batches: number[][] = [];
  for await (const batch of batchMatches(matches(sizes), { maxDocuments, maxBytes })) {
    batches.push(batch.map((document) => Number(document._id)));
  }
  return batches;
}

describe("batchMatches", () => {
  it("closes a batch at the document limit", async () => {
    expect(await batchIds([1, 1, 1, 1, 1], 2, 100)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it("closes a batch before a document that would pass the byte limit", async () => {
    expect(await batchIds([40, 40, 40, 10], 10, 100)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("puts a document larger than the byte limit in a batch of its own", async () => {
    expect(await batchIds([10, 500, 10], 10, 100)).toEqual([[0], [1], [2]]);
  });

  it("yields nothing for no matches", async () => {
    expect(await batchIds([], 10, 100)).toEqual([]);
  });
});
