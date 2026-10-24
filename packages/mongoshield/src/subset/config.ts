/**
 * The shape of a subset file and its validation.
 *
 *   // subset.ts
 *   import { defineSubset } from "mongoshield";
 *
 *   export default defineSubset({
 *     filters: {
 *       "app.orders": { createdAt: { $gte: new Date("2026-09-01") } },
 *     },
 *     follow: [
 *       { from: "app.orders.userId", to: "app.users._id" },
 *       { from: "app.orders.items.productId", to: "app.products._id" },
 *     ],
 *   });
 *
 * What each copied namespace gets:
 *
 *   no filter, not followed      every document (an ordinary copy)
 *   filter                       the documents matching the filter
 *   followed (a `to` side)       only the documents some copied document references
 *   filter AND followed          both: the filtered documents plus the referenced ones,
 *                                so references from elsewhere never dangle
 *
 * References are followed transitively (orders → users → companies) and may form
 * cycles (users.managerId → users._id); every value is followed once.
 *
 * Namespaces are SOURCE namespaces (before `rename`). A string endpoint such as
 * `app.orders.items.productId` is split at the longest copied namespace it starts
 * with; for collection names that are ambiguous, use `{ ns, path }`.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { type FieldPath, parseFieldPath, WILDCARD } from "../mask/paths.ts";

/** One side of a reference, when the string form would be ambiguous. */
export interface FollowEndpoint {
  /** Source namespace, e.g. `app.orders`. */
  readonly ns: string;
  /** Field path, e.g. `userId` or `items.productId`. */
  readonly path: string;
}

/** "Documents of `to` referenced by `from` are copied too." */
export interface FollowRule {
  /** Where references are read: `"app.orders.userId"` or `{ ns, path }`. May use `*`. */
  readonly from: string | FollowEndpoint;
  /** What they point at: `"app.users._id"` or `{ ns, path }`. No `*` (it is queried). */
  readonly to: string | FollowEndpoint;
}

/** A subset file's default export. */
export interface SubsetConfig {
  /** A query filter per source namespace. */
  readonly filters?: Readonly<Record<string, Document>>;
  readonly follow?: readonly FollowRule[];
  /** Referenced values per `$in` query. Defaults to 1000. */
  readonly batchSize?: number;
}

/**
 * Identity function that gives subset files type checking and editor completion.
 */
export function defineSubset(config: SubsetConfig): SubsetConfig {
  return config;
}

/** Referenced values per `$in` query when `batchSize` is not given. */
export const DEFAULT_FOLLOW_BATCH_SIZE = 1000;

/**
 * Upper limit of `batchSize`: a `$in` list is part of one query document, which must
 * stay under 16 MiB; 100 000 small ids is far below that, and larger lists bring nothing.
 */
const MAX_FOLLOW_BATCH_SIZE = 100_000;

/** How a namespace's documents are selected. */
export type SubsetSelection = "all" | "filtered" | "referenced" | "filtered+referenced";

/** A resolved `follow` rule. */
export interface CompiledFollow {
  readonly from: { readonly ns: string; readonly path: string; readonly segments: FieldPath };
  readonly to: { readonly ns: string; readonly path: string };
  /** One set of referenced values per distinct `to` side: `ns|path`. */
  readonly setKey: string;
}

/** A validated subset config, resolved against the namespaces being copied. */
export interface CompiledSubset {
  readonly filters: ReadonlyMap<string, Document>;
  readonly follows: readonly CompiledFollow[];
  readonly batchSize: number;
  /** How the documents of `ns` are selected. */
  selectionOf(ns: string): SubsetSelection;
  /** The rules whose `from` side is `ns`. */
  outgoing(ns: string): readonly CompiledFollow[];
}

/** A namespace being copied, as far as subsetting cares. */
export interface SubsetNamespace {
  readonly ns: string;
  readonly type: "collection" | "view" | "timeseries";
}

/**
 * Validates a subset config against the namespaces being copied.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for filters or follow rules naming
 *   namespaces that are not copied (or are views), bad paths, or a bad batch size.
 */
