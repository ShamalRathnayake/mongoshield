/**
 * The work behind each job kind, built on the public mongoshield API.
 *
 *   backup   runScheduledJob: storage lock → backup (+ guard) → verify → prune → notify,
 *            exactly what `mongoshield run` does, so a console and a CLI CronJob can
 *            share a storage location safely (they take the same lock)
 *   restore  shield.restore into a target connection
 *   verify   shield.verify (fast or deep), recorded next to the backup
 *   drill    shield.drill into a scratch connection, recorded next to the backup
 *
 * Each `…Job` function looks up what it needs, decrypts secrets only inside the
 * job (never earlier, never into a response), and returns a `JobSpec` for the
 * runner. Secrets that might appear in errors are listed in `spec.secrets` so
 * the runner scrubs them.
 */

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
  type RestoreMode,
  runScheduledJob,
  summarizeReport,
  type TenantRestoreMode,
} from "mongoshield";
import { notFound } from "../server/errors.ts";
import type { RestorePlanView } from "../shared/api.ts";
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
        onProgress: context.progress,
        ...(passphrase === undefined ? {} : { decryption: { passphrase } }),
        ...(deps.webhookSecret === undefined ? {} : { webhookSecret: deps.webhookSecret }),
      });
      return outcomeOf(report);
    },
  };
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

function secretsOf(decryption: DecryptionOptions | undefined): string[] {
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
