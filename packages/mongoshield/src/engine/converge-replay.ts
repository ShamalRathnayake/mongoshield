/**
 * Replaying a converge backup's change events into the restore target, after the
 * documents are loaded and before secondary indexes are built
 * (docs/specs/CONSISTENCY.md, "Restore").
 *
 *   changes file → events in order → step per event (converge-operations.ts)
 *     → document writes queued per target namespace, flushed as ordered bulkWrites
 *     → DDL (create, drop, rename) applied in place, after flushing what it affects
 *
 * Ordering: events are replayed in the order they happened. Writes to different
 * namespaces are independent, so each namespace has its own queue; within a namespace
 * a queue is one ordered bulkWrite, which keeps the order of the events of every
 * document. A DDL event first flushes the queues of the namespaces it touches.
 *
 * Why some write errors are tolerated: a document may have been dumped in a later
 * state than the one an event was made against (that is the point of replaying). An
 * update to `a.5.x` may then meet an `a` that is no longer an array of six documents
 * and fail with "path not viable". The event that changed `a` comes later in the
 * window and sets `a` absolutely, so skipping the failed update loses nothing.
 * Only these path errors on updates are skipped; every other error fails the restore.
 *
 * Drops: a dropped collection is emptied rather than dropped, so its restored options
 * survive in case it is created again later in the window; collections still dropped
 * at the end of the window are dropped for real at the end of the replay.
 */

import {
  type AnyBulkWriteOperation,
  type Collection,
  MongoBulkWriteError,
  type MongoClient,
  MongoServerError,
  type WriteConcernSettings,
  type WriteError,
} from "mongodb";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import type { ClusterTime, StoredFile } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { splitNamespace } from "../mongo/index.ts";
import { needsFullDocument, readChangeEvents, type StoredChangeEvent } from "./converge-events.ts";
import { type ReplayStep, replayStepFor } from "./converge-operations.ts";
import type { ReplayTargets } from "./converge-targets.ts";
import { compareClusterTimes } from "./converge-time.ts";
import type { ProgressTracker } from "./progress.ts";
import type { StoredBackupSource } from "./read-pipeline.ts";
import { commandWriteConcern, createNamespace, dropNamespace } from "./restore-collections.ts";
import { type BatchLimits, DEFAULT_BATCH_LIMITS } from "./restore-documents.ts";

/** How the replay shows up in progress events (it is not a namespace). */
export const REPLAY_PROGRESS_LABEL = "(changes during the backup)";

/**
 * Server error codes of updates whose path no longer fits the document (see the file
 * header): BadValue (`$push` to a field that is no longer an array), TypeMismatch, and
 * PathNotViable (`$set` through a field that is no longer a document or array).
 */
const TOLERATED_UPDATE_ERROR_CODES = new Set([2, 14, 28]);

/** NamespaceExists: `create` of a collection the restore already created. */
const NAMESPACE_EXISTS_CODE = 48;

/** NamespaceNotFound: e.g. renaming a collection that does not exist. */
const NAMESPACE_NOT_FOUND_CODE = 26;

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Everything `replayChanges` needs. */
export interface ReplayRequest {
  readonly client: MongoClient;
  readonly logger: Logger;
  readonly source: StoredBackupSource;
  readonly file: StoredFile;
  /** `consistency.to`: events after it are skipped (the capture already drops them). */
  readonly until: ClusterTime | undefined;
  readonly targets: ReplayTargets;
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly bypassDocumentValidation: boolean;
  readonly tracker: ProgressTracker;
  /** Number of events, from the pre-flight scan, for progress. */
  readonly expectedEvents: number;
  readonly signal: AbortSignal | undefined;
  readonly batchLimits?: BatchLimits | undefined;
}

/**
 * `replayChangeEvents`' request: like {@link ReplayRequest}, but the events come from
 * any ordered source instead of a backup's changes file. Point-in-time recovery uses it
 * to replay journal segments (src/journal/replay.ts) with exactly the same rules.
 */
export interface ReplayEventsRequest extends Omit<ReplayRequest, "source" | "file"> {
  /** The events, in cluster-time order, with their raw bytes. */
  readonly events: AsyncIterable<StoredChangeEvent>;
  /** How the replay shows up in progress events. Defaults to {@link REPLAY_PROGRESS_LABEL}. */
  readonly progressLabel?: string | undefined;
}

