// Shared helpers for the change journal's integration tests: starting a writer with
// fast test settings, waiting until it has committed a given cluster time, and reading
// the journaled events of one database back.

import { setTimeout as sleep } from "node:timers/promises";
import {
  type Db,
  type DbOptions,
  type Document,
  type MongoClient,
  MongoServerError,
  type RunCommandOptions,
  Timestamp,
} from "mongodb";
import { compareClusterTimes, readClusterTime } from "../../src/engine/converge-time.ts";
import type { ClusterTime } from "../../src/format/manifest.ts";
import {
  type JournalHandle,
  type JournalOptions,
  journalStatus,
  loadJournalCoverage,
  readJournalSegments,
  startJournal,
} from "../../src/journal/index.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";

/** Starts a writer with test settings: 1 s segments, quick retries, a short lease. */
export function startTestJournal(
  client: MongoClient,
  storage: StorageAdapter,
  database: string,
  overrides: Partial<JournalOptions> = {},
): Promise<JournalHandle> {
  return startJournal({
    client,
    storage,
    compression: "zstd",
    include: [`${database}.*`],
    segmentSeconds: 1,
    retryDelayMs: 100,
    leaseMs: 10_000,
    ...overrides,
  });
}

/** Polls `condition` every 100 ms until it is true; fails after `timeoutMs`. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits until the journal's committed recovery point is at or after "now". */
export async function waitForJournalToCatchUp(
  client: MongoClient,
  storage: StorageAdapter,
  timeoutMs = 30_000,
): Promise<ClusterTime> {
  const now = await readClusterTime(client);
  await waitFor(
    async () => {
      const { recoveryPoint } = await journalStatus(storage);
      return recoveryPoint !== undefined && compareClusterTimes(recoveryPoint, now) >= 0;
    },
    timeoutMs,
    "the journal to catch up",
  );
  return now;
}

/** A journaled event, reduced to what the tests compare. */
export interface EventSummary {
  readonly op: string;
  readonly ns: string | undefined;
  readonly id: unknown;
}

/** Every journaled event of `database`, from the first committed segment on. */
export async function journaledEvents(
  storage: StorageAdapter,
  database: string,
): Promise<EventSummary[]> {
  const coverage = await loadJournalCoverage(storage);
  const first = coverage.segments[0];
  const to = coverage.state?.recoveryPoint;
  if (first === undefined || to === undefined) return [];
  const events: EventSummary[] = [];
  for await (const { event } of readJournalSegments(storage, { from: first.from, to, coverage })) {
    if (event.ns?.db !== database) continue;
    const id: unknown = (event.documentKey as Document | undefined)?._id;
    events.push({ op: event.operationType, ns: event.ns.coll, id: unwrap(id) });
  }
  return events;
}

/** Lossless parsing keeps Int32 wrappers; tests compare plain numbers. */
function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "valueOf" in value) {
    const primitive: unknown = value.valueOf();
    if (typeof primitive === "number") return primitive;
  }
  return value;
}

/**
 * The client, as seen through a replica set whose oplog now starts at `oldest`: a
 * deployment-wide change stream opened before it fails with the server's real
 * `ChangeStreamHistoryLost` error (code 286). Everything else reaches the real server.
 *
 * Why not a real rollover: the oplog's minimum size is 990 MB, and a test replica set
 * whose oplog never rolled over accepts any start time (its first entry marks the
 * beginning of history).
 */
export function clientWithOplogStartingAt(client: MongoClient, oldest: ClusterTime): MongoClient {
  const startsTooEarly = (command: Document): boolean => {
    const pipeline: unknown = command.pipeline;
    if (command.aggregate !== 1 || !Array.isArray(pipeline)) return false;
    const stage: unknown = pipeline[0]?.$changeStream;
    const start: unknown =
      typeof stage === "object" && stage !== null
        ? Reflect.get(stage, "startAtOperationTime")
        : undefined;
    return (
      start instanceof Timestamp && compareClusterTimes({ t: start.t, i: start.i }, oldest) < 0
    );
  };
  const wrapDb = (db: Db): Db =>
    new Proxy(db, {
      get(target, property) {
        if (property !== "command") return bound(target, property);
        return async (command: Document, options?: RunCommandOptions) => {
          if (startsTooEarly(command)) {
            throw new MongoServerError({
              message:
                "Resume of change stream was not possible, as the resume point may no longer be in the oplog.",
              code: 286,
              codeName: "ChangeStreamHistoryLost",
            });
          }
          return target.command(command, options);
        };
      },
    });
  return new Proxy(client, {
    get(target, property) {
      if (property !== "db") return bound(target, property);
      return (name?: string, options?: DbOptions) => wrapDb(target.db(name, options));
    },
  });
}

/** A property of `target`, with methods bound to it (proxies must not rebind `this`). */
function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}
