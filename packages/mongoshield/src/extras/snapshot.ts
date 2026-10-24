/**
 * Snapshots before a migration, and rolling back to them.
 *
 *   await snapshot(shield, { label: "v42-add-orders-index", include: ["app.*"] });
 *   await runMigrations();                     // migrate-mongo, Mongoose, Prisma, …
 *   // something went wrong:
 *   await rollback(shield, { label: "v42-add-orders-index" });
 *
 * A snapshot is an ordinary backup (same storage, encryption, retention) with the label
 * `mongoshield.snapshot=<label>` and consistency `auto`, so it is a consistent point in
 * time on replica sets. Nothing about it is special on disk: `list`, `verify`, `hold`
 * and `restore` work on it like on any backup.
 *
 * A rollback restores the newest snapshot with that label (or a given backup id) over
 * the live data of the configured source, replacing each collection it contains
 * (`mode: "drop"` by default), and DROPS the collections created after the snapshot
 * (by the migration): those in the snapshot's databases that the snapshot does not
 * hold but would have captured (its include/exclude patterns are recorded in labels;
 * the rollback's own include/exclude narrow it further). `keepNew` leaves them alone.
 * Before it drops anything it takes a SAFETY SNAPSHOT of the collections it is about
 * to replace or drop, labelled `pre-rollback-<label>`, so a rollback can itself be
 * rolled back.
 *
 * The erasure ledger (erasure.ts) applies after a rollback like after any restore, once
 * `shield.restore` is wired through `withErasures`.
 */

import { assertNoConflicts } from "../engine/restore-plan.ts";
import { MongoShieldError } from "../errors.ts";
import { collectionEntries, type Manifest } from "../format/manifest.ts";
import { compileNamespaceFilter, discoverNamespaces, splitNamespace } from "../mongo/index.ts";
import type { MongoShield } from "../shield.ts";
import { messageOf } from "../storage/adapter-utils.ts";
import type {
  CompletedBackupResult,
  DecryptionOptions,
  NamespacePattern,
  ProgressEvent,
  RestoreMode,
  RestoreOptions,
  RestorePlan,
  RestoreResult,
} from "../types.ts";

/** The label key that marks a backup as a snapshot; its value is the snapshot's label. */
export const SNAPSHOT_LABEL = "mongoshield.snapshot";

/** On a safety snapshot: the id of the snapshot whose rollback it preceded. */
export const ROLLBACK_OF_LABEL = "mongoshield.rollback-of";

/** Prefix of the label of the safety snapshot taken before a rollback. */
export const SAFETY_SNAPSHOT_PREFIX = "pre-rollback-";

/**
 * On a snapshot: its include and exclude patterns as JSON arrays, so a rollback knows
 * which collections the snapshot would have captured had they existed.
 */
export const SNAPSHOT_INCLUDE_LABEL = "mongoshield.snapshot.include";
export const SNAPSHOT_EXCLUDE_LABEL = "mongoshield.snapshot.exclude";

/**
 * Snapshot labels: short, printable, no spaces, so they work as CLI arguments and in
 * file names. Backup ids (`2026-11-14T03-00-04Z_7f3a9c`) fit too, for safety snapshots
 * of id-based rollbacks.
 */
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,127}$/;

/** Longest label, so that `pre-rollback-<label>` can be cut to fit it. */
const MAX_LABEL_LENGTH = 128;

