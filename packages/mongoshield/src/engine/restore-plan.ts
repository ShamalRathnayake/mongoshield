/**
 * Restore planning: which namespaces of a backup are restored, where to, and what
 * happens to whatever already exists at each target.
 *
 *   select backup → filter namespaces (include/exclude) → rename → inspect targets
 *   → decide an action per namespace from the mode → refuse conflicts
 *
 * Planning only reads (listCollections and document counts); it never writes. The
 * actions, by mode, when the target already exists:
 *
 *   mode             existing target                  action
 *   fail-if-exists   empty collection, same type      insert (nothing to overwrite)
 *                    non-empty, a view, other type    conflict → MS_RESTORE_CONFLICT
 *   drop             anything                         drop-and-create
 *   insert           same type                        insert (duplicate _id skipped)
 *   upsert           same type                        upsert (replace by _id)
 *   insert / upsert  view, and the backup has a view  skip (keep the existing view)
 *   insert / upsert  different type                  conflict
 *   insert / upsert  non-empty time series           conflict (no unique _id to merge on)
 *
 * A target that does not exist is always `create`.
 */

import type { Document, MongoClient } from "mongodb";
import { MongoServerError } from "mongodb";
import { type CatalogEntry, listBackups, selectBackup } from "../catalog/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { type CollectionEntry, collectionEntries, type Manifest } from "../format/manifest.ts";
import { compileNamespaceFilter, splitNamespace } from "../mongo/index.ts";
import type { RestoreMode, RestoreOptions, RestorePlan, RestorePlanEntry } from "../types.ts";
import type { RestoreContext } from "./context.ts";
import { assertValidTargetNamespace, compileRenameMap } from "./restore-rename.ts";

/** The kind of namespace, as recorded in manifests and reported by listCollections. */
export type NamespaceType = CollectionEntry["type"];

/** What exists at a target namespace before the restore. */
export type TargetState =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly type: NamespaceType;
      /** `undefined` when the documents could not be counted (missing `find` privilege). */
      readonly documents: number | undefined;
    };

/** The decision for one namespace: an action, or why it cannot be restored in this mode. */
export type ActionDecision =
  | { readonly action: RestorePlanEntry["action"] }
  | { readonly conflict: string };

/** One planned namespace, with the manifest entry needed to restore it. */
export interface PlannedNamespace {
  readonly source: CollectionEntry;
  readonly entry: RestorePlanEntry;
}

