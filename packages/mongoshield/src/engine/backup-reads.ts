/**
 * How a backup reads data without hurting production: which members it reads from
 * (read preference) and how large each cursor batch is.
 *
 * Read preference by consistency mode:
 * - `none`: the configured preference (default `secondaryPreferred`).
 * - `converge`: the configured preference too, but every data cursor runs in a
 *   causally consistent session whose operation time is the window start T0, so a
 *   lagging secondary first catches up to T0 (`afterClusterTime`). Without that, a
 *   secondary could return data older than T0, and replaying the changes from T0
 *   would not repair it.
 * - `snapshot`: always the primary. The snapshot's time is pinned on the primary,
 *   and a secondary that has not reached it yet would fail the read.
 */

import { ReadPreference, type TagSet } from "mongodb";
import type { ConsistencyMode } from "../format/manifest.ts";
import type { BackupOptions } from "../types.ts";

/** The read preference used when the caller sets none: keeps load off the primary. */
export const DEFAULT_READ_PREFERENCE = "secondaryPreferred";

/** Each cursor batch aims at about this many bytes (the server caps a batch at 16 MiB). */
export const TARGET_BATCH_BYTES = 4 * 1024 * 1024;

/** Batch sizes stay within these bounds, whatever the average document size. */
const MIN_BATCH_DOCUMENTS = 16;
const MAX_BATCH_DOCUMENTS = 100_000;

/**
 * The read preference for this run's data reads (see the file header).
 * Planning reads (`$collStats`, `$sample`) use it too: they only need estimates.
 */
export function resolveReadPreference(
  options: Pick<BackupOptions, "readPreference" | "readPreferenceTags">,
  mode: ConsistencyMode,
): ReadPreference {
  if (mode === "snapshot") return ReadPreference.primary;
  const name = options.readPreference ?? DEFAULT_READ_PREFERENCE;
  const tags = options.readPreferenceTags;
  // Tag sets are not allowed with "primary" (the driver rejects them), so they are
  // only passed for the other modes.
  if (tags === undefined || tags.length === 0 || name === "primary") {
    return new ReadPreference(name);
  }
  const tagSets: TagSet[] = tags.map((tagSet) => ({ ...tagSet }));
  return new ReadPreference(name, tagSets);
}

/**
 * The cursor batch size for documents of `averageDocumentBytes`, aiming at about
 * 4 MiB per batch: big enough that round trips do not dominate, small enough that
 * `parallelism` cursors keep memory flat. `undefined` (the driver's default) when
 * the average is unknown.
 */
export function batchSizeFor(averageDocumentBytes: number | undefined): number | undefined {
  if (averageDocumentBytes === undefined || !(averageDocumentBytes > 0)) return undefined;
  const documents = Math.round(TARGET_BATCH_BYTES / averageDocumentBytes);
  return Math.min(MAX_BATCH_DOCUMENTS, Math.max(MIN_BATCH_DOCUMENTS, documents));
}
