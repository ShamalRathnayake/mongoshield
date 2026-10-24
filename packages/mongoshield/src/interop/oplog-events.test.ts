// Oplog entries → change events, checked through the parser and replay translation the
// restore uses (converge-events.ts, converge-operations.ts), so every converted entry
// is shown to replay as the write it recorded. Entries are written the way MongoDB
// 7.0 / 8.0 log them; the end-to-end proof against a real `mongodump --oplog` is
// test/integration/interop-oplog.test.ts.

import fc from "fast-check";
import { Binary, BSON, type Document, Int32, Long, Timestamp, UUID } from "mongodb";
import { describe, expect, it } from "vitest";
import { parseChangeEvent } from "../engine/converge-events.ts";
import { replayStepFor } from "../engine/converge-operations.ts";
import { isMongoShieldError } from "../errors.ts";
import { OplogConverter } from "./oplog-events.ts";

const TS = new Timestamp({ t: 1_767_225_600, i: 3 });
const WALL = new Date(1_767_225_600_000);
const everything = () => true;

function entry(fields: Document): Buffer {
  return Buffer.from(
    BSON.serialize({ ts: TS, t: Long.fromNumber(1), v: Long.fromNumber(2), wall: WALL, ...fields }),
  );
}

function convert(entries: readonly Document[], filter: (ns: string) => boolean = everything) {
  const converter = new OplogConverter(filter, "oplog.bson");
  const events = entries.flatMap((fields) => converter.convert(entry(fields)));
  return {
    events: events.map((raw) => parseChangeEvent(raw)),
    raw: events,
    window: converter.finish(),
  };
}

/** The replay step of the only event of `fields`. */
function stepOf(fields: Document): ReturnType<typeof replayStepFor> {
  const { events } = convert([fields]);
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error("no event");
  return replayStepFor(event);
}

