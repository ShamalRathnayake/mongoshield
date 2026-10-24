import { BSON } from "mongodb";
import { describe, expect, it } from "vitest";
import { parseChangeEvent } from "../engine/converge-events.ts";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { createJournalScope } from "./capture.ts";
import { STATE_KEY } from "./layout.ts";
import {
  encodeSegmentHeader,
  encodeSegmentTrailer,
  type GapRecord,
  parseSegmentHeader,
  parseSegmentTrailer,
  readGapRecords,
  readJournalState,
  writeGapRecord,
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

describe("malformed segment documents", () => {
  const failsWith = (code: string, action: () => unknown): void => {
    let error: unknown;
    try {
      action();
    } catch (caught) {
      error = caught;
    }
    expect(isMongoShieldError(error), String(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
  };
  const header = (fields: Record<string, unknown>) =>
    BSON.serialize({
      op: "segment",
      formatVersion: 1,
      from: new BSON.Timestamp({ t: 1, i: 0 }),
      previous: null,
      ...fields,
    });

  it("rejects headers without a start, with a bad digest, or of a newer format", () => {
    failsWith("MS_INTEGRITY_FAILED", () => parseSegmentHeader(Buffer.from([1, 2, 3]), "k"));
    failsWith("MS_INTEGRITY_FAILED", () => parseSegmentHeader(header({ from: 5 }), "k"));
    failsWith("MS_INTEGRITY_FAILED", () => parseSegmentHeader(header({ previous: "abc" }), "k"));
    failsWith("MS_INTEGRITY_FAILED", () => parseSegmentHeader(header({ previous: 7 }), "k"));
    failsWith("MS_FORMAT_UNSUPPORTED", () => parseSegmentHeader(header({ formatVersion: 2 }), "k"));
    failsWith("MS_FORMAT_UNSUPPORTED", () =>
      parseSegmentHeader(header({ formatVersion: new BSON.Long(9) }), "k"),
    );
    expect(parseSegmentHeader(header({ formatVersion: new BSON.Int32(1) }), "k").from).toEqual({
      t: 1,
      i: 0,
    });
  });

  it("rejects trailers without an end or a count, and accepts plain numbers", () => {
    failsWith("MS_INTEGRITY_FAILED", () =>
      parseSegmentTrailer({ op: "segment-end", events: 1 }, "k"),
    );
    failsWith("MS_INTEGRITY_FAILED", () =>
      parseSegmentTrailer(
        { op: "segment-end", to: new BSON.Timestamp({ t: 1, i: 1 }), events: 1.5 },
        "k",
      ),
    );
    expect(
      parseSegmentTrailer(
        { op: "segment-end", to: new BSON.Timestamp({ t: 1, i: 1 }), events: 3 },
        "k",
      ),
    ).toEqual({ to: { t: 1, i: 1 }, events: 3 });
  });
});

describe("journal records in storage", () => {
  it("reads nothing when state.json and gap records are missing", async () => {
    const storage = memoryStorage();
    expect(await readJournalState(storage)).toBeUndefined();
    expect(await readGapRecords(storage, ["journal/gaps/missing.json"])).toEqual([]);
  });

  it("round-trips state.json and gap records", async () => {
    const storage = memoryStorage();
    const gap: GapRecord = {
      formatVersion: 1,
      from: { t: 1, i: 1 },
      to: { t: 2, i: 2 },
      detectedAt: new Date(0).toISOString(),
      reason: "lost",
      action: "fail",
    };
    await writeGapRecord(storage, gap, new AbortController().signal);
    const [key] = storage.keys();
    expect(await readGapRecords(storage, [key ?? ""], new AbortController().signal)).toEqual([gap]);
  });

  it("refuses records that are not JSON or do not match the schema", async () => {
    const storage = memoryStorage();
    await storage.put(STATE_KEY, Buffer.from("{ not json"));
    await expect(readJournalState(storage)).rejects.toMatchObject({ code: "MS_MANIFEST_INVALID" });
    await storage.put(STATE_KEY, Buffer.from(JSON.stringify({ formatVersion: 1 })));
    await expect(readJournalState(storage)).rejects.toMatchObject({
      code: "MS_MANIFEST_INVALID",
      message: expect.stringContaining("state.json"),
    });
  });
});

describe("journal scope edge cases", () => {
  const event = (fields: Record<string, unknown>) =>
    parseChangeEvent(
      BSON.serialize({ clusterTime: new BSON.Timestamp({ t: 1, i: 1 }), ...fields }),
    );
  const scope = createJournalScope({ include: ["app.*"] });

  it("ignores events without a collection and internal databases", () => {
    expect(scope.keeps(event({ operationType: "insert", ns: { db: "app" } }))).toBe(false);
    expect(scope.keeps(event({ operationType: "dropDatabase" }))).toBe(false);
    expect(scope.keeps(event({ operationType: "dropDatabase", ns: { db: "admin" } }))).toBe(false);
    expect(
      createJournalScope({}).keeps(event({ operationType: "dropDatabase", ns: { db: "x" } })),
    ).toBe(true);
  });

  it("keeps renames into journaled namespaces and records only those from outside", () => {
    const rename = (from: string, to?: string) =>
      event({
        operationType: "rename",
        ns: { db: "app", coll: from },
        ...(to === undefined ? {} : { to: { db: "app", coll: to } }),
      });
    expect(scope.keeps(rename("tmp.agg_out.1", "summary"))).toBe(true);
    expect(scope.keeps(rename("tmp.agg_out.1", "tmp.agg_out.2"))).toBe(false);
    expect(scope.needsDestinationSnapshot(rename("users", "people"))).toBe(false);
    expect(scope.needsDestinationSnapshot(rename("tmp.agg_out.1", "tmp.other"))).toBe(false);
    expect(scope.needsDestinationSnapshot(rename("tmp.agg_out.1"))).toBe(false);
    expect(
      scope.needsDestinationSnapshot(
        event({ operationType: "insert", ns: { db: "app", coll: "x" } }),
      ),
    ).toBe(false);
  });

  it("asks the server only for the databases the patterns name", () => {
    expect(scope.serverFilter).toEqual({
      $or: [{ "ns.db": { $in: ["app"] } }, { "to.db": { $in: ["app"] } }],
    });
    expect(createJournalScope({ exclude: ["app.audit"] }).serverFilter).toEqual({
      "ns.db": { $nin: ["admin", "config", "local"] },
    });
  });
});
