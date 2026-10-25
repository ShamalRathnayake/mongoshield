/**
 * Restore one tenant: put back only one customer's documents, in every collection of a
 * backup, leaving every other tenant's data untouched ("acme's admin deleted half their
 * projects; restore acme as it was last night").
 *
 *   validate (filters, rename, mode) → select + open the backup once
 *   → pick namespaces (include/exclude, filter map) → inspect every target, refuse
 *     views / time series before anything is written
 *   → per namespace: [replace-tenant: delete the tenant's current documents]
 *     → stream the backed-up documents that match the tenant filter → write in batches
 *
 * The tenant filter is a MongoDB query (`{ tenantId: "acme" }`), the same for every
 * collection or given per namespace (`tenantFilterByNamespace`) when collections name
 * the tenant differently. Backed-up documents are matched in-process (engine/filter.ts,
 * a documented subset of the query language); the delete of replace-tenant runs the
 * same filter on the server, with the binary collation so both sides compare strings
 * the same way.
 *
 * Modes, per target collection:
 *
 *   insert (default)  add the tenant's backed-up documents whose `_id` is missing;
 *                     existing documents are kept (counted as skipped)
 *   upsert            also replace existing documents with their backed-up version
 *   replace-tenant    delete every current document that matches the filter, then
 *                     insert the backed-up ones: the tenant ends up exactly as backed
 *                     up (documents created since the backup are gone)
 *
 * A dry run reads the backup and counts what would be deleted, inserted, replaced and
 * skipped, writing nothing. Safety: an empty filter is refused (it would select every
 * tenant), and so is a filter map that names a namespace the backup does not hold.
 * replace-tenant is not transactional: if reading the backup fails after a delete, the
 * tenant is partly restored. Running the same restore again is safe and completes it
 * (it deletes and inserts the same documents again).
 */

import type { Collection, Document, WriteConcernSettings } from "mongodb";
import type { RestoreContext } from "../engine/context.ts";
import { compileFilter, type DocumentMatcher } from "../engine/filter.ts";
import { matchingDocuments } from "../engine/find.ts";
import {
  assertUsableTarget,
  type BatchWriter,
  batchMatches,
  type Counts,
  createTarget,
  inspectTarget,
  type TargetKind,
  toWriteError,
  writeBatch,
} from "../engine/find-restore.ts";
import { type BatchLimits, DEFAULT_BATCH_LIMITS } from "../engine/restore-documents.ts";
import { assertValidTargetNamespace, compileRenameMap } from "../engine/restore-rename.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { valueInStoredOrder } from "../format/field-order.ts";
import { type CollectionEntry, collectionEntries } from "../format/manifest.ts";
import { compileNamespaceFilter, splitNamespace } from "../mongo/index.ts";
import type {
  BackupSelector,
  DecryptionOptions,
  NamespacePattern,
  SourceOptions,
} from "../types.ts";
import { type OpenedBackup, openedNamespace, openSelectedBackup } from "./read-backup.ts";

/** How the tenant's documents are written into each target collection. */
export type TenantRestoreMode = "insert" | "upsert" | "replace-tenant";

/** Every mode, for validation and the CLI. */
export const TENANT_RESTORE_MODES: readonly TenantRestoreMode[] = [
  "insert",
  "upsert",
  "replace-tenant",
];

/** Options for `restoreTenant`. */
export interface RestoreTenantOptions {
  /** Which backup: an id, `"latest"`, or `{ before: date }`. */
  readonly backup: BackupSelector;
  /**
   * The tenant, as a MongoDB filter applied to every selected collection, e.g.
   * `{ tenantId: "acme" }`. Required unless `tenantFilterByNamespace` is given.
   */
  readonly tenantFilter?: Document;
  /**
   * Per-namespace filters, for collections that name the tenant differently, e.g.
   * `{ "app.invoices": { "customer.tenant": "acme" } }`. They override `tenantFilter`.
   * Without `tenantFilter`, only the namespaces listed here are restored.
   */
  readonly tenantFilterByNamespace?: Readonly<Record<string, Document>>;
  /** Only these namespaces (patterns like `app.*`). Defaults to every collection. */
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Restore into other namespaces: `{ "app.*": "sandbox.*" }`, as for `restore`. */
  readonly rename?: Readonly<Record<string, string>>;
  /** `"insert"` (default), `"upsert"` or `"replace-tenant"`; see the file header. */
  readonly mode?: TenantRestoreMode;
  /** Count what would be deleted and written, without writing. */
  readonly dryRun?: boolean;
  readonly decryption?: DecryptionOptions;
  readonly writeConcern?: WriteConcernSettings;
  /** Batch sizes for writes. Mainly for tests. */
  readonly batchLimits?: BatchLimits;
  readonly signal?: AbortSignal;
}

