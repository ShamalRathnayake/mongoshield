/**
 * Up-front privilege checks.
 *
 * A backup that fails on its 40th collection because the user cannot read it wastes
 * time and leaves a partial backup behind. Before starting, the engines ask the server
 * (`connectionStatus` with `showPrivileges`) what the user may do and compare that with
 * what the operation needs, so missing privileges are reported all at once.
 *
 * The check mirrors MongoDB's resource matching rules:
 * - `{ anyResource: true }` covers everything, `{ cluster: true }` covers cluster actions;
 * - `{ db: "app", collection: "" }` covers every NON-system collection in `app`;
 * - `{ db: "", collection: "" }` covers every non-system collection in every database;
 * - `{ db: "", collection: "users" }` covers `users` in every database;
 * - `system.*` collections are only covered by a resource naming them exactly.
 */

import type { Document, MongoClient } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { splitNamespace } from "./namespace-filter.ts";

/** The operation whose privileges are checked. */
export type PrivilegedOperation = "backup" | "restore";

/** What to check. */
export interface PrivilegeCheckOptions {
  readonly operation: PrivilegedOperation;
  /** Databases the operation touches. Database-level actions are checked on each. */
  readonly databases: readonly string[];
  /**
   * Namespaces the operation touches. When given, collection-level actions (`find`,
   * `insert`, …) are checked per namespace, so users whose roles grant access to single
   * collections pass. Otherwise they are checked on each whole database.
   */
  readonly namespaces?: readonly string[] | undefined;
  /**
   * The backup covers every database. Also requires `listDatabases`: without it the
   * server silently lists only the databases the user has privileges on, so an
   * "everything" backup could quietly miss some.
   */
  readonly allDatabases?: boolean | undefined;
  /** More collection-level actions the caller needs, e.g. `update` for upsert restores. */
  readonly extraActions?: readonly string[] | undefined;
}

/** The outcome of a privilege check. */
export interface PrivilegeCheckResult {
  /** True when nothing is missing (always true when the server runs without auth). */
  readonly ok: boolean;
  /** Human-readable `"<action> on <resource>"` entries, e.g. `"find on app.users"`. */
  readonly missing: readonly string[];
}

/** Actions each operation needs on every database it touches. */
const DATABASE_ACTIONS: Readonly<Record<PrivilegedOperation, readonly string[]>> = {
  // listCollections reads collection options and view definitions.
  backup: ["listCollections"],
  // listCollections lets the restore see what already exists in the target.
  restore: ["listCollections"],
};

/**
 * Actions each operation needs on every collection it touches. Kept to what the
 * built-in `backup` and `restore` roles grant, so those roles always pass. Note that
 * `restore` does NOT grant `find`, `update` or `remove`: restores must not depend on them
 * unless the caller asks for them via `extraActions`.
 */
const COLLECTION_ACTIONS: Readonly<Record<PrivilegedOperation, readonly string[]>> = {
  backup: ["find", "listIndexes"],
  restore: ["insert", "createCollection", "createIndex", "dropCollection"],
};

/** The built-in role that grants everything each operation needs, named in hints. */
const BUILT_IN_ROLE: Readonly<Record<PrivilegedOperation, string>> = {
  backup: "backup",
  restore: "restore",
};

/** What a single required action applies to. */
type Target =
  | { readonly kind: "cluster" }
  | { readonly kind: "database"; readonly db: string }
  | { readonly kind: "namespace"; readonly db: string; readonly collection: string };

/** One action on one target. */
interface Requirement {
  readonly action: string;
  readonly target: Target;
}

/** A privilege as reported by `connectionStatus`. */
interface Privilege {
  readonly resource: Document;
  readonly actions: readonly string[];
}

/**
 * Reports which privileges the connected user lacks for an operation.
 *
 * When no user is authenticated the result is `ok`: either the server runs without
 * access control (everything is allowed) or the operation will fail at its first
 * command with a clear server error anyway.
 */
