/**
 * The journal writer (docs/specs/JOURNAL.md, "The writer"): a long-running loop that
 * records every change of the deployment into segments, so a restore can stop at any
 * moment after a base backup.
 *
 *   lease ─▶ resume after the last committed segment (state.json, then gap records)
 *     ─▶ open the change stream after that point
 *     ─▶ segment: header ─▶ events… ─▶ trailer      streamed: getMore → compress →
 *                                                   (encrypt) → digest → storage.put
 *     ─▶ commit: rewrite state.json (the segment now counts)
 *     ─▶ next segment … until stop()
 *
 * Segment boundaries. A segment is closed once it is `segmentSeconds` old or holds
 * `segmentBytes`, and on stop. It may only end at a cluster time T such that every
 * event up to T is in it and none after T, so the next segment can start exactly at
 * T. Two moments give such a T (see change-stream.ts):
 *   - an event with a LATER cluster time than the previous one arrives: T is the
 *     previous one (the events of one transaction share a cluster time and are never
 *     split);
 *   - an empty batch reports the stream's position P: T is P.
 * The second is what makes an idle database still produce a segment every interval
 * (header and trailer only), so the recovery point keeps moving forward.
 *
 * Failures. Anything transient (network, storage) abandons the open segment (its
 * upload is discarded) and the writer starts again from the last commit, waiting
 * 1 s, 2 s, 4 s … up to a minute between attempts. Lost history (the oplog no longer
 * reaches the last commit) is a GAP: it is recorded in `journal/gaps/`, alerted, and
 * either a new base backup is taken while the journal continues from "now"
 * (`onGap: "backup"`) or the writer stops (`onGap: "fail"`). Missing privileges, bad
 * settings or a lost lease stop the writer.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { MongoClient } from "mongodb";
import { createCompressor, defaultCompression } from "../compression/index.ts";
import { createCoalescer } from "../engine/backup-coalesce.ts";
import { writeStoredFile } from "../engine/backup-write.ts";
import {
  compareClusterTimes,
  formatClusterTime,
  readClusterTime,
} from "../engine/converge-time.ts";
import { type ErrorCode, isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { ClusterTime, Compression } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { type NotifyRunOptions, notifyRun, pingHeartbeat } from "../notify/index.ts";
import { createLockOwner, type Lease } from "../schedule/lock.ts";
import { storageLock } from "../schedule/lock-storage.ts";
import { RUN_REPORT_VERSION, type RunReport } from "../schedule/report.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { EncryptionOptions, NamespacePattern } from "../types.ts";
import {
  createJournalScope,
  type JournalScope,
  openDestinationSnapshot,
  storedEventBytes,
} from "./capture.ts";
import { isHistoryLost, JournalChangeStream } from "./change-stream.ts";
import { loadJournalCoverage } from "./coverage.ts";
import { JOURNAL_LOCK_NAME, segmentKey } from "./layout.ts";
import { listBaseBackups } from "./plan.ts";
import {
  type CommittedSegment,
  encodeSegmentHeader,
  encodeSegmentTrailer,
  type GapRecord,
  JOURNAL_FORMAT_VERSION,
  type JournalState,
  writeGapRecord,
  writeJournalState,
} from "./records.ts";
import { planSegmentEncryption, type SegmentEncryptor } from "./segment-crypto.ts";
import { isAfter, laterOf } from "./time.ts";

/** Default segment length: the RPO is normally under one segment. */
export const DEFAULT_SEGMENT_SECONDS = 300;

/** Default segment size limit: 64 MiB of raw change events. */
export const DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024;

/**
 * Default writer lease. Short (unlike the scheduler's five minutes), because a
 * crashed writer blocks its replacement for this long, and every second without a
 * writer is RPO. Renewed every third of it.
 */
export const DEFAULT_JOURNAL_LEASE_MS = 60_000;

/** First wait before retrying after a transient failure; doubles up to the maximum. */
export const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60_000;

