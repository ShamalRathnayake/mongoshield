/**
 * The in-process job runner: backups, restores, verifies and drills started from
 * the UI or by a schedule.
 *
 *   start(spec) ─▶ queued ─▶ running ─▶ succeeded | failed | cancelled
 *
 * Rules worth knowing:
 * - Jobs run one at a time per *lane*. A lane is a connection (`connection:<id>`)
 *   for jobs that write to or read from MongoDB, or a storage location for
 *   verifies. Two backups of the same database never overlap, while jobs on
 *   different connections run in parallel.
 * - Cancelling a queued job removes it; cancelling a running job aborts its
 *   AbortSignal, and the job ends as `cancelled` once the library has cleaned up.
 * - Progress fans out to subscribers (the SSE endpoint). It is throttled to
 *   about four events per second per job, because the library may report
 *   thousands per second and a browser needs no more.
 * - Every status change is saved in console.json (the last 500 jobs). Progress
 *   is not saved: it is only interesting while you watch.
 * - On startup, jobs that were queued or running when the process stopped are
 *   marked failed (`CONSOLE_INTERRUPTED`): their work was not finished.
 */

import { isMongoShieldError, MongoShieldError, type ProgressEvent } from "mongoshield";
import { describeError } from "../server/errors.ts";
import type { ApiError, JobEvent, JobKind, JobSummary } from "../shared/api.ts";
import { randomId } from "../state/crypto.ts";
import type { StateStore } from "../state/store.ts";
import { MAX_JOB_HISTORY } from "../state/types.ts";

/** What a running job may do besides its work: report progress and log lines. */
export interface JobContext {
  /** Aborted when the job is cancelled or the server shuts down. */
  readonly signal: AbortSignal;
  /** Forward a library progress event. */
  progress(event: ProgressEvent): void;
  /** A line for the job's live log (never put secrets here). */
  log(level: "info" | "warn" | "error", message: string): void;
}

/** What a job produced. */
export interface JobOutcome {
  readonly summary: string;
  readonly backupId?: string;
}

/** Everything needed to run one job. */
export interface JobSpec {
  readonly kind: JobKind;
  /** Jobs in the same lane run one after another (see the file header). */
  readonly lane: string;
  /** A username, or "schedule". */
  readonly startedBy: string;
  readonly planId?: string;
  readonly storageId?: string;
  /** The backup the job works on, when known up front (restore, verify, drill). */
  readonly backupId?: string;
  /** The work. Throws on failure; the error is described to the client safely. */
  readonly run: (context: JobContext) => Promise<JobOutcome>;
  /** Strings to scrub from error messages (e.g. the connection URI). */
  readonly secrets?: readonly string[];
}

/** Options for {@link JobRunner}. */
export interface JobRunnerOptions {
  readonly store: StateStore;
  readonly now?: () => Date;
  /** Minimum time between two progress events of a job. Defaults to 250 ms. */
  readonly progressIntervalMs?: number;
  /** Called after a job reached a final status (audit logging, metrics). */
  readonly onFinished?: (job: JobSummary) => void;
}

/** Log lines kept per job for subscribers that connect late. */
const KEPT_LOG_LINES = 500;
/**
 * Finished jobs whose log and last progress stay in memory for replay, so a job
 * page opened right after the job ended still shows what happened. Older ones
 * keep only their saved summary.
 */
const KEPT_FINISHED_REPLAYS = 50;
const DEFAULT_PROGRESS_INTERVAL_MS = 250;

/** In-memory state of a job that has not finished yet. */
interface ActiveJob {
  summary: JobSummary;
  readonly spec: JobSpec;
  readonly controller: AbortController;
  readonly listeners: Set<(event: JobEvent) => void>;
  readonly logs: JobEvent[];
  lastProgress: JobEvent | undefined;
  pendingProgress: JobEvent | undefined;
  lastProgressAt: number;
  progressTimer: NodeJS.Timeout | undefined;
  /** Namespace of the most recent per-namespace event, shown with the overall progress. */
  namespace: string | undefined;
  cancelRequested: boolean;
  readonly done: Promise<JobSummary>;
  resolveDone: (job: JobSummary) => void;
}

/** Runs jobs; see the file header. */
export class JobRunner {
  readonly #store: StateStore;
  readonly #now: () => Date;
  readonly #progressIntervalMs: number;
  readonly #onFinished: ((job: JobSummary) => void) | undefined;
  readonly #active = new Map<string, ActiveJob>();
  /** Lanes with their queued job ids, first one running. */
  readonly #lanes = new Map<string, string[]>();
  /** Replay data of recently finished jobs (insertion order = finishing order). */
  readonly #finished = new Map<
    string,
    { readonly logs: readonly JobEvent[]; readonly progress: JobEvent | undefined }
  >();
  #accepting = true;

  constructor(options: JobRunnerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.#onFinished = options.onFinished;
  }