export async function checkPrivileges(
  client: MongoClient,
  options: PrivilegeCheckOptions,
): Promise<PrivilegeCheckResult> {
  const status = await client.db("admin").command({ connectionStatus: 1, showPrivileges: true });
  const authInfo: unknown = status.authInfo;
  if (!isDocument(authInfo) || !hasAuthenticatedUser(authInfo)) return { ok: true, missing: [] };

  const privileges = readPrivileges(authInfo.authenticatedUserPrivileges);
  const missing: string[] = [];
  for (const requirement of requirementsFor(options)) {
    if (!privileges.some((privilege) => grants(privilege, requirement))) {
      missing.push(describeRequirement(requirement));
    }
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Like `checkPrivileges`, but throws when anything is missing.
 *
 * @throws MongoShieldError `MS_PERMISSION_DENIED` listing every missing privilege.
 */
export async function assertPrivileges(
  client: MongoClient,
  options: PrivilegeCheckOptions,
): Promise<void> {
  const result = await checkPrivileges(client, options);
  if (result.ok) return;
  const role = BUILT_IN_ROLE[options.operation];
  throw new MongoShieldError(
    "MS_PERMISSION_DENIED",
    `The MongoDB user cannot ${options.operation}: missing ${result.missing.join(", ")}.`,
    {
      hint: `Grant the built-in \`${role}\` role (db: "admin"), or a custom role with the listed actions on these databases.`,
      details: { operation: options.operation, missing: result.missing },
    },
  );
}

/** Expands the options into the individual (action, resource) pairs to check. */
function requirementsFor(options: PrivilegeCheckOptions): Requirement[] {
  const requirements: Requirement[] = [];
  if (options.allDatabases === true && options.operation === "backup") {
    requirements.push({ action: "listDatabases", target: { kind: "cluster" } });
  }

  for (const db of unique(options.databases)) {
    for (const action of DATABASE_ACTIONS[options.operation]) {
      requirements.push({ action, target: { kind: "database", db } });
    }
  }

  const collectionActions = unique([
    ...COLLECTION_ACTIONS[options.operation],
    ...(options.extraActions ?? []),
  ]);
  for (const target of collectionTargets(options)) {
    for (const action of collectionActions) requirements.push({ action, target });
  }
  return requirements;
}

/** Per-namespace targets when namespaces are known, otherwise whole databases. */
function collectionTargets(options: PrivilegeCheckOptions): Target[] {
  if (options.namespaces === undefined) {
    return unique(options.databases).map((db) => ({ kind: "database", db }));
  }
  return unique(options.namespaces).map((ns) => {
    const { database, collection } = splitNamespace(ns);
    return { kind: "namespace", db: database, collection };
  });
}

/** True when the privilege grants the requirement's action on its target. */
function grants(privilege: Privilege, requirement: Requirement): boolean {
  return (
    privilege.actions.includes(requirement.action) &&
    resourceCovers(privilege.resource, requirement.target)
  );
}

/** Applies MongoDB's resource matching rules (see the header comment). */
function resourceCovers(resource: Document, target: Target): boolean {
  if (resource.anyResource === true) return true;
  if (target.kind === "cluster") return resource.cluster === true;

  const db: unknown = resource.db;
  const collection: unknown = resource.collection;
  // Other resource kinds (cluster, system_buckets) do not cover ordinary namespaces.
  if (typeof db !== "string" || typeof collection !== "string") return false;
  const databaseMatches = db === "" || db === target.db;
  if (!databaseMatches) return false;

  // A database-wide action needs a database-wide resource.
  if (target.kind === "database") return collection === "";
  if (collection === target.collection) return true;
  // `collection: ""` means "every collection except system ones".
  return collection === "" && !target.collection.startsWith("system.");
}

function describeRequirement(requirement: Requirement): string {
  const { target } = requirement;
  if (target.kind === "cluster") return `${requirement.action} on the cluster`;
  if (target.kind === "database") return `${requirement.action} on database ${target.db}`;
  return `${requirement.action} on ${target.db}.${target.collection}`;
}

function hasAuthenticatedUser(authInfo: Document): boolean {
  const users: unknown = authInfo.authenticatedUsers;
  return Array.isArray(users) && users.length > 0;
}

/** Narrows the raw `authenticatedUserPrivileges` array, dropping malformed entries. */
function readPrivileges(raw: unknown): Privilege[] {
  if (!Array.isArray(raw)) return [];
  const privileges: Privilege[] = [];
  for (const entry of raw) {
    if (!isDocument(entry) || !isDocument(entry.resource) || !Array.isArray(entry.actions))
      continue;
    const actions = entry.actions.filter((action): action is string => typeof action === "string");
    privileges.push({ resource: entry.resource, actions });
  }
  return privileges;
}

function isDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
