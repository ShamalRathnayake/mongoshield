/**
 * Which base backups a point-in-time restore may start from (journal/plan.ts).
 *
 * A base backup is only half of a point-in-time restore: the journal's events after
 * its cluster time are replayed onto it. Replaying onto the WRONG base loses data
 * without any error, so a base must be suitable for the restore being asked for, not
 * merely the newest complete one:
 *
 *   coverage   every namespace the restore selects must be in the base, or be one the
 *              base's own selection would have backed up had it existed then (it was
 *              created later, and the journal holds its creation). A namespace the
 *              base never meant to back up is rebuilt from journal events alone,
 *              which misses every document written before the base, and turns
 *              updates and deletes of them into no-ops. Example: a nightly `app.*`
 *              job and an hourly `app.users` job share a storage location; a restore
 *              of `app.*` must not start from the hourly `app.users` backup.
 *   query      a base taken with a `query` holds only some documents of those
 *              namespaces; the journal's updates to the others would find nothing.
 *              It is suitable only when the restore leaves those namespaces out.
 *   cluster    the journal follows one deployment; a base of another deployment
 *              (staging and production in one bucket) holds other data. The journal
 *              does not record its deployment, so with `clusterId` (and `instanceId`,
 *              for two replica sets that share a set name) only bases of that
 *              deployment qualify. Without it the planner judges each base against
 *              its own deployment's backups and takes the newest (journal/plan.ts).
 *
 * Old manifests that do not record their selection (written before MongoShield 2.0)
 * cannot be checked for coverage or queries; they are accepted as they always were.
 */

import type { CatalogEntry } from "../catalog/catalog.ts";
import { collectionEntries, type Manifest } from "../format/manifest.ts";
import { compileNamespaceFilter, type NamespaceFilter } from "../mongo/index.ts";
import type { NamespacePattern } from "../types.ts";

/** What the point-in-time restore asks for, as far as choosing its base is concerned. */
export interface BaseRequest {
  /** The restore's include/exclude patterns (empty include: everything). */
  readonly include?: readonly NamespacePattern[] | undefined;
  readonly exclude?: readonly NamespacePattern[] | undefined;
  /**
   * Only bases of this deployment (`manifest.source.clusterId`, as
   * `shield.sourceClusterId()` returns it). Bases that record no deployment still
   * qualify.
   */
  readonly clusterId?: string | undefined;
  /**
   * With `clusterId`: only bases of this replica set (`manifest.source.instanceId`).
   * Bases that record no `instanceId` still qualify, as in `sameDeployment`.
   */
  readonly instanceId?: string | undefined;
}

/** A request compiled once, with the namespaces it is known to select. */
export interface CompiledBaseRequest {
  readonly clusterId: string | undefined;
  readonly instanceId: string | undefined;
  /** The restore's filter. */
  readonly selects: NamespaceFilter;
  /**
   * Namespaces the restore selects that are known to exist at some point: those of
   * every complete backup in the location, and those the include patterns name
   * literally. A base must account for each of them (see the file header).
   */
  readonly wanted: readonly string[];
}

/**
 * Compiles the request against the catalog.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for malformed patterns.
 */
export function compileBaseRequest(
  request: BaseRequest,
  entries: readonly CatalogEntry[],
): CompiledBaseRequest {
  const selects = compileNamespaceFilter({ include: request.include, exclude: request.exclude });
  const known = new Set<string>();
  for (const entry of entries) {
    if (entry.status !== "complete" || entry.manifest === undefined) continue;
    // Another deployment's collections say nothing about what this one holds.
    if (isOtherDeployment(entry.manifest.source, request)) continue;
    for (const namespace of collectionEntries(entry.manifest.namespaces)) known.add(namespace.ns);
  }
  // `app.users` named on its own is wanted even if no backup holds it (yet).
  for (const pattern of request.include ?? []) {
    if (pattern !== "*" && !pattern.includes("*")) known.add(pattern);
  }
  const wanted = [...known].filter((ns) => selects(ns)).sort();
  return { clusterId: request.clusterId, instanceId: request.instanceId, selects, wanted };
}

/**
 * True when a manifest's `source` names a deployment other than the request's. Only
 * ids both sides record are compared, so old manifests without them still qualify.
 */
function isOtherDeployment(
  recorded: { readonly clusterId?: string | undefined; readonly instanceId?: string | undefined },
  request: BaseRequest,
): boolean {
  if (request.clusterId === undefined) return false;
  if (recorded.clusterId !== undefined && recorded.clusterId !== request.clusterId) return true;
  return (
    request.instanceId !== undefined &&
    recorded.instanceId !== undefined &&
    recorded.instanceId !== request.instanceId
  );
}

/**
 * Why `manifest` cannot be the base of this restore, or `undefined` when it can.
 * The cluster rule only checks the request's ids here; without them, which
 * deployment to follow is the planner's call.
 */
export function whyNotBase(manifest: Manifest, request: CompiledBaseRequest): string | undefined {
  if (isOtherDeployment(manifest.source, request)) {
    return "it was taken from another deployment";
  }
  const selection = manifest.selection;
  // Written by an older release: nothing to check against (see the file header).
  if (selection === undefined) return undefined;

  const queried = selection.query.filter((ns) => request.selects(ns));
  if (queried.length > 0) {
    return `it holds only the documents of a query for ${listOf(queried)}`;
  }

  const contains = new Set(collectionEntries(manifest.namespaces).map((entry) => entry.ns));
  const wouldBackUp = compileNamespaceFilter({
    include: selection.include,
    exclude: selection.exclude,
  });
  const missing = request.wanted.filter((ns) => !contains.has(ns) && !wouldBackUp(ns));
  if (missing.length > 0) {
    return `it does not cover ${listOf(missing)} (it backs up ${describeSelection(selection)})`;
  }
  return undefined;
}

/** `app.a, app.b and 3 more`. */
function listOf(namespaces: readonly string[]): string {
  const shown = namespaces.slice(0, 3).join(", ");
  const rest = namespaces.length - 3;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** `include app.users` / `everything except app.logs`. */
function describeSelection(selection: NonNullable<Manifest["selection"]>): string {
  const include = selection.include.length === 0 ? "everything" : selection.include.join(", ");
  const exclude = selection.exclude.length === 0 ? "" : ` except ${selection.exclude.join(", ")}`;
  return `${include}${exclude}`;
}