/** Options of `shield.restoreTenant()`: `RestoreTenantOptions` plus where to write. */
export interface ShieldRestoreTenantOptions extends RestoreTenantOptions {
  /** The deployment to write to. Defaults to the instance's `source`. */
  readonly target?: SourceOptions;
}

/** What happened (or, in a dry run, would happen) in one target collection. */
export interface TenantNamespaceResult {
  /** The backed-up namespace. */
  readonly namespace: string;
  /** The namespace written to (after `rename`). */
  readonly targetNamespace: string;
  /** Backed-up documents that match the tenant filter. */
  readonly matched: number;
  /** Current documents of the tenant deleted first (replace-tenant only). */
  readonly deleted: number;
  /** Matching documents written as new documents. */
  readonly inserted: number;
  /** Existing documents replaced by their backed-up version (upsert only). */
  readonly replaced: number;
  /**
   * Matching documents not written because their `_id` exists: in insert mode, the
   * tenant's own current documents; in replace-tenant, an `_id` now used by a document
   * outside the tenant (worth a look).
   */
  readonly skipped: number;
  /** True when the target collection did not exist and was (or would be) created. */
  readonly createsCollection: boolean;
}

/** A selected namespace that was not restored, and why. */
export interface SkippedTenantNamespace {
  readonly namespace: string;
  readonly reason: string;
}

/** The outcome of `restoreTenant`. */
export interface RestoreTenantResult {
  readonly backupId: string;
  readonly mode: TenantRestoreMode;
  readonly dryRun: boolean;
  /** One entry per restored collection, in backup order. */
  readonly namespaces: readonly TenantNamespaceResult[];
  /** Views and time series collections, which cannot be restored per document. */
  readonly skipped: readonly SkippedTenantNamespace[];
  /** Sums over `namespaces`. */
  readonly totals: {
    readonly matched: number;
    readonly deleted: number;
    readonly inserted: number;
    readonly replaced: number;
    readonly skipped: number;
  };
  readonly durationMs: number;
}

/** A namespace to restore, with everything decided before the first write. */
interface PlannedTenantNamespace {
  readonly entry: CollectionEntry;
  readonly targetNamespace: string;
  /** The tenant filter as given (sent to the server for replace-tenant). */
  readonly filter: Document;
  /** The same filter compiled for the backed-up documents. */
  readonly matcher: DocumentMatcher;
  readonly target: TargetKind;
}

/** Upserts, deletes and `_id` lookups use the binary collation, like the in-process matcher. */
const BINARY_COLLATION = { locale: "simple" } as const;

/**
 * Restores one tenant's documents from a backup into the target deployment.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a missing, empty or unsupported
 *   filter, an unknown mode, bad rename rules or patterns that select nothing;
 *   `MS_RESTORE_CONFLICT` when a target is a view or time series collection;
 *   `MS_PERMISSION_DENIED` / `MS_RESTORE_FAILED` for write failures; read-pipeline errors
 *   for damaged or locked backups; `MS_BACKUP_NOT_FOUND`; `MS_ABORTED`.
 */
