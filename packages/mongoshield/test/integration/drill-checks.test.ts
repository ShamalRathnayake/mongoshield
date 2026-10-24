// Integration tests for a drill's per-namespace checks (drill-checks.ts), run directly
// against hand-made "restored" namespaces, so every finding can be provoked: views
// that are missing or not views, missing indexes, missing and differing sampled
// documents, converge backups, and time series without usable options.

import { BSON, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { checkRestoredNamespace, fieldFingerprint } from "../../src/engine/drill-checks.ts";
import { sourceFromManifest } from "../../src/engine/read-pipeline.ts";
import { MongoShieldError } from "../../src/errors.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { Manifest } from "../../src/format/manifest.ts";
import { memoryStorage } from "../../src/storage/memory.ts";
import type { RestorePlanEntry } from "../../src/types.ts";
import { type FixtureNamespace, writeTestBackup } from "../helpers/backup-fixtures.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

/** Documents with numeric ids. */
interface NumberedDocument {
  _id: number;
  [field: string]: unknown;
}

/** A one-namespace backup, and a fresh target namespace to check against it. */
async function setUp(namespace: Omit<FixtureNamespace, "ns">) {
  const storage = memoryStorage();
  const ns = `${uniqueDb("dc")}.c`;
  const manifest: Manifest = await writeTestBackup(storage, { namespaces: [{ ns, ...namespace }] });
  const targetDatabase = uniqueDb("dct");
  return { storage, manifest, ns, targetDatabase, target: `${targetDatabase}.c` };
}

/** Runs the checks of the backup's only namespace against `target`. */
async function check(
  setup: Awaited<ReturnType<typeof setUp>>,
  options: { sampleSize?: number; replayedChanges?: boolean; type?: RestorePlanEntry["type"] } = {},
) {
  const entry = setup.manifest.namespaces[0];
  if (entry === undefined) throw new Error("no entry");
  return checkRestoredNamespace({
    client: client(),
    source: sourceFromManifest(setup.storage, setup.manifest, undefined),
    planned: {
      from: setup.ns,
      to: setup.target,
      type: options.type ?? (entry.type === "view" ? "view" : "collection"),
      documents: entry.documents,
      action: "create",
      existingDocuments: 0,
    },
    entry,
    sampleSize: options.sampleSize ?? 0,
    replayedChanges: options.replayedChanges ?? false,
    signal: undefined,
  });
}

describe("checking a restored view", () => {
  it("reports a view that was not restored, or restored as something else", async () => {
    const setup = await setUp({ type: "view", options: { viewOn: "x", pipeline: [] } });
    expect((await check(setup)).problems).toEqual(["the view was not restored"]);
    await client().db(setup.targetDatabase).createCollection("c");
    expect((await check(setup)).problems).toEqual(["restored as a collection, not a view"]);
  });
});

describe("checking a restored collection", () => {
  const documents = Array.from({ length: 8 }, (_, n) => ({ _id: n, v: n }));

  it("reports missing indexes, missing documents and differing documents (at most five)", async () => {
    const setup = await setUp({
      documents,
      indexes: [
        { v: 2, key: { _id: 1 }, name: "_id_" },
        { v: 2, key: { v: 1 }, name: "by_v" },
      ],
    });
    const target = client().db(setup.targetDatabase).collection<NumberedDocument>("c");
    // Documents 0-1 intact, 2-6 changed, 7 missing.
    await target.insertMany(documents.slice(0, 7).map((d) => (d._id < 2 ? d : { ...d, v: -1 })));
    const report = await check(setup, { sampleSize: 8 });
    expect(report.indexesFound).toBe(1);
    expect(report.sampled).toBe(8);
    expect(report.problems).toContain('index "by_v" is missing');
    expect(report.problems).toContain("7 documents restored, the manifest lists 8");
    expect(report.problems).toContain("… and 1 more sampled documents");
    // Five sample problems are listed, plus the count and the index problem.
    expect(report.problems).toHaveLength(8);
  });

  it("only notes count differences and skips sampling for converge backups", async () => {
    const setup = await setUp({ documents });
    await client()
      .db(setup.targetDatabase)
      .collection<NumberedDocument>("c")
      .insertOne({ _id: 99 });
    const report = await check(setup, { sampleSize: 5, replayedChanges: true });
    expect(report.problems).toEqual([]);
    expect(report.notes).toEqual([
      "1 documents restored, the manifest lists 8 (expected: changes of the backup window were replayed)",
      "converge backup: documents were not sampled (the change replay modifies them)",
    ]);
  });
});

describe("checking a restored time series", () => {
  it("does not sample a time series whose metadata has no usable timeField", async () => {
    for (const options of [{}, { timeseries: "nonsense" }, { timeseries: { timeField: 5 } }]) {
      const setup = await setUp({
        type: "timeseries",
        options,
        documents: [{ _id: 1, at: new Date(0) }],
      });
      await client().db(setup.targetDatabase).createCollection("c");
      const report = await check(setup, { sampleSize: 5, type: "timeseries" });
      expect(report.sampled, JSON.stringify(options)).toBe(0);
      expect(report.notes).toContain(
        "time-series collection without a timeField in its metadata: not sampled",
      );
    }
  });
});

describe("fieldFingerprint", () => {
  it("ignores field order, and the order inside the meta field only", () => {
    const left = { a: 1, meta: { y: [{ q: 1, p: 2 }], x: new Date(0) }, nested: { b: 1, a: 2 } };
    const right = { nested: { b: 1, a: 2 }, meta: { x: new Date(0), y: [{ p: 2, q: 1 }] }, a: 1 };
    expect(fieldFingerprint(left, "meta")).toBe(fieldFingerprint(right, "meta"));
    const reordered: Document = { ...right, nested: { a: 2, b: 1 } };
    expect(fieldFingerprint(left, "meta")).not.toBe(fieldFingerprint(reordered, "meta"));
    expect(fieldFingerprint({ meta: /x/ }, "meta")).toBe(
      fieldFingerprint(BSON.deserialize(BSON.serialize({ meta: /x/ })), "meta"),
    );
  });
});

describe("checking against a damaged backup", () => {
  it("reports a metadata file that does not match its digest as a problem", async () => {
    const setup = await setUp({ documents: [{ _id: 1 }] });
    const entry = setup.manifest.namespaces[0];
    if (entry === undefined) throw new Error("no entry");
    await client().db(setup.targetDatabase).collection<NumberedDocument>("c").insertOne({ _id: 1 });
    try {
      await setup.storage.put(
        resolveBackupKey(setup.manifest.id, entry.metadata.key),
        Buffer.from("x".repeat(entry.metadata.size)),
      );
      const report = await check(setup, { sampleSize: 5 });
      expect(report.ok).toBe(false);
      expect(report.problems).toEqual([expect.stringMatching(/^reading the backup failed: /)]);
    } finally {
      await client().db(setup.targetDatabase).dropDatabase();
    }
  });

  it("throws errors that are not about the backup (here: an abort)", async () => {
    const setup = await setUp({ documents: [{ _id: 1 }] });
    const entry = setup.manifest.namespaces[0];
    if (entry === undefined) throw new Error("no entry");
    const aborting = {
      ...setup.storage,
      async get(): Promise<never> {
        throw new MongoShieldError("MS_ABORTED", "stopped by the test");
      },
    };
    await expect(
      checkRestoredNamespace({
        client: client(),
        source: sourceFromManifest(aborting, setup.manifest, undefined),
        planned: {
          from: setup.ns,
          to: setup.target,
          type: "collection",
          documents: entry.documents,
          action: "create",
          existingDocuments: 0,
        },
        entry,
        sampleSize: 5,
        replayedChanges: false,
        signal: undefined,
      }),
    ).rejects.toThrow(/stopped by the test/);
  });
});
