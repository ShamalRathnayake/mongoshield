/**
 * Restore planning for a converge backup's changes file: which events are replayed,
 * and where to.
 *
 *   pre-flight:  scanChangeWindow     read the whole changes file once (proves it is
 *                                     intact and decryptable before anything is written)
 *                planReplayTargets    source namespace → target namespace, applying the
 *                                     restore's include/exclude and rename rules
 *                checkWindowTargets   collections created during the window must not
 *                                     overwrite existing data either
 *
 * Event namespaces fall into three groups:
 *
 * - namespaces in the backup: replayed into their planned target, when restored;
 * - collections created during the window (not in the backup's namespaces): restored
 *   from their events when the restore's patterns select them;
 * - scratch collections (`tmp.*`) that `$out` / `$merge` fill and then rename over their
 *   target: replayed (next to that target) only when the rename lands on a restored
 *   namespace; otherwise they are transient and skipped.
 */

import type { Document, MongoClient } from "mongodb";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime, StoredFile } from "../format/manifest.ts";
import { type NamespaceFilter, splitNamespace } from "../mongo/index.ts";
import type { RestoreMode } from "../types.ts";
import {
  collectionNamespaceOf,
  readChangeEvents,
  type StoredChangeEvent,
} from "./converge-events.ts";
import { compareClusterTimes } from "./converge-time.ts";
import type { StoredBackupSource } from "./read-pipeline.ts";
import { decideAction } from "./restore-plan.ts";
import type { NamespaceMapper } from "./restore-rename.ts";

/** Collection-name prefix of `$out` / `$merge` / mapReduce scratch collections. */
const SCRATCH_COLLECTION_PREFIX = "tmp.";

/** What the changes file holds, from one pass over it. */
export interface ChangeWindowSummary {
  /** Number of events in the file. */
  readonly events: number;
  /** Every collection namespace some event refers to (as `ns` or rename `to`). */
  readonly namespaces: ReadonlySet<string>;
  /** For each renamed namespace, where its first rename took it. */
  readonly renamedTo: ReadonlyMap<string, string>;
}

/**
 * Reads the whole changes file once: checks its integrity (size, SHA-256, every event
 * parses) and collects what the replay plan needs. Memory grows with the number of
 * namespaces, not events.
 *
 * @throws MongoShieldError from the read pipeline (`MS_INTEGRITY_FAILED`,
 *   `MS_DECRYPTION_FAILED`, `MS_STORAGE_NOT_FOUND`, `MS_ABORTED`).
 */
export async function scanChangeWindow(
  source: StoredBackupSource,
  file: StoredFile,
  signal: AbortSignal | undefined,
  until?: ClusterTime,
): Promise<ChangeWindowSummary> {
  return summarizeChangeEvents(eventsUntil(readChangeEvents(source, file, signal), until));
}

/**
 * The events at or before `until` (all of them when `until` is undefined).
 *
 * The capture writes events in the background and only learns the end of the window
 * (T1) after its closing `ping` returns, so a changes file can hold a few events from
 * just after T1. Replay and planning must therefore apply the bound themselves: the
 * manifest's `consistency.to` is the authority, not the file's last event.
 */
export async function* eventsUntil(
  events: AsyncIterable<StoredChangeEvent>,
  until: ClusterTime | undefined,
): AsyncGenerator<StoredChangeEvent> {
  for await (const stored of events) {
    // Events are in cluster-time order: the first one past the bound ends the window.
    if (until !== undefined && compareClusterTimes(stored.event.clusterTime, until) > 0) return;
    yield stored;
  }
}

/**
 * The summary of {@link scanChangeWindow} for events from any ordered source (journal
 * segments use it, see src/journal/replay.ts). Reads every event once.
 */
export async function summarizeChangeEvents(
  source: AsyncIterable<StoredChangeEvent>,
): Promise<ChangeWindowSummary> {
  let events = 0;
  const namespaces = new Set<string>();
  const renamedTo = new Map<string, string>();
  for await (const { event } of source) {
    events += 1;
    const ns = collectionNamespaceOf(event.ns);
    const to = collectionNamespaceOf(event.to);
    if (ns !== undefined) namespaces.add(ns);
    if (to !== undefined) namespaces.add(to);
    if (event.operationType === "rename" && ns !== undefined && to !== undefined) {
      if (!renamedTo.has(ns)) renamedTo.set(ns, to);
    }
  }
  return { events, namespaces, renamedTo };
}

