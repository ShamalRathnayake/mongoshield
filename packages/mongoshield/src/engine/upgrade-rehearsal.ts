/**
 * Upgrade rehearsals: proving a backup works on a newer MongoDB release before
 * production is upgraded. A rehearsal is a restore drill (drill.ts) with three
 * additions, in this order:
 *
 *   1. version     the target server must run the version being rehearsed
 *                  (upgrade-target.ts); a rehearsal on the old version proves nothing
 *   2. analysis    the static compatibility rules (upgrade-compat.ts) over the
 *                  backup's metadata, users, roles and stored JavaScript: what the
 *                  release notes say breaks or changes, decided before touching data
 *   3. drill       the normal drill (restore into temporary databases, counts,
 *                  indexes, views, a sample of documents byte for byte, your
 *                  assertions), plus the live checks only a newer server can answer
 *                  (upgrade-live.ts): `validate` on every collection, every view
 *                  queried, every validator evaluated, undefined values counted
 *
 * The analysis does not stop the restore: a geoHaystack index the analysis flags
 * also fails the restore, and seeing both is the proof. Problems from either side
 * fail the rehearsal; warnings do not.
 *
 * Where the target comes from (a scratch deployment or an ephemeral mongod) is the
 * caller's business (`MongoShield.rehearseUpgrade`); this engine gets a connected
 * client, like the drill engine.
 */

import type { DrillRecord } from "../catalog/annotations.ts";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { Manifest } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type {
  BackupSelector,
  DecryptionOptions,
  NamespacePattern,
  SourceOptions,
} from "../types.ts";
import type { EngineContext } from "./context.ts";
import {
  type DrillContext,
  type DrillOptions,
  type DrillProblem,
  type DrillReport,
  drillBackup,
  type RestoredScratch,
} from "./drill.ts";
import { drillRecordOf, storeDrillRecord } from "./drill-record.ts";
import { openBackupSource } from "./read-pipeline.ts";
import {
  analyzeUpgradeCompatibility,
  type BackedUpCollection,
  COMPATIBILITY_RULES,
  type CompatibilityReport,
  ruleApplies,
} from "./upgrade-compat.ts";
import { loadCompatibilityInput } from "./upgrade-inputs.ts";
import { runLiveChecks, type UpgradeCheck } from "./upgrade-live.ts";
import { assertServerVersion } from "./upgrade-target.ts";
import { parseServerVersion, parseTargetVersion } from "./upgrade-versions.ts";

/**
 * Documents per collection compared byte for byte when `sample` is not given.
 * Unlike plain drills (default 0) a rehearsal samples by default: whether documents
 * survive the new server unchanged is half of what it is for.
 */
export const DEFAULT_REHEARSAL_SAMPLE = 100;

/** Options of the static analysis alone (`MongoShield.checkUpgradeCompatibility`). */
export interface UpgradeCompatibilityOptions {
  readonly backup: BackupSelector;
  /** The release to upgrade to: `"8.0"` or `"8.0.13"`. */
  readonly targetVersion: string;
  readonly decryption?: DecryptionOptions;
  /** Only analyse these namespaces (as in restore and drills). */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  readonly signal?: AbortSignal;
}

/** The static analysis of one backup. */
export interface UpgradeCompatibilityResult extends CompatibilityReport {
  readonly backupId: string;
}

/**
 * Options of `rehearseUpgrade()`: a drill's options (except `allowSameDeployment`:
 * a rehearsal never runs on production, which still runs the old version) plus the
 * target version.
 */
export interface UpgradeRehearsalOptions extends Omit<DrillOptions, "allowSameDeployment"> {
  /** The release to upgrade to: `"8.0"`, or `"8.0.13"` to require that exact patch. */
  readonly targetVersion: string;
}

/** `shield.rehearseUpgrade()` options: where the newer server comes from. */
export interface ShieldUpgradeRehearsalOptions extends UpgradeRehearsalOptions {
  /**
   * A scratch deployment already running `targetVersion`. Leave it out to start an
   * ephemeral single-node replica set with mongodb-memory-server (an optional
   * dependency), which needs an exact `targetVersion` such as `"8.0.13"` unless
   * `mongodBinary` is given.
   */
  readonly target?: SourceOptions;
  /** The `mongod` binary of the ephemeral server, instead of a download. */
  readonly mongodBinary?: string;
}

