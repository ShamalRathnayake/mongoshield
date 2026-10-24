/**
 * Restore drills: proving that a backup can actually be restored.
 *
 * Verification (verify.ts) proves the files are intact. A drill goes all the way:
 *
 *   1. guard     refuse to drill into the deployment the backup was taken from
 *   2. names     pick temporary database names, `<prefix><run id>_<db>`, that do not exist
 *   3. restore   the normal restore engine, with every database renamed to its
 *                temporary name, in the default fail-if-exists mode (never touches
 *                existing data). Its duration is the recovery time (RTO).
 *   4. checks    per namespace: document count, indexes, optional sample comparison
 *                (drill-checks.ts), then the user's own assertions
 *   5. cleanup   drop the temporary databases, always (also on failure or abort),
 *                unless `keep` is set
 *
 * Findings about the backup (damaged files, counts that do not match, missing
 * indexes, failed assertions) are collected as problems in the report. Errors about
 * the drill's setup (no connection, no privileges, missing keys, abort) are thrown.
 *
 * How the same-deployment guard works: every manifest records the source's
 * `clusterId`, a hash of the replica set name (or sharded cluster id, or host list
 * for standalones) from `describeDeployment`. The drill computes the same id for
 * the target and refuses when they are equal. Backups without a recorded id cannot
 * be checked; the drill then logs a warning and proceeds (it only ever writes to
 * fresh temporary databases). A standalone reached under a different host name is
 * not recognised, because its id is derived from the host list.
 */

import { randomBytes } from "node:crypto";
import type { Db, MongoClient } from "mongodb";
import { listBackups, selectBackup } from "../catalog/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { collectionEntries, type Manifest, type NamespaceEntry } from "../format/manifest.ts";
import { describeDeployment } from "../mongo/deployment.ts";
import type {
  BackupSelector,
  DecryptionOptions,
  NamespacePattern,
  ProgressEvent,
  RestorePlanEntry,
  RestoreResult,
  SourceOptions,
  VerifyProblem,
} from "../types.ts";
import type { RestoreContext } from "./context.ts";
import {
  checkRestoredNamespace,
  type DrillNamespaceReport,
  isBackupDefect,
  messageOf,
} from "./drill-checks.ts";
import { openBackupSource, type StoredBackupSource } from "./read-pipeline.ts";
import { runRestore } from "./restore.ts";

export type { DrillNamespaceReport } from "./drill-checks.ts";

/** Prefix of temporary database names when `prefix` is not given. */
export const DEFAULT_DRILL_PREFIX = "msdrill_";

/** Largest `sample`: every sampled document is held in memory while sampling. */
export const MAX_DRILL_SAMPLE = 10_000;

/** MongoDB limits database names to 63 bytes. */
const MAX_DATABASE_NAME_BYTES = 63;

/** Allowed prefix characters: a safe subset of what database names allow everywhere. */
const PREFIX_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * A check of your own, run against each restored (temporary) database after the
 * built-in checks. Throw (or reject) to fail the drill; the error message is reported.
 */
export type DrillAssertion = (db: Db, info: DrillAssertionInfo) => Promise<void> | void;

/** What an assertion is told about the database it checks. */
export interface DrillAssertionInfo {
  /** The database's name in the backup, e.g. `app` (`db` is its temporary copy). */
  readonly database: string;
  /** The drilled backup's manifest. */
  readonly manifest: Manifest;
}

/**
 * Assertions: one function run for every restored database, or one function per
 * database name in the backup (`{ app: async (db) => … }`).
 */
export type DrillAssertions = DrillAssertion | Readonly<Record<string, DrillAssertion>>;