/** A plan plus everything `runRestore` needs to carry it out. */
export interface DetailedRestorePlan {
  readonly plan: RestorePlan;
  readonly manifest: Manifest;
  readonly namespaces: readonly PlannedNamespace[];
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** The mode used when none is given: never overwrite anything. */
export const DEFAULT_RESTORE_MODE: RestoreMode = "fail-if-exists";

/**
 * Plans a restore without writing anything.
 *
 * Namespaces that cannot be restored in the chosen mode appear with
 * `action: "conflict"` and a `reason`; the plan itself never throws for them.
 *
 * @throws MongoShieldError `MS_BACKUP_NOT_FOUND` when no backup matches the selector,
 *   `MS_CONFIG_INVALID` for bad patterns or rename rules.
 */
export async function planRestore(
  context: RestoreContext,
  options: RestoreOptions,
): Promise<RestorePlan> {
  const detailed = await buildRestorePlan(context, options);
  return detailed.plan;
}

/** `planRestore`, keeping the manifest entries for the restore itself. */
export async function buildRestorePlan(
  context: RestoreContext,
  options: RestoreOptions,
): Promise<DetailedRestorePlan> {
  const mode = options.mode ?? DEFAULT_RESTORE_MODE;
  const manifest = await loadManifest(context, options);
  const selected = selectNamespaces(manifest, options);
  const targets = mapTargets(selected, options.rename);

  const states = await inspectTargets(context.client, [...targets.values()], options.signal);
  const namespaces: PlannedNamespace[] = [];
  const conflicts: PlannedNamespace[] = [];

  for (const source of selected) {
    const to = targets.get(source.ns) ?? source.ns;
    const state = states.get(to) ?? { exists: false };
    const decision = decideAction(mode, source.type, state);
    const existingDocuments = state.exists ? state.documents : 0;
    if ("conflict" in decision) {
      // Conflicts stay in the plan, so callers can show the whole picture;
      // `runRestore` refuses a plan that contains any.
      conflicts.push({
        source,
        entry: {
          from: source.ns,
          to,
          type: source.type,
          documents: source.documents,
          action: "conflict",
          reason: decision.conflict,
          existingDocuments,
        },
      });
      continue;
    }
    if (state.exists && state.documents === undefined) {
      context.logger.warn("Could not count the documents already in a restore target", { ns: to });
    }
    namespaces.push({
      source,
      entry: {
        from: source.ns,
        to,
        type: source.type,
        documents: source.documents,
        action: decision.action,
        existingDocuments,
      },
    });
  }

  // `namespaces` is what will actually be restored; the plan lists conflicts too.
  const entries = [...namespaces, ...conflicts]
    .map((planned) => planned.entry)
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { manifest, namespaces, plan: { backupId: manifest.id, mode, entries } };
}

/**
 * Throws `MS_RESTORE_CONFLICT` listing every conflicting namespace, if the plan
 * has any. Used by `runRestore` (and the CLI, after showing the plan).
 */
export function assertNoConflicts(plan: RestorePlan): void {
  const conflicts = plan.entries.filter((entry) => entry.action === "conflict");
  if (conflicts.length === 0) return;
  throw conflictError(
    plan.mode,
    conflicts.map((entry) => ({ ns: entry.to, reason: entry.reason ?? "conflict" })),
  );
}

/**
 * Decides what happens to one namespace (see the table in the header comment).
 * Pure, so every combination is unit-tested.
 */
export function decideAction(
  mode: RestoreMode,
  sourceType: NamespaceType,
  target: TargetState,
): ActionDecision {
  if (!target.exists) return { action: "create" };
  if (mode === "drop") return { action: "drop-and-create" };

  if (target.type !== sourceType) {
    return {
      conflict: `it exists as a ${describeType(target.type)}, but the backup holds a ${describeType(sourceType)}`,
    };
  }

  if (mode === "fail-if-exists") return decideFailIfExists(target);

  // insert / upsert: merge into what exists.
  if (sourceType === "view") return { action: "skip" };
  if (sourceType === "timeseries") {
    // Time series have no unique _id index, so duplicates cannot be detected and
    // upserts are not supported; merging would silently duplicate measurements.
    if (target.documents === 0) return { action: "insert" };
    return {
      conflict:
        target.documents === undefined
          ? "it is a time series collection whose documents could not be counted (merging needs an empty target)"
          : `it is a time series collection holding ${target.documents} documents, which cannot be merged without duplicates`,
    };
  }
  return { action: mode === "upsert" ? "upsert" : "insert" };
}

/** `fail-if-exists`: an existing target is only acceptable when it is an empty collection. */
function decideFailIfExists(target: {
  readonly type: NamespaceType;
  readonly documents: number | undefined;
}): ActionDecision {
  if (target.type === "view") return { conflict: "a view with this name already exists" };
  if (target.documents === undefined) {
    return {
      conflict:
        "it exists and its documents could not be counted (the user lacks the find privilege)",
    };
  }
  if (target.documents > 0) return { conflict: `it already holds ${target.documents} documents` };
  // An existing empty collection has nothing to lose; restore into it as mongorestore does.
  return { action: "insert" };
}

function describeType(type: NamespaceType): string {
  if (type === "timeseries") return "time series collection";
  return type;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Selects the backup and returns its manifest. */
async function loadManifest(context: RestoreContext, options: RestoreOptions): Promise<Manifest> {
  const entries = await listBackups(context.storage, {
    logger: context.logger,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const selected: CatalogEntry = selectBackup(entries, options.backup);
  if (selected.manifest === undefined) {
    // selectBackup only returns complete entries, which always carry a manifest.
    throw new MongoShieldError("MS_INTERNAL", `Backup ${selected.id} has no manifest.`);
  }
  return selected.manifest;
}

/**
 * The manifest namespaces kept by include/exclude. When patterns were given but
 * match nothing, that is almost certainly a typo, so it is an error rather than
 * a restore that silently does nothing.
 */
function selectNamespaces(manifest: Manifest, options: RestoreOptions): CollectionEntry[] {
  const filter = compileNamespaceFilter({ include: options.include, exclude: options.exclude });
  // Users and roles are not collections: restore-authz.ts handles them separately.
  const available = collectionEntries(manifest.namespaces);
  const selected = available.filter((entry) => filter(entry.ns));
  const hasPatterns = (options.include?.length ?? 0) + (options.exclude?.length ?? 0) > 0;
  if (selected.length === 0 && hasPatterns && available.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `No namespace in backup ${manifest.id} matches the include/exclude patterns.`,
      {
        hint: `The backup holds: ${available
          .slice(0, 10)
          .map((entry) => entry.ns)
          .join(", ")}${available.length > 10 ? ", …" : ""}.`,
      },
    );
  }
  return selected;
}

/**
 * Source namespace → target namespace. Two namespaces restored to the same
 * target would mix their documents, so that is rejected.
 */
function mapTargets(
  selected: readonly CollectionEntry[],
  rename: RestoreOptions["rename"],
): Map<string, string> {
  const mapper = compileRenameMap(rename);
  const targets = new Map<string, string>();
  const sourceByTarget = new Map<string, string>();
  for (const entry of selected) {
    const target = mapper(entry.ns);
    // Names from the manifest were valid on the source; renamed ones need checking.
    if (target !== entry.ns) assertValidTargetNamespace(target);
    const other = sourceByTarget.get(target);
    if (other !== undefined) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Both ${other} and ${entry.ns} would be restored to ${target}.`,
        { hint: "Change the rename rules so every namespace has its own target." },
      );
    }
    sourceByTarget.set(target, entry.ns);
    targets.set(entry.ns, target);
  }
  return targets;
}

/**
 * Looks at every target: does it exist, as what, and how many documents does it hold.
 * One listCollections per target database; one count per existing collection.
 * Also used by `copy`, whose targets follow the same rules.
 */
export async function inspectTargets(
  client: MongoClient,
  targets: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, TargetState>> {
  const states = new Map<string, TargetState>();
  const byDatabase = groupByDatabase(targets);

  for (const [database, collections] of byDatabase) {
    throwIfAborted(signal);
    const existing = await listExistingTypes(client, database);
    for (const collection of collections) {
      const type = existing.get(collection);
      const ns = `${database}.${collection}`;
      if (type === undefined) {
        states.set(ns, { exists: false });
        continue;
      }
      // Views are never counted: counting would run their pipeline.
      const documents = type === "view" ? 0 : await countDocuments(client, database, collection);
      states.set(ns, { exists: true, type, documents });
    }
  }
  return states;
}

/**
 * Collection name → type for one database (only the listCollections privilege is needed).
 *
 * @throws MongoShieldError `MS_PERMISSION_DENIED` when the user may not even list the
 *   target database: it certainly cannot restore into it, and the planning step is the
 *   first to find out (before the write privileges are checked).
 */
async function listExistingTypes(
  client: MongoClient,
  database: string,
): Promise<Map<string, NamespaceType>> {
  let infos: Document[];
  try {
    infos = await client
      .db(database)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
  } catch (error) {
    if (!(error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE)) throw error;
    throw new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `The MongoDB user cannot restore into database ${database}: missing listCollections on database ${database}.`,
      {
        cause: error,
        hint: 'Grant the built-in `restore` role (db: "admin"), or `readWrite` on the target databases.',
        details: { operation: "restore", missing: [`listCollections on database ${database}`] },
      },
    );
  }
  const types = new Map<string, NamespaceType>();
  for (const info of infos) {
    types.set(info.name, normalizeType(info));
  }
  return types;
}

function normalizeType(info: Document): NamespaceType {
  if (info.type === "view" || info.type === "timeseries") return info.type;
  return "collection";
}

/**
 * The document count from collection metadata (fast, no scan). The built-in
 * `restore` role does not grant `find`, which `count` needs, so an authorization
 * failure yields `undefined` ("unknown") instead of failing the plan.
 */
async function countDocuments(
  client: MongoClient,
  database: string,
  collection: string,
): Promise<number | undefined> {
  try {
    return await client.db(database).collection(collection).estimatedDocumentCount();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) return undefined;
    throw error;
  }
}

function groupByDatabase(namespaces: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const ns of namespaces) {
    const { database, collection } = splitNamespace(ns);
    const group = groups.get(database) ?? [];
    group.push(collection);
    groups.set(database, group);
  }
  return groups;
}

/** One error listing every conflicting namespace, so the user can fix them all at once. */
function conflictError(
  mode: RestoreMode,
  conflicts: readonly { ns: string; reason: string }[],
): MongoShieldError {
  const lines = conflicts.map((conflict) => `  ${conflict.ns}: ${conflict.reason}`).join("\n");
  const hint =
    mode === "fail-if-exists"
      ? "Restore with --drop to replace the targets, --mode insert to keep existing documents, or --rename to restore elsewhere."
      : "Restore with --drop to replace the targets, or --rename to restore elsewhere.";
  return new MongoShieldError(
    "MS_RESTORE_CONFLICT",
    `The restore would overwrite existing data in ${conflicts.length} namespace(s):\n${lines}`,
    { hint, details: { mode, conflicts: conflicts.map((conflict) => conflict.ns) } },
  );
}
