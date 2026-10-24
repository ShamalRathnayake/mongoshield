/**
 * The run report: what one scheduled job did, as plain JSON-safe data.
 *
 * It is returned by `runScheduledJob`, printed by `mongoshield run --json`, and
 * sent as the body of webhook notifications, so its shape is a public contract
 * (documented in docs/guides/scheduling.md). It never contains secrets:
 * connection strings are not included and error messages are scrubbed.
 */

import type { GuardFinding } from "../engine/backup-guard.ts";
import type { VerifyMode, VerifyProblem } from "../types.ts";
import type { LockKind } from "./lock.ts";

/** Version of the report shape, bumped on incompatible changes. */
export const RUN_REPORT_VERSION = 1;

/**
 * - `success`: backed up (and verified and pruned, where enabled).
 * - `failure`: some step failed; `error` says which and why.
 * - `skipped`: another runner holds the lock. Normal with several replicas; not alerted.
 * - `checkpointed`: the backup used up its `backup.maxDurationMs` and saved a
 *   checkpoint; the next run resumes it. Not a failure (nothing was verified yet).
 */
export type RunStatus = "success" | "failure" | "skipped" | "checkpointed";

/**
 * How a scheduled run verifies its backup: the verify modes, or `"drill"`, a
 * restore into a scratch deployment that also measures the recovery time.
 */
export type ScheduledVerifyMode = VerifyMode | "drill";

/** The step a run was in when it failed. */
export type RunStep = "setup" | "lock" | "backup" | "verify" | "replicate" | "prune";

/** One scheduled run. */
export interface RunReport {
  readonly version: typeof RUN_REPORT_VERSION;
  /** Random id of this run, handy for correlating logs and notifications. */
  readonly runId: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** The machine that ran the job. */
  readonly host: string;
  /** Where backups are stored (the adapter's secret-free location). */
  readonly storage: string;
  readonly lock: {
    readonly kind: LockKind;
    /** When skipped: who holds the lock, if known. */
    readonly heldBy?: { readonly owner: string; readonly host: string; readonly expiresAt: string };
  };
  readonly backup?: {
    readonly id: string;
    /** `checkpointed` when the run stopped at its time budget (sizes cover finished parts). */
    readonly status?: "complete" | "checkpointed";
    /** Finished and total parts, for checkpointed backups. */
    readonly parts?: { readonly done: number; readonly total: number };
    readonly namespaces: number;
    readonly documents: number;
    readonly bytesRaw: number;
    readonly bytesStored: number;
    readonly durationMs: number;
    readonly attempts: number;
    /** `incremental` for a backup holding only the changes since `parent` (absent: full). */
    readonly kind?: "full" | "incremental";
    /** Incremental backups: the backup they continue. */
    readonly parent?: string;
    /** Incremental backups: the change events recorded. */
    readonly changes?: number;
    /** Set when the job takes incrementals but this run took a full backup: why. */
    readonly fullBackupReason?: string;
  };
  readonly guard?: {
    readonly ok: boolean;
    readonly action: "fail" | "warn";
    readonly baselineId?: string;
    readonly findings: readonly GuardFinding[];
  };
  readonly verify?: {
    readonly mode: ScheduledVerifyMode;
    readonly ok: boolean;
    readonly problems: readonly VerifyProblem[];
    readonly attempts: number;
    /**
     * Drills only: the measured recovery time (RTO), i.e. how long restoring the
     * backup into the scratch deployment took, in milliseconds.
     */
    readonly rtoMs?: number;
  };
  /** Off-site copies made after the backup (config `replicate`), one per target. */
  readonly replicate?: readonly {
    /** The destination, with secrets removed. */
    readonly location: string;
    readonly ok: boolean;
    readonly error?: string;
  }[];
  readonly prune?: {
    readonly deletedBackups: number;
    readonly deletedBytes: number;
    /** Backups of this job's scope that the policy kept. */
    readonly kept: number;
    /**
     * Backups of other sources or selections in the same storage location, which
     * this job's retention left alone (see `PruneScope`). Absent in reports of
     * releases before scoped retention.
     */
    readonly outOfScope?: number;
  };
  readonly error?: {
    readonly step: RunStep;
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    readonly attempts?: number;
  };
}

/** A one-line, human-readable summary of a report (used by chat notifications and the CLI). */
export function summarizeReport(report: RunReport): string {
  if (report.status === "skipped") {
    const holder = report.lock.heldBy ? ` by ${report.lock.heldBy.host}` : "";
    return `Skipped: the backup lock is held${holder}.`;
  }
  if (report.status === "failure") {
    const step = report.error?.step ?? "run";
    return `Backup failed during ${step}: ${report.error?.message ?? "unknown error"}`;
  }
  const backup = report.backup;
  if (report.status === "checkpointed") {
    const parts = backup?.parts ? ` (${backup.parts.done}/${backup.parts.total} parts done)` : "";
    return `Backup ${backup?.id ?? ""} checkpointed${parts}; the next run resumes it.`;
  }
  if (!backup) return "Backup succeeded.";
  const verified = report.verify ? `, verified (${verifyLabel(report.verify)})` : "";
  const pruned =
    report.prune && report.prune.deletedBackups > 0
      ? `, pruned ${report.prune.deletedBackups} old backup${report.prune.deletedBackups === 1 ? "" : "s"}`
      : "";
  if (backup.kind === "incremental") {
    const changes = (backup.changes ?? 0).toLocaleString("en-US");
    return `Incremental backup ${backup.id} succeeded: ${changes} changes since ${backup.parent ?? "its parent"}${verified}${pruned}.`;
  }
  return `Backup ${backup.id} succeeded: ${backup.namespaces} namespaces, ${backup.documents.toLocaleString("en-US")} documents${verified}${pruned}.`;
}

/**
 * `fast`, `deep`, or for drills `drill, RTO 42 s`: the verification as shown in
 * summaries and chat notifications.
 */
export function verifyLabel(verify: NonNullable<RunReport["verify"]>): string {
  if (verify.rtoMs === undefined) return verify.mode;
  return `${verify.mode}, RTO ${formatSeconds(verify.rtoMs)}`;
}

/** `1234` → `1.2 s`, `42000` → `42 s`: short and unit-explicit for notifications. */
function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}
