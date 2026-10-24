/**
 * The work behind each job kind, built on the public mongoshield API.
 *
 *   backup   runScheduledJob: storage lock → backup (+ guard) → verify → prune → notify,
 *            exactly what `mongoshield run` does, so a console and a CLI CronJob can
 *            share a storage location safely (they take the same lock). Every backup
 *            is labelled `mongoshield.plan=<plan id>`, and retention is scoped to that
 *            label plus the source's cluster id (see `planScopeLabels`), so plans
 *            sharing a storage location never prune each other's backups
 *   restore  shield.restore into a target connection
 *   verify   shield.verify (fast or deep), recorded next to the backup
 *   drill    shield.drill into a scratch connection, recorded next to the backup
 *   prune    shield.prune with a plan's retention policy and scope, under the same
 *            storage lock as backups, after re-checking the plan the admin confirmed
 *
 * Each `…Job` function looks up what it needs, decrypts secrets only inside the
 * job (never earlier, never into a response), and returns a `JobSpec` for the
 * runner. Secrets that might appear in errors are listed in `spec.secrets` so
 * the runner scrubs them.
 */

import { hostname } from "node:os";
import type { Document } from "mongodb";
import type { RunReport } from "mongoshield";
import {
  type DecryptionOptions,
  type EncryptionOptions,
  ERROR_CODES,
  type ErrorCode,
  type Logger,
  MongoShield,
  type MongoShieldConfig,
  MongoShieldError,
  PLAN_LABEL,
  type PruneScope,
  type RestoreMode,
  type RetentionPolicy,
  runScheduledJob,
  storageLock,
  summarizeReport,
  type TenantRestoreMode,
} from "mongoshield";
import { ConsoleError, invalid, notFound } from "../server/errors.ts";
import type { PrunePlanView, RestorePlanView } from "../shared/api.ts";
import { randomId } from "../state/crypto.ts";
import { scrubText } from "../state/redact.ts";
import { openConnectionUri, openNotifyUrl, openPlanPassphrase } from "../state/secrets.ts";
import type { StateStore } from "../state/store.ts";
import type { ConnectionRecord, PlanRecord, StorageRecord } from "../state/types.ts";
import type { JobContext, JobSpec } from "./runner.ts";
import type { StorageRegistry } from "./storage.ts";

/** What the tasks need from the rest of the console. */
export interface TaskDeps {
  readonly store: StateStore;
  readonly storage: StorageRegistry;
  readonly logger: Logger;
  /** Signs webhook notifications (MONGOSHIELD_WEBHOOK_SECRET), as the CLI does. */
  readonly webhookSecret?: string;
}