/** How often a writer started with `waitForLease` asks for the lease again. */
const LEASE_POLL_MS = 5000;

/** Content type of segments (BSON, compressed and maybe encrypted). */
const SEGMENT_CONTENT_TYPE = "application/octet-stream";

/**
 * Errors that retrying cannot fix: the writer stops with them. Everything else
 * (connection drops, storage hiccups) is retried from the last commit.
 */
const FATAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "MS_CONFIG_INVALID",
  "MS_PERMISSION_DENIED",
  "MS_AUTH_FAILED",
  "MS_UNSUPPORTED_TOPOLOGY",
  "MS_ENCRYPTION_FAILED",
  "MS_STORAGE_FORBIDDEN",
  "MS_STORAGE_PRECONDITION_FAILED",
  "MS_FORMAT_UNSUPPORTED",
  "MS_MANIFEST_INVALID",
  "MS_ABORTED",
]);

/** What `startJournal` needs. */
export interface JournalOptions {
  /** Connected client for the deployment to journal. Not closed by the writer. */
  readonly client: MongoClient;
  /** The same storage as the base backups: the journal lives under `journal/`. */
  readonly storage: StorageAdapter;
  /** Recipients and/or KMS keys (no passphrase; see segment-crypto.ts). Omit for none. */
  readonly encryption?: EncryptionOptions | undefined;
  /** Defaults to zstd (or gzip where zstd is unavailable). */
  readonly compression?: Compression | undefined;
  /** Namespaces to journal; defaults to every user namespace. Base backups must cover them. */
  readonly include?: readonly NamespacePattern[] | undefined;
  readonly exclude?: readonly NamespacePattern[] | undefined;
  /** Close a segment after this many seconds (default 300): the normal worst-case RPO. */
  readonly segmentSeconds?: number | undefined;
  /** …or once it holds this many bytes of events (default 64 MiB). */
  readonly segmentBytes?: number | undefined;
  /**
   * What to do when history is lost. `"backup"` (the default when `takeBaseBackup` is
   * given) records the gap, alerts, takes a base backup and keeps journaling;
   * `"fail"` (the default otherwise) records the gap, alerts and stops the writer.
   */
  readonly onGap?: "backup" | "fail" | undefined;
  /**
   * Takes a new base backup (a converge or snapshot backup into the same storage). The
   * writer calls it after a gap; `MongoShield` passes `shield.backup({ consistency:
   * "converge" })`. Injected so the journal does not depend on the backup engine.
   */
  readonly takeBaseBackup?: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  /**
   * Alerts: gaps are sent to `targets` as failures (and ping the heartbeat's `/fail`);
   * every committed segment pings `heartbeat`, so a stalled writer raises an alarm.
   */
  readonly notify?: NotifyRunOptions | undefined;
  readonly logger?: Logger | undefined;
  /** Aborting it stops the writer at once, discarding the open segment. Prefer `stop()`. */
  readonly signal?: AbortSignal | undefined;
  /** Writer lease length (default 60 s). */
  readonly leaseMs?: number | undefined;
  /** Wait for another writer's lease to end instead of failing (e.g. rolling updates). */
  readonly waitForLease?: boolean | undefined;
  /** First retry delay after a transient failure (default 1 s; doubles up to 1 min). */
  readonly retryDelayMs?: number | undefined;
  /** Called after each committed segment (metrics, tests). Must not throw. */
  readonly onSegment?: ((segment: CommittedSegment) => void) | undefined;
}

