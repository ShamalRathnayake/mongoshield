/**
 * Plan schedules: one library `BackupScheduler` per plan that has a cron schedule.
 *
 * The scheduler decides *when* (cron, time zone, no overlapping runs, graceful
 * stop); each tick hands a backup job to the runner, so scheduled and manual
 * runs share the same queue, history and live progress. The backup itself goes
 * through `runScheduledJob` with the storage lock (tasks.ts), so a console and a
 * `mongoshield schedule` process pointed at the same storage never both back up
 * at once: whoever is second records a "skipped" run.
 *
 * `sync()` reconciles the running schedulers with the plans in the state; the
 * plan routes call it after every change.
 */

import { BackupScheduler, type Logger } from "mongoshield";
import type { StateStore } from "../state/store.ts";
import type { PlanRecord } from "../state/types.ts";
import type { JobRunner, JobSpec } from "./runner.ts";

/** Options for {@link PlanSchedules}. */
export interface PlanSchedulesOptions {
  readonly store: StateStore;
  readonly runner: JobRunner;
  /** Builds the backup job for a plan (tasks.ts `backupJob`). */
  readonly backupJob: (plan: PlanRecord) => JobSpec;
  readonly logger: Logger;
}

/** A running scheduler and the schedule it was built for. */
interface ActiveSchedule {
  readonly signature: string;
  readonly scheduler: BackupScheduler;
}

/**
 * Throws `MS_CONFIG_INVALID` when a cron expression or time zone is invalid.
 * Used to validate plan input before it is saved.
 */
export function checkSchedule(cron: string, timezone: string): void {
  // Constructing a scheduler parses the expression; it is never started.
  new BackupScheduler({ cron, timezone, job: async () => undefined });
}

/** Keeps one scheduler per scheduled plan. */
export class PlanSchedules {
  readonly #options: PlanSchedulesOptions;
  readonly #active = new Map<string, ActiveSchedule>();
  #started = false;

  constructor(options: PlanSchedulesOptions) {
    this.#options = options;
  }

  /** Starts scheduling (main.ts). Tests that do not want timers never call it. */
  start(): void {
    this.#started = true;
    this.sync();
  }

  /** The next scheduled run of a plan, if it has one and scheduling is on. */
  nextRunOf(planId: string): Date | undefined {
    return this.#active.get(planId)?.scheduler.nextRun();
  }

  /** Creates, replaces and removes schedulers to match the current plans. */
  sync(): void {
    if (!this.#started) return;
    const plans = this.#options.store.current.plans;
    const wanted = new Map(
      plans.flatMap((plan) => (plan.schedule ? [[plan.id, plan] as const] : [])),
    );

    for (const [planId, active] of this.#active) {
      const plan = wanted.get(planId);
      if (plan === undefined || signatureOf(plan) !== active.signature) {
        this.#active.delete(planId);
        // Let a running backup finish: a plan edit must not abort it. (2^31-1 ms is
        // the longest timer Node allows; anything larger would fire immediately.)
        void active.scheduler.stop({ graceMs: 2 ** 31 - 1 });
      }
    }
    for (const [planId, plan] of wanted) {
      if (!this.#active.has(planId)) this.#schedule(plan);
    }
  }

  /** Stops every scheduler; running scheduled jobs get `graceMs` to finish. */
  async stop(graceMs: number): Promise<void> {
    this.#started = false;
    const stopping = [...this.#active.values()].map((active) => active.scheduler.stop({ graceMs }));
    this.#active.clear();
    await Promise.all(stopping);
  }

  #schedule(plan: PlanRecord): void {
    const schedule = plan.schedule;
    if (schedule === undefined) return;
    const { runner, store, logger } = this.#options;
    let scheduler: BackupScheduler;
    try {
      scheduler = new BackupScheduler({
        cron: schedule.cron,
        timezone: schedule.timezone,
        logger,
        job: async (signal) => {
          // Re-read the plan: it may have changed since the scheduler was created.
          const current = store.current.plans.find((candidate) => candidate.id === plan.id);
          if (current === undefined) return;
          const job = await runner.start(this.#options.backupJob(current));
          const cancel = (): void => void runner.cancel(job.id);
          signal.addEventListener("abort", cancel, { once: true });
          try {
            await runner.finished(job.id);
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        },
      });
    } catch (error) {
      // Validated on input, so this means a hand-edited state file. Skip the plan, keep running.
      logger.error("Cannot schedule plan", { plan: plan.id, error: String(error) });
      return;
    }
    scheduler.start();
    this.#active.set(plan.id, { signature: signatureOf(plan), scheduler });
  }
}

/** Two plans with the same signature need no new scheduler. */
function signatureOf(plan: PlanRecord): string {
  return `${plan.schedule?.cron ?? ""}|${plan.schedule?.timezone ?? ""}`;
}