/** Keys supplied with a request for an encrypted backup. */
export interface GivenKeys {
  readonly passphrase?: string;
  readonly identities?: readonly string[];
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** A connection by id, or 404. */
export function connectionById(store: StateStore, id: string): ConnectionRecord {
  const record = store.current.connections.find((candidate) => candidate.id === id);
  if (record === undefined) throw notFound("The connection");
  return record;
}

/** A storage location by id, or 404. */
export function storageById(store: StateStore, id: string): StorageRecord {
  const record = store.current.storage.find((candidate) => candidate.id === id);
  if (record === undefined) throw notFound("The storage location");
  return record;
}

/** A plan by id, or 404. */
export function planById(store: StateStore, id: string): PlanRecord {
  const record = store.current.plans.find((candidate) => candidate.id === id);
  if (record === undefined) throw notFound("The plan");
  return record;
}

/**
 * Keys for reading encrypted backups in a storage location: the ones given with
 * the request, else the passphrase of a plan that writes to that location (the
 * console already holds it, so the user need not type it again).
 */
export function decryptionFor(
  store: StateStore,
  storageId: string,
  given: GivenKeys = {},
): DecryptionOptions | undefined {
  if (given.passphrase !== undefined || (given.identities?.length ?? 0) > 0) {
    return {
      ...(given.passphrase === undefined ? {} : { passphrase: given.passphrase }),
      ...(given.identities === undefined ? {} : { identities: given.identities }),
    };
  }
  for (const plan of store.current.plans) {
    if (plan.storageId !== storageId) continue;
    const passphrase = openPlanPassphrase(store, plan);
    if (passphrase !== undefined) return { passphrase };
  }
  return undefined;
}

/** A `MongoShield` for one storage location (and optionally a source connection). */
export async function shieldFor(
  deps: TaskDeps,
  storage: StorageRecord,
  extra: {
    readonly uri?: string;
    readonly compression?: "zstd" | "gzip" | "none";
    readonly encryption?: EncryptionOptions;
    readonly logger?: Logger;
  } = {},
): Promise<MongoShield> {
  return new MongoShield({
    storage: await deps.storage.adapterFor(storage),
    logger: extra.logger ?? deps.logger,
    ...(extra.uri === undefined ? {} : { source: { uri: extra.uri } }),
    ...(extra.compression === undefined ? {} : { compression: extra.compression }),
    ...(extra.encryption === undefined ? {} : { encryption: extra.encryption }),
  });
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** A backup job for a plan (manual "run now" or a schedule tick). */
export function backupJob(deps: TaskDeps, plan: PlanRecord, startedBy: string): JobSpec {
  const connection = connectionById(deps.store, plan.connectionId);
  const storage = storageById(deps.store, plan.storageId);
  const uri = openConnectionUri(deps.store, connection);
  const passphrase = openPlanPassphrase(deps.store, plan);
  return {
    kind: "backup",
    lane: `connection:${connection.id}`,
    startedBy,
    planId: plan.id,
    storageId: storage.id,
    secrets: [uri, ...(passphrase === undefined ? [] : [passphrase])],
    run: async (context) => {
      const logger = jobLogger(context, deps.logger, [uri]);
      const encryption = encryptionOf(plan, passphrase);
      const shield = await shieldFor(deps, storage, {
        uri,
        compression: plan.compression,
        logger,
        ...(encryption === undefined ? {} : { encryption }),
      });
      const report = await runScheduledJob(shield, configOf(deps, plan, uri, shield, encryption), {
        signal: context.signal,
        logger,
        verify: plan.verify,
        // Labels this run's backup as the plan's, and limits the automatic prune to
        // the plan's own backups of this source.
        scopeLabels: planScopeLabels(plan),
        onProgress: context.progress,
        ...(passphrase === undefined ? {} : { decryption: { passphrase } }),
        ...(deps.webhookSecret === undefined ? {} : { webhookSecret: deps.webhookSecret }),
      });
      return outcomeOf(report);
    },
  };
}

/**
 * The labels that mark a plan's backups: `mongoshield.plan=<plan id>`.
 *
 * Several plans often write to one storage location (a nightly full backup and
 * an hourly one, two databases, two clusters). Retention must only see the
 * plan's own backups, or one plan's "keep the last 3" deletes the others'. Plan
 * ids never change when a plan is renamed or edited, so the label keeps working.
 */
function planScopeLabels(plan: PlanRecord): Record<string, string> {
  return { [PLAN_LABEL]: plan.id };
}

/**
 * The backups a plan's retention applies to: its own (by label) taken from its
 * connection's deployment (by cluster id, read from the source). Backups the plan
 * wrote before its connection pointed at another cluster are therefore left alone.
 */
async function planScope(
  deps: TaskDeps,
  plan: PlanRecord,
  signal?: AbortSignal,
): Promise<PruneScope> {
  const connection = connectionById(deps.store, plan.connectionId);
  const source = await shieldFor(deps, storageById(deps.store, plan.storageId), {
    uri: openConnectionUri(deps.store, connection),
  });
  try {
    const clusterId = await source.sourceClusterId(signal === undefined ? {} : { signal });
    return { clusterId, labels: planScopeLabels(plan) };
  } finally {
    await source.close();
  }
}

/** The library's encryption options for a plan. */
function encryptionOf(
  plan: PlanRecord,
  passphrase: string | undefined,
): EncryptionOptions | undefined {
  switch (plan.encryption.kind) {
    case "none":
      return undefined;
    case "recipients":
      return { recipients: plan.encryption.recipients };
    case "passphrase":
      return passphrase === undefined ? undefined : { passphrase };
  }
}

/**
 * The plan as a mongoshield config, which is what `runScheduledJob` takes. No
 * `schedule` section: the lock defaults to "storage" and verify is passed as an
 * option, and the console schedules runs itself (schedules.ts).
 */
function configOf(
  deps: TaskDeps,
  plan: PlanRecord,
  uri: string,
  shield: MongoShield,
  encryption: EncryptionOptions | undefined,
): MongoShieldConfig {
  const notify = plan.notify.map((target) => ({
    type: target.type,
    url: openNotifyUrl(deps.store, plan.id, target.url),
    on: ["success", "failure"] as ("success" | "failure")[],
  }));
  return {
    source: { uri },
    storage: shield.storage,
    compression: plan.compression,
    ...(encryption === undefined
      ? {}
      : {
          encryption: {
            ...(encryption.recipients === undefined
              ? {}
              : { recipients: [...encryption.recipients] }),
            ...(encryption.passphrase === undefined ? {} : { passphrase: encryption.passphrase }),
          },
        }),
    backup: {
      ...(plan.include.length > 0 ? { include: [...plan.include] } : {}),
      ...(plan.exclude.length > 0 ? { exclude: [...plan.exclude] } : {}),
      consistency: plan.consistency,
      // Incremental between full backups: the runner picks the kind of each run.
      ...(plan.incremental === undefined
        ? {}
        : { incremental: { fullEveryDays: plan.incremental.fullEveryDays } }),
    },
    ...(plan.retention === undefined ? {} : { retention: { ...plan.retention } }),
    ...(notify.length > 0 ? { notify } : {}),
  };
}

/** Turns a run report into a job outcome, or throws its error. */
function outcomeOf(report: RunReport): { summary: string; backupId?: string } {
  if (report.status === "failure") {
    const failure = report.error;
    const code = failure?.code ?? "MS_INTERNAL";
    throw new MongoShieldError(
      isErrorCode(code) ? code : "MS_INTERNAL",
      failure?.message ?? "The backup failed.",
      failure?.hint === undefined ? {} : { hint: failure.hint },
    );
  }
  const backupId = report.backup?.id;
  return {
    summary: summarizeReport(report),
    ...(backupId === undefined ? {} : { backupId }),
  };
}

function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}

// ---------------------------------------------------------------------------
// Restore, verify, drill
// ---------------------------------------------------------------------------

/** What a restore job restores, already authorized by the route. */
export interface RestoreJobInput {
  readonly storage: StorageRecord;
  readonly backupId: string;
  readonly target: ConnectionRecord;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly rename?: Readonly<Record<string, string>>;
  readonly mode: RestoreMode;
  readonly keys: GivenKeys;
  /**
   * Restore only matching documents (see `RestoreRequest.filter` in src/shared/api.ts).
   * Such restores go through `shield.restoreTenant`, which applies one filter to every
   * selected namespace and writes per document instead of per collection.
   */
  readonly filter?: Document;
}

/**
 * The library's per-document mode for a whole-collection restore mode. The
 * document-level restore never fails on existing data; the closest safe meaning
 * of "fail-if-exists" is "never overwrite", which is `insert`. `drop` becomes
 * `replace-tenant`: only the matching documents are deleted and restored, never
 * the whole collection.
 */
export function documentModeOf(mode: RestoreMode): TenantRestoreMode {
  switch (mode) {
    case "fail-if-exists":
    case "insert":
      return "insert";
    case "upsert":
      return "upsert";
    case "drop":
      return "replace-tenant";
  }
}

/** The options both a filtered plan (dry run) and a filtered restore pass to `restoreTenant`. */
function tenantOptions(
  input: RestoreJobInput,
  filter: Document,
  uri: string,
  decryption: DecryptionOptions | undefined,
) {
  return {
    backup: input.backupId,
    target: { uri },
    tenantFilter: filter,
    mode: documentModeOf(input.mode),
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(input.rename === undefined ? {} : { rename: input.rename }),
    ...(decryption === undefined ? {} : { decryption }),
  };
}

/**
 * The dry-run plan of a restore. Without a filter this is the library's
 * `planRestore`; with one, a `restoreTenant` dry run, whose counts are the
 * MATCHING documents (so the UI can compare them with the selection).
 */
export async function planRestoreView(
  deps: TaskDeps,
  input: RestoreJobInput,
): Promise<RestorePlanView> {
  const uri = openConnectionUri(deps.store, input.target);
  const decryption = decryptionFor(deps.store, input.storage.id, input.keys);
  const shield = await shieldFor(deps, input.storage);

  if (input.filter !== undefined) {
    const result = await shield.restoreTenant({
      ...tenantOptions(input, input.filter, uri, decryption),
      dryRun: true,
    });
    const mode = documentModeOf(input.mode);
    return {
      backupId: result.backupId,
      mode: input.mode,
      entries: [
        ...result.namespaces.map((entry) => ({
          from: entry.namespace,
          to: entry.targetNamespace,
          documents: entry.matched,
          existingDocuments:
            mode === "replace-tenant" ? entry.deleted : entry.skipped + entry.replaced,
          action: entry.createsCollection ? "create" : mode,
          reason: describeDocumentCounts(mode, entry),
        })),
        ...result.skipped.map((entry) => ({
          from: entry.namespace,
          to: entry.namespace,
          documents: 0,
          action: "skip",
          reason: entry.reason,
        })),
      ],
    };
  }

  const plan = await shield.planRestore({
    backup: input.backupId,
    target: { uri },
    mode: input.mode,
    ...(input.include === undefined ? {} : { include: input.include }),
    ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
    ...(input.rename === undefined ? {} : { rename: input.rename }),
    ...(decryption === undefined ? {} : { decryption }),
  });
  return {
    backupId: plan.backupId,
    mode: plan.mode,
    entries: plan.entries.map((entry) => ({
      from: entry.from,
      to: entry.to,
      documents: entry.documents,
      action: entry.action,
      ...(entry.existingDocuments === undefined
        ? {}
        : { existingDocuments: entry.existingDocuments }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    })),
  };
}

/** One line explaining a filtered namespace's counts, shown next to the plan entry. */
function describeDocumentCounts(
  mode: TenantRestoreMode,
  entry: {
    readonly matched: number;
    readonly inserted: number;
    readonly replaced: number;
    readonly skipped: number;
    readonly deleted: number;
  },
): string {
  const parts = [`${entry.matched} matching`, `${entry.inserted} new`];
  if (mode === "upsert") parts.push(`${entry.replaced} replaced`);
  if (mode === "replace-tenant") parts.push(`${entry.deleted} current deleted first`);
  if (entry.skipped > 0) parts.push(`${entry.skipped} already present, kept`);
  return parts.join(", ");
}

/** A restore job (whole collections, or only matching documents when `filter` is set). */
export function restoreJob(deps: TaskDeps, input: RestoreJobInput, startedBy: string): JobSpec {
  const uri = openConnectionUri(deps.store, input.target);
  const decryption = decryptionFor(deps.store, input.storage.id, input.keys);
  const filter = input.filter;
  return {
    kind: "restore",
    lane: `connection:${input.target.id}`,
    startedBy,
    storageId: input.storage.id,
    backupId: input.backupId,
    secrets: [uri, ...secretsOf(decryption)],
    run: async (context) => {
      const logger = jobLogger(context, deps.logger, [uri]);
      const shield = await shieldFor(deps, input.storage, { logger });

      if (filter !== undefined) {
        // restoreTenant reports no progress events; the job log says what happened.
        const result = await shield.restoreTenant({
          ...tenantOptions(input, filter, uri, decryption),
          signal: context.signal,
        });
        const { totals } = result;
        context.log(
          "info",
          `Matched ${totals.matched} documents: ${totals.inserted} inserted, ${totals.replaced} replaced, ${totals.skipped} kept, ${totals.deleted} deleted first.`,
        );
        return {
          summary: `Restored ${(totals.inserted + totals.replaced).toLocaleString("en-US")} of ${totals.matched.toLocaleString("en-US")} matching documents into ${result.namespaces.length} namespaces of ${input.target.name}.`,
          backupId: result.backupId,
        };
      }

      const result = await shield.restore({
        backup: input.backupId,
        target: { uri },
        mode: input.mode,
        signal: context.signal,
        onProgress: context.progress,
        ...(input.include === undefined ? {} : { include: input.include }),
        ...(input.exclude === undefined ? {} : { exclude: input.exclude }),
        ...(input.rename === undefined ? {} : { rename: input.rename }),
        ...(decryption === undefined ? {} : { decryption }),
      });
      const namespaces = result.plan.entries.filter((entry) => entry.action !== "skip").length;
      return {
        summary: `Restored ${result.documentsRestored.toLocaleString("en-US")} documents into ${namespaces} namespaces of ${input.target.name}.`,
        backupId: result.plan.backupId,
      };
    },
  };
}

/** A verify job. */
export function verifyJob(
  deps: TaskDeps,
  storage: StorageRecord,
  backupId: string,
  mode: "fast" | "deep",
  startedBy: string,
): JobSpec {
  const decryption = mode === "deep" ? decryptionFor(deps.store, storage.id) : undefined;
  return {
    kind: "verify",
    lane: `storage:${storage.id}`,
    startedBy,
    storageId: storage.id,
    backupId,
    secrets: secretsOf(decryption),
    run: async (context) => {
      const shield = await shieldFor(deps, storage, {
        logger: jobLogger(context, deps.logger, []),
      });
      const report = await shield.verify({
        backup: backupId,
        mode,
        signal: context.signal,
        onProgress: context.progress,
        ...(decryption === undefined ? {} : { decryption }),
      });
      if (!report.ok) {
        const first = report.problems[0];
        throw new MongoShieldError(
          "MS_INTEGRITY_FAILED",
          `Backup ${backupId} failed ${mode} verification with ${report.problems.length} problem(s)${first ? `, e.g. ${first.subject}: ${first.problem}` : ""}.`,
          { hint: "Do not rely on this backup. Take a new one and investigate the storage." },
        );
      }
      return {
        summary: `Verified (${mode}): ${report.filesChecked} files${mode === "deep" ? `, ${report.documentsChecked.toLocaleString("en-US")} documents` : ""}, no problems.`,
        backupId,
      };
    },
  };
}

/** A restore drill into a scratch connection. */
export function drillJob(
  deps: TaskDeps,
  storage: StorageRecord,
  backupId: string,
  target: ConnectionRecord,
  sample: number | undefined,
  startedBy: string,
): JobSpec {
  const uri = openConnectionUri(deps.store, target);
  const decryption = decryptionFor(deps.store, storage.id);
  return {
    kind: "drill",
    lane: `connection:${target.id}`,
    startedBy,
    storageId: storage.id,
    backupId,
    secrets: [uri, ...secretsOf(decryption)],
    run: async (context) => {
      const shield = await shieldFor(deps, storage, {
        logger: jobLogger(context, deps.logger, [uri]),
      });
      const report = await shield.drill({
        backup: backupId,
        target: { uri },
        signal: context.signal,
        onProgress: context.progress,
        // The drill only writes to fresh temporary databases. Drilling into the
        // backup's own deployment is allowed only when the target is NOT marked
        // production: there the extra load is someone else's risk to accept.
        allowSameDeployment: !target.production,
        ...(sample === undefined ? {} : { sample }),
        ...(decryption === undefined ? {} : { decryption }),
      });
      if (!report.ok) {
        const first = report.problems[0];
        throw new MongoShieldError(
          "MS_INTEGRITY_FAILED",
          `The drill of ${backupId} found ${report.problems.length} problem(s)${first ? `, e.g. ${first.subject}: ${first.problem}` : ""}.`,
        );
      }
      return {
        summary: `Drill passed: restored ${report.documentsRestored.toLocaleString("en-US")} documents in ${(report.restoreDurationMs / 1000).toFixed(1)} s (RTO).`,
        backupId,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

/**
 * How long the prune job holds the storage lock. Deleting a few backups takes
 * seconds; the lease is long so that even a slow storage cannot outlive it
 * (prune does not renew its lease, unlike a backup run).
 */
const PRUNE_LEASE_MS = 30 * 60 * 1000;

/** The plan's retention policy, or 400 when it has none. */
function retentionOf(plan: PlanRecord): RetentionPolicy & NonNullable<PlanRecord["retention"]> {
  if (plan.retention === undefined) {
    throw invalid(
      `The plan "${plan.name}" has no retention policy.`,
      "Edit the plan and set how many backups to keep first.",
    );
  }
  return { ...plan.retention };
}

/**
 * The dry run of a plan's retention policy: which of the plan's backups stay and
 * which would go. Backups of other plans and sources in the same storage are not
 * planned over; `outOfScope` says how many were left alone.
 */
export async function planPrune(deps: TaskDeps, plan: PlanRecord): Promise<PrunePlanView> {
  const policy = retentionOf(plan);
  const storage = storageById(deps.store, plan.storageId);
  const scope = await planScope(deps, plan);
  const shield = await shieldFor(deps, storage);
  const result = await shield.prune(policy, { dryRun: true, scope });
  return {
    planId: plan.id,
    storageId: storage.id,
    policy,
    keep: result.plan.keep.map((kept) => ({ id: kept.id, reasons: [...kept.reasons] })),
    remove: result.plan.remove.map((removed) => ({ id: removed.id, reason: removed.reason })),
    warnings: [...result.plan.warnings],
    outOfScope: result.outOfScope.length,
  };
}

/**
 * A prune job. `confirmed` are the ids the admin saw in the dry run: the job plans
 * again (the catalog may have changed) and refuses to run if that plan would delete
 * anything else, so confirming a dry run can never delete more than it showed.
 */
export function pruneJob(
  deps: TaskDeps,
  plan: PlanRecord,
  confirmed: readonly string[],
  startedBy: string,
): JobSpec {
  const policy = retentionOf(plan);
  const storage = storageById(deps.store, plan.storageId);
  const allowed = new Set(confirmed);
  return {
    kind: "prune",
    lane: `storage:${storage.id}`,
    startedBy,
    planId: plan.id,
    storageId: storage.id,
    run: async (context) => {
      const logger = jobLogger(context, deps.logger, []);
      const scope = await planScope(deps, plan, context.signal);
      const shield = await shieldFor(deps, storage, { logger });
      const release = await lockStorage(shield, context);
      try {
        const check = await shield.prune(policy, { dryRun: true, signal: context.signal, scope });
        const unexpected = check.plan.remove.filter((removed) => !allowed.has(removed.id));
        if (unexpected.length > 0) {
          throw new ConsoleError(
            409,
            "CONSOLE_PRUNE_PLAN_CHANGED",
            `The backups have changed since the dry run: ${unexpected.length} more would be deleted.`,
            "Review the retention plan again and confirm the new one.",
          );
        }
        const result = await shield.prune(policy, { signal: context.signal, scope });
        const skipped = result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "";
        return {
          summary: `Deleted ${result.deletedBackups} backups (${formatMiB(result.deletedBytes)}), kept ${result.plan.keep.length}${skipped}.`,
        };
      } finally {
        await release();
      }
    },
  };
}

/**
 * Takes the storage lock that backup runs hold (`runScheduledJob`, the CLI's
 * `mongoshield run`), so a prune never deletes while a backup is being written or
 * pruned by someone else. Storage without conditional writes cannot hold the lock;
 * the job then runs unlocked and says so in its log.
 *
 * @returns the function that releases the lock.
 */
async function lockStorage(shield: MongoShield, context: JobContext): Promise<() => Promise<void>> {
  if (!shield.storage.capabilities.conditionalWrites) {
    context.log("warn", "This storage cannot hold a lock; pruning without one.");
    return async () => {};
  }
  const host = hostname();
  const lock = storageLock({
    storage: shield.storage,
    owner: { id: `${host}:${process.pid}:console-prune-${randomId()}`, host, pid: process.pid },
    leaseMs: PRUNE_LEASE_MS,
  });
  const attempt = await lock.tryAcquire({ signal: context.signal });
  if (!attempt.acquired) {
    throw new ConsoleError(
      409,
      "CONSOLE_STORAGE_BUSY",
      "A backup or prune is running in this storage location right now.",
      "Try again when it has finished.",
    );
  }
  return () => attempt.lease.release();
}

/** Bytes as MiB with one decimal, for job summaries. */
function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------

/** The typed or stored keys of a job, for scrubbing them from its errors. */
export function secretsOf(decryption: DecryptionOptions | undefined): string[] {
  if (decryption === undefined) return [];
  return [
    ...(decryption.passphrase === undefined ? [] : [decryption.passphrase]),
    ...(decryption.identities ?? []),
  ];
}

/**
 * A library logger for one job: everything goes to the server log, and
 * warnings and errors also to the job's live log, scrubbed of secrets.
 */
function jobLogger(context: JobContext, base: Logger, secrets: readonly string[]): Logger {
  return {
    debug: (message, fields) => base.debug(message, fields),
    info: (message, fields) => base.info(message, fields),
    warn: (message, fields) => {
      base.warn(message, fields);
      context.log("warn", scrubText(message, secrets));
    },
    error: (message, fields) => {
      base.error(message, fields);
      context.log("error", scrubText(message, secrets));
    },
  };
}