export async function restoreTenant(
  context: RestoreContext,
  options: RestoreTenantOptions,
): Promise<RestoreTenantResult> {
  const startedAt = performance.now();
  const mode = validateTenantMode(options.mode);
  const dryRun = options.dryRun === true;
  assertSomeFilter(options);

  const backup = await openSelectedBackup(context, options);
  const { planned, skipped } = await planNamespaces(context, backup, options);

  const results: TenantNamespaceResult[] = [];
  for (const namespace of planned) {
    throwIfAborted(options.signal);
    results.push(await restoreNamespace(context, backup, namespace, { ...options, mode, dryRun }));
  }

  const result: RestoreTenantResult = {
    // An incremental's own id, not its chain's base (see restore-chain.ts).
    backupId: backup.chain?.backupId ?? backup.manifest.id,
    mode,
    dryRun,
    namespaces: results,
    skipped,
    totals: sumResults(results),
    durationMs: Math.round(performance.now() - startedAt),
  };
  context.logger.info(dryRun ? "Dry run: nothing was written" : "Restored the tenant", {
    backupId: result.backupId,
    namespaces: results.length,
    ...result.totals,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Validation and planning (nothing is written here)
// ---------------------------------------------------------------------------

/** The mode, or an error naming the valid ones. */
export function validateTenantMode(mode: string | undefined): TenantRestoreMode {
  if (mode === undefined) return "insert";
  const known = TENANT_RESTORE_MODES.find((candidate) => candidate === mode);
  if (known !== undefined) return known;
  throw new MongoShieldError("MS_CONFIG_INVALID", `Unknown tenant restore mode "${mode}".`, {
    hint: 'Use "insert" (keep existing documents), "upsert" (replace them) or "replace-tenant" (delete the tenant\'s current documents first).',
  });
}

/** At least one filter is needed: restoring "every tenant" is what `restore` is for. */
function assertSomeFilter(options: RestoreTenantOptions): void {
  const mapped = Object.keys(options.tenantFilterByNamespace ?? {}).length;
  if (options.tenantFilter === undefined && mapped === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Which tenant? No tenant filter was given.", {
      hint: 'Pass tenantFilter (CLI: --filter \'{"tenantId":"acme"}\'), or per-namespace filters.',
    });
  }
}

/**
 * An empty filter matches every document of every tenant (and, with replace-tenant,
 * would delete the whole collection), so it is refused.
 */
function compileTenantFilter(namespace: string, filter: Document): DocumentMatcher {
  if (Object.keys(filter).length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The tenant filter for ${namespace} is empty; it would select every document.`,
      {
        hint: 'Name the tenant, e.g. { "tenantId": "acme" }. To restore everything, use `restore`.',
      },
    );
  }
  return compileFilter(filter);
}

/**
 * Decides, for every namespace of the backup, whether and where it is restored, and
 * checks every target. Throws before anything is written if any target is unusable.
 */
async function planNamespaces(
  context: RestoreContext,
  backup: OpenedBackup,
  options: RestoreTenantOptions,
): Promise<{ planned: PlannedTenantNamespace[]; skipped: SkippedTenantNamespace[] }> {
  const { manifest } = backup;
  const byNamespace = options.tenantFilterByNamespace ?? {};
  // Users and roles entries are not collections; tenant data never lives there.
  const collections = collectionEntries(manifest.namespaces);
  assertMappedNamespacesExist(manifest.id, collections, byNamespace);

  const selectedByPattern = compileNamespaceFilter({
    include: options.include,
    exclude: options.exclude,
  });
  const rename = compileRenameMap(options.rename);
  const planned: PlannedTenantNamespace[] = [];
  const skipped: SkippedTenantNamespace[] = [];
  const sourceByTarget = new Map<string, string>();

  for (const entry of collections) {
    if (!selectedByPattern(entry.ns)) continue;
    const filter = byNamespace[entry.ns] ?? options.tenantFilter;
    // Without a global filter, only the namespaces of the map are restored.
    if (filter === undefined) continue;
    if (entry.type !== "collection") {
      skipped.push({ namespace: entry.ns, reason: skipReason(entry.type) });
      continue;
    }
    const matcher = compileTenantFilter(entry.ns, filter);
    const targetNamespace = rename(entry.ns);
    if (targetNamespace !== entry.ns) assertValidTargetNamespace(targetNamespace);
    assertSingleSource(sourceByTarget, entry.ns, targetNamespace);

    const target = await inspectTarget(context.client, targetNamespace);
    // A missing target is created (namespaces come from the backup, not from a typo).
    assertUsableTarget(targetNamespace, target, true);
    planned.push({ entry, targetNamespace, filter, matcher, target });
  }

  if (planned.length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `No collection of backup ${manifest.id} is selected for the tenant restore.`,
      { hint: "Check --include / --exclude and the namespaces of the per-namespace filters." },
    );
  }
  return { planned, skipped };
}

/** A typo in a filter map key would otherwise silently skip that collection. */
function assertMappedNamespacesExist(
  backupId: string,
  namespaces: readonly CollectionEntry[],
  byNamespace: Readonly<Record<string, Document>>,
): void {
  const known = new Set(namespaces.map((entry) => entry.ns));
  const unknown = Object.keys(byNamespace).filter((namespace) => !known.has(namespace));
  if (unknown.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Backup ${backupId} does not contain ${unknown.join(", ")} (named in the per-namespace filters).`,
      { hint: "Run `mongoshield inspect <backup>` to list its namespaces." },
    );
  }
}