function failure(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("OplogConverter: document writes", () => {
  it("turns an insert into an insert event replayed as an upsert of the document", () => {
    const { events, raw } = convert([
      { op: "i", ns: "app.users", ui: new UUID(), o: { _id: 7, name: "a", "1": "numeric" } },
    ]);
    const [event] = events;
    expect(event?.operationType).toBe("insert");
    expect(event?.ns).toEqual({ db: "app", coll: "users" });
    expect(event?.clusterTime).toEqual({ t: TS.t, i: TS.i });
    expect(event?.documentKey).toEqual({ _id: new Int32(7) });
    // The document is copied byte for byte: its field order survives.
    const fullDocument = BSON.deserialize(raw[0] ?? Buffer.alloc(0), { raw: true }).fullDocument;
    expect(
      Buffer.from(fullDocument).equals(
        Buffer.from(BSON.serialize({ _id: 7, name: "a", "1": "numeric" })),
      ),
    ).toBe(true);
    expect(event && replayStepFor(event)).toMatchObject({ kind: "write", ns: "app.users" });
    expect(BSON.deserialize(raw[0] ?? Buffer.alloc(0)).wallTime).toEqual(WALL);
  });

  it("turns a delete into a delete by _id", () => {
    expect(stepOf({ op: "d", ns: "app.users", o: { _id: 7 } })).toEqual({
      kind: "write",
      ns: "app.users",
      operations: [
        { deleteOne: { filter: { _id: new Int32(7) }, collation: { locale: "simple" } } },
      ],
    });
  });

  it("turns a replacement into a replace event", () => {
    const { events } = convert([
      { op: "u", ns: "app.users", o2: { _id: 7 }, o: { _id: 7, $price: 3 } },
    ]);
    expect(events[0]?.operationType).toBe("replace");
    expect(events[0]?.fullDocument).toEqual({ _id: new Int32(7), $price: new Int32(3) });
  });

  it("turns a version 2 diff into the update description a change stream reports", () => {
    const diff = {
      d: { gone: false },
      u: { name: "b", "3": "numeric field" },
      i: { added: new Int32(1) },
      sprofile: { u: { city: "x" }, saddress: { d: { zip: false } } },
      sitems: { a: true, l: new Int32(2), u1: "y", s0: { u: { qty: new Int32(5) } } },
    };
    const { events } = convert([{ op: "u", ns: "app.users", o2: { _id: 7 }, o: { $v: 2, diff } }]);
    const update = events[0]?.updateDescription;
    expect(events[0]?.operationType).toBe("update");
    expect(update?.updatedFields).toEqual({
      name: "b",
      "3": "numeric field",
      added: new Int32(1),
      "profile.city": "x",
      "items.1": "y",
      "items.0.qty": new Int32(5),
    });
    expect(update?.removedFields).toEqual(["gone", "profile.address.zip"]);
    expect(update?.truncatedArrays).toEqual([{ field: "items", newSize: 2 }]);
    // Indices and numeric field names are spelled out.
    expect(Object.fromEntries(update?.disambiguatedPaths ?? [])).toEqual({
      "3": ["3"],
      "items.1": ["items", 1],
      "items.0.qty": ["items", 0, "qty"],
    });
    const step = events[0] && replayStepFor(events[0]);
    expect(step?.kind).toBe("write");
  });

  it("turns $v: 1 modifiers into an update description", () => {
    const { events } = convert([
      {
        op: "u",
        ns: "app.users",
        o2: { _id: 7 },
        o: { $v: 1, $set: { "a.b": 1 }, $unset: { c: true } },
      },
    ]);
    expect(events[0]?.updateDescription?.updatedFields).toEqual({ "a.b": new Int32(1) });
    expect(events[0]?.updateDescription?.removedFields).toEqual(["c"]);
  });

  it("refuses updates of field names that $set cannot address", () => {
    for (const name of ["a.b", "$x", ""]) {
      const error = failure(() =>
        convert([
          { op: "u", ns: "app.users", o2: { _id: 7 }, o: { $v: 2, diff: { u: { [name]: 1 } } } },
        ]),
      );
      expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
      expect(String(Reflect.get(Object(error), "hint"))).toContain("ignoreOplog");
    }
  });

  it("refuses diffs and modifiers it does not know", () => {
    for (const o of [
      { $v: 2, diff: { x: { a: 1 } } },
      { $v: 2, diff: { sarr: { a: true, q1: 1 } } },
      { $v: 2, diff: { sarr: { a: true, s1: 5 } } },
      { $v: 2, diff: "not a document" },
      { $set: 5 },
    ]) {
      expect(
        failure(() => convert([{ op: "u", ns: "app.users", o2: { _id: 7 }, o }])),
      ).toBeInstanceOf(Error);
    }
  });

  it("refuses malformed entries", () => {
    for (const fields of [
      { op: "i", ns: "app.users" },
      { op: "i", ns: "app.users", o: { name: "no id" } },
      { op: "u", ns: "app.users", o: { $v: 2, diff: {} } },
      { op: "c", ns: "app.$cmd" },
      { op: "c", ns: "app.$cmd", o: { applyOps: 5 } },
      { op: "c", ns: "app.$cmd", o: { create: 5 } },
    ]) {
      expect(
        isMongoShieldError(
          failure(() => convert([fields])),
          "MS_INTEGRITY_FAILED",
        ),
      ).toBe(true);
    }
    const converter = new OplogConverter(everything, "oplog.bson");
    const noTime = Buffer.from(BSON.serialize({ op: "n", ns: "" }));
    expect(
      isMongoShieldError(
        failure(() => converter.convert(noTime)),
        "MS_INTEGRITY_FAILED",
      ),
    ).toBe(true);
    expect(
      isMongoShieldError(
        failure(() => convert([{ op: "xi", ns: "app.users", o: {} }])),
        "MS_FORMAT_UNSUPPORTED",
      ),
    ).toBe(true);
  });
});

describe("OplogConverter: commands", () => {
  it("turns create, drop and dropDatabase into the DDL events replay applies", () => {
    expect(
      stepOf({
        op: "c",
        ns: "app.$cmd",
        o: {
          create: "fresh",
          capped: true,
          size: 4096,
          idIndex: { v: 2, key: { _id: 1 }, name: "_id_" },
        },
      }),
    ).toMatchObject({
      kind: "create",
      ns: "app.fresh",
      options: { capped: true, size: new Int32(4096) },
    });
    expect(stepOf({ op: "c", ns: "app.$cmd", o: { drop: "old" } })).toMatchObject({
      kind: "drop",
      ns: "app.old",
    });
    expect(stepOf({ op: "c", ns: "app.$cmd", o: { dropDatabase: 1 } })).toMatchObject({
      kind: "dropDatabase",
      db: "app",
    });
    expect(convert([{ op: "c", ns: "admin.$cmd", o: { dropDatabase: 1 } }]).events).toEqual([]);
  });

  it("turns index builds and drops into createIndexes and dropIndexes events", () => {
    const spec = { v: 2, key: { status: 1 }, name: "by_status" };
    for (const o of [
      { createIndexes: "orders", ...spec },
      { commitIndexBuild: "orders", indexBuildUUID: new UUID(), indexes: [spec] },
    ]) {
      const { events } = convert([{ op: "c", ns: "app.$cmd", o }]);
      expect(events[0]?.operationType).toBe("createIndexes");
      expect(events[0]?.operationDescription?.indexes).toEqual([
        { v: new Int32(2), key: { status: new Int32(1) }, name: "by_status" },
      ]);
    }
    const dropped = convert([
      { op: "c", ns: "app.$cmd", o: { dropIndexes: "orders", index: "by_status" }, o2: spec },
    ]);
    expect(dropped.events[0]?.operationType).toBe("dropIndexes");
    expect(dropped.events[0]?.operationDescription?.indexes).toEqual([
      { v: new Int32(2), key: { status: new Int32(1) }, name: "by_status" },
    ]);
    const named = convert([
      { op: "c", ns: "app.$cmd", o: { deleteIndexes: "orders", index: "by_status" } },
    ]);
    expect(named.events[0]?.operationDescription?.indexes).toEqual([{ name: "by_status" }]);
    const empty = convert([
      { op: "c", ns: "app.$cmd", o: { commitIndexBuild: "orders", indexes: 5 } },
    ]);
    expect(empty.events[0]?.operationDescription?.indexes).toEqual([]);
  });

  it("ignores no-ops and commands that change no documents", () => {
    for (const fields of [
      { op: "n", ns: "", o: { msg: "periodic noop" } },
      { op: "c", ns: "app.$cmd", o: { collMod: "orders", validator: {} } },
      { op: "c", ns: "app.$cmd", o: { startIndexBuild: "orders", indexes: [] } },
      { op: "c", ns: "app.$cmd", o: { abortIndexBuild: "orders" } },
    ]) {
      expect(convert([fields]).events).toEqual([]);
    }
  });

  it("refuses commands no change event can replay", () => {
    for (const o of [
      { renameCollection: "app.a", to: "app.b" },
      { emptycapped: "log" },
      { convertToCapped: "log", size: 1 },
      { importCollection: "x" },
      { somethingNew: 1 },
    ]) {
      expect(
        isMongoShieldError(
          failure(() => convert([{ op: "c", ns: "app.$cmd", o }])),
          "MS_FORMAT_UNSUPPORTED",
        ),
      ).toBe(true);
    }
  });
});

describe("OplogConverter: transactions and applyOps", () => {
  const lsid = {
    id: new UUID("9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"),
    uid: new Binary(Buffer.alloc(32, 1)),
  };
  const insert = (id: number) => ({ op: "i", ns: "app.orders", o: { _id: id } });
  const zero = { ts: new Timestamp({ t: 0, i: 0 }), t: Long.fromNumber(-1) };
  const previous = { ts: new Timestamp({ t: 1_767_225_599, i: 1 }), t: Long.fromNumber(1) };

  it("unpacks applyOps at the time of its entry", () => {
    const { events } = convert([
      {
        op: "c",
        ns: "admin.$cmd",
        o: { applyOps: [insert(1), { op: "d", ns: "app.orders", o: { _id: 2 } }] },
      },
    ]);
    expect(events.map((event) => event.operationType)).toEqual(["insert", "delete"]);
    expect(events.every((event) => event.clusterTime.t === TS.t)).toBe(true);
  });

  it("waits for the last piece of a large transaction, in order", () => {
    const transaction = { lsid, txnNumber: Long.fromNumber(5) };
    const { events } = convert([
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: zero,
        o: { applyOps: [insert(1)], partialTxn: true },
      },
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: previous,
        o: { applyOps: [insert(2)], partialTxn: true },
      },
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: previous,
        o: { applyOps: [insert(3)], count: Long.fromNumber(3) },
      },
    ]);
    expect(events.map((event) => event.documentKey?._id)).toEqual([
      new Int32(1),
      new Int32(2),
      new Int32(3),
    ]);
  });

  it("drops transactions that were not committed when the oplog ends, or were aborted", () => {
    const transaction = { lsid, txnNumber: Long.fromNumber(6) };
    expect(
      convert([
        {
          op: "c",
          ns: "admin.$cmd",
          ...transaction,
          prevOpTime: zero,
          o: { applyOps: [insert(1)], partialTxn: true },
        },
      ]).events,
    ).toEqual([]);
    const aborted = convert([
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: zero,
        o: { applyOps: [insert(1)], prepare: true },
      },
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: previous,
        o: { abortTransaction: 1 },
      },
    ]);
    expect(aborted.events).toEqual([]);
  });

  it("applies a prepared transaction at its commit", () => {
    const transaction = { lsid, txnNumber: Long.fromNumber(7) };
    const committed = convert([
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: zero,
        o: { applyOps: [insert(1)], prepare: true },
      },
      {
        op: "c",
        ns: "admin.$cmd",
        ...transaction,
        prevOpTime: previous,
        o: { commitTransaction: 1, commitTimestamp: TS },
      },
    ]);
    expect(committed.events.map((event) => event.operationType)).toEqual(["insert"]);
    // A commit of a transaction the oplog does not have changes nothing.
    expect(
      convert([{ op: "c", ns: "admin.$cmd", ...transaction, o: { commitTransaction: 1 } }]).events,
    ).toEqual([]);
  });

  it("refuses a transaction whose first pieces are older than the oplog", () => {
    const transaction = { lsid, txnNumber: Long.fromNumber(8) };
    for (const o of [
      { applyOps: [insert(1)], count: Long.fromNumber(2) },
      { applyOps: [insert(1)], partialTxn: true },
    ]) {
      const error = failure(() =>
        convert([{ op: "c", ns: "admin.$cmd", ...transaction, prevOpTime: previous, o }]),
      );
      expect(isMongoShieldError(error, "MS_FORMAT_UNSUPPORTED")).toBe(true);
    }
  });
});

