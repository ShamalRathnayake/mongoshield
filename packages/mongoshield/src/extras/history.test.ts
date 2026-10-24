import { Double, Int32 } from "mongodb";
import { describe, expect, it } from "vitest";
import { writeTestBackup } from "../../test/helpers/backup-fixtures.ts";
import { isMongoShieldError } from "../errors.ts";
import type { DataFile } from "../format/manifest.ts";
import { silentLogger } from "../logger.ts";
import { memoryStorage } from "../storage/memory.ts";
import { diffDocuments, documentHistory, partsThatMayHold, sameBsonValue } from "./history.ts";

describe("diffDocuments", () => {
  it("lists changed, removed and added fields, descending into embedded documents", () => {
    const before = { _id: 1, name: "Ada", address: { city: "Oslo", zip: "0150" }, fax: "x" };
    const after = { _id: 1, name: "Ada L.", address: { city: "Oslo", zip: "0151" }, phone: "y" };
    expect(diffDocuments(before, after)).toEqual([
      { path: "name", kind: "changed", before: "Ada", after: "Ada L." },
      { path: "address.zip", kind: "changed", before: "0150", after: "0151" },
      { path: "fax", kind: "removed", before: "x" },
      { path: "phone", kind: "added", after: "y" },
    ]);
  });

  it("compares arrays as a whole and BSON types exactly", () => {
    expect(diffDocuments({ tags: ["a"] }, { tags: ["a", "b"] })).toHaveLength(1);
    expect(diffDocuments({ n: new Int32(1) }, { n: new Double(1) })).toHaveLength(1);
    expect(diffDocuments({ n: new Int32(1) }, { n: new Int32(1) })).toEqual([]);
  });

  it("treats identical documents as unchanged", () => {
    expect(sameBsonValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
  });
});

describe("partsThatMayHold", () => {
  const file = (key: string, range?: DataFile["range"]): DataFile => ({
    key,
    size: 1,
    sha256: "0".repeat(64),
    ...(range ? { range } : {}),
  });
  const parts = [
    file("p0", { from: { $minKey: 1 }, to: { $numberInt: "100" } }),
    file("p1", { from: { $numberInt: "100" }, to: { $numberInt: "200" } }),
    file("p2", { from: { $numberInt: "200" }, to: { $maxKey: 1 } }),
  ];

  it("keeps only the part whose _id range holds the id", () => {
    expect(partsThatMayHold(parts, 50).map((part) => part.key)).toEqual(["p0"]);
    expect(partsThatMayHold(parts, 100).map((part) => part.key)).toEqual(["p1"]);
    expect(partsThatMayHold(parts, 5000).map((part) => part.key)).toEqual(["p2"]);
  });

  it("orders values of different types as the _id index does", () => {
    // Strings sort after numbers, so a string id lives in the last part.
    expect(partsThatMayHold(parts, "ada").map((part) => part.key)).toEqual(["p2"]);
  });

  it("keeps parts without a range", () => {
    expect(partsThatMayHold([file("only")], 1)).toHaveLength(1);
  });
});

describe("documentHistory options", () => {
  const context = { storage: memoryStorage(), logger: silentLogger };

  it("refuses a missing or array _id and a bad backups count before reading anything", async () => {
    for (const options of [
      { namespace: "app.users", id: undefined },
      { namespace: "app.users", id: [1] },
      { namespace: "app.users", id: 1, backups: 0 },
      { namespace: "app.users", id: 1, backups: 1.5 },
      { namespace: "nodot", id: 1 },
    ]) {
      const error = await documentHistory(context, options).catch((caught: unknown) => caught);
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID"), JSON.stringify(options)).toBe(true);
    }
  });

  it("returns an empty history when no backup and no journal exist", async () => {
    const history = await documentHistory(context, {
      namespace: "app.users",
      id: 1,
      backups: "all",
    });
    expect(history).toMatchObject({
      versions: [],
      backupsSearched: 0,
      journal: { status: "none", gaps: 0 },
    });
    const withoutJournal = await documentHistory(context, {
      namespace: "app.users",
      id: 1,
      journal: false,
    });
    expect(withoutJournal.journal).toEqual({ status: "disabled", gaps: 0 });
  });
});

describe("partsThatMayHold with unreadable ranges", () => {
  it("keeps a part whose range cannot be read", () => {
    const part = {
      key: "app/users.0.bson.zst",
      size: 1,
      sha256: "0".repeat(64),
      documents: 1,
      range: { from: { $numberLong: "not a number" }, to: { $maxKey: 1 } },
    };
    expect(partsThatMayHold([part], 5)).toEqual([part]);
  });
});

describe("documentHistory over incomplete backups", () => {
  it("ignores a backup that has files but no manifest", async () => {
    const storage = memoryStorage();
    await storage.put("backups/2026-01-01T00-00-00Z_abcdef/app/users.bson.zst", Buffer.from("x"));
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: "app.users", id: 1, journal: false },
    );
    expect(history.backupsSearched).toBe(0);
  });
});

describe("documentHistory over backups without a cluster time", () => {
  it("places a backup taken without consistency at its completion time", async () => {
    const storage = memoryStorage();
    const manifest = await writeTestBackup(storage, {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1, name: "Ada" }] }],
    });
    const history = await documentHistory(
      { storage, logger: silentLogger },
      { namespace: "app.users", id: 1, journal: false },
    );
    expect(history.versions).toEqual([
      {
        kind: "backup",
        backupId: manifest.id,
        time: { t: Math.floor(Date.parse(manifest.completedAt) / 1000), i: 0 },
        completedAt: new Date(manifest.completedAt),
        state: "present",
        document: { _id: new Int32(1), name: "Ada" },
      },
    ]);
  });
});
