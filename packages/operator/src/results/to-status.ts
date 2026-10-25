/**
 * Turning a finished Job's result into the status of its MongoShieldBackup or
 * MongoShieldRestore.
 *
 * Pure functions, so every combination (report says success, report says failure,
 * no report but exit code 0, no report and a failed Job, …) is unit tested.
 */

import type {
  BackupPhase,
  BackupStatus,
  DrillStatus,
  RestorePhase,
  RestoreStatus,
  RunError,
} from "../api/types.ts";
import type { JobResult, JobState } from "./job-result.ts";
import type { RunReportOutput } from "./parse.ts";

/** How many verification problems are copied into the status (the rest are counted). */
const MAX_PROBLEMS_IN_STATUS = 5;

/** The terminal part of a backup status, plus the reason for its conditions. */
export interface BackupOutcome {
  readonly phase: Extract<BackupPhase, "Succeeded" | "Checkpointed" | "Skipped" | "Failed">;
  /** CamelCase reason for the Complete/Failed condition. */
  readonly reason: string;
  /** One line for humans (condition message and event). */
  readonly message: string;
  readonly fields: Partial<BackupStatus>;
}

/** Works out a backup's outcome from its finished Job. */
export function backupOutcome(state: JobState, result: JobResult): BackupOutcome {
  const output = result.output;
  if (output.kind === "run") return outcomeFromReport(output.report, result);
  if (output.kind === "error") {
    const error: RunError = {
      code: output.error.code,
      message: output.error.message,
      ...(output.error.hint ? { hint: output.error.hint } : {}),
      ...exitCodeField(output.error.exitCode ?? result.exitCode),
    };
    return {
      phase: "Failed",
      reason: "BackupFailed",
      message: errorLine(error),
      fields: { error },
    };
  }
  // No JSON document: fall back to what Kubernetes knows.
  if (state.phase === "succeeded") {
    return {
      phase: "Succeeded",
      reason: "ResultUnavailable",
      message: `The Job succeeded, but its result could not be read (${result.logError ?? "no JSON output in the pod log"}).`,
      fields: {},
    };
  }
  const error = jobFailureError(state, result);
  return { phase: "Failed", reason: "JobFailed", message: errorLine(error), fields: { error } };
}

/** Maps a MongoShield run report onto a backup status. */
function outcomeFromReport(report: RunReportOutput, result: JobResult): BackupOutcome {
  const fields: Partial<BackupStatus> = {
    runId: report.runId,
    ...(report.storage ? { storage: report.storage } : {}),
    ...backupFields(report),
    ...verificationFields(report),
    ...(report.prune
      ? { prune: { deletedBackups: report.prune.deletedBackups, kept: report.prune.kept } }
      : {}),
  };

  switch (report.status) {
    case "success":
      return {
        phase: "Succeeded",
        reason: report.verify && !report.verify.ok ? "VerificationFailed" : "BackupSucceeded",
        message: `Backup ${report.backup?.id ?? "?"} complete${report.verify ? `, verify ${report.verify.mode}: ${report.verify.ok ? "ok" : "problems found"}` : ""}.`,
        fields,
      };
    case "checkpointed":
      return {
        phase: "Checkpointed",
        reason: "BackupCheckpointed",
        message: `Backup ${report.backup?.id ?? "?"} reached its time budget${report.backup?.parts ? ` at ${report.backup.parts.done}/${report.backup.parts.total} parts` : ""}; the next run resumes it.`,
        fields,
      };
    case "skipped":
      return {
        phase: "Skipped",
        reason: "LockHeld",
        message: `Skipped: another run holds the backup lock${report.lock?.heldBy?.host ? ` (${report.lock.heldBy.host})` : ""}.`,
        fields,
      };
    case "failure": {
      const error: RunError = {
        code: report.error?.code ?? "MS_UNKNOWN",
        message: report.error?.message ?? "the run failed",
        ...(report.error?.hint ? { hint: report.error.hint } : {}),
        ...(report.error?.step ? { step: report.error.step } : {}),
        ...exitCodeField(result.exitCode),
      };
      return {
        phase: "Failed",
        reason: "BackupFailed",
        message: errorLine(error),
        fields: { ...fields, error },
      };
    }
  }
}

