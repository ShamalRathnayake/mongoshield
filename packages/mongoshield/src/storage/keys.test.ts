import { describe, expect, it } from "vitest";
import { assertValidKey, assertValidPrefix, joinKey } from "./keys.ts";

describe("assertValidKey", () => {
  it.each(["a", "backups/2026/app/users.bson.zst", "a/b.c/d-e_f"])("accepts %s", (key) => {
    expect(() => assertValidKey(key)).not.toThrow();
  });

  it.each([
    ["", "empty"],
    ["/abs", "absolute"],
    ["a/../b", "traversal"],
    ["a/./b", "dot segment"],
    ["a//b", "empty segment"],
    ["a\\b", "backslash"],
    ["a/", "trailing slash"],
  ])("rejects %s (%s)", (key) => {
    expect(() => assertValidKey(key)).toThrow(/Invalid storage key/);
  });
});

describe("assertValidPrefix", () => {
  it("accepts the empty prefix and prefixes ending in a slash", () => {
    expect(() => assertValidPrefix("")).not.toThrow();
    expect(() => assertValidPrefix("backups/")).not.toThrow();
    expect(() => assertValidPrefix("../")).toThrow();
  });
});

describe("joinKey", () => {
  it("joins segments and skips empty ones", () => {
    expect(joinKey("backups", "", "x.json")).toBe("backups/x.json");
  });
});
