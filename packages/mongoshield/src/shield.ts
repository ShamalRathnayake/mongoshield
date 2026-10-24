/**
 * `MongoShield`: the friendly front door of the library.
 *
 * It holds the long-lived settings (where to connect, where backups live, how
 * to compress and encrypt) and exposes one method per task. Each method opens
 * what it needs, calls the matching engine, and cleans up afterwards.
 *
 *   import { MongoShield } from "mongoshield";
 *   import { s3Storage } from "mongoshield/storage/s3";
 *
 *   const shield = new MongoShield({
 *     source: { uri: process.env.MONGODB_URI },
 *     storage: s3Storage({ bucket: "acme-backups", prefix: "prod/" }),
 *     encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
 *   });
 *
 *   const { id } = await shield.backup();
 *   await shield.restore({ backup: id, rename: { "app.*": "app_restored.*" } });
 */

import type { Document, MongoClient } from "mongodb";
import { placeHold, recordVerification, releaseHold } from "./catalog/annotations.ts";
import { type CatalogEntry, listBackups } from "./catalog/catalog.ts";
import { type PruneResult, pruneBackups } from "./catalog/prune.ts";
import type { RetentionPolicy } from "./catalog/retention.ts";
import type { PruneScope } from "./catalog/scope.ts";
import { defaultCompression } from "./compression/index.ts";
import { runCopy } from "./copy/copy.ts";
import { runBackup } from "./engine/backup.ts";
import type { BackupContext, RestoreContext } from "./engine/context.ts";
import { type DrillReport, drillBackup, type ShieldDrillOptions } from "./engine/drill.ts";
import { recordDrill } from "./engine/drill-record.ts";
import { type FindInBackupOptions, findInBackup } from "./engine/find.ts";
import {
  type RestoreDocumentsResult,
  restoreDocuments,
  type ShieldRestoreDocumentsOptions,
} from "./engine/find-restore.ts";
import { planRestore, runRestore } from "./engine/restore.ts";
import { verifyBackup } from "./engine/verify.ts";
import { MongoShieldError } from "./errors.ts";
import { type DiffOptions, type DiffResult, diffBackups } from "./extras/diff.ts";
import { type ErasableResult, withErasures } from "./extras/erasure.ts";
import {
  type ExportDocumentsOptions,
  type ExportDocumentsResult,
  exportDocuments,
} from "./extras/export-text.ts";
import {
  type DocumentHistory,
  type DocumentHistoryOptions,
  documentHistory,
} from "./extras/history.ts";
import {
  type RestoreTenantResult,
  restoreTenant,
  type ShieldRestoreTenantOptions,
} from "./extras/tenant-restore.ts";
import { isBackupId } from "./format/layout.ts";
import type { ClusterTime, Compression } from "./format/manifest.ts";
import { readManifest } from "./format/manifest-io.ts";
import {
  listBaseBackups,
  planPointInTimeRestore,
  pruneJournal,
  replayJournal,
} from "./journal/index.ts";
import { type Logger, silentLogger } from "./logger.ts";
import { type MongoConnection, openConnection } from "./mongo/connection.ts";
import { describeDeployment } from "./mongo/deployment.ts";
import type { StorageAdapter } from "./storage/types.ts";
import {
  ATTRIBUTES,
  ENGINE_SPANS,
  Telemetry,
  traceBackup,
  traceDrill,
  tracePrune,
  traceRestore,
  traceVerify,
  withEngineSpan,
} from "./telemetry/index.ts";
import type {
  BackupOptions,
  BackupResult,
  CompletedBackupResult,
  CompletingBackupOptions,
  CopyOptions,
  CopyResult,
  EncryptionOptions,
  MongoShieldOptions,
  RestoreOptions,
  RestorePlan,
  RestoreResult,
  SourceOptions,
  VerifyOptions,
  VerifyReport,
} from "./types.ts";