/** Everything `rehearseUpgrade()` needs besides its options. */
export interface UpgradeRehearsalContext extends DrillContext {
  /** True when the client is an ephemeral server started for this rehearsal (for the report). */
  readonly ephemeral?: boolean;
}

/** The outcome of an upgrade rehearsal. */
export interface UpgradeRehearsalReport {
  readonly backupId: string;
  /** True when the analysis found no problems and the drill (with its live checks) passed. */
  readonly ok: boolean;
  /** When the rehearsal started (ISO 8601). */
  readonly startedAt: string;
  /** The whole rehearsal: analysis, drill, checks and cleanup. */
  readonly durationMs: number;
  /** The version the backup was taken from, as the manifest records it. */
  readonly sourceVersion: string;
  /** The version asked for, e.g. `"8.0"`. */
  readonly targetVersion: string;
  /** The version the target server actually runs, e.g. `"8.0.13"`. */
  readonly serverVersion: string;
  /** True when the target was an ephemeral server started for the rehearsal. */
  readonly ephemeral: boolean;
  /** The static analysis. */
  readonly compatibility: CompatibilityReport;
  /** The restore drill, with the live checks' problems among its problems. */
  readonly drill: DrillReport;
  /** Every live check and its outcome, passed ones included. */
  readonly checks: readonly UpgradeCheck[];
  /** Every problem: the analysis's (`subject` is the namespace, prefixed by the rule) and the drill's. */
  readonly problems: readonly DrillProblem[];
  /** Warnings from the analysis, the live checks and the drill. */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Static analysis alone
// ---------------------------------------------------------------------------

/**
 * Runs the compatibility analysis on a stored backup. Needs no database: only the
 * backup's metadata (and users, roles and stored JavaScript) are read.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for an invalid target version,
 *   `MS_BACKUP_NOT_FOUND`, `MS_NO_IDENTITY` (encrypted backup without keys).
 */
export async function checkUpgradeCompatibility(
  context: EngineContext,
  options: UpgradeCompatibilityOptions,
): Promise<UpgradeCompatibilityResult> {
  parseTargetVersion(options.targetVersion);
  const manifest = await loadManifest(context.storage, options.backup, context, options.signal);
  const { report } = await analyzeBackup(context.storage, manifest, options);
  return { backupId: manifest.id, ...report };
}

/** Reads a backup's definitions and runs the rules over them. */
async function analyzeBackup(
  storage: StorageAdapter,
  manifest: Manifest,
  options: Pick<
    UpgradeCompatibilityOptions,
    "targetVersion" | "decryption" | "include" | "exclude" | "signal"
  >,
): Promise<{ report: CompatibilityReport; collections: Map<string, BackedUpCollection> }> {
  const source = await openBackupSource(storage, manifest, options.decryption, {
    signal: options.signal,
  });
  const input = await loadCompatibilityInput(source, manifest, options.targetVersion, {
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const collections = new Map(input.collections.map((collection) => [collection.ns, collection]));
  return { report: analyzeUpgradeCompatibility(input), collections };
}

// ---------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------

/**
 * Rehearses an upgrade: checks the target's version, analyses the backup, then
 * drills it into the target with the version-specific live checks. See the header.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for an invalid target version, a target
 *   running another version, or a target that is the backup's source deployment;
 *   otherwise whatever `drillBackup()` throws. Findings are reported, not thrown.
 */
export async function rehearseUpgrade(
  context: UpgradeRehearsalContext,
  options: UpgradeRehearsalOptions,
): Promise<UpgradeRehearsalReport> {
  const startedAt = new Date();
  const clock = performance.now();
  const target = parseTargetVersion(options.targetVersion);
  throwIfAborted(options.signal);

  // 1. The target must run the version being rehearsed.
  const serverVersion = await assertServerVersion(
    context.client,
    target,
    context.ephemeral === true ? "the ephemeral server" : "--target-uri",
  );

  // 2. The static analysis.
  const manifest = await loadManifest(context.storage, options.backup, context, options.signal);
  const { report: compatibility, collections } = await analyzeBackup(
    context.storage,
    manifest,
    options,
  );
  context.logger.info("Upgrade rehearsal: compatibility analysis done", {
    backupId: manifest.id,
    from: manifest.source.serverVersion,
    to: serverVersion,
    problems: compatibility.findings.filter((finding) => finding.severity === "problem").length,
  });

  // 3. The drill, with the live checks run while the temporary databases exist.
  const checks: UpgradeCheck[] = [];
  const checkUndefined = undefinedCheckApplies(
    manifest.source.serverVersion,
    options.targetVersion,
  );
  const extraChecks = async (restored: RestoredScratch): Promise<DrillProblem[]> => {
    checks.push(
      ...(await runLiveChecks({
        client: restored.client,
        entries: restored.entries,
        collections,
        checkUndefined,
        signal: options.signal,
      })),
    );
    return checks
      .filter((check) => check.outcome === "problem")
      .map((check) => ({ subject: `${check.check}:${check.ns}`, problem: check.message }));
  };
  const drill = await drillBackup(
    { ...context, extraChecks },
    {
      ...options,
      // The exact backup analysed, even if a newer one was committed meanwhile.
      backup: manifest.id,
      sample: options.sample ?? DEFAULT_REHEARSAL_SAMPLE,
    },
  );

  const problems: DrillProblem[] = [
    ...compatibility.findings
      .filter((finding) => finding.severity === "problem")
      .map((finding) => ({
        subject: `${finding.rule}:${finding.subject}`,
        problem: finding.message,
      })),
    ...drill.problems,
  ];
  const warnings = [
    ...compatibility.findings
      .filter((finding) => finding.severity === "warning")
      .map((finding) => `${finding.subject}: ${finding.message}`),
    ...checks
      .filter((check) => check.outcome === "warning")
      .map((check) => `${check.ns}: ${check.message}`),
    ...drill.warnings,
    // The ephemeral server and its data directory are deleted right after the rehearsal.
    ...(drill.kept && context.ephemeral === true
      ? [
          "--keep has no lasting effect on an ephemeral server: it is deleted after the rehearsal (use --target-uri to inspect the restored data).",
        ]
      : []),
  ];
  return {
    backupId: manifest.id,
    ok: problems.length === 0,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - clock),
    sourceVersion: manifest.source.serverVersion,
    targetVersion: options.targetVersion,
    serverVersion,
    ephemeral: context.ephemeral === true,
    compatibility,
    drill,
    checks,
    problems,
    warnings,
  };
}

/** True when the upgrade crosses 8.0, where null stops matching undefined. */
function undefinedCheckApplies(sourceVersion: string, targetVersion: string): boolean {
  const rule = COMPATIBILITY_RULES.find((candidate) => candidate.id === "null-matches-undefined");
  return (
    rule !== undefined &&
    ruleApplies(rule, parseServerVersion(sourceVersion), parseTargetVersion(targetVersion))
  );
}

/** The manifest of the selected backup (as drills select it). */
async function loadManifest(
  storage: StorageAdapter,
  selector: BackupSelector,
  context: Pick<EngineContext, "logger">,
  signal: AbortSignal | undefined,
): Promise<Manifest> {
  const entries = await listBackups(storage, {
    logger: context.logger,
    ...(signal ? { signal } : {}),
  });
  const selected = selectBackup(entries, selector);
  if (selected.manifest === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }
  return selected.manifest;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Stores a rehearsal next to its backup as a drill record (it IS a drill, into a
 * newer server) with the versions and the analysis counts, so `inspect` and the
 * console show it in the drill history, marked with the version it proved.
 */
export async function recordUpgradeRehearsal(
  storage: StorageAdapter,
  report: UpgradeRehearsalReport,
  drilledAt: Date = new Date(),
): Promise<DrillRecord> {
  const findings = report.compatibility.findings;
  const record: DrillRecord = {
    ...drillRecordOf(report.drill, drilledAt),
    ok: report.ok,
    durationMs: Math.max(0, Math.round(report.durationMs)),
    problemCount: report.problems.length,
    targetVersion: report.serverVersion,
    sourceVersion: report.sourceVersion,
    compatibility: {
      problems: findings.filter((finding) => finding.severity === "problem").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
    },
  };
  return storeDrillRecord(storage, record);
}
