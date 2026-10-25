/**
 * What each public operation reports to OpenTelemetry.
 *
 * `MongoShield` wraps every public method in one of these functions, so shield.ts
 * stays about orchestration and this file is the single place that says which
 * span, attributes and metrics an operation produces (the list in
 * docs/guides/observability.md is written from it).
 *
 * Every function runs the operation inside a `mongoshield.<operation>` span,
 * returns its result unchanged and rethrows its error unchanged. Metrics are
 * recorded after the operation settles, so they never delay or alter it.
 */

import type { PruneResult } from "../catalog/prune.ts";
import type { DrillReport } from "../engine/drill.ts";
import type { Manifest } from "../format/manifest.ts";
import type { BackupResult, RestoreResult, VerifyMode, VerifyReport } from "../types.ts";
import { ATTRIBUTES, spanName } from "./names.ts";
import { errorTypeOf, type Telemetry, type TelemetryAttributes } from "./telemetry.ts";

/** Error code put on spans of operations that finished but found problems. */
const PROBLEMS_FOUND = "MS_INTEGRITY_FAILED";

/** Milliseconds since `start` (a `performance.now()` value). */
function since(start: number): number {
  return performance.now() - start;
}

/**
 * Traces a backup. Span attributes: id, outcome (`complete` or `checkpointed`),
 * consistency mode, namespace count (names only with `includeNamespaces`),
 * documents, raw and stored bytes. Metrics: `mongoshield.backups{status}` and
 * `mongoshield.backup.duration{status}` with status `success`, `checkpointed` or
 * `failure`, plus `mongoshield.documents` and `mongoshield.bytes{kind}`.
 *
 * Documents and bytes are counted only when a backup completes: a resumed backup's
 * totals include the work of its earlier, checkpointed invocations, so counting
 * checkpoints too would count the same documents twice.
 */
export async function traceBackup(
  telemetry: Telemetry,
  run: () => Promise<BackupResult>,
): Promise<BackupResult> {
  const start = performance.now();
  try {
    const result = await telemetry.withSpan(spanName("backup"), {}, async (span) => {
      const backup = await run();
      span.setAttributes(backupAttributes(telemetry, backup));
      return backup;
    });
    const status = result.status === "complete" ? "success" : "checkpointed";
    await telemetry.count("backups", 1, { [ATTRIBUTES.status]: status });
    await telemetry.recordDuration("backupDuration", since(start), { [ATTRIBUTES.status]: status });
    if (result.status === "complete") await countBackupTotals(telemetry, result.manifest.totals);
    return result;
  } catch (error) {
    const failure = { [ATTRIBUTES.status]: "failure", [ATTRIBUTES.errorType]: errorTypeOf(error) };
    await telemetry.count("backups", 1, failure);
    await telemetry.recordDuration("backupDuration", since(start), failure);
    throw error;
  }
}

/**
 * Traces a restore. Span attributes: backup id, mode, dry run, documents restored.
 * Metrics: `mongoshield.restore.duration{status}` (real restores only) and
 * `mongoshield.documents` for the restore operation.
 */
export async function traceRestore(
  telemetry: Telemetry,
  details: { readonly mode: string; readonly dryRun: boolean },
  run: () => Promise<RestoreResult>,
): Promise<RestoreResult> {
  const start = performance.now();
  const attributes = { [ATTRIBUTES.mode]: details.mode, [ATTRIBUTES.dryRun]: details.dryRun };
  try {
    const result = await telemetry.withSpan(spanName("restore"), attributes, async (span) => {
      const restored = await run();
      span.setAttributes({
        [ATTRIBUTES.backupId]: restored.plan.backupId,
        [ATTRIBUTES.namespaceCount]: restored.plan.entries.length,
        [ATTRIBUTES.documents]: restored.documentsRestored,
        ...namespaceNames(
          telemetry,
          restored.plan.entries.map((entry) => entry.to),
        ),
      });
      return restored;
    });
    if (!result.dryRun) {
      await telemetry.recordDuration("restoreDuration", result.durationMs, {
        [ATTRIBUTES.status]: "success",
      });
      await telemetry.count("documents", result.documentsRestored, {
        [ATTRIBUTES.operation]: "restore",
      });
    }
    return result;
  } catch (error) {
    if (!details.dryRun) {
      await telemetry.recordDuration("restoreDuration", since(start), {
        [ATTRIBUTES.status]: "failure",
        [ATTRIBUTES.errorType]: errorTypeOf(error),
      });
    }
    throw error;
  }
}

/**
 * Traces a verification. A report with problems marks the span failed
 * (`error.type` MS_INTEGRITY_FAILED) without throwing, so alerts on failed spans
 * catch damaged backups. Metrics: documents and bytes checked.
 */