/** Sizes and counts of the backup in a report. */
function backupFields(report: RunReportOutput): Partial<BackupStatus> {
  const backup = report.backup;
  if (!backup) return {};
  return {
    backupId: backup.id,
    durationMs: backup.durationMs,
    namespaces: backup.namespaces,
    documents: backup.documents,
    bytesRaw: backup.bytesRaw,
    bytesStored: backup.bytesStored,
    ...(backup.kind ? { kind: backup.kind } : {}),
    ...(backup.parent ? { parentBackupId: backup.parent } : {}),
    ...(backup.changes !== undefined ? { changes: backup.changes } : {}),
    ...(backup.fullBackupReason ? { fullBackupReason: backup.fullBackupReason } : {}),
  };
}

/** The verification summary of a report. */
function verificationFields(report: RunReportOutput): Partial<BackupStatus> {
  const verify = report.verify;
  if (!verify) return {};
  const problems = verify.problems
    .slice(0, MAX_PROBLEMS_IN_STATUS)
    .map((problem) => `${problem.subject}: ${problem.problem}`);
  return {
    verification: {
      mode: verify.mode,
      ok: verify.ok,
      problemCount: verify.problems.length,
      ...(problems.length > 0 ? { problems } : {}),
      ...(verify.rtoMs !== undefined ? { rtoMs: verify.rtoMs } : {}),
    },
  };
}

/** The terminal part of a restore status. */
export interface RestoreOutcome {
  readonly phase: Extract<RestorePhase, "Succeeded" | "Failed">;
  readonly reason: string;
  readonly message: string;
  readonly fields: Partial<RestoreStatus>;
}

/** Works out a restore's outcome from its finished Job. */
export function restoreOutcome(state: JobState, result: JobResult): RestoreOutcome {
  const output = result.output;
  if (output.kind === "restore") {
    const restored = output.result;
    const fields: Partial<RestoreStatus> = {
      backupId: restored.plan.backupId,
      dryRun: restored.dryRun,
      documentsRestored: restored.documentsRestored,
      durationMs: restored.durationMs,
      namespaces: restored.plan.entries.length,
    };
    return {
      phase: "Succeeded",
      reason: restored.dryRun ? "DryRunSucceeded" : "RestoreSucceeded",
      message: restored.dryRun
        ? `Dry run of ${restored.plan.backupId}: ${restored.plan.entries.length} namespace(s) planned, nothing written.`
        : `Restored ${restored.documentsRestored} document(s) from ${restored.plan.backupId} into ${restored.plan.entries.length} namespace(s).`,
      fields,
    };
  }
  if (output.kind === "error") {
    const error: RunError = {
      code: output.error.code,
      message: output.error.message,
      ...(output.error.hint ? { hint: output.error.hint } : {}),
      ...exitCodeField(output.error.exitCode ?? result.exitCode),
    };
    return {
      phase: "Failed",
      reason: "RestoreFailed",
      message: errorLine(error),
      fields: { error },
    };
  }
  if (state.phase === "succeeded") {
    return {
      phase: "Succeeded",
      reason: "ResultUnavailable",
      message: `The Job succeeded, but its result could not be read (${result.logError ?? "no JSON output in the pod log"}).`,
      fields: {},
    };
  }
  const error = jobFailureError(state, result);
  return { phase: "Failed", reason: "JobFailed", message: errorLine(error), fields: { error } };
}

/** The terminal part of a drill status. */
export interface DrillOutcome {
  readonly phase: "Succeeded" | "Failed";
  readonly reason: string;
  readonly message: string;
  readonly fields: Partial<DrillStatus>;
}

/**
 * Works out a drill's outcome. A drill that ran but found problems is `Failed` with
 * reason `DrillFoundProblems` (MongoShield exits 33 then, after printing the report).
 */