/** What a running writer reports. */
export interface JournalWriterStatus {
  readonly running: boolean;
  /** Every change up to here is committed; `undefined` before the first segment. */
  readonly recoveryPoint: ClusterTime | undefined;
  /** How far the recovery point is behind the clock, in milliseconds. */
  readonly rpoMs: number | undefined;
  /** Segments, events and stored bytes committed by this writer run. */
  readonly segmentsWritten: number;
  readonly eventsWritten: number;
  readonly bytesWritten: number;
  /** Events per second over this run. */
  readonly eventsPerSecond: number;
  /** How long the last segment took from closing to committed (upload end + state). */
  readonly lastSegmentLatencyMs: number | undefined;
  /** Gaps detected by this run. */
  readonly gaps: number;
  /** The last transient failure, while the writer is retrying. */
  readonly lastError: string | undefined;
  /** Why the writer stopped, if it failed. */
  readonly failure: MongoShieldError | undefined;
}

/** A running journal writer. */
export interface JournalHandle {
  /** A snapshot of the writer's progress. */
  status(): JournalWriterStatus;
  /**
   * Stops gracefully: closes and commits the open segment, releases the lease.
   * Resolves when the writer has stopped; rejects if that last segment failed.
   */
  stop(): Promise<void>;
  /** Settles when the writer stops; rejects with the error that stopped it. */
  readonly done: Promise<void>;
}

/**
 * Starts the journal writer. Returns once the writer holds the lease and knows where to
 * resume; journaling then runs in the background until `stop()`.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for bad options (or storage without
 *   conditional writes), `MS_STORAGE_PRECONDITION_FAILED` when another writer holds the
 *   lease (unless `waitForLease`), storage errors while reading the journal state.
 */
export async function startJournal(options: JournalOptions): Promise<JournalHandle> {
  const settings = resolveSettings(options);
  const lease = await acquireLease(settings);
  try {
    const writer = new JournalWriter(settings, lease);
    await writer.prepare();
    return writer.start();
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Settings and lease
// ---------------------------------------------------------------------------

/** Options with defaults applied and validated. */
interface WriterSettings {
  readonly client: MongoClient;
  readonly storage: StorageAdapter;
  readonly logger: Logger;
  readonly compression: Compression;
  readonly encrypt: SegmentEncryptor | undefined;
  readonly scope: JournalScope;
  readonly segmentMs: number;
  readonly segmentBytes: number;
  readonly onGap: "backup" | "fail";
  readonly takeBaseBackup: ((signal: AbortSignal) => Promise<unknown>) | undefined;
  readonly notify: NotifyRunOptions | undefined;
  readonly signal: AbortSignal | undefined;
  readonly leaseMs: number;
  readonly waitForLease: boolean;
  readonly retryDelayMs: number;
  readonly onSegment: ((segment: CommittedSegment) => void) | undefined;
}

function resolveSettings(options: JournalOptions): WriterSettings {
  const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
  const segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  const leaseMs = options.leaseMs ?? DEFAULT_JOURNAL_LEASE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  assertPositive("segmentSeconds", segmentSeconds);
  assertPositive("segmentBytes", segmentBytes);
  assertPositive("leaseMs", leaseMs);
  assertPositive("retryDelayMs", retryDelayMs);

  const onGap = options.onGap ?? (options.takeBaseBackup === undefined ? "fail" : "backup");
  if (onGap === "backup" && options.takeBaseBackup === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      'onGap "backup" needs a takeBaseBackup callback.',
      {
        hint: 'Pass takeBaseBackup (e.g. () => shield.backup({ consistency: "converge" })), or use onGap "fail".',
      },
    );
  }
  return {
    client: options.client,
    storage: options.storage,
    logger: options.logger ?? silentLogger,
    compression: options.compression ?? defaultCompression(),
    encrypt: planSegmentEncryption(options.encryption),
    scope: createJournalScope({ include: options.include, exclude: options.exclude }),
    segmentMs: segmentSeconds * 1000,
    segmentBytes,
    onGap,
    takeBaseBackup: options.takeBaseBackup,
    notify: options.notify,
    signal: options.signal,
    leaseMs,
    waitForLease: options.waitForLease ?? false,
    retryDelayMs,
    onSegment: options.onSegment,
  };
}

function assertPositive(name: string, value: number): void {
  if (Number.isFinite(value) && value > 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `${name} must be a positive number, got ${String(value)}.`,
  );
}

/**
 * Takes the writer lease: the scheduler's storage lock (lock-storage.ts) under the name
 * `journal`, so two writers never run at once, wherever they are started.
 */
async function acquireLease(settings: WriterSettings): Promise<Lease> {
  const { storage, logger, signal } = settings;
  if (!storage.capabilities.conditionalWrites) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The ${storage.kind} storage adapter cannot do conditional writes, so it cannot hold the journal writer's lease.`,
      { hint: "Use a storage with conditional writes (file, S3, GCS, Azure) for the journal." },
    );
  }
  const lock = storageLock({
    storage,
    owner: createLockOwner(),
    leaseMs: settings.leaseMs,
    name: JOURNAL_LOCK_NAME,
    logger,
  });
  for (;;) {
    const result = await lock.tryAcquire(signal === undefined ? {} : { signal });
    if (result.acquired) return result.lease;
    const holder = result.holder;
    const who = holder === undefined ? "another writer" : `${holder.host} (${holder.owner})`;
    const until = holder === undefined ? "" : ` until ${holder.expiresAt.toISOString()}`;
    if (!settings.waitForLease) {
      throw new MongoShieldError(
        "MS_STORAGE_PRECONDITION_FAILED",
        `Another journal writer is running: ${who} holds the lease${until}.`,
        {
          hint: "Run one journal writer per storage location. Pass waitForLease (--wait-for-lease) to take over when the other one stops.",
        },
      );
    }
    logger.info("Waiting for the journal writer lease", { holder: who });
    await sleep(
      Math.min(LEASE_POLL_MS, settings.leaseMs),
      undefined,
      signal === undefined ? {} : { signal },
    );
  }
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/** Thrown inside a segment that has nothing to commit when stopping. */
class NothingToCommit extends Error {}