export async function traceVerify(
  telemetry: Telemetry,
  mode: VerifyMode,
  run: () => Promise<VerifyReport>,
): Promise<VerifyReport> {
  const report = await telemetry.withSpan(
    spanName("verify"),
    { [ATTRIBUTES.mode]: mode },
    async (span) => {
      const verified = await run();
      span.setAttributes(verifyAttributes(verified));
      if (!verified.ok) span.fail(PROBLEMS_FOUND);
      return verified;
    },
  );
  const operation = { [ATTRIBUTES.operation]: "verify" };
  await telemetry.count("documents", report.documentsChecked, operation);
  await telemetry.count("bytes", report.bytesChecked, {
    ...operation,
    [ATTRIBUTES.bytesKind]: "stored",
  });
  return report;
}

function verifyAttributes(report: VerifyReport): TelemetryAttributes {
  return {
    [ATTRIBUTES.backupId]: report.backupId,
    [ATTRIBUTES.ok]: report.ok,
    [ATTRIBUTES.filesChecked]: report.filesChecked,
    [ATTRIBUTES.bytesChecked]: report.bytesChecked,
    [ATTRIBUTES.documents]: report.documentsChecked,
    [ATTRIBUTES.problems]: report.problems.length,
  };
}

/** Traces a prune: dry run, backups and bytes deleted. */
export async function tracePrune(
  telemetry: Telemetry,
  dryRun: boolean,
  run: () => Promise<PruneResult>,
): Promise<PruneResult> {
  return telemetry.withSpan(spanName("prune"), { [ATTRIBUTES.dryRun]: dryRun }, async (span) => {
    const result = await run();
    span.setAttributes({
      [ATTRIBUTES.deletedBackups]: result.deletedBackups,
      [ATTRIBUTES.deletedBytes]: result.deletedBytes,
    });
    return result;
  });
}

/**
 * Traces a restore drill. The measured RTO is a span attribute and a point on the
 * restore-duration histogram (attribute `mongoshield.drill: true`), so recovery
 * time can be charted and alerted on next to real restores. A failed drill marks
 * the span failed without throwing, like verify.
 */
export async function traceDrill(
  telemetry: Telemetry,
  run: () => Promise<DrillReport>,
): Promise<DrillReport> {
  const report = await telemetry.withSpan(spanName("drill"), {}, async (span) => {
    const drilled = await run();
    span.setAttributes({
      [ATTRIBUTES.backupId]: drilled.backupId,
      [ATTRIBUTES.ok]: drilled.ok,
      [ATTRIBUTES.rtoMs]: drilled.restoreDurationMs,
      [ATTRIBUTES.namespaceCount]: drilled.namespaces.length,
      [ATTRIBUTES.documents]: drilled.documentsRestored,
      [ATTRIBUTES.problems]: drilled.problems.length,
    });
    if (!drilled.ok) span.fail(PROBLEMS_FOUND);
    return drilled;
  });
  if (report.restored) {
    await telemetry.recordDuration("restoreDuration", report.restoreDurationMs, {
      [ATTRIBUTES.status]: report.ok ? "success" : "failure",
      [ATTRIBUTES.drill]: true,
    });
  }
  await telemetry.count("documents", report.documentsRestored, { [ATTRIBUTES.operation]: "drill" });
  return report;
}

/** Span attributes of a finished backup invocation. */
function backupAttributes(telemetry: Telemetry, backup: BackupResult): TelemetryAttributes {
  if (backup.status === "checkpointed") {
    return {
      [ATTRIBUTES.backupId]: backup.id,
      [ATTRIBUTES.backupStatus]: backup.status,
      [ATTRIBUTES.documents]: backup.checkpoint.documents,
      [ATTRIBUTES.bytesRaw]: backup.checkpoint.bytesRaw,
    };
  }
  const { manifest } = backup;
  return {
    [ATTRIBUTES.backupId]: backup.id,
    [ATTRIBUTES.backupStatus]: backup.status,
    [ATTRIBUTES.consistency]: manifest.consistency.mode,
    [ATTRIBUTES.namespaceCount]: manifest.totals.namespaces,
    [ATTRIBUTES.documents]: manifest.totals.documents,
    [ATTRIBUTES.bytesRaw]: manifest.totals.bytesRaw,
    [ATTRIBUTES.bytesStored]: manifest.totals.bytesStored,
    ...namespaceNames(
      telemetry,
      manifest.namespaces.map((entry) => entry.ns),
    ),
  };
}

/** Adds a completed backup's documents and bytes to the counters. */
async function countBackupTotals(telemetry: Telemetry, totals: Manifest["totals"]): Promise<void> {
  const operation = { [ATTRIBUTES.operation]: "backup" };
  await telemetry.count("documents", totals.documents, operation);
  await telemetry.count("bytes", totals.bytesRaw, { ...operation, [ATTRIBUTES.bytesKind]: "raw" });
  await telemetry.count("bytes", totals.bytesStored, {
    ...operation,
    [ATTRIBUTES.bytesKind]: "stored",
  });
}

/** The namespace-names attribute, only when the user allowed names in telemetry. */
function namespaceNames(telemetry: Telemetry, names: readonly string[]): TelemetryAttributes {
  return telemetry.includeNamespaces ? { [ATTRIBUTES.namespaceNames]: names } : {};
}
