/**
 * The verify engine: checks that a stored backup is intact and restorable,
 * without touching any database.
 *
 *   fast  every file listed in the manifest (including a passphrase backup's key
 *         envelope) exists, with the recorded size and SHA-256. Streams the stored bytes; needs no key, so it can run on the
 *         backup server itself.
 *   deep  also decrypts and decompresses every data file, splits and parses every
 *         document, parses every metadata file, and compares the document counts
 *         with the manifest: what a restore would read, minus the writes. A converge
 *         backup's changes file is decoded event by event, and its event count, order
 *         and window are checked too.
 *
 * Problems are collected rather than thrown, so one run reports everything that is
 * wrong. Only a missing backup, a missing or non-matching key in deep mode, storage
 * access errors and aborts are thrown: those say nothing about the backup itself.
 */

import { BSON } from "mongodb";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import {
  type ChangesFile,
  isAuthzEntry,
  type Manifest,
  type NamespaceEntry,
  type StoredFile,
} from "../format/manifest.ts";
import { withEngineSpan } from "../telemetry/engine-spans.ts";
import { ATTRIBUTES, ENGINE_SPANS } from "../telemetry/names.ts";
import type { VerifyMode, VerifyOptions, VerifyProblem, VerifyReport } from "../types.ts";
import type { VerifyContext } from "./context.ts";
import { readChangeEvents } from "./converge-events.ts";
import { compareClusterTimes, formatClusterTime } from "./converge-time.ts";
import { mapWithConcurrency } from "./pool.ts";
import { ProgressTracker } from "./progress.ts";
import {
  checkStoredFile,
  openBackupSource,
  openDocumentStream,
  readMetadataFile,
  type StoredBackupSource,
  sourceFromManifest,
} from "./read-pipeline.ts";

/** Namespaces checked at the same time. Verification is I/O-bound. */
const VERIFY_CONCURRENCY = 4;

/** Error code on a namespace span whose files had problems (as on the verify span). */
const PROBLEMS_FOUND = "MS_INTEGRITY_FAILED";

/** Running totals of a verification. */
interface VerifyTotals {
  filesChecked: number;
  bytesChecked: number;
  documentsChecked: number;
  readonly problems: VerifyProblem[];
}

/** Shared state of one verify run. */
interface VerifyRun {
  readonly mode: VerifyMode;
  readonly source: StoredBackupSource;
  readonly totals: VerifyTotals;
  readonly tracker: ProgressTracker;
  readonly signal: AbortSignal | undefined;
}

/**
 * Verifies a backup and returns a report of every problem found.
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` / `MS_MANIFEST_INVALID` when the backup
 *   cannot be selected, `MS_NO_IDENTITY` in deep mode when the backup is encrypted and
 *   no matching key was given, storage access errors, and `MS_ABORTED`.
 */
export async function verifyBackup(
  context: VerifyContext,
  options: VerifyOptions,
): Promise<VerifyReport> {
  const startedAt = performance.now();
  const mode = options.mode ?? "fast";
  const manifest = await loadManifest(context, options);
  const totals: VerifyTotals = {
    filesChecked: 0,
    bytesChecked: 0,
    documentsChecked: 0,
    problems: [],
  };

  // Deep mode needs the keys (for passphrase backups: the unlocked key envelope).
  // If the envelope itself is damaged, nothing can be decrypted, so the rest of the
  // run falls back to checksum checks, which still find every other damaged file.
  const deepSource =
    mode === "deep" ? await openForDeepVerify(context, manifest, options, totals) : undefined;
  const run: VerifyRun = {
    mode: deepSource === undefined ? "fast" : "deep",
    source: deepSource ?? sourceFromManifest(context.storage, manifest, options.decryption),
    totals,
    tracker: new ProgressTracker({ onProgress: options.onProgress, logger: context.logger }),
    signal: options.signal,
  };
  context.logger.info("Verifying backup", { backupId: manifest.id, mode });

  checkTotals(manifest, run.totals.problems);
  // Fast mode checks the key envelope like any other file (deep mode just read it).
  const keyFile = manifest.encryption?.keyFile;
  if (mode === "fast" && keyFile !== undefined) {
    await checkFileFast(run, keyFile);
  }
  await mapWithConcurrency(
    manifest.namespaces,
    (entry) => verifyNamespaceInSpan(context, run, entry),
    { concurrency: VERIFY_CONCURRENCY, signal: options.signal },
  );
  if (manifest.changes !== undefined) {
    if (run.mode === "fast") await checkFileFast(run, manifest.changes);
    else await checkChangesDeep(run, manifest, manifest.changes);
  }
  run.tracker.finish();

  const report: VerifyReport = {
    backupId: manifest.id,
    mode,
    ok: totals.problems.length === 0,
    filesChecked: totals.filesChecked,
    bytesChecked: totals.bytesChecked,
    documentsChecked: totals.documentsChecked,
    problems: totals.problems,
    durationMs: Math.round(performance.now() - startedAt),
  };
  context.logger.info("Verification finished", {
    backupId: manifest.id,
    ok: report.ok,
    problems: report.problems.length,
  });
  return report;
}