export function drillOutcome(state: JobState, result: JobResult): DrillOutcome {
  const output = result.output;
  if (output.kind === "drill") {
    const report = output.report;
    const problems = report.problems
      .slice(0, MAX_PROBLEMS_IN_STATUS)
      .map((problem) => `${problem.subject}: ${problem.problem}`);
    const fields: Partial<DrillStatus> = {
      backupId: report.backupId,
      ok: report.ok,
      rtoMs: report.restoreDurationMs,
      durationMs: report.durationMs,
      documentsRestored: report.documentsRestored,
      namespaces: report.namespaces.length,
      problemCount: report.problems.length,
      ...(problems.length > 0 ? { problems } : {}),
    };
    return report.ok
      ? {
          phase: "Succeeded",
          reason: "DrillPassed",
          message: `Drill of ${report.backupId} passed: restored ${report.documentsRestored} document(s) in ${report.restoreDurationMs} ms (RTO).`,
          fields,
        }
      : {
          phase: "Failed",
          reason: "DrillFoundProblems",
          message: `Drill of ${report.backupId} found ${report.problems.length} problem(s)${problems[0] ? `: ${problems[0]}` : ""}.`,
          fields,
        };
  }
  // No drill report: the same fallbacks as a restore (error document, Job state).
  const generic = restoreOutcome(state, result);
  return {
    phase: generic.phase,
    reason: generic.reason === "RestoreFailed" ? "DrillFailed" : generic.reason,
    message: generic.message,
    fields: generic.fields.error ? { error: generic.fields.error } : {},
  };
}

/** What a finished data-deletion Job did. */
export type DeletionOutcome =
  | { readonly kind: "deleted"; readonly message: string }
  | { readonly kind: "refused"; readonly error: RunError; readonly message: string };

/**
 * Works out whether a `mongoshield delete` Job removed the backup. A backup that is
 * already gone (MS_BACKUP_NOT_FOUND) counts as deleted: the goal is reached.
 */
export function deletionOutcome(state: JobState, result: JobResult): DeletionOutcome {
  const output = result.output;
  if (output.kind === "delete") {
    return {
      kind: "deleted",
      message: `Deleted backup ${output.result.id} from storage: ${output.result.deletedObjects} object(s), ${output.result.deletedBytes} bytes.`,
    };
  }
  if (output.kind === "error" && output.error.code === "MS_BACKUP_NOT_FOUND") {
    return { kind: "deleted", message: "The backup was already gone from storage." };
  }
  if (output.kind === "error") {
    const error: RunError = {
      code: output.error.code,
      message: output.error.message,
      ...(output.error.hint ? { hint: output.error.hint } : {}),
      ...exitCodeField(output.error.exitCode ?? result.exitCode),
    };
    return { kind: "refused", error, message: errorLine(error) };
  }
  if (state.phase === "succeeded") {
    return {
      kind: "deleted",
      message: "The deletion Job succeeded (its result could not be read).",
    };
  }
  const error = jobFailureError(state, result);
  return { kind: "refused", error, message: errorLine(error) };
}

/** An error for a failed Job without a MongoShield report (killed, deadline, OOM, …). */
function jobFailureError(state: JobState, result: JobResult): RunError {
  const why =
    result.terminationMessage ??
    (state.phase === "failed" ? state.message : undefined) ??
    result.logError ??
    "the Job failed without a result";
  const reason = state.phase === "failed" && state.reason ? `${state.reason}: ` : "";
  return {
    code: "JOB_FAILED",
    // The tail of a failed pod's log can be long; the first part is enough here.
    message: `${reason}${why}`.slice(0, 4000),
    ...exitCodeField(result.exitCode),
  };
}

/** `{ exitCode }` when known. */
function exitCodeField(exitCode: number | undefined): { exitCode?: number } {
  return exitCode === undefined ? {} : { exitCode };
}

/** "MS_CODE: message" for conditions and events. */
function errorLine(error: RunError): string {
  return `${error.code}: ${error.message}`;
}
