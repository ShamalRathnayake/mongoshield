import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { assertValidKey } from "../storage/keys.ts";
import {
  BACKUPS_PREFIX,
  backupDir,
  backupIdToDate,
  COMPRESSION_EXTENSIONS,
  changesFileKey,
  dataFileKey,
  ENCRYPTED_EXTENSION,
  encodeNameSegment,
  isBackupId,
  manifestKey,
  metadataFileKey,
  newBackupId,
  reservedNameSuffix,
  resolveBackupKey,
} from "./layout.ts";

describe("backup ids", () => {
  const startedAt = new Date("2026-11-14T03:00:04.123Z");

  it("encode the UTC start time to the second plus 6 random hex characters", () => {
    expect(newBackupId(startedAt)).toMatch(/^2026-11-14T03-00-04Z_[0-9a-f]{6}$/);
  });

  it("are unique for backups started in the same second", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBackupId(startedAt)));
    expect(ids.size).toBeGreaterThan(45);
  });

  it("default to the current time", () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const date = backupIdToDate(newBackupId());
    expect(date.getTime()).toBeGreaterThanOrEqual(before);
    expect(date.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("decode back to the start time, without milliseconds", () => {
    expect(backupIdToDate(newBackupId(startedAt))).toEqual(new Date("2026-11-14T03:00:04Z"));
  });

  it("sort chronologically as plain strings", () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date("2000-01-01"), max: new Date("2999-12-31"), noInvalidDate: true }),
        fc.date({ min: new Date("2000-01-01"), max: new Date("2999-12-31"), noInvalidDate: true }),
        (first, second) => {
          const firstSecond = Math.floor(first.getTime() / 1000);
          const secondSecond = Math.floor(second.getTime() / 1000);
          fc.pre(firstSecond !== secondSecond);
          const idsInOrder = [newBackupId(first), newBackupId(second)].sort();
          const datesInOrder = firstSecond < secondSecond ? [first, second] : [second, first];
          expect(idsInOrder.map((id) => backupIdToDate(id).getTime())).toEqual(
            datesInOrder.map((date) => Math.floor(date.getTime() / 1000) * 1000),
          );
        },
      ),
    );
  });

  it.each(["2026-11-14T03-00-04Z_7f3a9c", "1999-01-01T00-00-00Z_000000"])(
    "recognises %s as a backup id",
    (id) => {
      expect(isBackupId(id)).toBe(true);
    },
  );

  it.each([
    "",
    "latest",
    "2026-11-14T03:00:04Z_7f3a9c",
    "2026-11-14T03-00-04Z_7F3A9C",
    "2026-11-14T03-00-04Z_7f3a9",
    "2026-11-14T03-00-04.123Z_7f3a9c",
    "2026-11-14T03-00-04Z_7f3a9c/",
    "x2026-11-14T03-00-04Z_7f3a9c",
  ])("rejects %j as a backup id", (id) => {
    expect(isBackupId(id)).toBe(false);
  });

  it("refuses to decode a malformed id with MS_CONFIG_INVALID and a hint", () => {
    let caught: unknown;
    try {
      backupIdToDate("yesterday");
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
    expect((caught as { hint?: string }).hint).toContain("mongoshield list");
  });
});

describe("backup keys", () => {
  const id = "2026-11-14T03-00-04Z_7f3a9c";

  it("place every backup in its own directory under backups/", () => {
    expect(BACKUPS_PREFIX).toBe("backups/");
    expect(backupDir(id)).toBe(`backups/${id}/`);
    expect(manifestKey(id)).toBe(`backups/${id}/manifest.json`);
    expect(resolveBackupKey(id, "app/users.bson.zst")).toBe(`backups/${id}/app/users.bson.zst`);
  });

  it("name data files <db>/<collection>[.part].bson[.zst|.gz][.age]", () => {
    expect(
      dataFileKey({ db: "app", collection: "users", compression: "zstd", encrypted: true }),
    ).toBe("app/users.bson.zst.age");
    expect(
      dataFileKey({ db: "app", collection: "users", compression: "gzip", encrypted: false }),
    ).toBe("app/users.bson.gz");
    expect(
      dataFileKey({ db: "app", collection: "users", compression: "none", encrypted: false }),
    ).toBe("app/users.bson");
  });

  it("zero-pad part numbers to three digits", () => {
    const base = {
      db: "app",
      collection: "orders",
      compression: "zstd",
      encrypted: false,
    } as const;
    expect(dataFileKey({ ...base, part: 0 })).toBe("app/orders.000.bson.zst");
    expect(dataFileKey({ ...base, part: 2 })).toBe("app/orders.002.bson.zst");
    expect(dataFileKey({ ...base, part: 123 })).toBe("app/orders.123.bson.zst");
  });

  it("name metadata files <db>/<collection>.metadata.json[.age], never compressed", () => {
    expect(metadataFileKey({ db: "app", collection: "users", encrypted: false })).toBe(
      "app/users.metadata.json",
    );
    expect(metadataFileKey({ db: "app", collection: "users", encrypted: true })).toBe(
      "app/users.metadata.json.age",
    );
  });

  it("use the documented extensions", () => {
    expect(COMPRESSION_EXTENSIONS).toEqual({ zstd: ".zst", gzip: ".gz", none: "" });
    expect(ENCRYPTED_EXTENSION).toBe(".age");
  });

  it("encode database and collection names", () => {
    expect(
      dataFileKey({ db: "my db", collection: "a/b", compression: "none", encrypted: false }),
    ).toBe("my%20db/a%2Fb.bson");
  });
});

