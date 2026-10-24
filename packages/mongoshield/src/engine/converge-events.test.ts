import { BSON, Int32, Long, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  collectionNamespaceOf,
  namespaceString,
  needsFullDocument,
  parseChangeEvent,
  pathComponents,
  plainNumber,
} from "./converge-events.ts";

const clusterTime = new Timestamp({ t: 7, i: 3 });
const parse = (fields: Record<string, unknown>) =>
  parseChangeEvent(BSON.serialize({ operationType: "update", clusterTime, ...fields }));

describe("parseChangeEvent", () => {
  it("rejects events without a cluster time", () => {
    expect(() => parseChangeEvent(BSON.serialize({ operationType: "insert" }))).toThrow(
      /no clusterTime/,
    );
  });

  it("reads loosely typed update descriptions defensively", () => {
    const event = parse({
      updateDescription: {
        removedFields: "not a list",
        truncatedArrays: [{ field: "a", newSize: Long.fromNumber(2) }, { field: 5 }, "junk"],
        disambiguatedPaths: { "a.0": ["a", new Int32(0)], bad: "x", "b.c": ["b.c", true] },
      },
    });
    expect(event.updateDescription).toEqual({
      updatedFields: {},
      removedFields: [],
      truncatedArrays: [{ field: "a", newSize: 2 }],
      disambiguatedPaths: new Map([
        ["a.0", ["a", 0]],
        ["b.c", ["b.c"]],
      ]),
    });
  });

  it("treats BSON values in document positions as absent", () => {
    const event = parse({ fullDocument: new Int32(1), documentKey: [1], ns: { db: 1 } });
    expect(event.fullDocument).toBeUndefined();
    expect(event.documentKey).toBeUndefined();
    expect(event.ns).toBeUndefined();
  });
});

describe("namespaces and paths", () => {
  it("formats database and collection namespaces", () => {
    expect(namespaceString({ db: "app", coll: undefined })).toBe("app");
    expect(namespaceString({ db: "app", coll: "users" })).toBe("app.users");
    expect(collectionNamespaceOf({ db: "app", coll: undefined })).toBeUndefined();
    expect(collectionNamespaceOf(undefined)).toBeUndefined();
  });

  it("splits paths without disambiguatedPaths", () => {
    const event = parse({ updateDescription: { updatedFields: { "a.b": 1 } } });
    if (event.updateDescription === undefined) throw new Error("no description");
    expect(pathComponents(event.updateDescription, "a.b")).toEqual(["a", "b"]);
  });

  it("needs the full document only for updates with unaddressable paths", () => {
    expect(needsFullDocument(parse({}))).toBe(false);
    expect(
      needsFullDocument(
        parse({ updateDescription: { updatedFields: {}, removedFields: ["$weird"] } }),
      ),
    ).toBe(true);
    expect(
      needsFullDocument(
        parse({
          updateDescription: {
            updatedFields: {},
            truncatedArrays: [{ field: "x..y", newSize: 1 }],
          },
        }),
      ),
    ).toBe(true);
  });

  it("unwraps every BSON number type", () => {
    expect(plainNumber(3)).toBe(3);
    expect(plainNumber(new Int32(4))).toBe(4);
    expect(plainNumber(new BSON.Double(5.5))).toBe(5.5);
    expect(plainNumber(Long.fromNumber(6))).toBe(6);
    expect(plainNumber("7")).toBeUndefined();
  });
});
