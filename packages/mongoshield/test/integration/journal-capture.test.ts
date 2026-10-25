// The journal's two enrichments (src/journal/capture.ts), called directly against the
// real server: an update to a dotted field name gets the document as of the event,
// and a rename's destination is recorded as of the rename, batch by batch. When the
// snapshot read is impossible (the event is older than the server's snapshot window)
// the event is stored as is and an error is logged, never a half-recorded collection.

import { BSON, type Document, Timestamp } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { parseChangeEvent } from "../../src/engine/converge-events.ts";
import { readClusterTime } from "../../src/engine/converge-time.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import { openDestinationSnapshot, storedEventBytes } from "../../src/journal/capture.ts";
import type { Logger } from "../../src/logger.ts";
import { uniqueDb, useMongoClient } from "../helpers/mongo.ts";
import type { AnyDocument } from "./converge-test-utils.ts";

const client = useMongoClient();
const database = uniqueDb("jcap");

afterAll(async () => {
  await client().db(database).dropDatabase();
});

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const ignore = (): void => {};
  return {
    logger: { debug: ignore, info: ignore, warn: ignore, error: (message) => errors.push(message) },
    errors,
  };
}

function event(fields: Document, at: ClusterTime) {
  const raw = Buffer.from(BSON.serialize({ clusterTime: new Timestamp(at), ...fields }));
  return { raw, event: parseChangeEvent(raw) };
}

/** An update of `a.b` (a field name with a dot), which `$set` cannot replay. */
function dottedUpdate(coll: string | undefined, id: unknown, at: ClusterTime) {
  return event(
    {
      operationType: "update",
      ns: coll === undefined ? { db: database } : { db: database, coll },
      documentKey: { _id: id },
      updateDescription: {
        updatedFields: { "a.b": 2 },
        removedFields: [],
        truncatedArrays: [],
        disambiguatedPaths: { "a.b": ["a.b"] },
      },
    },
    at,
  );
}

async function drain(generator: AsyncGenerator<Buffer>): Promise<Document[]> {
  const documents: Document[] = [];
  for await (const raw of generator) documents.push(BSON.deserialize(raw));
  return documents;
}

describe("storedEventBytes", () => {
  it("adds the document as of the update", async () => {
    await client().db(database).collection<AnyDocument>("docs").insertOne({ _id: 1, "a.b": 2 });
    const now = await readClusterTime(client());
    const { raw, event: update } = dottedUpdate("docs", 1, now);
    const { logger, errors } = recordingLogger();
    const stored = BSON.deserialize(await storedEventBytes(client(), raw, update, logger));
    expect(stored.fullDocument).toEqual({ _id: 1, "a.b": 2 });
    expect(errors).toEqual([]);
  });

  it("stores the event as is, logging an error, when the document cannot be read", async () => {
    const now = await readClusterTime(client());
    const cases = [
      dottedUpdate("docs", "missing", now), // no such document
      dottedUpdate(undefined, 1, now), // no collection in the namespace
      dottedUpdate("docs", 1, { t: 1, i: 1 }), // far older than the snapshot window
    ];
    for (const { raw, event: update } of cases) {
      const { logger, errors } = recordingLogger();
      const stored = await storedEventBytes(client(), raw, update, logger);
      expect(stored.equals(raw)).toBe(true);
      expect(errors).toHaveLength(1);
    }
  });
});

describe("openDestinationSnapshot", () => {
  const rename = (to: Document, at: ClusterTime) =>
    event({ operationType: "rename", ns: { db: database, coll: "tmp.x" }, to }, at).event;

  it("records the destination as drop, create and one insert per document", async () => {
    const documents = Array.from({ length: 250 }, (_, n) => ({ _id: n }));
    await client().db(database).collection<AnyDocument>("dest").insertMany(documents);
    const at = await readClusterTime(client());
    const { logger } = recordingLogger();
    const snapshot = await openDestinationSnapshot(
      client(),
      rename({ db: database, coll: "dest" }, at),
      undefined,
      logger,
    );
    if (snapshot === undefined) throw new Error("expected a snapshot");
    const recorded = await drain(snapshot);
    expect(recorded.map((document) => document.operationType).slice(0, 3)).toEqual([
      "drop",
      "create",
      "insert",
    ]);
    // More than one batch (101 documents in the first): the getMore path.
    expect(recorded.filter((document) => document.operationType === "insert")).toHaveLength(250);
    expect(recorded.every((document) => document.synthesized === true)).toBe(true);
  });

  it("closes the cursor when the reader stops early", async () => {
    const at = await readClusterTime(client());
    const { logger } = recordingLogger();
    const snapshot = await openDestinationSnapshot(
      client(),
      rename({ db: database, coll: "dest" }, at),
      undefined,
      logger,
    );
    if (snapshot === undefined) throw new Error("expected a snapshot");
    await snapshot.next();
    await snapshot.return(undefined);
    const open = await client()
      .db("admin")
      .aggregate([
        { $currentOp: { idleCursors: true, allUsers: true } },
        { $match: { ns: `${database}.dest`, type: "idleCursor" } },
      ])
      .toArray();
    expect(open).toEqual([]);
  });

  it("returns nothing for a rename without a destination collection, or too old to read", async () => {
    const { logger, errors } = recordingLogger();
    const now = await readClusterTime(client());
    expect(
      await openDestinationSnapshot(client(), rename({ db: database }, now), undefined, logger),
    ).toBeUndefined();
    expect(
      await openDestinationSnapshot(
        client(),
        rename({ db: database, coll: "dest" }, { t: 1, i: 1 }),
        undefined,
        logger,
      ),
    ).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});