/** What a replay did. */
export interface ReplayResult {
  /** Events read from the file. */
  readonly events: number;
  /** Events that changed something (document writes and DDL). */
  readonly applied: number;
  /** Events skipped: other namespaces, ignored event types, past the window. */
  readonly skipped: number;
  /** Updates skipped because their path no longer fit (see the file header). */
  readonly toleratedErrors: number;
  /** Target namespaces that no longer exist after the replay (dropped or renamed away). */
  readonly removedTargets: ReadonlySet<string>;
  /** Things the user should know, also logged as warnings. */
  readonly warnings: readonly string[];
}

/**
 * Replays every event of the changes file into the target.
 *
 * @throws MongoShieldError `MS_RESTORE_FAILED` for write failures, `MS_PERMISSION_DENIED`
 *   when the server refuses a write, read-pipeline errors for a damaged file,
 *   `MS_ABORTED` when the signal fires.
 */
export async function replayChanges(request: ReplayRequest): Promise<ReplayResult> {
  const { source, file, ...rest } = request;
  return replayChangeEvents({ ...rest, events: readChangeEvents(source, file, request.signal) });
}

/**
 * Replays events from any ordered source (see {@link ReplayEventsRequest}) with the
 * rules of {@link replayChanges}.
 *
 * @throws as {@link replayChanges}, plus whatever the event source throws.
 */
export async function replayChangeEvents(request: ReplayEventsRequest): Promise<ReplayResult> {
  const replayer = new Replayer(request);
  return replayer.run();
}

/** A queue of writes for one target namespace. */
interface PendingWrites {
  operations: AnyBulkWriteOperation[];
  bytes: number;
}

/** One replay run. */
class Replayer {
  readonly #request: ReplayEventsRequest;
  readonly #label: string;
  readonly #limits: BatchLimits;
  readonly #pending = new Map<string, PendingWrites>();
  /** Targets emptied by a drop and not created again (yet). */
  readonly #dropped = new Set<string>();
  readonly #removed = new Set<string>();
  readonly #warnings: string[] = [];
  #events = 0;
  #applied = 0;
  #skipped = 0;
  #tolerated = 0;
  #bytes = 0;

  constructor(request: ReplayEventsRequest) {
    this.#request = request;
    this.#label = request.progressLabel ?? REPLAY_PROGRESS_LABEL;
    this.#limits = request.batchLimits ?? DEFAULT_BATCH_LIMITS;
  }

  async run(): Promise<ReplayResult> {
    const { tracker, until, signal } = this.#request;
    tracker.startNamespace(this.#label, this.#request.expectedEvents);

    for await (const { raw, event } of this.#request.events) {
      throwIfAborted(signal);
      this.#events += 1;
      this.#bytes += raw.length;
      if (until !== undefined && compareClusterTimes(event.clusterTime, until) > 0) {
        this.#skipped += 1;
        continue;
      }
      if (needsFullDocument(event)) {
        // The capture could not record this update in a replayable form (see
        // converge-capture.ts); the backup's manifest carries a warning about it.
        this.#skipped += 1;
        this.#warn(
          "Skipped updates to field names containing dots or starting with $ that the backup could not record.",
        );
        continue;
      }
      await this.#apply(replayStepFor(event), raw.length);
      tracker.updateNamespace(this.#label, this.#events, this.#bytes);
    }

    await this.#flushAll();
    for (const target of this.#dropped) {
      await this.#ddl(target, "Dropping", () => this.#dropTarget(target));
      this.#removed.add(target);
    }
    tracker.finishNamespace(this.#label, this.#events, this.#bytes);
    this.#request.logger.info("Replayed the changes made during the backup", {
      events: this.#events,
      applied: this.#applied,
      skipped: this.#skipped,
      toleratedErrors: this.#tolerated,
    });
    return {
      events: this.#events,
      applied: this.#applied,
      skipped: this.#skipped,
      toleratedErrors: this.#tolerated,
      removedTargets: this.#removed,
      warnings: this.#warnings,
    };
  }