/** Options for {@link snapshot}. */
export interface SnapshotOptions {
  /** A name for this point in time, e.g. the migration's name or version. */
  readonly label: string;
  /** Namespaces to capture (default: everything a backup would take). */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** More labels to record next to `mongoshield.snapshot`. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Make the snapshot write-once for this many days (storage with object lock). */
  readonly retainDays?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/**
 * Takes a snapshot: a backup labelled `mongoshield.snapshot=<label>`, consistency `auto`.
 *
 * @throws MS_CONFIG_INVALID for a malformed label, and anything `shield.backup` throws.
 */
export async function snapshot(
  shield: MongoShield,
  options: SnapshotOptions,
): Promise<CompletedBackupResult> {
  assertValidLabel(options.label);
  return shield.backup({
    consistency: "auto",
    labels: {
      ...options.labels,
      [SNAPSHOT_LABEL]: options.label,
      ...(options.include ? { [SNAPSHOT_INCLUDE_LABEL]: JSON.stringify(options.include) } : {}),
      ...(options.exclude ? { [SNAPSHOT_EXCLUDE_LABEL]: JSON.stringify(options.exclude) } : {}),
    },
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.retainDays !== undefined ? { retainDays: options.retainDays } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

/** Options for {@link rollback}. Give `label` or `backupId`. */
export interface RollbackOptions {
  /** Roll back to the newest snapshot with this label. */
  readonly label?: string;
  /** Or to exactly this backup. */
  readonly backupId?: string;
  /** Only these namespaces of the snapshot. */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Defaults to `"drop"`: each collection is replaced by its snapshotted state. */
  readonly mode?: RestoreMode;
  /** Plan only: find the snapshot, work out the restore plan, write nothing. */
  readonly dryRun?: boolean;
  /** Keys for encrypted snapshots. */
  readonly decryption?: DecryptionOptions;
  /** Take the `pre-rollback-<label>` safety snapshot first. Defaults to true. */
  readonly safetySnapshot?: boolean;
  /**
   * Leave the collections created after the snapshot (`newCollections`) alone instead
   * of dropping them. Defaults to false.
   */
  readonly keepNew?: boolean;
  /** Do not apply the erasure ledger afterwards (passed through to the restore). */
  readonly skipErasures?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** What {@link rollback} did. */
export interface RollbackResult {
  /** The snapshot rolled back to. */
  readonly snapshotId: string;
  /** Its label, when it has one. */
  readonly label: string | undefined;
  readonly plan: RestorePlan;
  readonly dryRun: boolean;
  /**
   * Collections and views in the snapshot's databases that the snapshot does not hold
   * (created after it, e.g. by the migration), sorted. Dropped unless `keepNew`; in a
   * dry run, the ones that would be.
   */
  readonly newCollections: readonly string[];
  /** Whether `newCollections` are (or, in a dry run, would be) dropped. */
  readonly dropsNew: boolean;
  /** The safety snapshot taken before anything was dropped, if one was. */
  readonly safetySnapshotId: string | undefined;
  /** The restore's result (absent for dry runs). */
  readonly restore: RestoreResult | undefined;
}

/**
 * Restores a snapshot over the live data of the shield's source. See the file header.
 *
 * @throws MS_BACKUP_NOT_FOUND when no snapshot has the label; MS_CONFIG_INVALID for
 *   neither or both of `label` and `backupId`, or filters that select nothing;
 *   MS_RESTORE_CONFLICT in a mode that refuses existing data; and anything
 *   `shield.backup` (safety snapshot) or `shield.restore` throws.
 */
export async function rollback(
  shield: MongoShield,
  options: RollbackOptions,
): Promise<RollbackResult> {
  const target = await findSnapshot(shield, options);
  const restoreOptions: RestoreOptions & { readonly skipErasures?: boolean } = {
    backup: target.id,
    mode: options.mode ?? "drop",
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
    ...(options.decryption ? { decryption: options.decryption } : {}),
    ...(options.skipErasures !== undefined ? { skipErasures: options.skipErasures } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };

  // The planner refuses filters that select nothing of the snapshot (MS_CONFIG_INVALID).
  const plan = await shield.planRestore(restoreOptions);
  assertNoConflicts(plan);
  const newCollections = await findNewCollections(shield, target, options);
  const dropsNew = options.keepNew !== true && newCollections.length > 0;
  if (options.dryRun === true) {
    return {
      snapshotId: target.id,
      label: target.label,
      plan,
      dryRun: true,
      newCollections,
      dropsNew,
      safetySnapshotId: undefined,
      restore: undefined,
    };
  }

  const safetySnapshotId =
    options.safetySnapshot === false
      ? undefined
      : await takeSafetySnapshot(shield, target, plan, dropsNew ? newCollections : [], options);
  const restore = await shield.restore(restoreOptions);
  // Only after the restore succeeded: a failed rollback must not also lose these.
  if (dropsNew) await dropCollections(shield, newCollections);
  return {
    snapshotId: target.id,
    label: target.label,
    plan: restore.plan,
    dryRun: false,
    newCollections,
    dropsNew,
    safetySnapshotId,
    restore,
  };
}

/** The snapshot a rollback restores. */
interface SnapshotTarget {
  readonly id: string;
  readonly label: string | undefined;
  /** Its manifest, when the catalog has it (always, for a complete backup). */
  readonly manifest: Manifest | undefined;
}

/**
 * The live collections and views a rollback drops: in a database of the snapshot,
 * absent from the snapshot, and selected both by the snapshot's own patterns (a
 * collection it deliberately left out was not "created after it") and by the
 * rollback's include/exclude. Snapshots taken before the patterns were recorded (and
 * plain backups rolled back to by id) count as having captured whole databases.
 */
async function findNewCollections(
  shield: MongoShield,
  target: SnapshotTarget,
  options: RollbackOptions,
): Promise<string[]> {
  const entries = collectionEntries(target.manifest?.namespaces ?? []);
  const databases = new Set(entries.map((entry) => entry.db));
  if (databases.size === 0) return [];
  const snapshotted = new Set(entries.map((entry) => entry.ns));
  const labels = target.manifest?.labels ?? {};
  const capturedBySnapshot = compileNamespaceFilter({
    include: patternsLabel(labels[SNAPSHOT_INCLUDE_LABEL]),
    exclude: patternsLabel(labels[SNAPSHOT_EXCLUDE_LABEL]),
  });
  const selected = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  const live = await shield.withSourceClient((client) =>
    discoverNamespaces(client, {
      include: [...databases].map((database) => `${database}.*`),
      signal: options.signal,
    }),
  );
  return live
    .map((spec) => spec.ns)
    .filter(
      (ns) =>
        databases.has(splitNamespace(ns).database) &&
        !snapshotted.has(ns) &&
        capturedBySnapshot(ns) &&
        selected(ns),
    )
    .sort();
}

/** A recorded pattern list, or `undefined` (no restriction) when absent or unreadable. */
function patternsLabel(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Not written by `snapshot()`: ignore it, like a missing label.
  }
  return undefined;
}

/**
 * Drops each namespace. One already gone is fine: the driver reports a missing
 * namespace as "nothing dropped", not as an error.
 */
async function dropCollections(shield: MongoShield, namespaces: readonly string[]): Promise<void> {
  await shield.withSourceClient(async (client) => {
    for (const ns of namespaces) {
      const { database, collection } = splitNamespace(ns);
      await client
        .db(database)
        .dropCollection(collection)
        .catch((error: unknown) => {
          throw new MongoShieldError(
            "MS_RESTORE_FAILED",
            `The rollback restored the snapshot but could not drop ${ns}, which the snapshot does not hold: ${messageOf(error)}`,
            { cause: error, hint: "Drop it by hand, or roll back again." },
          );
        });
    }
  });
}

/** Resolves `label` (newest snapshot with it) or `backupId`. */
async function findSnapshot(
  shield: MongoShield,
  options: RollbackOptions,
): Promise<SnapshotTarget> {
  if ((options.label === undefined) === (options.backupId === undefined)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Pass exactly one of `label` and `backupId`.", {
      hint: 'Roll back to a snapshot by its label, e.g. `rollback(shield, { label: "v42" })`.',
    });
  }
  const entries = await shield.list(options.signal ? { signal: options.signal } : {});
  if (options.backupId !== undefined) {
    const entry = entries.find((candidate) => candidate.id === options.backupId);
    // Let the restore planner report unknown or incomplete ids with its usual hints.
    return {
      id: options.backupId,
      label: entry?.manifest?.labels[SNAPSHOT_LABEL],
      manifest: entry?.manifest,
    };
  }

  // `list` is newest first, so the first match is the newest snapshot with the label.
  const match = entries.find(
    (entry) =>
      entry.status === "complete" && entry.manifest?.labels[SNAPSHOT_LABEL] === options.label,
  );
  if (match === undefined) {
    const labels = [
      ...new Set(entries.flatMap((entry) => entry.manifest?.labels[SNAPSHOT_LABEL] ?? [])),
    ];
    throw new MongoShieldError(
      "MS_BACKUP_NOT_FOUND",
      `There is no snapshot labelled "${options.label ?? ""}".`,
      {
        hint:
          labels.length > 0
            ? `Snapshots available: ${labels.slice(0, 10).join(", ")}.`
            : "Take one with `mongoshield snapshot <label>` before migrating.",
      },
    );
  }
  return { id: match.id, label: options.label, manifest: match.manifest };
}

/**
 * Backs up the live collections the rollback is about to replace or drop. Returns its
 * id, or `undefined` when there are none (nothing would be lost).
 */
async function takeSafetySnapshot(
  shield: MongoShield,
  target: SnapshotTarget,
  plan: RestorePlan,
  dropping: readonly string[],
  options: RollbackOptions,
): Promise<string | undefined> {
  // `undefined` means "could not count": treat it as possibly holding data.
  const replaced = plan.entries
    .filter((entry) => entry.type !== "view" && entry.existingDocuments !== 0)
    .map((entry) => entry.to);
  const live = [...new Set([...replaced, ...dropping])];
  if (live.length === 0) return undefined;
  const result = await snapshot(shield, {
    // Cut to the label limit; the full id is in the `rollback-of` label anyway.
    label: `${SAFETY_SNAPSHOT_PREFIX}${target.label ?? target.id}`.slice(0, MAX_LABEL_LENGTH),
    include: live,
    labels: { [ROLLBACK_OF_LABEL]: target.id },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return result.id;
}

/**
 * Checks a snapshot label.
 *
 * @throws MS_CONFIG_INVALID with the allowed characters.
 */
export function assertValidLabel(label: string): void {
  if (LABEL_PATTERN.test(label)) return;
  throw new MongoShieldError("MS_CONFIG_INVALID", `"${label}" is not a valid snapshot label.`, {
    hint: "Use up to 128 letters, digits and . _ - : + @, starting with a letter or digit (e.g. v42-add-index).",
  });
}
