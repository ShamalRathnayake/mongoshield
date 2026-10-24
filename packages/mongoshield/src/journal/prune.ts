/**
 * Journal retention (docs/specs/JOURNAL.md, "Retention"): segments that end at or
 * before the oldest kept base backup can never be replayed (nothing older to replay
 * them onto), so they are deleted. Run it after pruning backups:
 *
 *   const [oldest] = (await listBaseBackups(storage)).slice(-1);
 *   if (oldest) await pruneJournal(storage, { olderThan: oldest.clusterTime });
 *
 * Gap records are never deleted, and neither is the newest segment (the writer chains
 * the next segment to it).
 */

import type { ClusterTime } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { loadJournalCoverage } from "./coverage.ts";
import { isAfter } from "./time.ts";

/** Options for {@link pruneJournal}. */
export interface PruneJournalOptions {
  /** Delete segments whose events all happened at or before this cluster time. */
  readonly olderThan: ClusterTime;
  /** Report what would be deleted without deleting anything. */
  readonly dryRun?: boolean | undefined;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What was (or would be) deleted. */
export interface PruneJournalResult {
  readonly deleted: readonly { readonly key: string; readonly size: number }[];
  readonly deletedBytes: number;
  /** Committed segments left. */
  readonly kept: number;
}

/**
 * Deletes the segments that end at or before `olderThan`.
 *
 * @throws MongoShieldError from storage (`MS_STORAGE_FORBIDDEN` for retained objects).
 */
export async function pruneJournal(
  storage: StorageAdapter,
  options: PruneJournalOptions,
): Promise<PruneJournalResult> {
  const logger = options.logger ?? silentLogger;
  const coverage = await loadJournalCoverage(storage, options.signal);
  const newest = coverage.segments.at(-1);
  const deleted = coverage.segments
    .filter((segment) => segment !== newest && !isAfter(segment.to, options.olderThan))
    .map((segment) => ({ key: segment.key, size: segment.size }));

  if (deleted.length > 0 && options.dryRun !== true) {
    await storage.delete(
      deleted.map((segment) => segment.key),
      options.signal === undefined ? {} : { signal: options.signal },
    );
  }
  const deletedBytes = deleted.reduce((total, segment) => total + segment.size, 0);
  logger.info(
    options.dryRun === true ? "Journal segments that would be pruned" : "Pruned journal segments",
    {
      segments: deleted.length,
      bytes: deletedBytes,
    },
  );
  return { deleted, deletedBytes, kept: coverage.segments.length - deleted.length };
}
