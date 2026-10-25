// The converge capture (src/engine/converge-capture.ts) driven directly, without a
// backup around it: the manifest warnings it adds for time series collections, old
// servers and updates it could not record; the events it leaves out; renames whose
// source was already dumped; documents it reads itself, which keep their stored field
// order; and how a failure or an abort ends it.

import { BSON, type Document, MongoServerError, Timestamp } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ChangeCaptureRequest,
  DESTINATION_READ_ATTEMPTS,
  startChangeCapture,
} from "../../src/engine/converge-capture.ts";
import { compareClusterTimes, readClusterTime } from "../../src/engine/converge-time.ts";
import { isMongoShieldError } from "../../src/errors.ts";
import { resolveBackupKey } from "../../src/format/layout.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import { silentLogger } from "../../src/logger.ts";
import type { CollectionSpec } from "../../src/mongo/index.ts";
import { type MemoryStorage, memoryStorage } from "../../src/storage/memory.ts";
import { clientWithFaults, type FaultInjector, isChangeStreamGetMore } from "../helpers/faults.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import { bytesOf, knownReorderedDocument } from "../helpers/ordered-documents.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const databases: string[] = [];

afterAll(async () => {
  for (const database of databases) await client().db(database).dropDatabase();
});

function newDatabase(): string {
  const name = uniqueDb("cvc");
  databases.push(name);
  return name;
}

function spec(
  database: string,
  name: string,
  type: CollectionSpec["type"] = "collection",
): CollectionSpec {
  return {
    ns: `${database}.${name}`,
    db: database,
    name,
    type,
    options: {},
    indexes: [],
    estimatedDocuments: 0,
  };
}

async function request(
  database: string,
  overrides: Partial<ChangeCaptureRequest> = {},
): Promise<ChangeCaptureRequest & { readonly storage: MemoryStorage }> {
  return {
    client: client(),
    storage: memoryStorage(),
    logger: silentLogger,
    backupId: `capture-${database}`,
    compression: "none",
    encryption: undefined,
    writtenKeys: new Set(),
    from: await readClusterTime(client()),
    specs: [spec(database, "a")],
    include: [`${database}.a`],
    exclude: undefined,
    serverVersion: "7.0.0",
    signal: undefined,
    resume: { attempts: 1, initialDelayMs: 10, maxDelayMs: 10 },
    ...overrides,
  } as ChangeCaptureRequest & { readonly storage: MemoryStorage };
}