/** Where the events of each source namespace are replayed. */
export interface ReplayTargets {
  /** The target namespace for a source collection, or `undefined` to skip its events. */
  targetOf(ns: string): string | undefined;
  /** Source namespaces (of any group above) with a target, in database `db`. */
  sourcesInDatabase(db: string): readonly string[];
  /** Collections created during the window that will be restored: `from → to`. */
  readonly windowTargets: ReadonlyMap<string, string>;
}

/** What `planReplayTargets` combines. */
export interface ReplayTargetsInput {
  /** Every namespace in the backup's manifest. */
  readonly backedUp: ReadonlySet<string>;
  /** The manifest namespaces this restore writes: source → target. */
  readonly restored: ReadonlyMap<string, string>;
  /** The restore's include/exclude patterns. */
  readonly filter: NamespaceFilter;
  /** The restore's rename rules. */
  readonly rename: NamespaceMapper;
  readonly summary: ChangeWindowSummary;
}

/** Decides the target of every namespace in the window (see the file header). */
export function planReplayTargets(input: ReplayTargetsInput): ReplayTargets {
  const targets = new Map<string, string>();
  const windowTargets = new Map<string, string>();

  // Non-scratch namespaces first: scratch targets depend on them.
  for (const ns of input.summary.namespaces) {
    if (isScratch(ns)) continue;
    if (input.backedUp.has(ns)) {
      const target = input.restored.get(ns);
      if (target !== undefined) targets.set(ns, target);
    } else if (input.filter(ns)) {
      const target = input.rename(ns);
      targets.set(ns, target);
      windowTargets.set(ns, target);
    }
  }
  for (const ns of input.summary.namespaces) {
    if (!isScratch(ns)) continue;
    const destination = input.summary.renamedTo.get(ns);
    const destinationTarget = destination === undefined ? undefined : targets.get(destination);
    if (destinationTarget === undefined) continue;
    // Next to the final target, so the rename stays within one database where possible.
    const { database } = splitNamespace(destinationTarget);
    targets.set(ns, `${database}.${splitNamespace(ns).collection}`);
  }
  // Manifest namespaces without events can still be hit by a dropDatabase.
  for (const [ns, target] of input.restored) {
    if (!targets.has(ns)) targets.set(ns, target);
  }

  return {
    targetOf: (ns) => targets.get(ns),
    sourcesInDatabase: (db) =>
      [...targets.keys()].filter((ns) => splitNamespace(ns).database === db),
    windowTargets,
  };
}

function isScratch(ns: string): boolean {
  return splitNamespace(ns).collection.startsWith(SCRATCH_COLLECTION_PREFIX);
}

/**
 * Collections created during the window get the same protection as the backup's own
 * namespaces: in `fail-if-exists` mode an existing non-empty target is a conflict, in
 * `drop` mode the target is dropped before the replay (returned here), and `insert` /
 * `upsert` replay into what exists. Only reads; never writes.
 *
 * @throws MongoShieldError `MS_RESTORE_CONFLICT` listing every conflicting target.
 * @returns the targets to drop before replaying.
 */
export async function checkWindowTargets(
  client: MongoClient,
  targets: ReplayTargets,
  mode: RestoreMode,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const toDrop: string[] = [];
  const conflicts: string[] = [];
  for (const target of targets.windowTargets.values()) {
    throwIfAborted(signal);
    const { database, collection } = splitNamespace(target);
    const [info] = await client
      .db(database)
      .listCollections({ name: collection }, { nameOnly: true, authorizedCollections: true })
      .toArray();
    if (info === undefined) continue;
    const type = typeOf(info);
    const documents =
      type === "view"
        ? 0
        : await client.db(database).collection(collection).estimatedDocumentCount();
    const decision = decideAction(mode, "collection", { exists: true, type, documents });
    if ("conflict" in decision) conflicts.push(`  ${target}: ${decision.conflict}`);
    else if (decision.action === "drop-and-create") toDrop.push(target);
  }
  if (conflicts.length > 0) {
    throw new MongoShieldError(
      "MS_RESTORE_CONFLICT",
      `Collections created while the backup was running would overwrite existing data:\n${conflicts.join("\n")}`,
      {
        hint: "Restore with --drop to replace the targets, --mode insert to keep existing documents, or --rename to restore elsewhere.",
        details: { mode, conflicts: conflicts.length },
      },
    );
  }
  return toDrop;
}

function typeOf(info: Document): "collection" | "view" | "timeseries" {
  if (info.type === "view" || info.type === "timeseries") return info.type;
  return "collection";
}
