/**
 * `verifyFirst` for restores: a fast verify of exactly the files a restore is about
 * to read, run during pre-flight, before the first write.
 *
 *   data files of every written namespace (+ the changes file) → size + SHA-256
 *   → any problem: MS_INTEGRITY_FAILED listing every damaged file; nothing written
 *
 * Why: restore checks each data file's checksum while streaming it, so a file damaged
 * late in a large collection is only noticed after the batches before it were
 * inserted. Into an empty target that is cleaned up by re-running with `--drop`, but
 * into a target that already holds data (insert, upsert, drop modes) a half-restored
 * namespace is much harder to untangle. Paying one extra read of the selected data
 * up front turns that into a clean refusal.
 *
 * Metadata files, users and roles and a converge backup's changes file are already
 * read in full (integrity check included) by the regular pre-flight, so a damaged
 * one stops the restore before any write either way. The changes file is checked
 * here anyway when the caller passes it: it is cheap next to the data and keeps the
 * promise "every file the restore reads was verified" independent of how pre-flight
 * evolves.
 */

import { MongoShieldError } from "../errors.ts";
import type { StoredFile } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { VerifyProblem } from "../types.ts";
import { mapWithConcurrency } from "./pool.ts";
import { checkStoredFile, type StoredBackupSource } from "./read-pipeline.ts";

/** Files checksummed at the same time. Hashing is I/O-bound, like verify's. */
const VERIFY_FIRST_CONCURRENCY = 4;

/** Damaged files named in the error message; the rest are in `details.problems`. */
const MAX_PROBLEMS_IN_MESSAGE = 5;

/** What `verifyBeforeWriting` checks, and how. */
export interface VerifyFirstRequest {
  readonly source: Pick<StoredBackupSource, "storage" | "backupId">;
  /** Every stored file the restore will read, in any order. */
  readonly files: readonly StoredFile[];
  readonly logger: Logger;
  readonly signal: AbortSignal | undefined;
}

/** What the check found (only returned when every file is intact). */
export interface VerifyFirstResult {
  readonly filesChecked: number;
  readonly bytesChecked: number;
}

/**
 * Streams every file once and compares its size and SHA-256 with the manifest. No key
 * is needed: the stored bytes are hashed as they are.
 *
 * @throws MongoShieldError `MS_INTEGRITY_FAILED` listing every missing, truncated or
 *   modified file; storage access errors and `MS_ABORTED` unchanged.
 */
export async function verifyBeforeWriting(request: VerifyFirstRequest): Promise<VerifyFirstResult> {
  const files = uniqueFiles(request.files);
  request.logger.info("Verifying the backup files before writing (verifyFirst)", {
    files: files.length,
  });
  const checks = await mapWithConcurrency(
    files,
    (file, _index, signal) => checkStoredFile(request.source, file, { signal }),
    { concurrency: VERIFY_FIRST_CONCURRENCY, signal: request.signal },
  );

  const problems: VerifyProblem[] = [];
  let bytesChecked = 0;
  checks.forEach((check, index) => {
    bytesChecked += check.size;
    const file = files[index];
    if (!check.ok && file !== undefined)
      problems.push({ subject: file.key, problem: check.problem });
  });
  if (problems.length > 0) throw integrityFailure(request.source.backupId, problems);

  request.logger.info("Every backup file is intact", { files: files.length, bytes: bytesChecked });
  return { filesChecked: files.length, bytesChecked };
}

/** The same file listed twice (it should not be) is only read once. */
function uniqueFiles(files: readonly StoredFile[]): StoredFile[] {
  const byKey = new Map<string, StoredFile>();
  for (const file of files) byKey.set(file.key, file);
  return [...byKey.values()];
}

function integrityFailure(backupId: string, problems: readonly VerifyProblem[]): MongoShieldError {
  const listed = problems
    .slice(0, MAX_PROBLEMS_IN_MESSAGE)
    .map((problem) => `${problem.subject}: ${problem.problem}`)
    .join("; ");
  const more =
    problems.length > MAX_PROBLEMS_IN_MESSAGE
      ? ` (and ${problems.length - MAX_PROBLEMS_IN_MESSAGE} more)`
      : "";
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `Backup ${backupId} is damaged; nothing was written. ${problems.length} file(s) failed the check before restoring: ${listed}${more}.`,
    {
      hint: `Run \`mongoshield verify ${backupId}\` for the full report, and restore from another backup.`,
      details: { problems: problems.map((problem) => ({ ...problem })) },
    },
  );
}
