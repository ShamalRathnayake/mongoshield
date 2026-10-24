/**
 * What every reconciler gets: the API client, the informer caches, the event
 * recorder, metrics, logging, the Job defaults and a clock.
 *
 * Reconcilers read their primary object (and related ones) from the caches, which
 * the informers keep current, and write through the client. A cache may lag a write
 * by a few milliseconds; writes carry the resourceVersion they were based on, so a
 * stale read turns into a 409 Conflict and a quick retry, never a lost update.
 */

import type { Backup, BackupPlan, Drill, Restore } from "../api/types.ts";
import type { EventRecorder } from "../controller/events.ts";
import type { KubeClient } from "../kube/client.ts";
import type { Informer } from "../kube/informer.ts";
import type { CronJob, Job } from "../kube/objects.ts";
import type { Logger } from "../logger.ts";
import type { OperatorMetrics } from "../operator-metrics.ts";
import type { JobDefaults } from "../resources/pod.ts";

/** Read access to cached objects. Informers implement it; tests may pass simple stubs. */
export interface Cache<T> {
  get(namespace: string, name: string): T | undefined;
  list(namespace?: string): T[];
}

export interface ReconcilerContext {
  readonly client: KubeClient;
  readonly plans: Cache<BackupPlan>;
  readonly backups: Cache<Backup>;
  readonly restores: Cache<Restore>;
  readonly drills: Cache<Drill>;
  readonly jobs: Cache<Job>;
  readonly cronJobs: Cache<CronJob>;
  readonly events: EventRecorder;
  readonly metrics: OperatorMetrics;
  readonly logger: Logger;
  readonly defaults: JobDefaults;
  readonly now: () => Date;
}

/** Re-check interval while a Job runs (to notice stuck pods; completion arrives as an event). */
export const RUNNING_RECHECK_MS = 30_000;

/** Re-check interval while waiting for something else (a plan, a backup) to become ready. */
export const WAITING_RECHECK_MS = 15_000;

/** Re-check interval while waiting for a deletion to finish. */
export const DELETION_RECHECK_MS = 2_000;

/** Informer type alias re-exported for wiring code. */
export type { Informer };
