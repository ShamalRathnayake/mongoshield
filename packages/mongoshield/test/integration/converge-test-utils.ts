// Shared helpers for the converge integration tests and the randomized harness:
// storage wrappers that run code (or wait) when the backup starts writing a file, and
// reading collections as raw BSON, optionally as of a cluster time, to compare them
// byte for byte.

import { setTimeout as sleep } from "node:timers/promises";
import { BSON, type Document, type MongoClient, Timestamp } from "mongodb";
import type { ClusterTime } from "../../src/format/manifest.ts";
import type { MemoryStorage } from "../../src/storage/memory.ts";

/**
 * A memory storage whose `put` first awaits `beforePut(key)`. While it waits, the
 * backup's cursor for that file is open but not drained, so whatever `beforePut` does
 * to the database happens in the middle of the dump.
 */
export function hookedStorage(
  base: MemoryStorage,
  beforePut: (key: string) => Promise<void>,
): MemoryStorage {
  return {
    ...base,
    async put(key, body, options) {
      await beforePut(key);
      return base.put(key, body, options);
    },
  };
}

/** A memory storage that waits `delayMs` before storing each data file: a slow backup. */
export function slowStorage(base: MemoryStorage, delayMs: number): MemoryStorage {
  return hookedStorage(base, async (key) => {
    if (key.endsWith(".bson") || key.includes(".bson.")) await sleep(delayMs);
  });
}

/** True for the storage key of `collection`'s data file. */
export function isDataFileOf(key: string, collection: string): boolean {
  return key.includes(`/${collection}.bson`);
}

/**
 * Every document of a collection as raw BSON, sorted by `_id`; as of `atClusterTime`
 * when given (a snapshot read, so it must be within the server's snapshot window).
 * Test collections are small: one batch holds them all.
 */
export async function rawDocuments(
  client: MongoClient,
  database: string,
  collection: string,
  atClusterTime?: ClusterTime,
): Promise<Buffer[]> {
  const reply = await client.db(database).command(
    {
      find: collection,
      filter: {},
      sort: { _id: 1 },
      batchSize: 1_000_000,
      singleBatch: true,
      ...(atClusterTime === undefined
        ? {}
        : {
            readConcern: {
              level: "snapshot",
              atClusterTime: new Timestamp({ t: atClusterTime.t, i: atClusterTime.i }),
            },
          }),
    },
    { fieldsAsRaw: { firstBatch: true } },
  );
  const batch: unknown = reply.cursor?.firstBatch;
  if (!Array.isArray(batch)) throw new Error(`no batch for ${database}.${collection}`);
  return batch.map((raw: Uint8Array) => Buffer.from(raw));
}

/** Collection names of a database (without `system.*`), sorted. */
export async function collectionNames(client: MongoClient, database: string): Promise<string[]> {
  const infos = await client.db(database).listCollections({}, { nameOnly: true }).toArray();
  return infos
    .map((info) => info.name)
    .filter((name) => !name.startsWith("system."))
    .sort();
}

/** A readable description of the first difference between two raw document lists. */
export function firstDifference(expected: Buffer[], actual: Buffer[]): string | undefined {
  const length = Math.max(expected.length, actual.length);
  const describe = (raw: Buffer | undefined) =>
    raw === undefined ? "(missing)" : JSON.stringify(BSON.EJSON.serialize(parse(raw)));
  for (let index = 0; index < length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (left !== undefined && right !== undefined && left.equals(right)) continue;
    return `document #${index}: expected ${describe(left)}, got ${describe(right)} (${expected.length} vs ${actual.length} documents)`;
  }
  return undefined;
}

function parse(raw: Buffer): Document {
  return BSON.deserialize(raw, { promoteValues: false, promoteLongs: false, bsonRegExp: true });
}
