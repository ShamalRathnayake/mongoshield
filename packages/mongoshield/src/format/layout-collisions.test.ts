import { describe, expect, it } from "vitest";
import { caseCollisionSuffixes, dataFileKey, metadataFileKey } from "./layout.ts";

// Tests for the two ways two collections could otherwise end up with the same file name.

describe("collection names that look like part numbers", () => {
  it("keeps a collection named users.000 apart from part 0 of users", () => {
    const literal = dataFileKey({
      db: "app",
      collection: "users.000",
      compression: "zstd",
      encrypted: false,
    });
    const part = dataFileKey({
      db: "app",
      collection: "users",
      part: 0,
      compression: "zstd",
      encrypted: false,
    });
    expect(literal).toBe("app/users%2E000.bson.zst");
    expect(part).toBe("app/users.000.bson.zst");
    expect(literal).not.toBe(part);
  });

  it("leaves ordinary dotted names readable", () => {
    expect(metadataFileKey({ db: "app", collection: "audit.v2", encrypted: false })).toBe(
      "app/audit.v2.metadata.json",
    );
  });
});

describe("caseCollisionSuffixes", () => {
  it("gives every name in a case-insensitive clash its own suffix", () => {
    const suffixes = caseCollisionSuffixes(["Users", "users", "orders"]);
    expect(suffixes.has("orders")).toBe(false);
    expect(suffixes.get("Users")).toMatch(/^~[0-9a-f]{8}$/);
    expect(suffixes.get("users")).toMatch(/^~[0-9a-f]{8}$/);
    expect(suffixes.get("Users")).not.toBe(suffixes.get("users"));
  });

  it("is stable across calls, so restores and re-runs agree", () => {
    expect(caseCollisionSuffixes(["A", "a"])).toEqual(caseCollisionSuffixes(["a", "A"]));
  });

  it("is applied to the file keys", () => {
    const suffix = caseCollisionSuffixes(["Users", "users"]).get("Users") ?? "";
    expect(
      dataFileKey({
        db: "app",
        collection: "Users",
        compression: "none",
        encrypted: true,
        uniqueSuffix: suffix,
      }),
    ).toBe(`app/Users${suffix}.bson.age`);
  });
});
