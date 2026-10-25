import { tmpdir } from "node:os";
import { BSON, type Document, Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import { compareDocumentStreams, compareIndexes, compareOptions } from "./diff.ts";

async function* raw(documents: readonly Document[]): AsyncGenerator<Uint8Array> {
  for (const document of documents) yield BSON.serialize(document);
}

/** 300 documents on each side: ids 0-9 removed, 300-309 added, every 7th changed. */
function sides(): { from: Document[]; to: Document[] } {
  const from = Array.from({ length: 300 }, (_, id) => ({ _id: id, value: id }));
  const to = Array.from({ length: 300 }, (_, index) => {
    const id = index + 10;
    return { _id: id, value: id % 7 === 0 && id < 300 ? -id : id };
  });
  return { from, to };
}

const settings = { examples: 3, workDirectory: tmpdir(), signal: undefined };

describe("compareDocumentStreams", () => {
  it("counts added, removed, changed and unchanged documents in memory", async () => {
    const { from, to } = sides();
    const result = await compareDocumentStreams(raw(from), raw(to), {
      ...settings,
      maxRecords: 1000,
      expected: 300,
    });
    const changed = Array.from({ length: 290 }, (_, index) => index + 10).filter(
      (id) => id % 7 === 0,
    ).length;
    expect(result.spilled).toBe(false);
    expect(result.counts).toEqual({
      from: 300,
      to: 300,
      added: 10,
      removed: 10,
      changed,
      unchanged: 290 - changed,
    });
    expect(result.examples.added).toHaveLength(3);
  });

  it("gives the same answer when spilling to bucket files", async () => {
    const { from, to } = sides();
    const inMemory = await compareDocumentStreams(raw(from), raw(to), {
      ...settings,
      maxRecords: 1000,
      expected: 300,
    });
    const spilled = await compareDocumentStreams(raw(from), raw(to), {
      ...settings,
      maxRecords: 16,
      expected: 300,
    });
    expect(spilled.spilled).toBe(true);
    expect(spilled.counts).toEqual(inMemory.counts);
    for (const id of spilled.examples.removed) expect(Number(id)).toBeLessThan(10);
  });

  it("treats a different BSON type of the same value as a change", async () => {
    const result = await compareDocumentStreams(
      raw([{ _id: 1, n: new Int32(1) }]),
      raw([{ _id: 1, n: 1.5 }]),
      { ...settings, maxRecords: 10, expected: 1 },
    );
    expect(result.counts.changed).toBe(1);
  });
});

describe("compareIndexes", () => {
  it("finds added, removed and changed indexes, ignoring v and option order", () => {
    const from = [
      { v: 2, key: { _id: 1 }, name: "_id_" },
      { v: 2, key: { email: 1 }, name: "email_1", unique: true, sparse: true },
      { v: 2, key: { age: 1 }, name: "age_1" },
    ];
    const to = [
      { v: 1, key: { _id: 1 }, name: "_id_" },
      { v: 2, key: { email: 1 }, name: "email_1", sparse: true, unique: true },
      { v: 2, key: { age: -1 }, name: "age_1" },
      { v: 2, key: { city: 1 }, name: "city_1" },
    ];
    expect(compareIndexes(from, to)).toEqual({
      added: ["city_1"],
      removed: [],
      changed: ["age_1"],
    });
  });
});

describe("compareOptions", () => {
  it("names the options that were added, removed or changed", () => {
    expect(
      compareOptions(
        { validator: { a: { $type: "string" } }, capped: true },
        { validator: { a: { $type: "int" } }, collation: { locale: "fr" }, capped: true },
      ),
    ).toEqual(["collation", "validator"]);
  });
});