  /** Marks jobs left queued or running by a previous process as failed. */
  async recoverInterrupted(): Promise<void> {
    const interrupted = this.#store.current.jobs.filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    if (interrupted.length === 0) return;
    const at = this.#now().toISOString();
    await this.#store.update((state) => {
      state.jobs = state.jobs.map((job) =>
        job.status === "queued" || job.status === "running"
          ? {
              ...job,
              status: "failed",
              finishedAt: at,
              error: {
                code: "CONSOLE_INTERRUPTED",
                message: "The console stopped before this job finished.",
                hint: "Start the job again.",
              },
            }
          : job,
      );
    });
  }

  /** Queues a job and returns its summary (status `queued` or already `running`). */
  async start(spec: JobSpec): Promise<JobSummary> {
    if (!this.#accepting) {
      throw new Error("The console is shutting down and accepts no new jobs.");
    }
    const summary: JobSummary = {
      id: randomId(),
      kind: spec.kind,
      status: "queued",
      startedBy: spec.startedBy,
      ...(spec.planId === undefined ? {} : { planId: spec.planId }),
      ...(spec.storageId === undefined ? {} : { storageId: spec.storageId }),
      ...(spec.backupId === undefined ? {} : { backupId: spec.backupId }),
    };
    let resolveDone: (job: JobSummary) => void = () => {};
    const done = new Promise<JobSummary>((resolve) => {
      resolveDone = resolve;
    });
    const job: ActiveJob = {
      summary,
      spec,
      controller: new AbortController(),
      listeners: new Set(),
      logs: [],
      lastProgress: undefined,
      pendingProgress: undefined,
      lastProgressAt: 0,
      progressTimer: undefined,
      namespace: undefined,
      cancelRequested: false,
      done,
      resolveDone,
    };
    this.#active.set(summary.id, job);
    await this.#save(summary);

    const lane = this.#lanes.get(spec.lane) ?? [];
    lane.push(summary.id);
    this.#lanes.set(spec.lane, lane);
    if (lane.length === 1) this.#launch(job);
    return job.summary;
  }

  /** A job by id: active ones from memory, finished ones from history. */
  get(id: string): JobSummary | undefined {
    return this.#active.get(id)?.summary ?? this.#store.current.jobs.find((job) => job.id === id);
  }

  /** Every known job, newest first. */
  list(): JobSummary[] {
    return this.#store.current.jobs.map((job) => this.#active.get(job.id)?.summary ?? job);
  }

  /** Resolves with the final summary once the job has finished. */
  finished(id: string): Promise<JobSummary | undefined> {
    const active = this.#active.get(id);
    return active === undefined ? Promise.resolve(this.get(id)) : active.done;
  }

  /** True while the job is queued or running. */
  isActive(id: string): boolean {
    return this.#active.has(id);
  }

  /**
   * Cancels a job. Returns its summary afterwards (a running job may still be
   * winding down, its status changes to `cancelled` when it has).
   */
  async cancel(id: string): Promise<JobSummary | undefined> {
    const job = this.#active.get(id);
    if (job === undefined) return this.get(id);
    job.cancelRequested = true;
    if (job.summary.status === "queued") {
      await this.#finish(job, { status: "cancelled" });
      return job.summary;
    }
    job.controller.abort(new Error("Cancelled by a user."));
    return job.summary;
  }

  /**
   * Subscribes to a job's events. The listener first receives a replay: the
   * current status, the latest progress (if any) and the log lines so far (the
   * last 500); then live events until the final status. Finished jobs replay
   * the same way, from memory for recent ones, else just their saved status.
   * Returns `unsubscribe`.
   */
  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    const job = this.#active.get(id);
    if (job === undefined) {
      const summary = this.get(id);
      if (summary === undefined) return () => {};
      listener({ type: "status", job: summary });
      const replay = this.#finished.get(id);
      if (replay?.progress !== undefined) listener(replay.progress);
      for (const line of replay?.logs ?? []) listener(line);
      return () => {};
    }
    listener({ type: "status", job: job.summary });
    if (job.lastProgress !== undefined) listener(job.lastProgress);
    for (const line of job.logs) listener(line);
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  /** Jobs currently running (not queued). */
  running(): JobSummary[] {
    return [...this.#active.values()]
      .filter((job) => job.summary.status === "running")
      .map((job) => job.summary);
  }

  /**
   * Stops accepting jobs, cancels queued ones, gives running ones `graceMs` to
   * finish and then aborts them, and waits until they have wound down.
   */
  async shutdown(graceMs: number): Promise<void> {
    this.#accepting = false;
    for (const job of [...this.#active.values()]) {
      if (job.summary.status === "queued") await this.cancel(job.summary.id);
    }
    const running = [...this.#active.values()].map((job) => job.done);
    if (running.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), graceMs);
    });
    const outcome = await Promise.race([Promise.all(running), timedOut]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      for (const job of this.#active.values()) {
        job.controller.abort(new Error("The console is shutting down."));
      }
      await Promise.all(running);
    }
  }

  // -------------------------------------------------------------------------

  /** Starts a job that is first in its lane. */
  #launch(job: ActiveJob): void {
    void this.#execute(job);
  }

  async #execute(job: ActiveJob): Promise<void> {
    job.summary = { ...job.summary, status: "running", startedAt: this.#now().toISOString() };
    this.#emit(job, { type: "status", job: job.summary });
    await this.#save(job.summary).catch(() => undefined);

    const context: JobContext = {
      signal: job.controller.signal,
      progress: (event) => this.#onProgress(job, event),
      log: (level, message) => {
        const line: JobEvent = { type: "log", level, message };
        job.logs.push(line);
        if (job.logs.length > KEPT_LOG_LINES) job.logs.shift();
        this.#emit(job, line);
      },
    };

    try {
      // A cancel or shutdown may have arrived while the status was being saved;
      // do not start work whose signal is already aborted.
      if (job.controller.signal.aborted) {
        throw new MongoShieldError("MS_ABORTED", "The job was stopped before it started.");
      }
      const outcome = await job.spec.run(context);
      await this.#finish(job, {
        status: "succeeded",
        summary: outcome.summary,
        ...(outcome.backupId === undefined ? {} : { backupId: outcome.backupId }),
      });
    } catch (error) {
      const cancelled =
        job.cancelRequested &&
        (job.controller.signal.aborted || isMongoShieldError(error, "MS_ABORTED"));
      if (cancelled) {
        await this.#finish(job, { status: "cancelled" });
      } else {
        await this.#finish(job, {
          status: "failed",
          error: describeError(error, job.spec.secrets ?? []),
        });
      }
    }
  }

  /** Records the final status, notifies subscribers and starts the lane's next job. */
  async #finish(
    job: ActiveJob,
    result: {
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly summary?: string;
      readonly backupId?: string;
      readonly error?: ApiError["error"];
    },
  ): Promise<void> {
    this.#flushProgress(job);
    job.summary = {
      ...job.summary,
      ...result,
      finishedAt: this.#now().toISOString(),
    };
    this.#active.delete(job.summary.id);
    this.#finished.set(job.summary.id, { logs: job.logs, progress: job.lastProgress });
    for (const oldest of this.#finished.keys()) {
      if (this.#finished.size <= KEPT_FINISHED_REPLAYS) break;
      this.#finished.delete(oldest);
    }
    await this.#save(job.summary).catch(() => undefined);
    this.#emit(job, { type: "status", job: job.summary });
    job.listeners.clear();
    job.resolveDone(job.summary);
    this.#onFinished?.(job.summary);

    const lane = this.#lanes.get(job.spec.lane) ?? [];
    const position = lane.indexOf(job.summary.id);
    if (position !== -1) lane.splice(position, 1);
    if (lane.length === 0) {
      this.#lanes.delete(job.spec.lane);
      return;
    }
    // A cancelled queued job may sit behind the running one; only launch when the head changed.
    const head = this.#active.get(lane[0] ?? "");
    if (position === 0 && head !== undefined) this.#launch(head);
  }

  /** Turns library progress into throttled `progress` events. */
  #onProgress(job: ActiveJob, event: ProgressEvent): void {
    if (event.type === "namespace:start" || event.type === "namespace:progress") {
      job.namespace = event.ns;
      return;
    }
    if (event.type !== "overall") return;
    const progress: JobEvent = {
      type: "progress",
      documents: event.documents,
      estimatedDocuments: event.estimatedDocuments,
      bytes: event.bytes,
      ...(event.etaMs === undefined ? {} : { etaMs: event.etaMs }),
      ...(job.namespace === undefined ? {} : { namespace: job.namespace }),
    };
    job.pendingProgress = progress;
    const wait = job.lastProgressAt + this.#progressIntervalMs - Date.now();
    if (wait <= 0) {
      this.#flushProgress(job);
    } else if (job.progressTimer === undefined) {
      job.progressTimer = setTimeout(() => this.#flushProgress(job), wait);
    }
  }

  #flushProgress(job: ActiveJob): void {
    if (job.progressTimer !== undefined) clearTimeout(job.progressTimer);
    job.progressTimer = undefined;
    const pending = job.pendingProgress;
    if (pending === undefined) return;
    job.pendingProgress = undefined;
    job.lastProgress = pending;
    job.lastProgressAt = Date.now();
    this.#emit(job, pending);
  }

  #emit(job: ActiveJob, event: JobEvent): void {
    for (const listener of job.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (closed connection) must not break the job.
      }
    }
  }

  /** Inserts or replaces a job in the saved history (newest first, capped). */
  async #save(summary: JobSummary): Promise<void> {
    await this.#store.update((state) => {
      const others = state.jobs.filter((job) => job.id !== summary.id);
      const existing = state.jobs.findIndex((job) => job.id === summary.id);
      if (existing === -1) {
        state.jobs = [summary, ...others].slice(0, MAX_JOB_HISTORY);
      } else {
        const next = [...state.jobs];
        next[existing] = summary;
        state.jobs = next;
      }
    });
  }
}
