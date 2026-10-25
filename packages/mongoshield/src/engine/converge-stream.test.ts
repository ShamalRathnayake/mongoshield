import { BSON, Int32, MongoNetworkError, MongoServerError, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { MongoShieldError } from "../errors.ts";
import { silentLogger } from "../logger.ts";
import { compileNamespaceRules } from "../mongo/namespace-filter.ts";
import { parseChangeEvent, serializeChangeEvent } from "./converge-events.ts";
import {
  eventTooLargeError,
  isEventTooLarge,
  isResumableError,
  mergeFragments,
  SplitEventAssembler,
  serverDatabaseFilter,
  splitEventOf,
} from "./converge-stream.ts";

const clusterTime = new Timestamp({ t: 100, i: 1 });

function raw(document: Record<string, unknown>): Buffer {
  return Buffer.from(BSON.serialize(document));
}

/** The fragments the server would send for one insert event split in two. */
function fragments(): Buffer[] {
  return [
    raw({
      _id: { _data: "first" },
      splitEvent: { fragment: 1, of: 2 },
      operationType: "insert",
      clusterTime,
      ns: { db: "app", coll: "big" },
      documentKey: { _id: 1 },
    }),
    raw({
      _id: { _data: "last" },
      splitEvent: { fragment: 2, of: 2 },
      fullDocument: { _id: 1, payload: "x" },
    }),
  ];
}

function serverError(code: number, labels: string[] = []): MongoServerError {
  return new MongoServerError({ message: `error ${code}`, code, errorLabels: labels });
}

describe("SplitEventAssembler", () => {
  it("passes whole events through with their exact bytes", () => {
    const assembler = new SplitEventAssembler(silentLogger);
    const bytes = raw({ operationType: "delete", clusterTime, ns: { db: "a", coll: "b" } });
    const whole = assembler.push(bytes);
    expect(whole?.raw.equals(bytes)).toBe(true);
    expect(whole?.event.operationType).toBe("delete");
    expect(assembler.incomplete).toBe(false);
  });

  it("collects the fragments of a split event and merges them into one", () => {
    const assembler = new SplitEventAssembler(silentLogger);
    const [first, last] = fragments();
    if (first === undefined || last === undefined) throw new Error("no fragments");
    expect(assembler.push(first)).toBeUndefined();
    expect(assembler.incomplete).toBe(true);
    const whole = assembler.push(last);
    expect(assembler.incomplete).toBe(false);
    expect(whole?.event.operationType).toBe("insert");
    expect(whole?.event.fullDocument).toEqual({ _id: new Int32(1), payload: "x" });
    // The stored bytes are the merged event: last resume token, no splitEvent.
    const stored = parseChangeEvent(whole?.raw ?? Buffer.alloc(0)).document;
    expect(stored._id).toEqual({ _data: "last" });
    expect(stored).not.toHaveProperty("splitEvent");
    expect(Object.keys(stored)).toEqual([
      "_id",
      "operationType",
      "clusterTime",
      "ns",
      "documentKey",
      "fullDocument",
    ]);
  });

  it("rejects fragments out of order and whole events between fragments", () => {
    const [first, last] = fragments();
    if (first === undefined || last === undefined) throw new Error("no fragments");
    expect(() => new SplitEventAssembler(silentLogger).push(last)).toThrow(/out of order/);

    const assembler = new SplitEventAssembler(silentLogger);
    assembler.push(first);
    expect(() => assembler.push(raw({ operationType: "insert", clusterTime }))).toThrow(
      /unsplit event arrived between fragments/,
    );
  });

  it("rejects bytes that are not a change event", () => {
    const assembler = new SplitEventAssembler(silentLogger);
    expect(() => assembler.push(Buffer.from([1, 2, 3]))).toThrow(MongoShieldError);
    expect(() => assembler.push(raw({ clusterTime }))).toThrow(/no operationType/);
  });
});

describe("split event fields", () => {
  it("reads splitEvent and rejects malformed ones", () => {
    expect(splitEventOf({})).toBeUndefined();
    expect(splitEventOf({ splitEvent: { fragment: new Int32(2), of: new Int32(3) } })).toEqual({
      fragment: 2,
      of: 3,
    });
    for (const splitEvent of [{ fragment: 0, of: 1 }, { fragment: 3, of: 2 }, { fragment: "1" }]) {
      expect(() => splitEventOf({ splitEvent })).toThrow(/malformed/);
    }
  });

  it("merges fragments field by field, the later _id winning", () => {
    expect(
      mergeFragments([
        { _id: 1, splitEvent: {}, a: 1 },
        { _id: 2, splitEvent: {}, b: 2 },
      ]),
    ).toEqual({ _id: 2, a: 1, b: 2 });
  });
});

describe("isResumableError", () => {
  it("resumes after network errors, killed cursors and labelled server errors", () => {
    expect(isResumableError(new MongoNetworkError("reset"))).toBe(true);
    for (const code of [43, 237, 11601, 189, 91, 10107]) {
      expect(isResumableError(serverError(code)), String(code)).toBe(true);
    }
    expect(isResumableError(serverError(1234, ["ResumableChangeStreamError"]))).toBe(true);
  });

  it("never resumes after lost history, missing privileges or other errors", () => {
    for (const code of [286, 280, 136, 13, 2]) {
      expect(isResumableError(serverError(code)), String(code)).toBe(false);
    }
    expect(isResumableError(serverError(286, ["ResumableChangeStreamError"]))).toBe(false);
    expect(isResumableError(new Error("plain"))).toBe(false);
    expect(isResumableError(undefined)).toBe(false);
  });
});

describe("events over the size limit", () => {
  it("are recognised by the server's error codes", () => {
    expect(isEventTooLarge(serverError(10334))).toBe(true);
    expect(isEventTooLarge(serverError(7182500))).toBe(true);
    expect(isEventTooLarge(serverError(2))).toBe(false);
    expect(isEventTooLarge(new Error("BSONObjectTooLarge"))).toBe(false);
  });

  it("name the change's cluster time when the server quotes its resume token", () => {
    const error = new MongoServerError({
      message:
        'BSONObj size: 16795374 (0x10046EE) is invalid. First element: _id: { _data: "826ADC4608000000142B042C01" }',
      code: 10334,
    });
    const translated = eventTooLargeError(error);
    expect(translated.code).toBe("MS_UNSUPPORTED_TOPOLOGY");
    expect(translated.details?.clusterTime).toEqual({ t: 0x6adc4608, i: 0x14 });
    expect(translated.message).toContain(`cluster time ${0x6adc4608}:${0x14}`);

    const withoutToken = eventTooLargeError(serverError(7182500));
    expect(withoutToken.details?.clusterTime).toBeUndefined();
    expect(withoutToken.details?.serverCode).toBe(7182500);
  });
});

describe("serverDatabaseFilter", () => {
  const internal = ["admin", "config", "local"];

  it("lists the databases when every include pattern names its database", () => {
    const rules = compileNamespaceRules({ include: ["app.*", "shop.orders"] });
    expect(serverDatabaseFilter(rules, ["extra"], internal)).toEqual({
      $or: [
        { "ns.db": { $in: ["app", "extra", "shop"] } },
        { "to.db": { $in: ["app", "extra", "shop"] } },
      ],
    });
  });

  it("skips only the internal databases otherwise", () => {
    expect(serverDatabaseFilter(compileNamespaceRules({}), [], internal)).toEqual({
      "ns.db": { $nin: internal },
    });
    const wildcard = compileNamespaceRules({ include: ["app.*", "*.sessions"] });
    expect(serverDatabaseFilter(wildcard, ["admin"], internal)).toEqual({
      "ns.db": { $nin: ["config", "local"] },
    });
  });
});

describe("serverDatabaseFilter with regexOnly (Atlas Free and Flex)", () => {
  const internal = ["admin", "config", "local"];
  const regexOnly = { regexOnly: true };

  it("matches exactly the listed databases with one anchored regex", () => {
    const rules = compileNamespaceRules({ include: ["app.*", "sh+op.orders"] });
    const filter = serverDatabaseFilter(rules, ["extra"], internal, regexOnly);
    const oneOf = /^(?:app|extra|sh\+op)$/;
    expect(filter).toEqual({ $or: [{ "ns.db": oneOf }, { "to.db": oneOf }] });
    expect(["app", "extra", "sh+op"].every((db) => oneOf.test(db))).toBe(true);
    expect(["apps", "shhop", "xapp"].some((db) => oneOf.test(db))).toBe(false);
  });

  it("skips the internal databases with a negative lookahead", () => {
    const filter = serverDatabaseFilter(compileNamespaceRules({}), ["admin"], internal, regexOnly);
    const regex: unknown = filter["ns.db"];
    expect(regex).toBeInstanceOf(RegExp);
    const skips = regex as RegExp;
    expect(skips.test("app")).toBe(true);
    expect(skips.test("admin")).toBe(true);
    expect(skips.test("localish")).toBe(true);
    expect(skips.test("config")).toBe(false);
    expect(skips.test("local")).toBe(false);
  });

  it("keeps every named database when nothing is skipped", () => {
    const filter = serverDatabaseFilter(compileNamespaceRules({}), [], [], regexOnly);
    expect((filter["ns.db"] as RegExp).test("app")).toBe(true);
  });
});

describe("serializeChangeEvent", () => {
  it("serializes events larger than js-bson's default 17 MiB buffer intact", () => {
    const payload = "x".repeat(20 * 1024 * 1024);
    const bytes = serializeChangeEvent({ operationType: "update", clusterTime, payload, tail: 1 });
    const parsed = parseChangeEvent(bytes).document;
    expect(parsed.payload).toHaveLength(payload.length);
    expect(parsed.tail).toEqual(new Int32(1));
  });

  it("keeps undefined values and keys a server would never accept", () => {
    const bytes = serializeChangeEvent({
      operationType: "update",
      clusterTime,
      fullDocument: { "a.b": 1, $c: undefined },
    });
    expect(Object.keys(parseChangeEvent(bytes).fullDocument ?? {})).toEqual(["a.b", "$c"]);
  });
});