  /** Applies (or queues) one step. */
  async #apply(step: ReplayStep, bytes: number): Promise<void> {
    switch (step.kind) {
      case "write":
        return this.#queueWrites(step.ns, step.operations, bytes);
      case "create":
        return this.#create(step.ns, step.options);
      case "drop":
        return this.#drop(step.ns);
      case "dropDatabase":
        for (const ns of this.#request.targets.sourcesInDatabase(step.db)) await this.#drop(ns);
        this.#applied += 1;
        return;
      case "rename":
        return this.#rename(step.from, step.to);
      case "ignore":
        this.#skipped += 1;
        this.#request.logger.debug("Change event not replayed", { reason: step.reason });
        return;
    }
  }

  async #queueWrites(
    ns: string,
    operations: AnyBulkWriteOperation[],
    bytes: number,
  ): Promise<void> {
    const target = this.#request.targets.targetOf(ns);
    if (target === undefined) {
      this.#skipped += 1;
      return;
    }
    this.#markExists(target);
    const pending = this.#pending.get(target) ?? { operations: [], bytes: 0 };
    pending.operations.push(...operations);
    pending.bytes += bytes;
    this.#pending.set(target, pending);
    this.#applied += 1;
    const full =
      pending.operations.length >= this.#limits.maxDocuments ||
      pending.bytes >= this.#limits.maxBytes;
    if (full) await this.#flush(target);
  }

  /** A collection created during the window: create it with its options unless it exists. */
  async #create(ns: string, options: Record<string, unknown>): Promise<void> {
    const target = this.#request.targets.targetOf(ns);
    if (target === undefined) {
      this.#skipped += 1;
      return;
    }
    this.#markExists(target);
    this.#applied += 1;
    const { database, collection } = splitNamespace(target);
    await this.#ddl(target, "Creating", async () => {
      try {
        await createNamespace(
          this.#request.client.db(database),
          collection,
          options,
          this.#request.writeConcern,
        );
      } catch (error) {
        // The restore created it already (it was in the backup), or an earlier event did.
        if (error instanceof MongoServerError && error.code === NAMESPACE_EXISTS_CODE) return;
        throw error;
      }
    });
  }

  /** Empties the target; it is dropped at the end unless something creates it again. */
  async #drop(ns: string): Promise<void> {
    const target = this.#request.targets.targetOf(ns);
    if (target === undefined) {
      this.#skipped += 1;
      return;
    }
    await this.#flush(target);
    await this.#ddl(target, "Emptying", async () => {
      await this.#collection(target).deleteMany({}, this.#writeOptions());
    });
    this.#dropped.add(target);
    this.#applied += 1;
  }

  /**
   * `from` becomes `to`, replacing whatever `to` held (the backup checked that `from`
   * is complete as of the rename; see converge-capture.ts). A rename out of the
   * restored namespaces is a drop; a rename into them from a namespace this restore
   * does not write cannot be reproduced, which is reported.
   */
  async #rename(from: string, to: string): Promise<void> {
    const { targetOf } = this.#request.targets;
    const fromTarget = targetOf(from);
    const toTarget = targetOf(to);
    if (fromTarget === undefined && toTarget === undefined) {
      this.#skipped += 1;
      return;
    }
    if (toTarget === undefined) return this.#drop(from);
    if (fromTarget === undefined) {
      this.#skipped += 1;
      this.#warn(
        `${toTarget} keeps its restored documents: it was replaced during the backup by ${from}, which this restore does not include.`,
      );
      return;
    }
    if (fromTarget === toTarget) return;

    await this.#flush(fromTarget);
    await this.#flush(toTarget);
    await this.#ddl(fromTarget, "Renaming", async () => {
      try {
        await this.#request.client.db("admin").command({
          renameCollection: fromTarget,
          to: toTarget,
          dropTarget: true,
          ...commandWriteConcern(this.#request.writeConcern),
        });
      } catch (error) {
        if (!(error instanceof MongoServerError && error.code === NAMESPACE_NOT_FOUND_CODE)) {
          throw error;
        }
        // Expected when the backup did not hold the source: it then recorded the
        // destination as of the rename (synthesized events right after this one).
        this.#request.logger.debug("Rename source missing in the target", { from, to });
      }
    });
    this.#dropped.delete(fromTarget);
    this.#removed.add(fromTarget);
    this.#markExists(toTarget);
    this.#applied += 1;
  }

  #markExists(target: string): void {
    this.#dropped.delete(target);
    this.#removed.delete(target);
  }

  async #flushAll(): Promise<void> {
    for (const target of [...this.#pending.keys()]) await this.#flush(target);
  }

  /**
   * Writes a target's queue as one ordered bulkWrite. An update that fails with a
   * tolerated path error is skipped and the rest of the queue continues after it.
   */
  async #flush(target: string): Promise<void> {
    const pending = this.#pending.get(target);
    this.#pending.delete(target);
    let operations = pending?.operations ?? [];
    while (operations.length > 0) {
      throwIfAborted(this.#request.signal);
      try {
        await this.#collection(target).bulkWrite(operations, {
          ...this.#writeOptions(),
          ordered: true,
          bypassDocumentValidation: this.#request.bypassDocumentValidation,
        });
        return;
      } catch (error) {
        const failedIndex = toleratedFailureIndex(error, operations);
        if (failedIndex === undefined) throw toReplayError(target, error);
        this.#tolerated += 1;
        this.#request.logger.debug("Skipped an update whose path no longer fits the document", {
          ns: target,
          error: error instanceof Error ? error.message : String(error),
        });
        operations = operations.slice(failedIndex + 1);
      }
    }
  }

  async #dropTarget(target: string): Promise<void> {
    const { database, collection } = splitNamespace(target);
    await dropNamespace(this.#request.client.db(database), collection, this.#request.writeConcern);
  }

  /** Runs a DDL step, naming the target in errors. */
  async #ddl(target: string, step: string, action: () => Promise<void>): Promise<void> {
    throwIfAborted(this.#request.signal);
    try {
      await action();
    } catch (error) {
      throw toReplayError(target, error, step);
    }
  }

  #collection(target: string): Collection {
    const { database, collection } = splitNamespace(target);
    return this.#request.client.db(database).collection(collection);
  }

  #writeOptions(): { writeConcern?: WriteConcernSettings } {
    const { writeConcern } = this.#request;
    return writeConcern === undefined ? {} : { writeConcern };
  }

  #warn(warning: string): void {
    if (this.#warnings.includes(warning)) return;
    this.#warnings.push(warning);
    this.#request.logger.warn(warning);
  }
}

