import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { collectPathValues, parseFieldPath, REMOVE, visitPath } from "./paths.ts";

/** The locations a path selects in a document, without changing it. */
function locations(document: Record<string, unknown>, path: string): string[] {
  const found: string[] = [];
  visitPath(document, parseFieldPath(path), (value, location) => {
    found.push(location);
    return value;
  });
  return found;
}

describe("parseFieldPath", () => {
  it("splits a dotted path into segments", () => {
    expect(parseFieldPath("addresses.*.street")).toEqual(["addresses", "*", "street"]);
  });

  it.each(["", "a..b", ".a", "a.", "$set", "a.$b"])("rejects the malformed path %j", (path) => {
    expect(() => parseFieldPath(path)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
    try {
      parseFieldPath(path);
    } catch (error) {
      expect(isMongoShieldError(error) && error.hint).toContain("addresses.*.street");
    }
  });
});

describe("visitPath", () => {
  const document = () => ({
    email: "a@b.c",
    profile: { phone: "1", nested: { deep: 1 } },
    addresses: [{ street: "x" }, { street: "y" }, "not a document"],
    matrix: [[{ v: 1 }], [{ v: 2 }]],
  });

  it("selects top-level and nested fields", () => {
    expect(locations(document(), "email")).toEqual(["email"]);
    expect(locations(document(), "profile.nested.deep")).toEqual(["profile.nested.deep"]);
  });

  it("selects every array element with *", () => {
    expect(locations(document(), "addresses.*")).toEqual([
      "addresses.0",
      "addresses.1",
      "addresses.2",
    ]);
    expect(locations(document(), "addresses.*.street")).toEqual([
      "addresses.0.street",
      "addresses.1.street",
    ]);
  });

  it("selects every key of a sub-document with *", () => {
    expect(locations(document(), "profile.*")).toEqual(["profile.phone", "profile.nested"]);
  });

  it("traverses arrays implicitly like MongoDB queries, including nested arrays", () => {
    expect(locations(document(), "addresses.street")).toEqual([
      "addresses.0.street",
      "addresses.1.street",
    ]);
    expect(locations(document(), "matrix.v")).toEqual(["matrix.0.0.v", "matrix.1.0.v"]);
  });

  it("selects one element by index", () => {
    expect(locations(document(), "addresses.1.street")).toEqual(["addresses.1.street"]);
    expect(locations(document(), "addresses.9.street")).toEqual([]);
  });

  it("selects nothing for missing fields or paths through scalars", () => {
    expect(locations(document(), "missing")).toEqual([]);
    expect(locations(document(), "email.local")).toEqual([]);
  });

  it("replaces values and removes keys and array elements", () => {
    const masked = document();
    visitPath(masked, parseFieldPath("addresses.*.street"), () => "masked");
    visitPath(masked, parseFieldPath("email"), () => REMOVE);
    expect(masked.addresses).toEqual([
      { street: "masked" },
      { street: "masked" },
      "not a document",
    ]);
    expect("email" in masked).toBe(false);

    const withList = { tags: ["a", "b", "c"] };
    visitPath(withList, parseFieldPath("tags.*"), (value) => (value === "b" ? value : REMOVE));
    expect(withList.tags).toEqual(["b"]);
  });

  it("returns how many values were visited", () => {
    expect(visitPath(document(), parseFieldPath("addresses.street"), (value) => value)).toBe(2);
  });
});

describe("collectPathValues", () => {
  it("flattens arrays found at the end of the path", () => {
    const document = { tagIds: [1, [2, 3]], items: [{ productId: 7 }, { productId: 8 }] };
    expect(collectPathValues(document, parseFieldPath("tagIds"))).toEqual([1, 2, 3]);
    expect(collectPathValues(document, parseFieldPath("items.productId"))).toEqual([7, 8]);
  });

  it("does not change the document", () => {
    const document = { a: { b: [1, 2] } };
    collectPathValues(document, parseFieldPath("a.b"));
    expect(document).toEqual({ a: { b: [1, 2] } });
  });
});