/** Options for `shield.prune()`. */
export interface ShieldPruneOptions {
  /** Report what would be deleted without deleting anything. */
  readonly dryRun?: boolean;
  /** The current time; mainly for tests. */
  readonly now?: Date;
  /**
   * Apply the policy only to the backups of one source/selection, e.g.
   * `{ clusterId: await shield.sourceClusterId(), labels: { "mongoshield.shape": "…" } }`.
   * Every other backup in the storage location is left alone and reported in
   * `outOfScope`. Without a scope the policy covers every backup in the location,
   * which is only right when one job writes there.
   */
  readonly scope?: PruneScope;
  readonly signal?: AbortSignal;
}

export class MongoShield {
  /** Where backups are read from and written to. */
  readonly storage: StorageAdapter;
  /** Compression used for new backups. */
  readonly compression: Compression;

  readonly #source: SourceOptions | undefined;
  readonly #encryption: EncryptionOptions | undefined;
  readonly #logger: Logger;
  /** Keys hashed erasure filters; see `MongoShieldOptions.erasures`. */
  readonly #erasureSecret: string | undefined;
  /** OpenTelemetry spans and metrics around each public operation (no-op unless set up). */
  readonly #telemetry: Telemetry;

  constructor(options: MongoShieldOptions) {
    // Plain JavaScript callers get no compile-time checks, so check the one
    // setting nothing can work without.
    if (typeof options?.storage?.put !== "function") {
      throw new MongoShieldError("MS_CONFIG_INVALID", "MongoShield needs a storage adapter.", {
        hint: 'Pass one, e.g. `storage: fileStorage({ path: "./backups" })`.',
      });
    }

    this.storage = options.storage;
    this.compression = options.compression ?? defaultCompression();
    this.#source = options.source;
    this.#encryption = options.encryption;
    this.#logger = options.logger ?? silentLogger;
    this.#erasureSecret = options.erasures?.secret;
    this.#telemetry = new Telemetry(options.telemetry);
  }