/** True if the string has no lone surrogates (it survives a UTF-8 round trip). */
function isWellFormed(text: string): boolean {
  return Buffer.from(text, "utf8").toString("utf8") === text;
}

describe("encodeNameSegment", () => {
  it.each([
    ["users", "users"],
    ["Users_2026-v1", "Users_2026-v1"],
    ["system.views", "system.views"],
    ["a.b.c", "a.b.c"],
    ["a/b", "a%2Fb"],
    ["a\\b", "a%5Cb"],
    ["with space", "with%20space"],
    ["$cmd", "%24cmd"],
    ["100%", "100%25"],
    ["café", "caf%C3%A9"],
    ["日本", "%E6%97%A5%E6%9C%AC"],
    ["😀", "%F0%9F%98%80"],
    [".", "%2E"],
    ["..", "%2E%2E"],
    ["...", "%2E%2E%2E"],
    [".hidden", ".hidden"],
    ["a\0b", "a%00b"],
  ])("encodes %j as %j", (name, encoded) => {
    expect(encodeNameSegment(name)).toBe(encoded);
  });

  it("rejects empty names", () => {
    expect(() => encodeNameSegment("")).toThrow(expect.objectContaining({ code: "MS_INTERNAL" }));
  });

  it("shortens long names to 180 characters with a hash suffix", () => {
    const encoded = encodeNameSegment("x".repeat(300));
    expect(encoded).toHaveLength(180);
    expect(encoded).toMatch(/^x{163}~[0-9a-f]{16}$/);
  });

  it("keeps names of exactly 180 encoded characters unchanged", () => {
    expect(encodeNameSegment("y".repeat(180))).toBe("y".repeat(180));
    expect(encodeNameSegment("y".repeat(181))).toHaveLength(180);
  });

  it("keeps long names that share a prefix distinct", () => {
    const prefix = "events_".repeat(40);
    expect(encodeNameSegment(`${prefix}a`)).not.toBe(encodeNameSegment(`${prefix}b`));
  });

  it("shortens long unicode names by encoded length, staying under filesystem limits", () => {
    const encoded = encodeNameSegment("é".repeat(100)); // 600 encoded characters
    expect(encoded).toHaveLength(180);
    // With the longest suffix (".000.bson.zst.age") a file name stays below 255 bytes.
    expect(Buffer.byteLength(`${encoded}.000.bson.zst.age`)).toBeLessThan(255);
  });

  it("always produces a valid, single key segment", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", minLength: 1, maxLength: 300 }), (name) => {
        const encoded = encodeNameSegment(name);
        expect(encoded).not.toContain("/");
        expect(encoded.length).toBeLessThanOrEqual(180);
        expect(() => assertValidKey(`backups/x/${encoded}/y`)).not.toThrow();
        expect(encoded).toMatch(/^[A-Za-z0-9_.%~-]+$/);
      }),
      { numRuns: 500 },
    );
  });

  it("maps different short names to different segments", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", minLength: 1, maxLength: 20 }),
        fc.string({ unit: "binary", minLength: 1, maxLength: 20 }),
        (first, second) => {
          fc.pre(first !== second);
          // Lone surrogates all encode to U+FFFD, so only compare well-formed strings.
          fc.pre(isWellFormed(first) && isWellFormed(second));
          expect(encodeNameSegment(first)).not.toBe(encodeNameSegment(second));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("changes file of converge backups", () => {
  it("lives in _changes/ with the data file extensions", () => {
    expect(changesFileKey({ compression: "zstd", encrypted: true })).toBe(
      "_changes/window.bson.zst.age",
    );
    expect(changesFileKey({ compression: "none", encrypted: false })).toBe("_changes/window.bson");
  });

  it("gives a collection that would collide with it (in any case) a suffix", () => {
    expect(reservedNameSuffix("_changes", "window")).toMatch(/^~[0-9a-f]{8}$/);
    expect(reservedNameSuffix("_Changes", "WINDOW")).toMatch(/^~[0-9a-f]{8}$/);
    expect(reservedNameSuffix("_changes", "other")).toBeUndefined();
    expect(reservedNameSuffix("app", "window")).toBeUndefined();
    const key = dataFileKey({
      db: "_changes",
      collection: "window",
      compression: "zstd",
      encrypted: false,
      uniqueSuffix: reservedNameSuffix("_changes", "window") ?? "",
    });
    expect(key).not.toBe(changesFileKey({ compression: "zstd", encrypted: false }));
  });
});
