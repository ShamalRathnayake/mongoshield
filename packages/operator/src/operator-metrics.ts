/**
 * The operator's Prometheus metrics.
 *
 * Two groups:
 *   - how the operator itself is doing (reconciles, errors, queue depth, leadership),
 *   - how the backups are doing, per plan, computed at scrape time from the cached
 *     MongoShieldBackup objects. Alert on these, for example:
 *
 *       time() - mongoshield_backup_last_success_timestamp_seconds > 26 * 3600
 *
 *     fires when a daily plan has gone more than a day without a good backup.
 */

import type { Backup, Drill, Restore } from "./api/types.ts";
import { Counter, Gauge, Histogram, type Labels, Registry } from "./http/metrics.ts";

/** Sources the scrape-time gauges read from (the informer caches). */
export interface MetricSources {
  readonly backups: () => readonly Backup[];
  readonly restores: () => readonly Restore[];
  readonly drills: () => readonly Drill[];
  readonly queueDepths: () => readonly { controller: string; depth: number }[];
  readonly isLeader: () => boolean;
}

export class OperatorMetrics {
  readonly registry = new Registry();

  readonly reconciles = this.registry.add(
    new Counter(
      "mongoshield_operator_reconcile_total",
      "Reconcile calls by controller and result (success, requeue, conflict, error).",
    ),
  );

  readonly reconcileDuration = this.registry.add(
    new Histogram(
      "mongoshield_operator_reconcile_duration_seconds",
      "How long reconcile calls take.",
      [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    ),
  );

  readonly runsFinished = this.registry.add(
    new Counter(
      "mongoshield_operator_runs_finished_total",
      "Backup and restore runs the operator saw finish, by kind and phase.",
    ),
  );

  constructor(sources: MetricSources) {
    this.registry.add(
      new Gauge("mongoshield_operator_workqueue_depth", "Keys waiting in each work queue.", () =>
        sources.queueDepths().map((entry) => ({
          labels: { controller: entry.controller },
          value: entry.depth,
        })),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_operator_leader",
        "1 when this replica holds the leader lease and runs the controllers.",
        () => [{ labels: {}, value: sources.isLeader() ? 1 : 0 }],
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_backup_last_success_timestamp_seconds",
        "Completion time of the newest successful backup of each plan (Unix seconds).",
        () =>
          latestPerPlan(
            sources.backups(),
            (backup) => backup.status?.phase === "Succeeded",
            completionSeconds,
          ),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_backup_last_failure_timestamp_seconds",
        "Completion time of the newest failed backup of each plan (Unix seconds).",
        () =>
          latestPerPlan(
            sources.backups(),
            (backup) => backup.status?.phase === "Failed",
            completionSeconds,
          ),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_backup_last_size_bytes",
        "Bytes stored by the newest successful backup of each plan.",
        () =>
          latestPerPlan(
            sources.backups(),
            (backup) => backup.status?.phase === "Succeeded",
            (backup) => backup.status?.bytesStored ?? 0,
          ),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_backup_last_duration_seconds",
        "How long the newest successful backup of each plan took.",
        () =>
          latestPerPlan(
            sources.backups(),
            (backup) => backup.status?.phase === "Succeeded",
            (backup) => (backup.status?.durationMs ?? 0) / 1000,
          ),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_backups",
        "MongoShieldBackup objects by namespace, plan and phase.",
        () =>
          countBy(sources.backups(), (backup) => ({
            namespace: backup.metadata.namespace ?? "",
            plan: backup.spec.planRef.name,
            phase: backup.status?.phase ?? "Pending",
          })),
      ),
    );
    this.registry.add(
      new Gauge("mongoshield_restores", "MongoShieldRestore objects by namespace and phase.", () =>
        countBy(sources.restores(), (restore) => ({
          namespace: restore.metadata.namespace ?? "",
          phase: restore.status?.phase ?? "Pending",
        })),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_drills",
        "MongoShieldDrill objects by namespace, plan and phase.",
        () =>
          countBy(sources.drills(), (drill) => ({
            namespace: drill.metadata.namespace ?? "",
            plan: drill.spec.planRef.name,
            phase: drill.status?.phase ?? "Pending",
          })),
      ),
    );
    this.registry.add(
      new Gauge(
        "mongoshield_drill_last_rto_seconds",
        "Measured restore time (RTO) of the newest finished drill of each plan.",
        () => lastDrillRto(sources.drills()),
      ),
    );
  }

  /** The /metrics response body. */
  render(): string {
    return this.registry.render();
  }
}

/** A backup's completion time in Unix seconds (0 when unknown). */
function completionSeconds(backup: Backup): number {
  const time = backup.status?.completionTime;
  return time ? Date.parse(time) / 1000 : 0;
}

/** For each (namespace, plan): `value` of the newest backup matching `filter`. */
function latestPerPlan(
  backups: readonly Backup[],
  filter: (backup: Backup) => boolean,
  value: (backup: Backup) => number,
): { labels: Labels; value: number }[] {
  const newest = new Map<string, Backup>();
  for (const backup of backups) {
    if (!filter(backup)) continue;
    const key = `${backup.metadata.namespace}/${backup.spec.planRef.name}`;
    const current = newest.get(key);
    if (!current || completionSeconds(backup) > completionSeconds(current)) newest.set(key, backup);
  }
  return [...newest.values()].map((backup) => ({
    labels: { namespace: backup.metadata.namespace ?? "", plan: backup.spec.planRef.name },
    value: value(backup),
  }));
}

/** For each (namespace, plan): the RTO of the newest drill that measured one. */
function lastDrillRto(drills: readonly Drill[]): { labels: Labels; value: number }[] {
  const newest = new Map<string, Drill>();
  for (const drill of drills) {
    if (drill.status?.rtoMs === undefined) continue;
    const key = `${drill.metadata.namespace}/${drill.spec.planRef.name}`;
    const current = newest.get(key);
    const time = (candidate: Drill): string => candidate.status?.completionTime ?? "";
    if (!current || time(drill) > time(current)) newest.set(key, drill);
  }
  return [...newest.values()].map((drill) => ({
    labels: { namespace: drill.metadata.namespace ?? "", plan: drill.spec.planRef.name },
    value: (drill.status?.rtoMs ?? 0) / 1000,
  }));
}

/** Counts objects per label set. */
function countBy<T>(
  objects: readonly T[],
  labelsOf: (object: T) => Labels,
): { labels: Labels; value: number }[] {
  const counts = new Map<string, { labels: Labels; value: number }>();
  for (const object of objects) {
    const labels = labelsOf(object);
    const key = JSON.stringify(Object.entries(labels).sort());
    const entry = counts.get(key) ?? { labels, value: 0 };
    entry.value += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}
