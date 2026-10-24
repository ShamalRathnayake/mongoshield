/**
 * The backup guard: refuses to commit a backup that looks like data was lost.
 *
 * Unattended backups have a nasty failure mode: someone (or a bug) drops a
 * collection or deletes most of its documents, the nightly backup faithfully
 * captures the damage, and retention then prunes the last good copies. The
 * guard compares the backup about to be committed with the previous one and
 * stops (or warns) when a collection vanished or shrank more than allowed.
 *
 *   checkBackupSanity   pure comparison of two manifests (easy to test)
 *   findGuardBaseline   picks the "previous" backup to compare with
 *   enforceBackupGuard  baseline + comparison + the configured action
 *
 * ## Which backup is "previous"?
 *
 * Comparing against an unrelated backup produces false alarms (a backup of
 * `app.*` compared with one of `analytics.*` would report every collection as
 * missing). The baseline is therefore the NEWEST backup that:
 *
 *   1. is complete (has a valid manifest) and is not the candidate itself,
 *   2. started before the candidate,
 *   3. has the same "shape": the same include/exclude patterns and the same
 *      namespaces with a `query`. The shape is a short hash stored in the
 *      `mongoshield.shape` label (see `backupShapeLabel`). Backups without the
 *      label only match other backups without it.
 *   4. comes from the same deployment, when both manifests record a `clusterId`.
 *
 * The baseline does not have to be verified: the guard is about the source
 * data shrinking, not about the previous backup's integrity.
 *
 * Incremental backups hold change events, not collections: they are never a baseline,
 * and an incremental candidate is not checked (it has no document counts to compare).
 * The next full backup is compared with the previous full one.
 */

import { createHash } from "node:crypto";
import { listBackups } from "../catalog/catalog.ts";
import { MongoShieldError } from "../errors.ts";
import { isIncrementalManifest, type Manifest } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** What the guard checks. Mirrors the `guard` section of the config file. */
export interface BackupGuardPolicy {
  /** Flag any collection that lost more than this percentage of its documents. */
  readonly maxDocumentDropPercent?: number;
  /** Flag a drop of the backup's total raw (uncompressed BSON) size of more than this percentage. */
  readonly maxSizeDropPercent?: number;
  /** Flag namespaces present in the previous backup but missing now. Defaults to true. */
  readonly failOnMissingCollection?: boolean;
  /** `"fail"` (default) refuses to commit the backup; `"warn"` only logs the findings. */
  readonly action?: "fail" | "warn";
}

/** One thing the guard noticed. `ns` is absent for whole-backup findings (total size). */
export interface GuardFinding {
  readonly ns?: string;
  readonly message: string;
}

/** The outcome of comparing two manifests. */
export interface GuardCheck {
  /** True when nothing was flagged. */
  readonly ok: boolean;
  readonly findings: readonly GuardFinding[];
}

/** The outcome of {@link enforceBackupGuard}: the check plus what it was compared with. */
export interface GuardResult extends GuardCheck {
  /** The id of the backup the candidate was compared with, if one was found. */
  readonly baselineId: string | undefined;
  /** The action that applied (`"fail"` or `"warn"`). */
  readonly action: "fail" | "warn";
}

/**
 * A callback the backup engine runs with the finished manifest, right BEFORE
 * writing it (the commit). Throwing aborts the run: the engine deletes the
 * files it wrote and rethrows, so nothing that the hook refused is ever committed.
 * The scheduler uses it to run {@link enforceBackupGuard}.
 */
export type BeforeCommitHook = (
  manifest: Manifest,
  options: { readonly signal?: AbortSignal },
) => Promise<void>;

/**
 * The label that records a backup's include/exclude shape. Labels are free-form
 * and already part of the manifest, so this needs no format change.
 */
export const GUARD_SHAPE_LABEL = "mongoshield.shape";