export function compileSubset(
  config: SubsetConfig,
  namespaces: readonly SubsetNamespace[],
): CompiledSubset {
  if (typeof config !== "object" || config === null)
    throw subsetError("the subset config must be an object");
  const byNs = new Map(namespaces.map((namespace) => [namespace.ns, namespace]));
  const filters = compileFilters(config.filters ?? {}, byNs);
  const follows = (config.follow ?? []).map((rule, index) => compileFollow(rule, index, byNs));
  const batchSize = config.batchSize ?? DEFAULT_FOLLOW_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FOLLOW_BATCH_SIZE) {
    throw subsetError(`batchSize must be a whole number from 1 to ${MAX_FOLLOW_BATCH_SIZE}`);
  }

  const followed = new Set(follows.map((follow) => follow.to.ns));
  return {
    filters,
    follows,
    batchSize,
    selectionOf(ns) {
      const filtered = filters.has(ns);
      if (followed.has(ns)) return filtered ? "filtered+referenced" : "referenced";
      return filtered ? "filtered" : "all";
    },
    outgoing(ns) {
      return follows.filter((follow) => follow.from.ns === ns);
    },
  };
}

function compileFilters(
  filters: Readonly<Record<string, Document>>,
  byNs: ReadonlyMap<string, SubsetNamespace>,
): Map<string, Document> {
  if (typeof filters !== "object" || filters === null)
    throw subsetError("filters must be an object");
  const compiled = new Map<string, Document>();
  for (const [ns, filter] of Object.entries(filters)) {
    assertCopiedCollection(ns, byNs, `the filter for "${ns}"`);
    if (typeof filter !== "object" || filter === null || Array.isArray(filter)) {
      throw subsetError(`the filter for "${ns}" must be a query document`);
    }
    compiled.set(ns, filter);
  }
  return compiled;
}

function compileFollow(
  rule: FollowRule,
  index: number,
  byNs: ReadonlyMap<string, SubsetNamespace>,
): CompiledFollow {
  const where = `follow rule ${index + 1}`;
  if (typeof rule !== "object" || rule === null) throw subsetError(`${where} must be { from, to }`);
  const from = resolveEndpoint(rule.from, byNs, `${where} (from)`);
  const to = resolveEndpoint(rule.to, byNs, `${where} (to)`);
  const toSegments = parseFieldPath(to.path);
  if (toSegments.includes(WILDCARD)) {
    throw subsetError(`${where}: the "to" path cannot use * (it is used in a query)`);
  }
  return {
    from: { ns: from.ns, path: from.path, segments: parseFieldPath(from.path) },
    to,
    setKey: `${to.ns}|${to.path}`,
  };
}

/** Splits `db.collection.path` at the longest copied namespace, or checks `{ ns, path }`. */
function resolveEndpoint(
  endpoint: string | FollowEndpoint,
  byNs: ReadonlyMap<string, SubsetNamespace>,
  where: string,
): FollowEndpoint {
  if (typeof endpoint === "object" && endpoint !== null) {
    assertCopiedCollection(endpoint.ns, byNs, where);
    if (typeof endpoint.path !== "string") throw subsetError(`${where}: path must be a string`);
    return { ns: endpoint.ns, path: endpoint.path };
  }
  if (typeof endpoint !== "string")
    throw subsetError(`${where} must be "db.collection.field" or { ns, path }`);

  let best: string | undefined;
  for (const ns of byNs.keys()) {
    if (endpoint.startsWith(`${ns}.`) && (best === undefined || ns.length > best.length)) best = ns;
  }
  if (best === undefined) {
    throw subsetError(
      `${where}: "${endpoint}" does not start with a copied namespace (expected "db.collection.field")`,
    );
  }
  assertCopiedCollection(best, byNs, where);
  return { ns: best, path: endpoint.slice(best.length + 1) };
}

function assertCopiedCollection(
  ns: string,
  byNs: ReadonlyMap<string, SubsetNamespace>,
  where: string,
): void {
  const namespace = byNs.get(ns);
  if (namespace === undefined) {
    throw subsetError(
      `${where} names "${ns}", which is not being copied (check --include/--exclude)`,
    );
  }
  if (namespace.type === "view") {
    throw subsetError(`${where} names the view "${ns}"; views hold no documents to subset`);
  }
}

function subsetError(problem: string): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", `Invalid subset config: ${problem}.`, {
    hint: "See docs/guides/staging-data.md for the subset file format.",
  });
}