/** Where the next segment starts, and how the writer got there. */
type StartKind = "resume" | "base" | "now";

class JournalWriter {
  readonly #settings: WriterSettings;
  readonly #lease: Lease;
  /** Fires on the caller's abort and on fatal errors: tears down uploads at once. */
  readonly #hardStop = new AbortController();
  /** Fires on stop(): wakes retry sleeps and aborts a running base backup. */
  readonly #softStop = new AbortController();
  readonly #signal: AbortSignal;
  readonly #startedAt = performance.now();

  #position: ClusterTime = { t: 0, i: 0 };
  #startKind: StartKind = "now";
  #previousHash: string | null = null;
  #state: JournalState | undefined;
  #gapsRecorded: GapRecord[] = [];

  #running = false;
  #stopRequested = false;
  #renewing = false;
  #renewTimer: NodeJS.Timeout | undefined;
  #baseBackup: Promise<void> | undefined;
  #done: Promise<void> = Promise.resolve();

  #segmentsWritten = 0;
  #eventsWritten = 0;
  #bytesWritten = 0;
  #lastLatencyMs: number | undefined;
  #lastError: string | undefined;
  #failure: MongoShieldError | undefined;

  constructor(settings: WriterSettings, lease: Lease) {
    this.#settings = settings;
    this.#lease = lease;
    this.#signal =
      settings.signal === undefined
        ? this.#hardStop.signal
        : AbortSignal.any([this.#hardStop.signal, settings.signal]);
  }

  /**
   * Works out where to start: after the last committed segment (and any gaps recorded
   * after it), or, for a new journal, at the newest base backup's cluster time or now.
   * Also deletes segments whose upload was interrupted before their commit.
   */
  async prepare(): Promise<void> {
    const { storage, logger, client } = this.#settings;
    const coverage = await loadJournalCoverage(storage, this.#signal);
    const state = coverage.state;

    if (state === undefined) {
      if (coverage.uncommitted.length > 0) {
        throw new MongoShieldError(
          "MS_CONFIG_INVALID",
          "The journal has segments but no journal/state.json, so the writer does not know which are complete.",
          {
            hint: "Restore journal/state.json from a copy, or move journal/ aside to start a new journal (and take a base backup).",
          },
        );
      }
      const [newestBase] = await listBaseBackups(storage, { signal: this.#signal });
      if (newestBase !== undefined) {
        this.#position = newestBase.clusterTime;
        this.#startKind = "base";
        logger.info("Starting a new journal at the newest base backup", {
          backup: newestBase.id,
          at: formatClusterTime(newestBase.clusterTime),
        });
      } else {
        this.#position = await readClusterTime(client);
        this.#startKind = "now";
        logger.warn(
          "Starting a new journal now. There is no base backup yet: point-in-time recovery becomes possible from the next converge or snapshot backup.",
        );
      }
      return;
    }

    this.#state = state;
    this.#previousHash = state.lastSegment.sha256;
    this.#position = followGaps(state.recoveryPoint, coverage.gaps);
    this.#startKind = "resume";
    if (coverage.uncommitted.length > 0) {
      const keys = coverage.uncommitted.map((segment) => segment.key);
      logger.debug("Deleting segments whose upload was interrupted", { keys });
      await storage.delete(keys).catch((error: unknown) => {
        // Harmless: readers ignore them, and the next segment overwrites the same key.
        logger.debug("Could not delete interrupted segments", { error: String(error) });
      });
    }
    logger.info("Resuming the journal", { after: formatClusterTime(this.#position) });
  }

  /** Starts the loop and the lease renewals. */
  start(): JournalHandle {
    this.#running = true;
    const renewEveryMs = Math.max(1, Math.floor(this.#settings.leaseMs / 3));
    this.#renewTimer = setInterval(() => void this.#renewLease(), renewEveryMs);
    this.#renewTimer.unref();
    this.#done = this.#run();
    // Mark the promise handled: a caller that never awaits `done` must not crash the
    // process. Callers that do await it still see the rejection.
    this.#done.catch(() => {});
    return {
      status: () => this.#status(),
      stop: () => this.#stop(),
      done: this.#done,
    };
  }

  async #stop(): Promise<void> {
    this.#stopRequested = true;
    this.#softStop.abort();
    await this.#done;
  }

  #status(): JournalWriterStatus {
    const recoveryPoint = this.#state?.recoveryPoint;
    const elapsedSeconds = (performance.now() - this.#startedAt) / 1000;
    return {
      running: this.#running,
      recoveryPoint,
      rpoMs:
        recoveryPoint === undefined ? undefined : Math.max(0, Date.now() - recoveryPoint.t * 1000),
      segmentsWritten: this.#segmentsWritten,
      eventsWritten: this.#eventsWritten,
      bytesWritten: this.#bytesWritten,
      eventsPerSecond: elapsedSeconds > 0 ? this.#eventsWritten / elapsedSeconds : 0,
      lastSegmentLatencyMs: this.#lastLatencyMs,
      gaps: this.#gapsRecorded.length,
      lastError: this.#lastError,
      failure: this.#failure,
    };
  }

  /** The main loop (see the file header). */
  async #run(): Promise<void> {
    const { logger, client } = this.#settings;
    let retryDelay = this.#settings.retryDelayMs;
    try {
      while (!this.#stopRequested) {
        let stream: JournalChangeStream | undefined;
        try {
          stream = await JournalChangeStream.open(client, this.#position, {
            match: this.#settings.scope.serverFilter,
            logger,
            signal: this.#signal,
          });
          for (;;) {
            const outcome = await this.#writeSegment(stream);
            retryDelay = this.#settings.retryDelayMs;
            this.#lastError = undefined;
            if (outcome === "stopped") return;
          }
        } catch (error) {
          if (this.#signal.aborted) throw this.#failure ?? toError(error);
          if (error instanceof NothingToCommit) return;
          let failure = toError(error);
          if (isHistoryLost(failure)) {
            try {
              await this.#handleHistoryLost(failure);
              continue;
            } catch (gapError) {
              // onGap "fail" rethrows the history error (fatal below); anything else,
              // such as a network error while recording the gap, is retried.
              failure = toError(gapError);
            }
          }
          if (FATAL_CODES.has(failure.code) || isHistoryLost(failure)) throw failure;
          this.#lastError = failure.message;
          logger.warn("The journal writer failed; retrying from the last committed segment", {
            error: failure.message,
            retryInMs: retryDelay,
          });
          await sleep(retryDelay, undefined, { signal: this.#softStop.signal }).catch(() => {});
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
        } finally {
          await stream?.close();
        }
      }
    } catch (error) {
      this.#failure = toError(error);
      logger.error("The journal writer stopped", { error: this.#failure.message });
      throw this.#failure;
    } finally {
      this.#running = false;
      clearInterval(this.#renewTimer);
      this.#softStop.abort();
      await this.#baseBackup;
      await this.#lease.release().catch((error: unknown) => {
        logger.debug("Releasing the journal lease failed", { error: String(error) });
      });
    }
  }

  /** Streams one segment to storage and commits it. */
  async #writeSegment(stream: JournalChangeStream): Promise<"committed" | "stopped"> {
    const { storage, compression, encrypt, logger } = this.#settings;
    const from = this.#position;
    const key = segmentKey({ from, compression, encrypted: encrypt !== undefined });
    const body = new SegmentBody(this.#settings, stream, from, this.#previousHash, {
      stopRequested: () => this.#stopRequested,
      signal: this.#signal,
    });

    const digest = await writeStoredFile({
      storage,
      key,
      source: Readable.from(body.generate(), { objectMode: true }),
      transforms: [
        createCoalescer(),
        createCompressor(compression),
        ...(encrypt ? [encrypt(this.#signal)] : []),
      ],
      contentType: SEGMENT_CONTENT_TYPE,
      signal: this.#signal,
    }).catch((error: unknown) => {
      // The body ends with NothingToCommit when a stop comes before anything happened;
      // the write then fails on purpose and nothing is stored.
      throw body.nothingToCommit ? new NothingToCommit() : error;
    });

    const segment: CommittedSegment = {
      key,
      from,
      to: body.to,
      size: digest.size,
      sha256: digest.sha256,
      events: body.events,
    };
    await this.#commit(segment);
    this.#lastLatencyMs = performance.now() - body.closedAt;
    logger.debug("Committed a journal segment", {
      key,
      to: formatClusterTime(segment.to),
      events: segment.events,
      bytesStored: segment.size,
    });
    this.#afterCommit(segment);
    return body.closedByStop ? "stopped" : "committed";
  }

  /** Rewrites state.json: from now on the segment is part of the journal. */
  async #commit(segment: CommittedSegment): Promise<void> {
    const totals = this.#state?.totals ?? { segments: 0, events: 0, bytes: 0 };
    const state: JournalState = {
      formatVersion: JOURNAL_FORMAT_VERSION,
      recoveryPoint: segment.to,
      lastSegment: segment,
      totals: {
        segments: totals.segments + 1,
        events: totals.events + segment.events,
        bytes: totals.bytes + segment.size,
      },
      updatedAt: new Date().toISOString(),
      writer: { host: hostname(), pid: process.pid },
    };
    await writeJournalState(this.#settings.storage, state, this.#signal);
    this.#state = state;
    this.#position = segment.to;
    this.#previousHash = segment.sha256;
    this.#startKind = "resume";
    this.#segmentsWritten += 1;
    this.#eventsWritten += segment.events;
    this.#bytesWritten += segment.size;
  }

  /** Metrics hook and heartbeat; neither may disturb the writer. */
  #afterCommit(segment: CommittedSegment): void {
    const { onSegment, notify, logger } = this.#settings;
    try {
      onSegment?.(segment);
    } catch (error) {
      logger.warn("The onSegment callback threw", { error: String(error) });
    }
    if (notify?.heartbeat !== undefined) {
      // Never throws; not awaited so a slow heartbeat service cannot add to the RPO.
      void pingHeartbeat(notify.heartbeat, "success", notify);
    }
  }

  /**
   * The oplog no longer reaches the point the journal must resume after.
   *
   * A brand-new journal that tried to start at an old base backup just starts now
   * (it had nothing to lose). Otherwise this is a gap: recorded, alerted, and then
   * either a base backup is taken while journaling continues from now, or the
   * writer stops (onGap).
   */
  async #handleHistoryLost(error: MongoShieldError): Promise<void> {
    const { client, storage, logger, onGap } = this.#settings;
    const resumeAt = await readClusterTime(client);
    if (this.#startKind !== "resume") {
      logger.warn(
        "The newest base backup is older than the oplog, so the new journal starts now. Point-in-time recovery becomes possible from the next base backup.",
        { from: formatClusterTime(this.#position), now: formatClusterTime(resumeAt) },
      );
      this.#position = resumeAt;
      this.#startKind = "now";
      return;
    }

    const gap: GapRecord = {
      formatVersion: JOURNAL_FORMAT_VERSION,
      from: this.#position,
      to: resumeAt,
      detectedAt: new Date().toISOString(),
      reason: error.message,
      action: onGap,
    };
    await writeGapRecord(storage, gap, this.#signal);
    this.#gapsRecorded.push(gap);
    this.#position = resumeAt;
    logger.error("The journal lost change history: changes in this range cannot be recovered", {
      from: formatClusterTime(gap.from),
      to: formatClusterTime(gap.to),
      onGap,
    });
    await this.#alert(gap, error);

    if (onGap === "fail") throw error;
    this.#startBaseBackup();
  }

  /** Runs `takeBaseBackup` in the background while journaling continues. */
  #startBaseBackup(): void {
    const { takeBaseBackup, logger } = this.#settings;
    if (takeBaseBackup === undefined || this.#baseBackup !== undefined) return;
    logger.info("Taking a new base backup after the gap");
    this.#baseBackup = takeBaseBackup(this.#softStop.signal)
      .then(() => logger.info("The base backup after the gap is complete"))
      .catch((error: unknown) => {
        logger.error(
          "The base backup after the gap failed; recovery past the gap needs the next base backup",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      })
      .finally(() => {
        this.#baseBackup = undefined;
      });
  }

  /** Sends the gap to the notification targets as a failed run (and pings `/fail`). */
  async #alert(gap: GapRecord, error: MongoShieldError): Promise<void> {
    const { notify, storage } = this.#settings;
    if (notify === undefined) return;
    const now = new Date().toISOString();
    const report: RunReport = {
      version: RUN_REPORT_VERSION,
      runId: randomBytes(6).toString("hex"),
      status: "failure",
      startedAt: gap.detectedAt,
      finishedAt: now,
      durationMs: 0,
      host: hostname(),
      storage: storage.location,
      lock: { kind: "storage" },
      error: {
        step: "backup",
        code: error.code,
        message: `The change journal has a gap from ${formatClusterTime(gap.from)} to ${formatClusterTime(gap.to)}: point-in-time recovery into it is impossible. ${error.message}`,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      },
    };
    await notifyRun(report, notify);
  }

  /** Renews the lease; losing it stops the writer at once. */
  async #renewLease(): Promise<void> {
    if (this.#renewing || !this.#running) return;
    this.#renewing = true;
    try {
      const result = await this.#lease.renew();
      if (result === "lost") {
        this.#failure = new MongoShieldError(
          "MS_STORAGE_PRECONDITION_FAILED",
          "The journal writer lost its lease to another writer.",
          {
            hint: "Run one journal writer per storage location; check that its storage is reachable.",
          },
        );
        this.#hardStop.abort(this.#failure);
      }
    } catch (error) {
      this.#settings.logger.warn("Renewing the journal lease failed; retrying", {
        error: String(error),
      });
    } finally {
      this.#renewing = false;
    }
  }
}

/**
 * The content of one segment, generated as the stream delivers it: header, events,
 * trailer. Tracks what the commit needs (end, event count) and whether it ended
 * because of a stop.
 */
class SegmentBody {
  readonly #settings: WriterSettings;
  readonly #stream: JournalChangeStream;
  readonly #from: ClusterTime;
  readonly #previous: string | null;
  readonly #control: { readonly stopRequested: () => boolean; readonly signal: AbortSignal };
  readonly #openedAt = performance.now();
  #bytes = 0;

  /** Where the segment ends; set when it closes. */
  to: ClusterTime;
  events = 0;
  /** When the segment closed (the commit latency is measured from here). */
  closedAt = 0;
  closedByStop = false;
  nothingToCommit = false;

  constructor(
    settings: WriterSettings,
    stream: JournalChangeStream,
    from: ClusterTime,
    previous: string | null,
    control: { readonly stopRequested: () => boolean; readonly signal: AbortSignal },
  ) {
    this.#settings = settings;
    this.#stream = stream;
    this.#from = from;
    this.#previous = previous;
    this.#control = control;
    this.to = from;
  }

  /** The segment's documents (see the boundary rules in the file header). */
  async *generate(): AsyncGenerator<Buffer> {
    const { scope, client, logger } = this.#settings;
    yield encodeSegmentHeader({ from: this.#from, previous: this.#previous });
    let lastSeen = this.#from;

    for (;;) {
      const item = await this.#stream.peek(this.#control.signal, this.#from);
      const closing = this.#isClosing();
      const hasProgress = isAfter(lastSeen, this.#from);

      if (item.kind === "position") {
        this.#stream.take();
        lastSeen = laterOf(lastSeen, item.time);
        if (closing && isAfter(lastSeen, this.#from)) break;
        if (closing && this.#control.stopRequested() && this.events === 0) {
          // Stopping, and nothing happened since the last commit: nothing to store.
          this.nothingToCommit = true;
          throw new NothingToCommit();
        }
        continue;
      }

      const { event, raw } = item;
      // Close between two cluster times only, never inside one (a transaction).
      if (closing && hasProgress && compareClusterTimes(event.clusterTime, lastSeen) > 0) break;
      this.#stream.take();
      lastSeen = laterOf(lastSeen, event.clusterTime);
      if (!scope.keeps(event)) continue;

      const bytes = await storedEventBytes(client, raw, event, logger);
      this.#count(bytes);
      yield bytes;
      if (scope.needsDestinationSnapshot(event)) {
        const snapshot = await openDestinationSnapshot(client, event, this.#control.signal, logger);
        if (snapshot === undefined) continue;
        for await (const synthesized of snapshot) {
          this.#count(synthesized);
          yield synthesized;
        }
      }
    }

    this.to = lastSeen;
    this.closedAt = performance.now();
    this.closedByStop = this.#control.stopRequested();
    yield encodeSegmentTrailer({ to: this.to, events: this.events });
  }

  #count(bytes: Buffer): void {
    this.events += 1;
    this.#bytes += bytes.length;
  }

  #isClosing(): boolean {
    return (
      this.#control.stopRequested() ||
      this.#bytes >= this.#settings.segmentBytes ||
      performance.now() - this.#openedAt >= this.#settings.segmentMs
    );
  }
}

/** Starting at `point`, skips over recorded gaps that begin exactly there. */
function followGaps(point: ClusterTime, gaps: readonly GapRecord[]): ClusterTime {
  let current = point;
  for (;;) {
    const gap = gaps.find((candidate) => compareClusterTimes(candidate.from, current) === 0);
    if (gap === undefined || !isAfter(gap.to, current)) return current;
    current = gap.to;
  }
}

function toError(error: unknown): MongoShieldError {
  if (isMongoShieldError(error)) return error;
  return new MongoShieldError(
    "MS_INTERNAL",
    `The journal writer failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