/** The namespace selection of a backup, as far as the shape is concerned. */
export interface BackupShapeInput {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  /** Only the KEYS matter: query values often contain "now minus 30 days" and change every run. */
  readonly query?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The `mongoshield.shape` label value for a namespace selection: the first 12
 * hex digits of a SHA-256 over the sorted patterns. Order does not matter
 * (`include: [a, b]` and `[b, a]` select the same namespaces). Patterns are not
 * secret, but a hash keeps the label short however many patterns there are.
 */
export function backupShapeLabel(selection: BackupShapeInput): string {
  const canonical = JSON.stringify({
    include: [...(selection.include ?? [])].sort(),
    exclude: [...(selection.exclude ?? [])].sort(),
    query: Object.keys(selection.query ?? {}).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * `labels` plus the `mongoshield.shape` label of `selection`. Every backup the
 * scheduler and `mongoshield backup` write carries it: the guard uses it to find a
 * comparable baseline, and retention uses it to prune each selection on its own
 * (see catalog/scope.ts). The computed shape wins over a hand-written label of the
 * same name, so the label always describes what was really selected.
 */
export function withShapeLabel(
  labels: Readonly<Record<string, string>> | undefined,
  selection: BackupShapeInput,
): Record<string, string> {
  return { ...labels, [GUARD_SHAPE_LABEL]: backupShapeLabel(selection) };
}

/**
 * Compares the backup about to be committed (`current`) with the previous one.
 * Pure: no I/O, no clock. With no previous backup there is nothing to compare,
 * so the result is always ok.
 */
export function checkBackupSanity(
  previous: Manifest | undefined,
  current: Manifest,
  policy: BackupGuardPolicy,
): GuardCheck {
  if (previous === undefined) return { ok: true, findings: [] };

  const findings: GuardFinding[] = [];
  const currentByNs = new Map(current.namespaces.map((entry) => [entry.ns, entry]));
  const failOnMissing = policy.failOnMissingCollection ?? true;

  for (const before of previous.namespaces) {
    const after = currentByNs.get(before.ns);
    if (after === undefined) {
      if (failOnMissing) {
        findings.push({
          ns: before.ns,
          message: `${before.ns} was in backup ${previous.id} (${formatCount(before.documents)} documents) but is missing now.`,
        });
      }
      continue;
    }

    const limit = policy.maxDocumentDropPercent;
    const drop = dropPercent(before.documents, after.documents);
    if (limit !== undefined && drop !== undefined && drop > limit) {
      findings.push({
        ns: before.ns,
        message: `${before.ns} shrank from ${formatCount(before.documents)} to ${formatCount(after.documents)} documents (-${formatPercent(drop)}), more than the allowed ${formatPercent(limit)}.`,
      });
    }
  }

  const sizeLimit = policy.maxSizeDropPercent;
  const sizeDrop = dropPercent(previous.totals.bytesRaw, current.totals.bytesRaw);
  if (sizeLimit !== undefined && sizeDrop !== undefined && sizeDrop > sizeLimit) {
    findings.push({
      message: `The backup's raw size shrank from ${formatCount(previous.totals.bytesRaw)} to ${formatCount(current.totals.bytesRaw)} bytes (-${formatPercent(sizeDrop)}), more than the allowed ${formatPercent(sizeLimit)}.`,
    });
  }

  return { ok: findings.length === 0, findings };
}

/**
 * Finds the backup to compare `candidate` with (see the file header for the
 * rules). Returns `undefined` when there is none, e.g. for the very first backup.
 */
export async function findGuardBaseline(
  storage: StorageAdapter,
  candidate: Manifest,
  options: { readonly signal?: AbortSignal; readonly logger?: Logger } = {},
): Promise<Manifest | undefined> {
  const entries = await listBackups(storage, options);
  // listBackups returns newest first, so the first match is the newest one.
  for (const entry of entries) {
    if (entry.manifest !== undefined && isComparable(entry.manifest, candidate)) {
      return entry.manifest;
    }
  }
  return undefined;
}

/** True if `other` is a valid baseline for `candidate` (rules 1–4 of the file header). */
export function isComparable(other: Manifest, candidate: Manifest): boolean {
  if (other.id === candidate.id) return false;
  // Incrementals list no collections, so every collection would look missing.
  if (isIncrementalManifest(other)) return false;
  if (Date.parse(other.startedAt) >= Date.parse(candidate.startedAt)) return false;
  if (other.labels[GUARD_SHAPE_LABEL] !== candidate.labels[GUARD_SHAPE_LABEL]) return false;

  const otherCluster = other.source.clusterId;
  const candidateCluster = candidate.source.clusterId;
  if (otherCluster !== undefined && candidateCluster !== undefined) {
    return otherCluster === candidateCluster;
  }
  return true;
}

/** What {@link enforceBackupGuard} needs. */
export interface EnforceGuardOptions {
  readonly storage: StorageAdapter;
  /** The manifest about to be written (not yet in storage). */
  readonly candidate: Manifest;
  readonly policy: BackupGuardPolicy;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/**
 * Compares a backup about to be committed with its baseline and logs every
 * finding as a warning. Never throws for findings; see {@link enforceBackupGuard}.
 */
export async function evaluateBackupGuard(options: EnforceGuardOptions): Promise<GuardResult> {
  const logger = options.logger ?? silentLogger;
  const action = options.policy.action ?? "fail";
  if (isIncrementalManifest(options.candidate)) {
    logger.debug("Backup guard: incremental backups are not checked", {
      id: options.candidate.id,
    });
    return { ok: true, findings: [], baselineId: undefined, action };
  }
  const baseline = await findGuardBaseline(options.storage, options.candidate, {
    logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const check = checkBackupSanity(baseline, options.candidate, options.policy);
  const result: GuardResult = { ...check, baselineId: baseline?.id, action };

  if (baseline === undefined) {
    logger.debug("Backup guard: no previous backup with the same shape to compare with", {
      id: options.candidate.id,
    });
  } else if (check.ok) {
    logger.debug("Backup guard passed", { id: options.candidate.id, baseline: baseline.id });
  } else {
    for (const finding of check.findings) {
      logger.warn(`Backup guard: ${finding.message}`, { id: options.candidate.id });
    }
  }
  return result;
}

/**
 * Runs the guard for a backup about to be committed.
 *
 * With action `"warn"` findings are only logged. With action `"fail"` (the
 * default) findings make it throw, so the backup engine deletes the run's
 * files instead of writing the manifest.
 *
 * @throws MongoShieldError `MS_GUARD_FAILED` with `details.guard` listing
 *   the findings, when the action is `"fail"` and something was flagged.
 */
export async function enforceBackupGuard(options: EnforceGuardOptions): Promise<GuardResult> {
  const result = await evaluateBackupGuard(options);
  if (!result.ok && result.action === "fail") throw guardFailedError(options.candidate.id, result);
  return result;
}

/** The error thrown when the guard refuses a backup. */
export function guardFailedError(backupId: string, result: GuardResult): MongoShieldError {
  const count = result.findings.length;
  const first = result.findings[0]?.message ?? "";
  return new MongoShieldError(
    "MS_GUARD_FAILED",
    `The backup guard refused to commit backup ${backupId}: ${count === 1 ? first : `${count} problems, e.g. ${first}`}`,
    {
      hint: 'If the change is intended, run the backup once with the guard action set to "warn" (guard.action), or raise the thresholds.',
      details: { guard: result.findings, baselineId: result.baselineId },
    },
  );
}

/**
 * Percentage lost going from `before` to `after`, or `undefined` when nothing
 * can be lost (an empty baseline) or nothing was (growth).
 */
function dropPercent(before: number, after: number): number | undefined {
  if (before <= 0 || after >= before) return undefined;
  return ((before - after) / before) * 100;
}

/** `12.5%`, with at most one decimal (and none for whole numbers). */
function formatPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

/** `1,234,567` (locale-independent so messages are stable in tests and logs). */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
