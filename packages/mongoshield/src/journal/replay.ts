/**
 * Replaying the journal onto a restored base backup: the second half of a point-in-time
 * restore (docs/specs/JOURNAL.md, "Restore to a point in time", step 4).
 *
 *   pre-flight   read every event of (from, to] once: the segment chain, decryption
 *                and parsing are all checked before anything is written
 *   targets      source namespace → target namespace, with the restore's
 *                include/exclude and rename rules (converge-targets.ts)
 *   replay       the converge replay (converge-replay.ts): the same translation table,
 *                ordering, batching and error tolerance as a converge backup's window
 *
 * Why the converge rules carry over unchanged: they replay a stream of change events
 * onto collections that already reflect some prefix of it, writing absolute values.
 * A base backup restored as of its cluster time B, followed by every event after B in
 * order, reaches exactly the state at the last event replayed.
 *
 * Unlike a converge restore, the replay runs after the base restore has built its
 * indexes, so collections created after the base backup get no secondary indexes
 * (the same limit as collections created during a converge window).
 */

import type { MongoClient, WriteConcernSettings } from "mongodb";
import { replayChangeEvents } from "../engine/converge-replay.ts";
import {
  checkWindowTargets,
  planReplayTargets,
  summarizeChangeEvents,
} from "../engine/converge-targets.ts";
import { ProgressTracker } from "../engine/progress.ts";
import { dropNamespace } from "../engine/restore-collections.ts";
import { compileRenameMap } from "../engine/restore-rename.ts";
import { throwIfAborted } from "../errors.ts";
import type { ClusterTime } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { compileNamespaceFilter, splitNamespace } from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions, NamespacePattern, ProgressEvent, RestoreMode } from "../types.ts";
import { loadJournalCoverage, segmentsBetween } from "./coverage.ts";
import { readJournalSegments } from "./reader.ts";
import { toJournalTime } from "./time.ts";

/** How the journal replay shows up in progress events (it is not a namespace). */
export const JOURNAL_PROGRESS_LABEL = "(journal)";

/** Options for {@link replayJournal}. */
export interface ReplayJournalOptions {
  /** Connected client for the restore target. Not closed. */
  readonly client: MongoClient;
  /** The storage holding the journal. */
  readonly storage: StorageAdapter;
  /** Replay the events after this cluster time: the base backup's (plan `baseTime`). */
  readonly from: ClusterTime;
  /** … up to and including this one (a `Date` is rounded down to its second). */
  readonly to: Date | ClusterTime;
  /**
   * The base backup's namespaces (plan `baseNamespaces`). Their events go to where the
   * base restore put them; other namespaces are collections created after the base
   * backup and get the conflict checks of `mode`. Also needed for `dropDatabase`
   * events to reach collections the journal never mentions.
   */
  readonly baseNamespaces?: readonly string[] | undefined;
  /** The base restore's include/exclude patterns (same meaning as for restore). */
  readonly include?: readonly NamespacePattern[] | undefined;
  readonly exclude?: readonly NamespacePattern[] | undefined;
  /** The base restore's rename rules, e.g. `{ "app.*": "app_restored.*" }`. */
  readonly rename?: Readonly<Record<string, string>> | undefined;
  /** For collections created after the base backup; defaults to `"fail-if-exists"`. */
  readonly mode?: RestoreMode | undefined;
  readonly decryption?: DecryptionOptions | undefined;
  readonly writeConcern?: WriteConcernSettings | undefined;
  /** Skip document validation (needs the bypassDocumentValidation privilege). */
  readonly bypassDocumentValidation?: boolean | undefined;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
}

/** What a journal replay did. */
export interface ReplayJournalResult {
  /** The exact cluster time the target now reflects. */
  readonly restoredTo: ClusterTime;
  readonly segments: number;
  /** Events read from the journal in the range. */
  readonly events: number;
  /** Events that changed something (document writes and DDL). */
  readonly applied: number;
  readonly skipped: number;
  /** Updates skipped because their path no longer fit (see converge-replay.ts). */
  readonly toleratedErrors: number;
  /** Target namespaces dropped or renamed away by the replay. */
  readonly removedTargets: readonly string[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

/**
 * Replays the journaled changes in `(from, to]` into the target.
 *
 * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when the journal does not cover the
 *   range, `MS_INTEGRITY_FAILED` for a broken segment chain (both before any write),
 *   `MS_RESTORE_CONFLICT` for collections created after the base backup whose target
 *   holds data (mode `fail-if-exists`), `MS_RESTORE_FAILED` / `MS_PERMISSION_DENIED`
 *   for write failures, `MS_ABORTED`.
 */
export async function replayJournal(options: ReplayJournalOptions): Promise<ReplayJournalResult> {
  const startedAt = performance.now();
  const { client, storage, from, signal } = options;
  const logger = options.logger ?? silentLogger;
  const to = toJournalTime(options.to);
  const decryption = options.decryption;

  const coverage = await loadJournalCoverage(storage, signal);
  const read = () => readJournalSegments(storage, { from, to, decryption, signal, coverage });

  // Pre-flight: one full pass proves the range is intact before anything is written.
  const summary = await summarizeChangeEvents(read());
  throwIfAborted(signal);

  const filter = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  const rename = compileRenameMap(options.rename);
  const baseNamespaces = options.baseNamespaces ?? [];
  const restored = new Map<string, string>();
  for (const ns of baseNamespaces) if (filter(ns)) restored.set(ns, rename(ns));
  const targets = planReplayTargets({
    backedUp: new Set(baseNamespaces),
    restored,
    filter,
    rename,
    summary,
  });

  const dropFirst = await checkWindowTargets(
    client,
    targets,
    options.mode ?? "fail-if-exists",
    signal,
  );
  for (const target of dropFirst) {
    const { database, collection } = splitNamespace(target);
    await dropNamespace(client.db(database), collection, options.writeConcern);
  }

  logger.info("Replaying the journal", { events: summary.events });
  const tracker = new ProgressTracker({ onProgress: options.onProgress, logger });
  const result = await replayChangeEvents({
    client,
    logger,
    events: read(),
    until: undefined,
    targets,
    writeConcern: options.writeConcern,
    bypassDocumentValidation: options.bypassDocumentValidation ?? false,
    tracker,
    expectedEvents: summary.events,
    signal,
    progressLabel: JOURNAL_PROGRESS_LABEL,
  });
  tracker.finish();

  return {
    restoredTo: to,
    segments: segmentsBetween(coverage.segments, from, to).length,
    events: result.events,
    applied: result.applied,
    skipped: result.skipped,
    toleratedErrors: result.toleratedErrors,
    removedTargets: [...result.removedTargets],
    warnings: result.warnings,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