/** The events stored in a finished capture's changes file. */
async function storedEvents(
  storage: MemoryStorage,
  backupId: string,
  key: string,
): Promise<Document[]> {
  const raw = await storage.get(resolveBackupKey(backupId, key));
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const documents: Document[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.readInt32LE(offset);
    documents.push(BSON.deserialize(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  return documents;
}

/**
 * The `fullDocument` of each stored event, as the stored bytes (`raw: true` keeps every
 * sub-document as BSON), keyed by operation type in file order.
 */
async function storedFullDocuments(
  storage: MemoryStorage,
  backupId: string,
  key: string,
): Promise<{ operationType: unknown; synthesized: unknown; fullDocument: Buffer | undefined }[]> {
  const raw = await storage.get(resolveBackupKey(backupId, key));
  const chunks: Buffer[] = [];
  for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const events = [];
  for (let offset = 0; offset < bytes.length; ) {
    const length = bytes.readInt32LE(offset);
    const event = BSON.deserialize(bytes.subarray(offset, offset + length), { raw: true });
    const fullDocument: unknown = event.fullDocument;
    events.push({
      operationType: event.operationType,
      synthesized: event.synthesized,
      fullDocument: fullDocument instanceof Uint8Array ? Buffer.from(fullDocument) : undefined,
    });
    offset += length;
  }
  return events;
}

describe("startChangeCapture", () => {
  it("warns about time series collections and servers without disambiguatedPaths", async () => {
    const database = newDatabase();
    const capture = await startChangeCapture(
      await request(database, {
        specs: [spec(database, "a"), spec(database, "metrics", "timeseries")],
        serverVersion: "6.0.5",
      }),
    );
    const window = await capture.finish();
    expect(window.warnings).toHaveLength(2);
    expect(window.warnings[0]).toContain(`${database}.metrics`);
    expect(window.warnings[1]).toContain("MongoDB 6.0.5 does not report disambiguatedPaths");
    expect(window.file.events).toBe(0);
  });

  it("keeps only the events of the backup's namespaces", async () => {
    const database = newDatabase();
    const options = await request(database);
    const capture = await startChangeCapture(options);
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: 1 });
    await client().db(database).collection<AnyDocument>("b").insertOne({ _id: 1 });
    const window = await capture.finish();
    const events = await storedEvents(options.storage, options.backupId, window.file.key);
    expect(events.map((event) => `${event.operationType} ${event.ns.coll}`)).toEqual([
      "create a",
      "insert a",
    ]);
  });

  it("warns once when it cannot read the document of unreplayable updates", async () => {
    const database = newDatabase();
    await client()
      .db(database)
      .collection<AnyDocument>("a")
      // Large enough that the server records the change as an update, not a replacement.
      .insertMany([
        { _id: 1, pad: "p".repeat(1000) },
        { _id: 2, pad: "p".repeat(1000) },
      ]);
    // Snapshot reads fail: the capture cannot add the document to the update.
    const inject: FaultInjector = (command) =>
      command.find !== undefined && command.readConcern?.level === "snapshot"
        ? new MongoServerError({
            message: "snapshot too old",
            code: 239,
            codeName: "SnapshotTooOld",
          })
        : undefined;
    const options = await request(database, { client: clientWithFaults(client(), inject) });
    const capture = await startChangeCapture(options);
    for (const _id of [1, 2]) {
      await client()
        .db(database)
        .collection<AnyDocument>("a")
        .updateOne({ _id }, [
          { $replaceWith: { $setField: { field: "a.b", input: "$$ROOT", value: 1 } } },
        ]);
    }
    const window = await capture.finish();
    expect(window.warnings).toEqual([
      "Some updates to field names containing dots or starting with $ could not be recorded; restore skips them.",
    ]);
    const updates = (await storedEvents(options.storage, options.backupId, window.file.key)).filter(
      (event) => event.operationType === "update",
    );
    expect(updates).toHaveLength(2);
    expect(updates.every((event) => event.fullDocument === undefined)).toBe(true);
  });

  describe("documents it reads itself keep their stored field order", () => {
    /** A document whose fields and embedded `_id` JavaScript would reorder. */
    const stored = knownReorderedDocument(1, ["pad", "p".repeat(1000)]);

    it("for an update to a dotted field name (the document after the update)", async () => {
      const database = newDatabase();
      const collection = client().db(database).collection<AnyDocument>("a");
      await collection.insertOne(stored as unknown as AnyDocument);
      const options = await request(database);
      const capture = await startChangeCapture(options);
      // Not expressible as $set: the capture reads the document as of the update.
      await collection.updateOne({ _id: stored.get("_id") as never }, [
        { $replaceWith: { $setField: { field: "a.b", input: "$$ROOT", value: 1 } } },
      ]);
      const window = await capture.finish();
      // The embedded-document `_id` was found (in JavaScript order it matches nothing).
      expect(window.warnings).toEqual([]);
      const events = await storedFullDocuments(options.storage, options.backupId, window.file.key);
      const update = events.find((event) => event.operationType === "update");
      const [now] = await collection.find({}, { raw: true }).toArray();
      expect(update?.fullDocument).toEqual(Buffer.from(now as unknown as Uint8Array));
    });

    it("for a rename's destination recorded as of the rename", async () => {
      const database = newDatabase();
      await client()
        .db(database)
        .collection<AnyDocument>("z")
        .insertOne(stored as unknown as AnyDocument);
      const options = await request(database, {
        specs: [spec(database, "a"), spec(database, "z")],
        include: [`${database}.*`],
      });
      const capture = await startChangeCapture(options);
      // `z` was not dumped yet: its destination is recorded document by document.
      await client().db(database).collection<AnyDocument>("z").rename("z_moved");
      const window = await capture.finish();
      const events = await storedFullDocuments(options.storage, options.backupId, window.file.key);
      const inserts = events.filter(
        (event) => event.synthesized === true && event.operationType === "insert",
      );
      expect(inserts.map((event) => event.fullDocument)).toEqual([bytesOf(stored)]);
    });
  });

  it("records a rename alone when its source was dumped before it", async () => {
    const database = newDatabase();
    await client().db(database).collection<AnyDocument>("a").insertOne({ _id: 1 });
    const options = await request(database, {
      specs: [spec(database, "a"), spec(database, "z")],
      include: [`${database}.*`],
    });
    const capture = await startChangeCapture(options);
    await capture.markDumped(`${database}.a`);
    await client().db(database).collection<AnyDocument>("a").rename("z", { dropTarget: true });
    // A rename out of the backed-up namespaces needs nothing either.
    const elsewhere = newDatabase();
    await client()
      .db("admin")
      .command({ renameCollection: `${database}.z`, to: `${elsewhere}.moved` });
    const window = await capture.finish();
    const events = await storedEvents(options.storage, options.backupId, window.file.key);
    expect(events.some((event) => event.synthesized === true)).toBe(false);
    expect(events.filter((event) => event.operationType === "rename")).toHaveLength(1);
    // A cross-database rename shows up here as the source's drop.
    expect(events.some((event) => event.operationType === "drop" && event.ns.coll === "z")).toBe(
      true,
    );
  });

  describe("a rename's destination the server will not read as of the rename", () => {
    /** SnapshotUnavailable as a shard reports it after the rename's catalog change. */
    const catalogChanged = () =>
      new MongoServerError({
        message: `Collection has undergone a catalog change and no longer satisfies the requirements for the current transaction.`,
        code: 246,
        codeName: "SnapshotUnavailable",
      });

    /**
     * Fails the first `failures` snapshot reads of the destination; records the time
     * each asked for (`undefined`: the server's latest snapshot).
     */
    function refusingDestinationReads(failures: number) {
      const times: (ClusterTime | undefined)[] = [];
      const inject: FaultInjector = (command) => {
        if (command.find !== "z_moved" || command.readConcern?.level !== "snapshot") {
          return undefined;
        }
        const atClusterTime: unknown = command.readConcern.atClusterTime;
        times.push(
          atClusterTime instanceof Timestamp
            ? { t: atClusterTime.t, i: atClusterTime.i }
            : undefined,
        );
        return times.length <= failures ? catalogChanged() : undefined;
      };
      return { inject, times };
    }

    /** A capture during which `z` (not dumped yet) is renamed to `z_moved` and changed. */
    async function renameDuringCapture(inject: FaultInjector) {
      const database = newDatabase();
      await client()
        .db(database)
        .collection<AnyDocument>("z")
        .insertMany([{ _id: 1 }, { _id: 2 }]);
      const options = await request(database, {
        client: clientWithFaults(client(), inject),
        specs: [spec(database, "a"), spec(database, "z")],
        include: [`${database}.*`],
      });
      const capture = await startChangeCapture(options);
      await client().db(database).collection<AnyDocument>("z").rename("z_moved");
      await client().db(database).collection<AnyDocument>("z_moved").insertOne({ _id: 3 });
      return { capture, options };
    }

    it("reads it at a later time, never after the end of the window", async () => {
      const { inject, times } = refusingDestinationReads(2);
      const { capture, options } = await renameDuringCapture(inject);
      const window = await capture.finish();
      // The rename's time, then later times, never after T1.
      expect(times).toHaveLength(3);
      const [renamedAt, ...later] = times;
      if (renamedAt === undefined) throw new Error("the first read must be at the rename");
      for (const time of later) {
        if (time === undefined) throw new Error("every read names its time");
        expect(compareClusterTimes(time, renamedAt)).toBeGreaterThan(0);
        expect(compareClusterTimes(time, window.to)).toBeLessThanOrEqual(0);
      }
      expect(compareClusterTimes(renamedAt, window.to)).toBeLessThanOrEqual(0);
      const events = await storedEvents(options.storage, options.backupId, window.file.key);
      const recorded = events.filter((event) => event.synthesized === true);
      expect(recorded.map((event) => event.operationType).slice(0, 2)).toEqual(["drop", "create"]);
      // A later read may already see the insert made after the rename (replayed again).
      const ids = recorded.slice(2).map((event) => Number(event.documentKey._id));
      expect(ids.slice(0, 2)).toEqual([1, 2]);
      // Stamped with the rename's cluster time, whatever time the read used.
      const stamp = new Timestamp(renamedAt);
      expect(recorded.every((event) => stamp.equals(event.clusterTime))).toBe(true);
    });

    it("fails typed after a bounded number of attempts", async () => {
      const { inject, times } = refusingDestinationReads(Number.POSITIVE_INFINITY);
      const { capture } = await renameDuringCapture(inject);
      const error = await capture.finish().catch((caught: unknown) => caught);
      expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
      expect(String(error)).toContain("catalog change");
      expect(times).toHaveLength(DESTINATION_READ_ATTEMPTS);
      await capture.stop();
    });
  });

  it("fails with the stream's error, and finish() reports it", async () => {
    const database = newDatabase();
    let refuse = false;
    const inject: FaultInjector = (command) =>
      refuse && isChangeStreamGetMore(command)
        ? new MongoServerError({ message: "not authorized", code: 13, codeName: "Unauthorized" })
        : undefined;
    const capture = await startChangeCapture(
      await request(database, { client: clientWithFaults(client(), inject) }),
    );
    refuse = true;
    await new Promise<void>((resolve) => capture.signal.addEventListener("abort", () => resolve()));
    expect(capture.failure?.code).toBe("MS_PERMISSION_DENIED");
    await expect(capture.finish()).rejects.toMatchObject({ code: "MS_PERMISSION_DENIED" });
    await capture.stop();
  });

  it("ends with MS_ABORTED when the caller's signal fires", async () => {
    const database = newDatabase();
    const controller = new AbortController();
    const capture = await startChangeCapture(
      await request(database, { signal: controller.signal }),
    );
    controller.abort();
    await expect(capture.finish()).rejects.toMatchObject({ code: "MS_ABORTED" });
    expect(capture.signal.aborted).toBe(true);
  });
});