/**
 * Opens the backup for deep verification. For passphrase backups this unlocks the
 * key envelope, which counts as one checked file. Returns `undefined` (with the
 * problem recorded) when the envelope is missing or damaged; key problems such as a
 * wrong passphrase are thrown, like for any other file.
 */
async function openForDeepVerify(
  context: VerifyContext,
  manifest: Manifest,
  options: VerifyOptions,
  totals: VerifyTotals,
): Promise<StoredBackupSource | undefined> {
  const keyFile = manifest.encryption?.keyFile;
  try {
    const source = await openBackupSource(context.storage, manifest, options.decryption, {
      signal: options.signal,
    });
    if (keyFile !== undefined) {
      totals.filesChecked += 1;
      totals.bytesChecked += keyFile.size;
    }
    return source;
  } catch (error) {
    if (keyFile === undefined) throw error;
    recordReadFailure({ totals }, keyFile.key, error);
    totals.filesChecked += 1;
    totals.problems.push({
      subject: keyFile.key,
      problem:
        "Without the key file nothing can be decrypted; the other files were only checked against their checksums.",
    });
    return undefined;
  }
}

async function loadManifest(context: VerifyContext, options: VerifyOptions): Promise<Manifest> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const selected = selectBackup(entries, options.backup);
  if (selected.manifest === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }
  return selected.manifest;
}

/** The manifest's totals must add up; a mismatch means it was edited or mis-written. */
function checkTotals(manifest: Manifest, problems: VerifyProblem[]): void {
  let documents = 0;
  for (const entry of manifest.namespaces) documents += entry.documents;
  if (manifest.totals.documents !== documents) {
    problems.push({
      subject: "manifest.json",
      problem: `totals.documents is ${manifest.totals.documents}, but the namespaces add up to ${documents}.`,
    });
  }
  if (manifest.totals.namespaces !== manifest.namespaces.length) {
    problems.push({
      subject: "manifest.json",
      problem: `totals.namespaces is ${manifest.totals.namespaces}, but ${manifest.namespaces.length} namespaces are listed.`,
    });
  }
}

/**
 * `verifyNamespace` inside a `mongoshield.verify.namespace` span. Problems are
 * collected, not thrown, so a namespace with problems marks its span failed
 * explicitly: alerts on failed spans then point at the damaged collection.
 */
function verifyNamespaceInSpan(
  context: VerifyContext,
  run: VerifyRun,
  entry: NamespaceEntry,
): Promise<void> {
  return withEngineSpan(
    context.telemetry,
    ENGINE_SPANS.verifyNamespace,
    (telemetry) => telemetry.namespaceAttributes(entry.ns),
    async (span) => {
      // Namespaces run concurrently and share one problem list, so count this
      // namespace's problems by their subject (its file keys) afterwards.
      await verifyNamespace(run, entry);
      const problems = problemsOf(run.totals.problems, entry);
      span.setAttributes({ [ATTRIBUTES.problems]: problems });
      if (problems > 0) span.fail(PROBLEMS_FOUND);
    },
  );
}

/** How many of `problems` are about `entry`'s files or the namespace itself. */
function problemsOf(problems: readonly VerifyProblem[], entry: NamespaceEntry): number {
  const subjects = new Set<string>([entry.ns, entry.metadata.key]);
  for (const file of entry.files) subjects.add(file.key);
  let count = 0;
  for (const problem of problems) {
    if (subjects.has(problem.subject)) count += 1;
  }
  return count;
}

/** Checks one namespace's metadata and data files. */
async function verifyNamespace(run: VerifyRun, entry: NamespaceEntry): Promise<void> {
  throwIfAborted(run.signal);
  run.tracker.startNamespace(entry.ns, entry.documents);
  if (run.mode === "fast") {
    for (const file of [entry.metadata, ...entry.files]) await checkFileFast(run, file);
    run.tracker.finishNamespace(entry.ns, 0, 0);
    return;
  }

  await checkMetadataDeep(run, entry);
  let documents = 0;
  let readable = true;
  for (const file of entry.files) {
    const result = await checkDataFileDeep(run, entry, file, documents);
    documents = result.documents;
    readable = readable && result.ok;
  }
  // A count is only meaningful when every part could be read to the end.
  if (readable && documents !== entry.documents) {
    addProblem(
      run,
      entry.ns,
      `The data files hold ${documents} documents, but the manifest records ${entry.documents}.`,
    );
  }
  run.tracker.finishNamespace(entry.ns, documents, 0);
}

/** Fast mode: existence, size and checksum. */
async function checkFileFast(run: VerifyRun, file: StoredFile): Promise<void> {
  const check = await checkStoredFile(run.source, file, { signal: run.signal });
  run.totals.filesChecked += 1;
  run.totals.bytesChecked += check.size;
  if (!check.ok) addProblem(run, file.key, check.problem);
}