/**
 * For an ordered bulkWrite that stopped at a tolerated update error (see the file
 * header), the index of that update; otherwise `undefined`.
 */
function toleratedFailureIndex(
  error: unknown,
  operations: readonly AnyBulkWriteOperation[],
): number | undefined {
  if (!(error instanceof MongoBulkWriteError)) return undefined;
  if (error.result.getWriteConcernError() !== undefined) return undefined;
  const [first, ...others] = asArray(error.writeErrors);
  if (first === undefined || others.length > 0) return undefined;
  if (!TOLERATED_UPDATE_ERROR_CODES.has(first.code)) return undefined;
  const operation = operations[first.index];
  return operation !== undefined && "updateOne" in operation ? first.index : undefined;
}

/** The driver reports one write error as an object and several as an array. */
function asArray(errors: WriteError | readonly WriteError[]): readonly WriteError[] {
  return isWriteErrorList(errors) ? errors : [errors];
}

function isWriteErrorList(
  errors: WriteError | readonly WriteError[],
): errors is readonly WriteError[] {
  return Array.isArray(errors);
}

/** Turns a replay failure into a MongoShieldError that names the target. */
function toReplayError(target: string, error: unknown, step = "Replaying changes into"): unknown {
  if (isMongoShieldError(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `${step} ${target} was refused: ${reason}`,
      {
        cause: error,
        hint: "Replaying a converge backup needs insert, update, remove and renameCollection: grant readWrite plus restore on the targets.",
      },
    );
  }
  return new MongoShieldError("MS_RESTORE_FAILED", `${step} ${target} failed: ${reason}`, {
    cause: error,
    hint: "The target may be partially restored. Fix the cause and restore again with --drop.",
  });
}
