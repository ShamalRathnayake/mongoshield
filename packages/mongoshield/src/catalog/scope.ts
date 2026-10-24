/**
 * Retention scopes: which backups in a storage location one retention policy is about.
 *
 * Several jobs often share one storage location: two `mongoshield run` jobs for
 * different databases or clusters, two console plans, a nightly full backup next
 * to an hourly backup of one collection. Each job's retention must only ever see
 * its own backups; otherwise "keep the last 3" of the hourly job deletes the
 * nightly job's backups (they are simply older).
 *
 * A scope selects backups by what their manifest records about where they came
 * from:
 *
 *   clusterId   manifest.source.clusterId (a hash identifying the deployment)
 *   labels      manifest.labels, e.g. `mongoshield.shape` (the include/exclude
 *               selection, see engine/backup-guard.ts) or `mongoshield.plan`
 *               (the console plan that wrote the backup)
 *
 * Every field the scope gives must match; fields it leaves out match anything.
 * A backup that records nothing for a field (an old manifest without `clusterId`,
 * a backup without the label) does NOT match: when MongoShield cannot tell whose
 * a backup is, it leaves it alone.
 *
 * Incomplete runs have no manifest. A resumable run's checkpoint records the same
 * `source.clusterId` and `labels` the manifest will have, so it can be attributed;
 * an incomplete run without a checkpoint cannot, and stays out of every scope
 * (only an unscoped prune of the whole location removes it).
 */

import { MongoShieldError } from "../errors.ts";

/**
 * The label that names the console plan (by plan id) that wrote a backup. The
 * console prunes each plan's backups with this label plus the source's clusterId,
 * so plans that share a storage location never prune each other's backups.
 */
export const PLAN_LABEL = "mongoshield.plan";

/**
 * Which backups a prune applies to. All given fields must match; omitted fields
 * match anything. Pass no scope at all to prune the whole location.
 */
export interface PruneScope {
  /** Only backups whose `manifest.source.clusterId` is this value. */
  readonly clusterId?: string;
  /** Only backups whose `manifest.labels` include every one of these key/value pairs. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** What a backup records about its origin: from its manifest, or its checkpoint while it runs. */
export interface BackupOrigin {
  readonly clusterId?: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * True if a backup with this origin belongs to `scope` (see the file header).
 * A field the scope gives but the backup does not record never matches.
 */
export function isInScope(origin: BackupOrigin, scope: PruneScope): boolean {
  if (scope.clusterId !== undefined && origin.clusterId !== scope.clusterId) return false;
  for (const [key, value] of Object.entries(scope.labels ?? {})) {
    // `Object.hasOwn` so that a label named like an Object.prototype member
    // ("constructor", "toString") never matches by accident.
    if (!Object.hasOwn(origin.labels, key) || origin.labels[key] !== value) return false;
  }
  return true;
}

/**
 * Rejects scopes that would select more than intended.
 *
 * An empty scope (`{}`, or `{ labels: {} }`) would match every attributable
 * backup, which is almost always a bug in the caller (an unset variable, a
 * missing label) rather than a request to prune the whole location. Pruning the
 * whole location is spelled by passing no scope at all.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for an empty scope, an empty
 *   `clusterId`, or a label key or value that is not a string.
 */
export function validateScope(scope: PruneScope): void {
  const labels = Object.entries(scope.labels ?? {});
  if (scope.clusterId === undefined && labels.length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "A prune scope needs a clusterId or at least one label.",
      { hint: "Omit `scope` to apply the policy to every backup in the storage location." },
    );
  }
  if (scope.clusterId !== undefined && (typeof scope.clusterId !== "string" || !scope.clusterId)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The prune scope's clusterId must be a non-empty string.",
    );
  }
  for (const [key, value] of labels) {
    if (key === "" || typeof value !== "string") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `The prune scope's label "${key}" must have a non-empty key and a string value.`,
      );
    }
  }
}

/** `cluster 3f9a… · mongoshield.shape=1c2d…`: a scope (or origin) for messages and logs. */
export function describeScope(scope: PruneScope): string {
  const parts: string[] = [];
  if (scope.clusterId !== undefined) parts.push(`cluster ${scope.clusterId}`);
  for (const [key, value] of Object.entries(scope.labels ?? {})) parts.push(`${key}=${value}`);
  return parts.length === 0 ? "every backup" : parts.join(" · ");
}