/** Deep mode: decrypt and parse the metadata, and check it describes this namespace. */
async function checkMetadataDeep(run: VerifyRun, entry: NamespaceEntry): Promise<void> {
  run.totals.filesChecked += 1;
  try {
    const metadata = await readMetadataFile(run.source, entry.metadata, { signal: run.signal });
    run.totals.bytesChecked += entry.metadata.size;
    // Users and roles entries carry a plain mongodump-style metadata file of type
    // "collection" (see FORMAT.md), so that is what their file must say.
    const expectedType = isAuthzEntry(entry) ? "collection" : entry.type;
    if (metadata.collectionName !== entry.collection || metadata.type !== expectedType) {
      addProblem(
        run,
        entry.metadata.key,
        `It describes ${metadata.type} "${metadata.collectionName}", but the manifest lists ${entry.type} "${entry.collection}".`,
      );
    }
  } catch (error) {
    recordReadFailure(run, entry.metadata.key, error);
  }
}

/**
 * Deep mode: reads one data part through the whole restore pipeline and parses
 * every document. Returns the running document count and whether the part was
 * read completely.
 */
async function checkDataFileDeep(
  run: VerifyRun,
  entry: NamespaceEntry,
  file: StoredFile,
  documentsBefore: number,
): Promise<{ readonly ok: boolean; readonly documents: number }> {
  run.totals.filesChecked += 1;
  let documents = documentsBefore;
  try {
    for await (const raw of openDocumentStream(run.source, file, { signal: run.signal })) {
      parseDocument(raw as Buffer, file, documents - documentsBefore);
      documents += 1;
      run.totals.documentsChecked += 1;
      run.tracker.updateNamespace(entry.ns, documents, 0);
    }
    run.totals.bytesChecked += file.size;
    return { ok: true, documents };
  } catch (error) {
    recordReadFailure(run, file.key, error);
    return { ok: false, documents };
  }
}

/**
 * Deep mode for a converge backup's changes file: decodes every event (as restore's
 * replay would), and checks the count against the manifest and that the events are
 * in cluster-time order inside the window `consistency.from`…`to`.
 */
async function checkChangesDeep(
  run: VerifyRun,
  manifest: Manifest,
  file: ChangesFile,
): Promise<void> {
  run.totals.filesChecked += 1;
  const { from, to } = manifest.consistency;
  let events = 0;
  let previous = from;
  let orderProblem: string | undefined;
  try {
    for await (const { event } of readChangeEvents(run.source, file, run.signal)) {
      events += 1;
      const time = event.clusterTime;
      if (
        orderProblem === undefined &&
        previous !== undefined &&
        compareClusterTimes(time, previous) < 0
      ) {
        orderProblem = `Event #${events} (${formatClusterTime(time)}) is earlier than the one before it or the start of the window.`;
      }
      if (orderProblem === undefined && to !== undefined && compareClusterTimes(time, to) > 0) {
        orderProblem = `Event #${events} (${formatClusterTime(time)}) is after the end of the window (${formatClusterTime(to)}).`;
      }
      previous = time;
    }
    run.totals.bytesChecked += file.size;
  } catch (error) {
    recordReadFailure(run, file.key, error);
    return;
  }
  if (orderProblem !== undefined) addProblem(run, file.key, orderProblem);
  if (events !== file.events) {
    addProblem(
      run,
      file.key,
      `The changes file holds ${events} events, but the manifest records ${file.events}.`,
    );
  }
}

/** Parses a document exactly as restore would; failures name the document. */
function parseDocument(raw: Buffer, file: StoredFile, indexInFile: number): void {
  try {
    BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS);
  } catch (error) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `Document #${indexInFile + 1} of ${file.key} is not valid BSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Records a read failure as a problem, or rethrows it when it says nothing about the
 * backup: aborts, storage access errors other than a missing file, and key problems
 * (no matching identity, or a passphrase that does not open a file whose checksum is
 * fine; the read pipeline has already turned modified files into MS_INTEGRITY_FAILED).
 */
function recordReadFailure(run: Pick<VerifyRun, "totals">, subject: string, error: unknown): void {
  if (!isMongoShieldError(error)) throw error;
  const isKeyProblem =
    error.code === "MS_NO_IDENTITY" ||
    (error.code === "MS_DECRYPTION_FAILED" && error.details?.stage === "unwrap");
  const isBackupProblem =
    error.code === "MS_STORAGE_NOT_FOUND" ||
    error.code === "MS_INTEGRITY_FAILED" ||
    error.code === "MS_DECRYPTION_FAILED" ||
    error.code === "MS_FORMAT_UNSUPPORTED";
  if (isKeyProblem || !isBackupProblem) throw error;

  const problem =
    error.code === "MS_STORAGE_NOT_FOUND" ? "The file is missing from storage." : error.message;
  addProblem(run, subject, problem);
}

function addProblem(run: Pick<VerifyRun, "totals">, subject: string, problem: string): void {
  run.totals.problems.push({ subject, problem });
}