describe("OplogConverter: what is replayed", () => {
  it("leaves out internal databases, system collections and unselected namespaces, with warnings", () => {
    const { events, window } = convert(
      [
        { op: "i", ns: "local.oplog.rs", o: { _id: 1 } },
        { op: "i", ns: "config.system.sessions", o: { _id: 1 } },
        { op: "i", ns: "app.system.buckets.metrics", o: { _id: 1 } },
        { op: "i", ns: "admin.system.users", o: { _id: "app.alice" } },
        { op: "i", ns: "app.system.views", o: { _id: "app.v" } },
        { op: "i", ns: "app.system.js", o: { _id: "add" } },
        { op: "i", ns: "other.things", o: { _id: 1 } },
        { op: "i", ns: "noDotNamespace", o: { _id: 1 } },
        { op: "c", ns: "other.$cmd", o: { drop: "things" } },
      ],
      (ns) => ns.startsWith("app."),
    );
    expect(events.map((event) => `${event.ns?.db}.${event.ns?.coll}`)).toEqual(["app.system.js"]);
    expect(window?.warnings).toEqual([
      "Time-series collections are restored as dumped: changes to them during the dump are not replayed.",
      "Users and roles are restored as dumped: changes to them during the dump are not replayed.",
    ]);
  });

  it("records the window from the first to the last entry", () => {
    const converter = new OplogConverter(everything, "oplog.bson");
    expect(converter.finish()).toBeUndefined();
    converter.convert(
      Buffer.from(BSON.serialize({ op: "n", ns: "", o: {}, ts: new Timestamp({ t: 10, i: 1 }) })),
    );
    converter.convert(
      Buffer.from(
        BSON.serialize({ op: "i", ns: "app.a", o: { _id: 1 }, ts: new Timestamp({ t: 12, i: 4 }) }),
      ),
    );
    expect(converter.finish()).toEqual({
      from: { t: 10, i: 1 },
      to: { t: 12, i: 4 },
      events: 1,
      warnings: [],
    });
  });

  it("either converts an entry or fails with a MongoShieldError (property)", () => {
    const valid = [
      entry({ op: "i", ns: "app.users", o: { _id: 1, a: [1, { b: 2 }] } }),
      entry({
        op: "u",
        ns: "app.users",
        o2: { _id: 1 },
        o: { $v: 2, diff: { u: { a: 1 }, sb: { a: true, l: 1, u0: 3 } } },
      }),
      entry({
        op: "c",
        ns: "admin.$cmd",
        o: { applyOps: [{ op: "d", ns: "app.users", o: { _id: 1 } }] },
      }),
    ];
    fc.assert(
      fc.property(
        fc.nat(),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 3,
        }),
        (index, flips) => {
          const damaged = Buffer.from(valid[index % valid.length] ?? Buffer.alloc(0));
          for (const [position, byte] of flips) damaged[position % damaged.length] = byte;
          try {
            new OplogConverter(everything, "oplog.bson").convert(damaged);
          } catch (error) {
            expect(isMongoShieldError(error)).toBe(true);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
