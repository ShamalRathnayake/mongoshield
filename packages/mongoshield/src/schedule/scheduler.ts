/**
 * The in-process scheduler: runs a job on a cron schedule until stopped.
 *
 *   const scheduler = new BackupScheduler({
 *     cron: "15 3 * * *",
 *     timezone: "Europe/Berlin",
 *     jitterSeconds: 300,
 *     job: (signal) => runScheduledJob(shield, config, { signal }),
 *   });
 *   scheduler.start();
 *   scheduler.stopOnSignals();          // SIGTERM / SIGINT: finish or abort, then stop
 *   await scheduler.stopped;
 *
 * croner is used only to compute the next matching time (time zones and DST
 * included); the waiting is our own `setTimeout` loop. That keeps three rules
 * simple and testable with fake timers:
 *
 * - No overlap: the next run is planned only after the current one finished.
 *   Slots that pass while a run is still busy are skipped (and logged), never
 *   queued: a backlog of backups helps nobody.
 * - Jitter: each run starts a random 0–`jitterSeconds` after its slot.
 * - Graceful stop: `stop()` lets a running job finish for up to `graceMs`,
 *   then aborts its signal and waits for it to wind down (release the lock,
 *   delete partial files).
 */

import { Cron } from "croner";
import { MongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";

/** Options for {@link BackupScheduler}. */
export interface SchedulerOptions {
  /** Standard 5-field cron expression, e.g. `"15 3 * * *"`. */
  readonly cron: string;
  /** IANA time zone, e.g. `"Europe/Berlin"`. Defaults to UTC. */
  readonly timezone?: string | undefined;
  /** Random delay of up to this many seconds after each slot. Defaults to 0. */
  readonly jitterSeconds?: number | undefined;
  /** The work. Must stop promptly when `signal` aborts. Errors are logged, never fatal. */
  readonly job: (signal: AbortSignal) => Promise<unknown>;
  readonly logger?: Logger;
  /** Random number in [0, 1); for tests. */
  readonly random?: () => number;
}

/** Options for {@link BackupScheduler.stop}. */
export interface StopOptions {
  /** How long a running job may take to finish before it is aborted. Defaults to 60 s. */
  readonly graceMs?: number;
}

/** Default grace period: long enough for most verify/prune steps to end on their own. */
export const DEFAULT_GRACE_MS = 60_000;

/**
 * Node's timers overflow above 2^31-1 ms (about 24.8 days); a longer wait
 * (a yearly schedule) is done in chunks.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Runs a job on a cron schedule. See the file header. */
export class BackupScheduler {
  readonly #cron: Cron;
  readonly #options: SchedulerOptions;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | undefined;
  /** The slot the timer is waiting for. */
  #nextSlot: Date | undefined;
  #current: { readonly done: Promise<void>; readonly controller: AbortController } | undefined;
  #state: "idle" | "running" | "stopping" | "stopped" = "idle";
  #resolveStopped: () => void = () => {};

  /** Resolves once the scheduler has stopped (after `stop()` finished). */
  readonly stopped: Promise<void>;

  /**
   * @throws MongoShieldError `MS_CONFIG_INVALID` for an invalid cron expression or time zone.
   */
  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#cron = parseCron(options.cron, options.timezone);
    this.stopped = new Promise((resolve) => {
      this.#resolveStopped = resolve;
    });
  }

  /** True while a job is running. */
  get busy(): boolean {
    return this.#current !== undefined;
  }

  /**
   * The next time the job will start (its cron slot, before jitter), or
   * `undefined` when stopped or when the expression never matches again.
   * While a job runs, the next slot after now is shown.
   */
  nextRun(): Date | undefined {
    if (this.#state === "stopping" || this.#state === "stopped") return undefined;
    return this.#nextSlot ?? this.#cron.nextRun(new Date()) ?? undefined;
  }

  /** The next `count` cron slots after `from` (for `mongoshield schedule` to print). */
  upcoming(count: number, from: Date = new Date()): Date[] {
    return this.#cron.nextRuns(count, from);
  }

  /** Starts waiting for the first slot. Calling it twice has no effect. */
  start(): void {
    if (this.#state !== "idle") return;
    this.#state = "running";
    this.#planNext();
  }

  /**
   * Stops scheduling. A running job gets `graceMs` to finish, then its signal
   * is aborted; the returned promise resolves once it has wound down.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state === "stopping") return this.stopped;
    this.#state = "stopping";
    this.#clearTimer();
    this.#nextSlot = undefined;

    const current = this.#current;
    if (current) {
      const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
      this.#logger.info("Stopping: waiting for the running backup to finish", { graceMs });
      const finished = await settlesWithin(current.done, graceMs);
      if (!finished) {
        this.#logger.warn("The running backup did not finish in time; aborting it");
        current.controller.abort(
          new MongoShieldError("MS_ABORTED", "The scheduler is shutting down."),
        );
        await current.done;
      }
    }
    this.#state = "stopped";
    this.#resolveStopped();
  }

  /**
   * Stops gracefully when the process receives one of `signals`. Returns a
   * function that removes the handlers. Only for long-running processes that
   * own their signal handling (the CLI, a dedicated worker).
   */
  stopOnSignals(
    signals: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"],
    options: StopOptions = {},
  ): () => void {
    const onSignal = (signal: NodeJS.Signals): void => {
      this.#logger.info("Received a shutdown signal", { signal });
      void this.stop(options);
    };
    for (const signal of signals) process.once(signal, onSignal);
    return () => {
      for (const signal of signals) process.off(signal, onSignal);
    };
  }

  // -------------------------------------------------------------------------

  /** Plans the timer for the next slot after now. */
  #planNext(): void {
    if (this.#state !== "running") return;
    const slot = this.#cron.nextRun(new Date());
    if (slot === null) {
      this.#logger.warn("The cron expression has no future runs; the scheduler is idle");
      this.#nextSlot = undefined;
      return;
    }
    this.#nextSlot = slot;
    const jitterMs = Math.round(
      (this.#options.random ?? Math.random)() * (this.#options.jitterSeconds ?? 0) * 1000,
    );
    this.#logger.debug("Next scheduled run", { at: slot.toISOString(), jitterMs });
    this.#waitUntil(slot.getTime() + jitterMs, slot);
  }

  /** Sets a timer for `targetMs`, chunked when it is further away than a timer allows. */
  #waitUntil(targetMs: number, slot: Date): void {
    const remaining = targetMs - Date.now();
    if (remaining > MAX_TIMER_MS) {
      this.#timer = setTimeout(() => this.#waitUntil(targetMs, slot), MAX_TIMER_MS);
      return;
    }
    this.#timer = setTimeout(() => void this.#fire(slot), Math.max(0, remaining));
  }

  /** Runs the job for `slot`, then plans the next one. */
  async #fire(slot: Date): Promise<void> {
    this.#timer = undefined;
    // While the job runs, nextRun() reports the next slot after now.
    this.#nextSlot = undefined;
    if (this.#state !== "running") return;

    const controller = new AbortController();
    const done = this.#runJob(controller.signal, slot);
    this.#current = { done, controller };
    await done;
    this.#current = undefined;

    // Overlap prevention: slots that passed while the job ran are skipped.
    const missed = this.#cron.nextRun(slot);
    if (missed !== null && missed.getTime() < Date.now()) {
      this.#logger.warn("Skipped scheduled runs while the previous run was still busy", {
        slot: slot.toISOString(),
        firstSkipped: missed.toISOString(),
      });
    }
    this.#planNext();
  }

  /** Runs the job once; a throwing job is logged so the schedule keeps going. */
  async #runJob(signal: AbortSignal, slot: Date): Promise<void> {
    this.#logger.info("Starting scheduled run", { slot: slot.toISOString() });
    try {
      await this.#options.job(signal);
    } catch (error) {
      this.#logger.error("The scheduled job threw", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Parses and validates a cron expression and time zone.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` with croner's explanation.
 */
export function parseCron(expression: string, timezone: string | undefined): Cron {
  if (timezone !== undefined) assertTimeZone(timezone);
  try {
    // "5-part": exactly the standard fields, as documented for `schedule.cron`.
    return new Cron(expression, {
      paused: true,
      mode: "5-part",
      timezone: timezone ?? "UTC",
    });
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid cron expression "${expression}": ${error instanceof Error ? error.message : String(error)}`,
      { hint: 'Use 5 fields: minute hour day-of-month month day-of-week, e.g. "15 3 * * *".' },
    );
  }
}

/** Throws a config error for a time zone Intl does not know (a typo like "Europe/Berln"). */
function assertTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Unknown time zone "${timezone}".`, {
      hint: 'Use an IANA name such as "UTC", "Europe/Berlin" or "America/New_York".',
    });
  }
}

/** Resolves true if `promise` settles within `ms`, false otherwise. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
