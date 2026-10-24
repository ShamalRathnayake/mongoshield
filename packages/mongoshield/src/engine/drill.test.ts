// The pure parts of restore drills: option validation, temporary database names,
// rename rules and how sampled documents are named in reports. The drill itself
// runs against a real deployment in test/integration/drill.test.ts.

import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoShieldError } from "../errors.ts";
import {
  DEFAULT_DRILL_PREFIX,
  drillRenameRules,
  MAX_DRILL_SAMPLE,
  temporaryDatabaseNames,
  validPrefix,
  validSampleSize,
} from "./drill.ts";
import { describeId, isBackupDefect } from "./drill-checks.ts";
import { compileRenameMap } from "./restore-rename.ts";

/** A manifest with namespaces in the given databases (only `db` matters here). */
function manifestWith(...databases: string[]) {
  return {
    namespaces: databases.map((db) => ({
      ns: `${db}.c`,
      db,
      collection: "c",
      type: "collection" as const,
      documents: 0,
      bytesRaw: 0,
      files: [],
      metadata: { key: `${db}/c.metadata.json`, size: 0, sha256: "0".repeat(64) },
    })),
  };
}

describe("temporaryDatabaseNames", () => {
  it("gives every database of the backup one prefixed, run-specific name", () => {
    expect(
      temporaryDatabaseNames(manifestWith("app", "billing", "app"), "msdrill_", "1a2b3c4d"),
    ).toEqual([
      { source: "app", target: "msdrill_1a2b3c4d_app" },
      { source: "billing", target: "msdrill_1a2b3c4d_billing" },
    ]);
  });

  it("falls back to a numbered name when the database name would exceed 63 bytes", () => {
    const long = "x".repeat(50);
    const [database] = temporaryDatabaseNames(manifestWith(long), "msdrill_", "1a2b3c4d");
    expect(database).toEqual({ source: long, target: "msdrill_1a2b3c4d-0" });
  });
});

describe("drillRenameRules", () => {
  it("sends every collection of each database to its temporary database", () => {
    const rules = drillRenameRules([{ source: "app", target: "msdrill_1_app" }]);
    expect(rules).toEqual({ "app.*": "msdrill_1_app.*" });
    expect(compileRenameMap(rules)("app.users")).toBe("msdrill_1_app.users");
  });
});

describe("option validation", () => {
  it("defaults the prefix and accepts simple prefixes", () => {
    expect(validPrefix(undefined)).toBe(DEFAULT_DRILL_PREFIX);
    expect(validPrefix("drill-")).toBe("drill-");
  });

  it.each(["", "a.b", "a b", "x".repeat(33), "$x"])("rejects the prefix %j", (prefix) => {
    expect(() => validPrefix(prefix)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });

  it("accepts sample sizes from 0 to the maximum and rejects others", () => {
    expect(validSampleSize(undefined)).toBe(0);
    expect(validSampleSize(MAX_DRILL_SAMPLE)).toBe(MAX_DRILL_SAMPLE);
    for (const bad of [-1, 1.5, MAX_DRILL_SAMPLE + 1, Number.NaN]) {
      expect(() => validSampleSize(bad)).toThrow(
        expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
      );
    }
  });
});

describe("describeId", () => {
  it("shows ObjectIds and numbers, and only the type of other ids", () => {
    const objectId = new BSON.ObjectId("64b7f0c2a1b2c3d4e5f60718");
    expect(describeId(objectId)).toBe('ObjectId("64b7f0c2a1b2c3d4e5f60718")');
    expect(describeId(new BSON.Int32(7))).toBe("_id 7");
    expect(describeId(3)).toBe("_id 3");
    // Natural keys such as e-mail addresses are personal data: never printed.
    expect(describeId("ada@example.com")).toBe("with a string _id");
    expect(describeId(new BSON.Binary(Buffer.from("x")))).toBe("with a Binary _id");
  });
});

describe("isBackupDefect", () => {
  it("treats damaged-backup codes as findings and setup errors as failures", () => {
    expect(isBackupDefect(new MongoShieldError("MS_INTEGRITY_FAILED", "x"))).toBe(true);
    expect(isBackupDefect(new MongoShieldError("MS_RESTORE_FAILED", "x"))).toBe(true);
    expect(isBackupDefect(new MongoShieldError("MS_NO_IDENTITY", "x"))).toBe(false);
    expect(isBackupDefect(new MongoShieldError("MS_ABORTED", "x"))).toBe(false);
    expect(isBackupDefect(new Error("x"))).toBe(false);
  });
});
