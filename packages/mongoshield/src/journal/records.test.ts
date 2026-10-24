import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { parseChangeEvent } from "../engine/converge-events.ts";
import { isMongoShieldError } from "../errors.ts";
import { createJournalScope } from "./capture.ts";
import {
  encodeSegmentHeader,
  encodeSegmentTrailer,
  parseSegmentHeader,
  parseSegmentTrailer,
} from "./records.ts";

describe("segment header and trailer", () => {
  it("round-trip", () => {
    const header = { from: { t: 10, i: 2 }, previous: "f".repeat(64) };
    expect(parseSegmentHeader(encodeSegmentHeader(header), "k")).toEqual(header);
    expect(
      parseSegmentHeader(encodeSegmentHeader({ ...header, previous: null }), "k").previous,
    ).toBeNull();

    const trailer = { to: { t: 11, i: 0 }, events: 12_345 };
    expect(parseSegmentTrailer(BSON.deserialize(encodeSegmentTrailer(trailer)), "k")).toEqual(
      trailer,
    );
  });

  it("rejects a segment that does not start with a header", () => {
    let error: unknown;
    try {
      parseSegmentHeader(BSON.serialize({ operationType: "insert" }), "k");
    } catch (caught) {
      error = caught;
    }
    expect(isMongoShieldError(error, "MS_INTEGRITY_FAILED")).toBe(true);
  });

  it("tells a trailer from a change event", () => {
    expect(parseSegmentTrailer({ operationType: "insert" }, "k")).toBeUndefined();
  });
});

describe("journal scope", () => {
  const event = (fields: Record<string, unknown>) =>
    parseChangeEvent(
      BSON.serialize({ clusterTime: new BSON.Timestamp({ t: 1, i: 1 }), ...fields }),
    );

  it("keeps selected namespaces, never internal, system or scratch collections", () => {
    const scope = createJournalScope({ include: ["app.*"], exclude: ["app.audit"] });
    expect(scope.keepsNamespace("app.users")).toBe(true);
    expect(scope.keepsNamespace("app.audit")).toBe(false);
    expect(scope.keepsNamespace("other.users")).toBe(false);
    expect(scope.keepsNamespace("app.system.views")).toBe(false);
    expect(scope.keepsNamespace("app.tmp.agg_out.1")).toBe(false);
    expect(createJournalScope({}).keepsNamespace("admin.users")).toBe(false);
  });

  it("keeps dropDatabase of databases that may hold journaled namespaces", () => {
    const scope = createJournalScope({ include: ["app.*"] });
    expect(scope.keeps(event({ operationType: "dropDatabase", ns: { db: "app" } }))).toBe(true);
    expect(scope.keeps(event({ operationType: "dropDatabase", ns: { db: "other" } }))).toBe(false);
  });

  it("records the destination of a rename from a namespace it does not journal", () => {
    const scope = createJournalScope({ include: ["app.*"] });
    const fromScratch = event({
      operationType: "rename",
      ns: { db: "app", coll: "tmp.agg_out.1" },
      to: { db: "app", coll: "summary" },
    });
    expect(scope.keeps(fromScratch)).toBe(true);
    expect(scope.needsDestinationSnapshot(fromScratch)).toBe(true);

    const between = event({
      operationType: "rename",
      ns: { db: "app", coll: "a" },
      to: { db: "app", coll: "b" },
    });
    expect(scope.needsDestinationSnapshot(between)).toBe(false);
    const outOf = event({
      operationType: "rename",
      ns: { db: "app", coll: "a" },
      to: { db: "other", coll: "b" },
    });
    expect(scope.keeps(outOf)).toBe(true);
    expect(scope.needsDestinationSnapshot(outOf)).toBe(false);
  });
});