/** Two namespaces renamed onto one target would mix their documents. */
function assertSingleSource(
  sourceByTarget: Map<string, string>,
  namespace: string,
  targetNamespace: string,
): void {
  const other = sourceByTarget.get(targetNamespace);
  if (other !== undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Both ${other} and ${namespace} would be restored to ${targetNamespace}.`,
      { hint: "Change the rename rules so every namespace has its own target." },
    );
  }
  sourceByTarget.set(targetNamespace, namespace);
}

function skipReason(type: CollectionEntry["type"]): string {
  if (type === "view") return "a view stores no documents";
  return "time series collections have no unique _id to restore documents by; restore the whole collection with `restore`";
}

// ---------------------------------------------------------------------------
// Restoring one namespace
// ---------------------------------------------------------------------------

/** The options `restoreNamespace` reads, with mode and dry run resolved. */
interface ResolvedOptions extends RestoreTenantOptions {
  readonly mode: TenantRestoreMode;
  readonly dryRun: boolean;
}

/** [delete the tenant] → stream the tenant's backed-up documents → write in batches. */
async function restoreNamespace(
  context: RestoreContext,
  backup: OpenedBackup,
  planned: PlannedTenantNamespace,
  options: ResolvedOptions,
): Promise<TenantNamespaceResult> {
  const { database, collection: name } = splitNamespace(planned.targetNamespace);
  const collection = context.client.db(database).collection(name);
  const opened = openedNamespace(backup, planned.entry);
  const exists = planned.target !== "missing";

  if (!exists && !options.dryRun) {
    await createTarget(context, opened, planned.targetNamespace, options);
  }
  const deleted =
    options.mode === "replace-tenant" && exists
      ? await deleteTenant(collection, planned.filter, options)
      : 0;

  const counts: Counts = { matched: 0, inserted: 0, replaced: 0, skipped: 0 };
  const writer: BatchWriter = {
    collection,
    // After the delete, replace-tenant only inserts.
    mode: options.mode === "upsert" ? "upsert" : "insert",
    dryRun: options.dryRun,
    targetExists: exists,
    options,
  };
  const matches = matchingDocuments(opened, planned.matcher, options.signal, {
    logger: context.logger,
  });
  for await (const batch of batchMatches(matches, options.batchLimits ?? DEFAULT_BATCH_LIMITS)) {
    throwIfAborted(options.signal);
    counts.matched += batch.length;
    if (options.dryRun && options.mode === "replace-tenant") {
      await countReplaceTenantBatch(collection, planned.filter, batch, exists, counts);
    } else {
      await writeBatch(writer, batch, counts);
    }
  }

  context.logger.info(options.dryRun ? "Planned tenant namespace" : "Restored tenant namespace", {
    ns: planned.entry.ns,
    target: planned.targetNamespace,
    deleted,
    ...counts,
  });
  return {
    namespace: planned.entry.ns,
    targetNamespace: planned.targetNamespace,
    deleted,
    ...counts,
    createsCollection: !exists,
  };
}

/** Deletes (or, in a dry run, counts) the tenant's current documents. */
async function deleteTenant(
  collection: Collection,
  filter: Document,
  options: ResolvedOptions,
): Promise<number> {
  try {
    if (options.dryRun) {
      return await collection.countDocuments(filter, { collation: BINARY_COLLATION });
    }
    const result = await collection.deleteMany(filter, {
      collation: BINARY_COLLATION,
      ...(options.writeConcern ? { writeConcern: options.writeConcern } : {}),
    });
    return result.deletedCount;
  } catch (error) {
    throw toWriteError(collection.namespace, error);
  }
}

/**
 * Dry run of replace-tenant: the tenant's current documents would be deleted first, so
 * only `_id`s held by documents OUTSIDE the tenant would block an insert.
 */
async function countReplaceTenantBatch(
  collection: Collection,
  filter: Document,
  documents: readonly Document[],
  exists: boolean,
  counts: Counts,
): Promise<void> {
  // `_id`s in stored field order, so an embedded-document `_id` with integer-like
  // field names matches the stored one (src/format/field-order.ts).
  const ids = documents
    .filter((document) => document._id !== undefined)
    .map((document) => valueInStoredOrder(document._id));
  let blocked = 0;
  if (exists && ids.length > 0) {
    try {
      const query: Document = { $and: [{ _id: { $in: ids } }, { $nor: [filter] }] };
      blocked = await collection.countDocuments(query, { collation: BINARY_COLLATION });
    } catch (error) {
      throw toWriteError(collection.namespace, error);
    }
  }
  counts.skipped += blocked;
  counts.inserted += documents.length - blocked;
}

function sumResults(results: readonly TenantNamespaceResult[]): RestoreTenantResult["totals"] {
  const totals = { matched: 0, deleted: 0, inserted: 0, replaced: 0, skipped: 0 };
  for (const result of results) {
    totals.matched += result.matched;
    totals.deleted += result.deleted;
    totals.inserted += result.inserted;
    totals.replaced += result.replaced;
    totals.skipped += result.skipped;
  }
  return totals;
}