  /**
   * Backs up the source deployment. The backup is committed (its manifest is
   * written) only if every collection was saved successfully. With `maxDurationMs`
   * or `resume` the result may instead be `{ status: "checkpointed" }`: call again
   * with `resume` to continue (see docs/specs/PARTS-AND-RESUME.md).
   */
  async backup(options?: CompletingBackupOptions): Promise<CompletedBackupResult>;
  async backup(options?: BackupOptions): Promise<BackupResult>;
  async backup(options: BackupOptions = {}): Promise<BackupResult> {
    const source = this.#requireSource("backup");
    return traceBackup(this.#telemetry, () =>
      this.#withConnection(
        source,
        (connection) => {
          const context: BackupContext = {
            client: connection.client,
            storage: this.storage,
            logger: this.#logger,
            compression: this.compression,
            encryption: this.#encryption,
            ...this.#engineTelemetry(),
          };
          return runBackup(context, options);
        },
        options.signal,
      ),
    );
  }

  /**
   * Restores a backup into `options.target`, or into the source deployment if
   * no target is given. Refuses to overwrite existing data unless `mode` says so.
   */
  async restore(options: RestoreOptions): Promise<RestoreResult> {
    const target = options.target ?? this.#requireSource("restore");
    const details = { mode: options.mode ?? "fail-if-exists", dryRun: options.dryRun === true };
    return traceRestore(this.#telemetry, details, () =>
      this.#withConnection(
        target,
        (connection) =>
          options.at === undefined
            ? this.#withErasures(connection, options, () =>
                runRestore(this.#restoreContext(connection), options),
              )
            : this.#withErasures(connection, options, () =>
                this.#restoreToPointInTime(connection, options, options.at as Date | ClusterTime),
              ),
        options.signal,
      ),
    );
  }

  /**
   * Point-in-time recovery: restore the newest base backup taken before `at`, then
   * replay the change journal from that backup's cluster time up to `at`.
   * Planning comes first, so a gap in the journal fails before anything is written.
   */
  async #restoreToPointInTime(
    connection: MongoConnection,
    options: RestoreOptions,
    at: Date | ClusterTime,
  ): Promise<RestoreResult> {
    if (options.backup !== "latest") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        "A point-in-time restore picks its base backup itself.",
        {
          hint: 'Pass `backup: "latest"` together with `at`, or restore a backup id without `at`.',
        },
      );
    }

    const plan = await planPointInTimeRestore(this.storage, at, { signal: options.signal });
    const base = await runRestore(this.#restoreContext(connection), {
      ...options,
      backup: plan.baseBackupId,
    });
    if (options.dryRun === true) {
      return {
        ...base,
        pointInTime: {
          baseBackupId: plan.baseBackupId,
          restoredTo: plan.at,
          events: 0,
          warnings: [],
        },
      };
    }

    const replay = await withEngineSpan(
      this.#engineTelemetry().telemetry,
      ENGINE_SPANS.restoreReplay,
      () => ({}),
      async (span) => {
        const replayed = await replayJournal({
          client: connection.client,
          storage: this.storage,
          from: plan.baseTime,
          to: plan.at,
          baseNamespaces: plan.baseNamespaces,
          include: options.include,
          exclude: options.exclude,
          rename: options.rename,
          mode: options.mode,
          decryption: options.decryption,
          writeConcern: options.writeConcern,
          skipIndexes: options.skipIndexes,
          logger: this.#logger,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        span.setAttributes({ [ATTRIBUTES.events]: replayed.applied });
        return replayed;
      },
    );
    return {
      ...base,
      durationMs: base.durationMs + replay.durationMs,
      pointInTime: {
        baseBackupId: plan.baseBackupId,
        restoredTo: replay.restoredTo,
        events: replay.events,
        warnings: replay.warnings,
      },
    };
  }

  /** Works out what `restore()` would do, without writing anything. */
  async planRestore(options: RestoreOptions): Promise<RestorePlan> {
    const target = options.target ?? this.#requireSource("plan a restore");
    return this.#withConnection(
      target,
      (connection) => planRestore(this.#restoreContext(connection), options),
      options.signal,
    );
  }

  /**
   * Checks that a backup is complete and intact. Needs no database connection.
   * The outcome is recorded next to the backup, where retention's `minVerified`
   * rule and `list()` can see it.
   */
  async verify(options: VerifyOptions): Promise<VerifyReport> {
    return traceVerify(this.#telemetry, options.mode ?? "fast", async () => {
      const report = await verifyBackup(
        { storage: this.storage, logger: this.#logger, ...this.#engineTelemetry() },
        options,
      );
      await recordVerification(this.storage, report);
      return report;
    });
  }

  /**
   * Restore drill: restores a backup into temporary databases on a scratch
   * deployment (`options.target`, required), checks counts, indexes, an optional
   * sample of documents and your own assertions, then drops the temporary
   * databases. `restoreDurationMs` in the report is the measured recovery time.
   * The outcome is recorded next to the backup, like a verification.
   */
  async drill(options: ShieldDrillOptions): Promise<DrillReport> {
    return traceDrill(this.#telemetry, () =>
      this.#withConnection(
        options.target,
        async (connection) => {
          const context = this.#restoreContext(connection);
          const report = await drillBackup(context, options);
          await recordDrill(this.storage, report);
          return report;
        },
        options.signal,
      ),
    );
  }

  /**
   * Copies namespaces from `options.from` (default: the configured source) straight
   * into `options.to`, masking and subsetting on the way. Nothing goes through storage.
   * Refuses to overwrite existing data unless `mode` says so.
   *
   *   await shield.copy({
   *     to: { uri: process.env.STAGING_URI },
   *     rename: { "app.*": "app_staging.*" },
   *     mask: defineMask({ secret, rules: { "app.users": { email: { fake: "email" } } } }),
   *   });
   */
  async copy(options: CopyOptions): Promise<CopyResult> {
    const from = options.from ?? this.#requireSource("copy");
    return this.#withConnection(
      from,
      (source) =>
        this.#withConnection(options.to, (target) =>
          this.#withErasures(target, options, () =>
            runCopy(
              { source: source.client, target: target.client, logger: this.#logger },
              options,
            ),
          ),
        ),
      options.signal,
    );
  }

  /** Protects a backup from pruning until `release()` is called. */
  async hold(backupId: string, details: { readonly reason: string; readonly by?: string }) {
    // Holding a typo'd id would silently protect nothing, so insist the backup exists.
    if (!isBackupId(backupId) || (await readManifest(this.storage, backupId)) === undefined) {
      throw new MongoShieldError(
        "MS_BACKUP_NOT_FOUND",
        `There is no complete backup "${backupId}".`,
        {
          hint: "Run `mongoshield list` to see the available backup ids.",
        },
      );
    }
    return placeHold(this.storage, backupId, details);
  }

  /** Removes a hold placed with `hold()`. */
  async release(backupId: string): Promise<void> {
    await releaseHold(this.storage, backupId);
  }

  /** Lists the backups in storage, newest first, including incomplete runs. */
  async list(options: { readonly signal?: AbortSignal } = {}): Promise<CatalogEntry[]> {
    return listBackups(this.storage, { logger: this.#logger, ...options });
  }

  /** Deletes backups that the retention policy no longer needs. */
  async prune(policy: RetentionPolicy, options: ShieldPruneOptions = {}): Promise<PruneResult> {
    return tracePrune(this.#telemetry, options.dryRun === true, async () => {
      const result = await pruneBackups(this.storage, policy, { logger: this.#logger, ...options });
      // Journal segments older than the oldest remaining base backup can never be
      // replayed onto anything, so they go too. Gap records are always kept.
      // The base backups are listed WITHOUT the scope: the journal is shared by the
      // whole location, and a segment another scope's backup still needs must stay.
      if (options.dryRun !== true) {
        const oldestBase = (await listBaseBackups(this.storage)).at(-1);
        if (oldestBase) await pruneJournal(this.storage, { olderThan: oldestBase.clusterTime });
      }
      return result;
    });
  }

  /**
   * The stable, non-secret id of the configured source deployment: the
   * `source.clusterId` its backups record (a hash, never a host name). Pass it in
   * a prune `scope` so retention only covers this deployment's backups.
   */
  async sourceClusterId(options: { readonly signal?: AbortSignal } = {}): Promise<string> {
    const source = this.#requireSource("identify the source deployment");
    return this.#withConnection(
      source,
      async (connection) => (await describeDeployment(connection.client)).clusterId,
      options.signal,
    );
  }

  /** Releases the storage adapter's resources (connections, file handles). */
  async close(): Promise<void> {
    await this.storage.close?.();
  }

  // --- Recovery recipes (extras/*.ts) ------------------------------------------

  /**
   * Runs `task` with a client connected to the configured source, and closes the
   * connection afterwards (a client passed as `source.client` is never closed). For
   * recipes that look at the live deployment besides restoring into it, such as
   * `rollback` finding the collections a migration created.
   */
  async withSourceClient<T>(task: (client: MongoClient) => Promise<T>): Promise<T> {
    return this.#withConnection(this.#requireSource("connect to the source"), (connection) =>
      task(connection.client),
    );
  }

  /**
   * Restores only one tenant's documents (e.g. `{ tenantId: "acme" }`) across every
   * selected collection, leaving other tenants untouched.
   */
  async restoreTenant(options: ShieldRestoreTenantOptions): Promise<RestoreTenantResult> {
    const target = options.target ?? this.#requireSource("restore a tenant");
    return this.#withConnection(
      target,
      async (connection) => {
        // The erasure helper reads which namespaces were written from a `plan`; a tenant
        // restore reports them per namespace, so they are mapped into that shape.
        const result = await this.#withErasures(connection, options, async () => {
          const tenant = await restoreTenant(this.#restoreContext(connection), options);
          const entries = tenant.namespaces.map((ns) => ({
            from: ns.namespace,
            to: ns.targetNamespace,
          }));
          return { ...tenant, plan: { entries } };
        });
        const { plan: _plan, ...tenantResult } = result;
        return tenantResult;
      },
      options.signal,
    );
  }

  /** How one document looked in each backup (and in the change journal, if any). */
  async history(options: DocumentHistoryOptions): Promise<DocumentHistory> {
    return documentHistory(this.#storageContext(), options);
  }

  /** What changed between two backups, or between a backup and a live deployment. */
  async diff(options: DiffOptions): Promise<DiffResult> {
    return diffBackups(this.#storageContext(), options);
  }

  /** Writes one collection of a backup as JSON Lines or CSV. */
  async exportDocuments(options: ExportDocumentsOptions): Promise<ExportDocumentsResult> {
    return exportDocuments(this.#storageContext(), options);
  }

  // --- Searching backups and single-document restore (engine/find*.ts) -----

  /**
   * Searches one collection of a backup with a MongoDB filter, without restoring it
   * and without a database connection. Documents stream in backup order, with their
   * BSON types preserved. Only a subset of query operators is supported (see
   * src/engine/filter.ts); others fail with `MS_CONFIG_INVALID`.
   *
   *   for await (const user of shield.find({ backup: "latest", namespace: "app.users",
   *     filter: { email: "ada@example.com" } })) console.log(user);
   */
  find(options: FindInBackupOptions): AsyncIterable<Document> {
    return findInBackup({ storage: this.storage, logger: this.#logger }, options);
  }

  /**
   * Restores only the documents of a backed-up collection that match `filter`, into
   * `options.to` (default: the source) and `targetNamespace` (default: the same
   * namespace). `mode: "insert"` (default) skips documents whose `_id` exists;
   * `"upsert"` replaces them. `dryRun` only counts.
   */
  async restoreDocuments(options: ShieldRestoreDocumentsOptions): Promise<RestoreDocumentsResult> {
    const target = options.to ?? this.#requireSource("restore documents");
    return this.#withConnection(
      target,
      (connection) => restoreDocuments(this.#restoreContext(connection), options),
      options.signal,
    );
  }

  // -------------------------------------------------------------------------

  /** The context for engines that only read storage. */
  #storageContext() {
    return { storage: this.storage, logger: this.#logger, ...this.#engineTelemetry() };
  }

  /**
   * Runs a restore-like operation, then deletes every document the erasure ledger
   * lists from the namespaces it wrote, so erased personal data never comes back.
   */
  #withErasures<Result extends ErasableResult>(
    connection: MongoConnection,
    options: {
      readonly skipErasures?: boolean | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly dryRun?: boolean | undefined;
    },
    operation: () => Promise<Result>,
  ) {
    const context = {
      client: connection.client,
      storage: this.storage,
      secret: this.#erasureSecret,
      logger: this.#logger,
    };
    return withErasures(context, options, operation);
  }

  #restoreContext(connection: MongoConnection): RestoreContext {
    return {
      client: connection.client,
      storage: this.storage,
      logger: this.#logger,
      ...this.#engineTelemetry(),
    };
  }

  /**
   * The engines' telemetry (per-namespace spans), as a context field. Left out
   * entirely when telemetry is disabled, so the engines skip even no-op calls.
   */
  #engineTelemetry(): { readonly telemetry?: Telemetry } {
    return this.#telemetry.enabled ? { telemetry: this.#telemetry } : {};
  }

  /** Returns the configured source, or explains that one is needed. */
  #requireSource(task: string): SourceOptions {
    if (!this.#source) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `A database connection is needed to ${task}.`,
        {
          hint: "Pass `source: { uri }` (or `{ client }`) to `new MongoShield(...)`, or a `target` to restore().",
        },
      );
    }
    return this.#source;
  }

  /**
   * Opens a connection, runs `task`, and always closes the connection again
   * (a client supplied by the caller is never closed).
   */
  async #withConnection<T>(
    source: SourceOptions,
    task: (connection: MongoConnection) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // The signal also covers connecting: Ctrl-C while the driver is still looking for a
    // server must cancel at once, not after the 30 s server selection timeout.
    const connection = await openConnection(source, {
      logger: this.#logger,
      ...(signal ? { signal } : {}),
    });
    try {
      return await task(connection);
    } finally {
      await connection.close();
    }
  }
}