/** Options of `drillBackup()`. */
export interface DrillOptions {
  readonly backup: BackupSelector;
  readonly decryption?: DecryptionOptions;
  /** Only drill these namespaces (as in restore). Defaults to the whole backup. */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Prefix of the temporary database names. Defaults to `"msdrill_"`. */
  readonly prefix?: string;
  /**
   * Documents per collection to compare byte for byte with the backup (costs one
   * more read of each collection's data from storage). Defaults to 0 (off).
   */
  readonly sample?: number;
  /** Your own checks, run against the restored databases. */
  readonly assertions?: DrillAssertions;
  /** Keep the temporary databases for inspection instead of dropping them. */
  readonly keep?: boolean;
  /**
   * Allow drilling into the deployment the backup was taken from. The drill still
   * only writes to fresh temporary databases, but a full restore puts real load
   * and disk usage on production, so this must be asked for explicitly.
   */
  readonly allowSameDeployment?: boolean;
  /** Collections restored at the same time (as in restore). */
  readonly parallelism?: number;
  /** Insert workers per collection (as in restore). */
  readonly insertWorkers?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

/** `shield.drill()` options: a drill always names its scratch target explicitly. */
export interface ShieldDrillOptions extends DrillOptions {
  /**
   * The scratch deployment to restore into. Required, and never defaults to the
   * configured source, so a drill cannot hit production by omission.
   */
  readonly target: SourceOptions;
}

/** Everything `drillBackup()` needs besides its options. */
export interface DrillContext extends RestoreContext {
  /** Connected client for the SCRATCH deployment (not closed by the drill). */
  readonly client: MongoClient;
  /**
   * Identifies a deployment, for the same-deployment guard. Defaults to the
   * `clusterId` of `describeDeployment()`, the value manifests record; tests inject it.
   */
  readonly identifyDeployment?: (client: MongoClient) => Promise<string | undefined>;
}

/** A database of the backup and its temporary name on the scratch deployment. */
export interface DrillDatabase {
  readonly source: string;
  readonly target: string;
}

/** A problem found by a drill. `subject` is a namespace, `restore`, or `assertions:<db>`. */
export type DrillProblem = VerifyProblem;

/** The outcome of a drill. */
export interface DrillReport {
  readonly backupId: string;
  /** True when the backup restored and every check passed. */
  readonly ok: boolean;
  /** When the drill started (ISO 8601). */
  readonly startedAt: string;
  /** The whole drill, checks and cleanup included. */
  readonly durationMs: number;
  /**
   * The recovery time objective actually measured: how long the restore took,
   * from planning to the last index (or to the failure, when it failed).
   */
  readonly restoreDurationMs: number;
  /** Whether the restore itself completed. */
  readonly restored: boolean;
  readonly documentsRestored: number;
  /** The temporary databases used. */
  readonly databases: readonly DrillDatabase[];
  /** True when the temporary databases were kept (`keep`); they must be dropped by hand. */
  readonly kept: boolean;
  /** Per-namespace results (empty when the restore failed). */
  readonly namespaces: readonly DrillNamespaceReport[];
  /** Every problem: the restore's, each namespace's, and failed assertions. */
  readonly problems: readonly DrillProblem[];
  /** Things that went wrong around the drill without saying anything about the backup. */
  readonly warnings: readonly string[];
}

/**
 * Restores a backup into temporary databases on a scratch deployment, checks the
 * result, and cleans up. See the file header for the steps.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for invalid options or a target that
 *   is the backup's source deployment, `MS_RESTORE_CONFLICT` if a temporary name is
 *   taken, `MS_BACKUP_NOT_FOUND`, `MS_NO_IDENTITY`, `MS_PERMISSION_DENIED`,
 *   `MS_ABORTED`, and connection errors. Backup defects are reported, not thrown.
 */
export async function drillBackup(
  context: DrillContext,
  options: DrillOptions,
): Promise<DrillReport> {
  const startedAt = new Date();
  const clock = performance.now();
  const sampleSize = validSampleSize(options.sample);
  const prefix = validPrefix(options.prefix);
  throwIfAborted(options.signal);

  const manifest = await loadManifest(context, options);
  await assertScratchTarget(context, manifest, options);
  const databases = temporaryDatabaseNames(manifest, prefix, randomBytes(4).toString("hex"));
  await assertDatabasesUnused(context.client, databases);

  const problems: DrillProblem[] = [];
  const warnings: string[] = [];
  let namespaces: DrillNamespaceReport[] = [];
  let outcome: RestoreOutcome;
  const keep = options.keep === true;

  context.logger.info("Drill: restoring into temporary databases", {
    backupId: manifest.id,
    databases: databases.map((database) => database.target),
  });
  try {
    outcome = await restoreIntoScratch(context, options, manifest, databases);
    if (outcome.result === undefined) {
      problems.push({ subject: "restore", problem: outcome.failure });
    } else {
      const source = await openBackupSource(context.storage, manifest, options.decryption, {
        signal: options.signal,
      });
      namespaces = await checkNamespaces(
        context,
        options,
        manifest,
        source,
        outcome.result,
        sampleSize,
      );
      for (const namespace of namespaces) {
        for (const problem of namespace.problems) problems.push({ subject: namespace.ns, problem });
      }
      problems.push(
        ...(await runAssertions(context, options, manifest, databases, outcome.result)),
      );
    }
  } finally {
    if (keep) {
      context.logger.warn("Drill: kept the temporary databases; drop them when done", {
        databases: databases.map((database) => database.target),
      });
    } else {
      warnings.push(...(await dropDatabases(context, databases)));
    }
  }

  const report: DrillReport = {
    backupId: manifest.id,
    ok: problems.length === 0,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - clock),
    restoreDurationMs: outcome.durationMs,
    restored: outcome.result !== undefined,
    documentsRestored: outcome.result?.documentsRestored ?? 0,
    databases,
    kept: keep,
    namespaces,
    problems,
    warnings,
  };
  context.logger.info("Drill finished", {
    backupId: report.backupId,
    ok: report.ok,
    problems: report.problems.length,
    restoreDurationMs: report.restoreDurationMs,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Options and names
// ---------------------------------------------------------------------------

/**
 * Validates `sample`.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` unless it is a whole number in [0, MAX_DRILL_SAMPLE].
 */
export function validSampleSize(sample: number | undefined): number {
  if (sample === undefined) return 0;
  if (!Number.isInteger(sample) || sample < 0 || sample > MAX_DRILL_SAMPLE) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The drill sample must be a whole number from 0 to ${MAX_DRILL_SAMPLE} (got ${String(sample)}).`,
      { hint: "It is the number of documents per collection compared with the backup." },
    );
  }
  return sample;
}

/**
 * Validates the temporary database prefix. It must be non-empty: without it the
 * temporary names would not stand out, and cleanup scripts match on it.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID`
 */
export function validPrefix(prefix: string | undefined): string {
  const value = prefix ?? DEFAULT_DRILL_PREFIX;
  if (!PREFIX_PATTERN.test(value)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `The drill prefix "${value}" is not allowed.`, {
      hint: 'Use 1–32 letters, digits, "_" or "-", e.g. "msdrill_".',
    });
  }
  return value;
}

/**
 * The temporary name of every database in the backup: `<prefix><runId>_<db>`.
 * Names longer than MongoDB's 63-byte limit become `<prefix><runId>-<n>` instead;
 * the `-` (instead of `_`) keeps them from colliding with a database called `<n>`.
 */
export function temporaryDatabaseNames(
  manifest: Pick<Manifest, "namespaces">,
  prefix: string,
  runId: string,
): DrillDatabase[] {
  // Users and roles entries (under `admin`) are not restored by drills.
  const sources = [
    ...new Set(collectionEntries(manifest.namespaces).map((entry) => entry.db)),
  ].sort();
  return sources.map((source, index) => {
    const preferred = `${prefix}${runId}_${source}`;
    const target =
      Buffer.byteLength(preferred, "utf8") <= MAX_DATABASE_NAME_BYTES
        ? preferred
        : `${prefix}${runId}-${index}`;
    return { source, target };
  });
}

/** The restore `rename` rules that send every backed-up database to its temporary name. */
export function drillRenameRules(databases: readonly DrillDatabase[]): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const { source, target } of databases) rules[`${source}.*`] = `${target}.*`;
  return rules;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function loadManifest(context: DrillContext, options: DrillOptions): Promise<Manifest> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const selected = selectBackup(entries, options.backup);
  if (selected.manifest === undefined) {
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }
  return selected.manifest;
}

/** Refuses a target that is the backup's own source deployment (see the file header). */
async function assertScratchTarget(
  context: DrillContext,
  manifest: Manifest,
  options: DrillOptions,
): Promise<void> {
  if (options.allowSameDeployment === true) return;
  const sourceId = manifest.source.clusterId;
  if (sourceId === undefined) {
    context.logger.warn(
      "Drill: the backup does not record its source deployment, so the target cannot be checked",
      { backupId: manifest.id },
    );
    return;
  }
  const identify = context.identifyDeployment ?? defaultIdentifyDeployment;
  if ((await identify(context.client)) !== sourceId) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The drill target is the deployment backup ${manifest.id} was taken from.`,
    {
      hint: "Drill into a scratch deployment (--target-uri). To drill into the source anyway, pass --allow-same-deployment (allowSameDeployment: true); only temporary databases are written.",
    },
  );
}

async function defaultIdentifyDeployment(client: MongoClient): Promise<string> {
  return (await describeDeployment(client)).clusterId;
}

/**
 * Makes sure no temporary database exists yet. The names are random, so this
 * practically never fails, but cleanup drops these databases: it must be certain
 * the drill created them.
 */
async function assertDatabasesUnused(
  client: MongoClient,
  databases: readonly DrillDatabase[],
): Promise<void> {
  for (const { target } of databases) {
    const existing = await client.db(target).listCollections({}, { nameOnly: true }).next();
    if (existing !== null) {
      throw new MongoShieldError(
        "MS_RESTORE_CONFLICT",
        `The temporary database ${target} already exists on the drill target.`,
        { hint: "Run the drill again (it picks a new random name), or use another --prefix." },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Restore, checks, assertions
// ---------------------------------------------------------------------------

/** What the restore step produced: a result, or the failure that is the finding. */
type RestoreOutcome =
  | { readonly result: RestoreResult; readonly durationMs: number }
  | { readonly result: undefined; readonly durationMs: number; readonly failure: string };

/** Restores the backup under the temporary names and measures how long it took (the RTO). */
async function restoreIntoScratch(
  context: DrillContext,
  options: DrillOptions,
  manifest: Manifest,
  databases: readonly DrillDatabase[],
): Promise<RestoreOutcome> {
  const startedAt = performance.now();
  try {
    const result = await runRestore(
      { client: context.client, storage: context.storage, logger: context.logger },
      {
        // The exact id, so a backup committed meanwhile cannot change what "latest" means.
        backup: manifest.id,
        rename: drillRenameRules(databases),
        mode: "fail-if-exists",
        ...(options.decryption ? { decryption: options.decryption } : {}),
        ...(options.include ? { include: options.include } : {}),
        ...(options.exclude ? { exclude: options.exclude } : {}),
        ...(options.parallelism === undefined ? {} : { parallelism: options.parallelism }),
        ...(options.insertWorkers === undefined ? {} : { insertWorkers: options.insertWorkers }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      },
    );
    return { result, durationMs: result.durationMs };
  } catch (error) {
    if (!isBackupDefect(error)) throw error;
    return {
      result: undefined,
      durationMs: Math.round(performance.now() - startedAt),
      failure: messageOf(error),
    };
  }
}

/** Runs the namespace checks one after another (they are light next to the restore). */
async function checkNamespaces(
  context: DrillContext,
  options: DrillOptions,
  manifest: Manifest,
  source: StoredBackupSource,
  result: RestoreResult,
  sampleSize: number,
): Promise<DrillNamespaceReport[]> {
  const entries = new Map<string, NamespaceEntry>();
  for (const entry of manifest.namespaces) entries.set(entry.ns, entry);
  const replayedChanges = (manifest.changes?.events ?? 0) > 0;

  const reports: DrillNamespaceReport[] = [];
  for (const planned of result.plan.entries) {
    throwIfAborted(options.signal);
    const entry = entries.get(planned.from);
    if (entry === undefined) continue;
    reports.push(
      await checkRestoredNamespace({
        client: context.client,
        source,
        planned,
        entry,
        sampleSize,
        replayedChanges,
        signal: options.signal,
      }),
    );
  }
  return reports;
}

/**
 * Runs the user's assertions against each restored database. Failures become
 * problems with the subject `assertions:<db>`; a per-database assertion for a
 * database the drill did not restore is reported too (most likely a typo).
 */
async function runAssertions(
  context: DrillContext,
  options: DrillOptions,
  manifest: Manifest,
  databases: readonly DrillDatabase[],
  result: RestoreResult,
): Promise<DrillProblem[]> {
  const assertions = options.assertions;
  if (assertions === undefined) return [];
  const restored = restoredDatabases(databases, result.plan.entries);
  const problems: DrillProblem[] = [];

  if (typeof assertions !== "function") {
    for (const name of Object.keys(assertions)) {
      if (!restored.some((database) => database.source === name)) {
        problems.push({
          subject: `assertions:${name}`,
          problem: `there is an assertion for database "${name}", but the drill restored no such database`,
        });
      }
    }
  }

  for (const database of restored) {
    const assertion = typeof assertions === "function" ? assertions : assertions[database.source];
    if (assertion === undefined) continue;
    throwIfAborted(options.signal);
    try {
      await assertion(context.client.db(database.target), { database: database.source, manifest });
    } catch (error) {
      problems.push({ subject: `assertions:${database.source}`, problem: messageOf(error) });
    }
  }
  return problems;
}

/** The temporary databases the restore actually wrote to (include/exclude may skip some). */
function restoredDatabases(
  databases: readonly DrillDatabase[],
  entries: readonly RestorePlanEntry[],
): DrillDatabase[] {
  const sources = new Set(entries.map((entry) => entry.from.slice(0, entry.from.indexOf("."))));
  return databases.filter((database) => sources.has(database.source));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Drops every temporary database. Runs after success, failure and abort alike;
 * a database that cannot be dropped becomes a warning (and a log line), not an
 * error, so the drill's real outcome is never hidden by its cleanup.
 */
async function dropDatabases(
  context: DrillContext,
  databases: readonly DrillDatabase[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const { target } of databases) {
    try {
      // Dropping a database that was never created is a no-op.
      await context.client.db(target).dropDatabase();
    } catch (error) {
      const warning = `Could not drop the temporary database ${target}: ${messageOf(error)}`;
      context.logger.warn(warning);
      warnings.push(warning);
    }
  }
  return warnings;
}
