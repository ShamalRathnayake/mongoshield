/**
 * `mongoshield/testing`: fast snapshot and reset of test databases, for your own
 * integration tests (Vitest, Jest, node:test, …). Works with mongodb-memory-server
 * and with real servers.
 *
 *   import { useMongoSnapshot } from "mongoshield/testing";
 *
 *   const db = useMongoSnapshot(() => client, { databases: ["app_test"] });
 *   beforeAll(seedFixtures);          // put the baseline data in place
 *   beforeEach(() => db.reset());     // 1st call snapshots, later calls restore
 *   afterAll(() => db.dispose());
 *
 * Or manage the snapshot yourself with `createDatabaseSnapshot(client, …)`, which
 * returns `{ restore(), dispose() }`. See docs/guides/testing.md.
 *
 * Nothing here depends on a test framework: the helpers only return functions to
 * call from your framework's hooks.
 */

import type { MongoClient } from "mongodb";
import {
  createDatabaseSnapshot,
  type DatabaseSnapshot,
  type DatabaseSnapshotOptions,
} from "./snapshot.ts";

export { createDatabaseSnapshot, type DatabaseSnapshot, type DatabaseSnapshotOptions };

/** A client, or a function returning one (handy when the client is created in `beforeAll`). */
export type ClientSource = MongoClient | (() => MongoClient | Promise<MongoClient>);

/** What `useMongoSnapshot` returns. */
export interface MongoSnapshotHandle {
  /**
   * The first call captures the current state of the databases; every later call
   * puts that state back. Call it from `beforeEach`.
   */
  reset(): Promise<void>;
  /** Captures the state now (replacing an earlier snapshot), e.g. at the end of `beforeAll`. */
  snapshot(): Promise<DatabaseSnapshot>;
  /** Frees the snapshot's memory. Call it from `afterAll`. */
  dispose(): Promise<void>;
}

/**
 * A snapshot that is taken lazily on the first `reset()` and restored on every
 * later one, so `beforeEach(() => db.reset())` is all a test file needs: each test
 * starts from the state the databases had before the first test.
 *
 * Concurrent calls are serialized, so a `reset()` never overlaps a snapshot.
 */
export function useMongoSnapshot(
  client: ClientSource,
  options: DatabaseSnapshotOptions,
): MongoSnapshotHandle {
  let current: DatabaseSnapshot | undefined;
  // Serializes snapshot/reset/dispose, which all touch `current` and the database.
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function takeSnapshot(): Promise<DatabaseSnapshot> {
    const previous = current;
    current = await createDatabaseSnapshot(await resolveClient(client), options);
    await previous?.dispose();
    return current;
  }

  return {
    reset: () =>
      serialized(async () => {
        if (current === undefined) await takeSnapshot();
        else await current.restore();
      }),
    snapshot: () => serialized(takeSnapshot),
    dispose: () =>
      serialized(async () => {
        await current?.dispose();
        current = undefined;
      }),
  };
}

async function resolveClient(client: ClientSource): Promise<MongoClient> {
  return typeof client === "function" ? client() : client;
}
