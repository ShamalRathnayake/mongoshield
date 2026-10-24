/**
 * Backing up users and custom roles (`backup({ includeUsersAndRoles: true })`).
 *
 * MongoDB keeps every user in `admin.system.users` and every custom role in
 * `admin.system.roles`, whatever database they belong to. Instead of reading those
 * collections (which needs privileges on `admin`), they are read with the
 * user-management commands, which work for anyone allowed to view users and roles:
 *
 *   usersInfo  { showCredentials, showCustomData }   per backed-up database, or
 *              { forAllDBs: true } on admin           when backing up everything
 *   rolesInfo  { showPrivileges, showBuiltinRoles: false }   per database
 *              (rolesInfo has no "all databases" form, so "everything" asks every
 *              database that exists or that a user or role refers to)
 *
 * The answers are trimmed to the shape of the server's own `system.users` /
 * `system.roles` documents (computed fields such as `mechanisms` or
 * `inheritedPrivileges` are removed), so restore can hand them to the server's
 * `_mergeAuthzCollections` command like mongorestore does (see restore-authz.ts).
 *
 * They are stored like a collection, compressed and encrypted like everything else:
 *
 *   admin/system.users.bson[.zst][.age]  +  admin/system.users.metadata.json[.age]
 *   admin/system.roles.bson[.zst][.age]  +  admin/system.roles.metadata.json[.age]
 *
 * with manifest entries of type "users" and "roles" (see docs/specs/FORMAT.md).
 * Credentials are SCRAM hashes: not passwords, but open to offline guessing, so a
 * warning is logged when the backup is not encrypted.
 *
 * Users and roles are read when the dump is done, right before the manifest is
 * written: they are not part of a snapshot or converge window.
 *
 * The replies' users and roles are read as raw BSON and parsed with their stored
 * field order recorded (src/format/field-order.ts), and written back in that order:
 * a user's `customData` is free-form and may hold integer-like field names, which
 * JavaScript objects would move first.
 */

import { Readable } from "node:stream";
import { BSON, type Document, type MongoClient, MongoServerError } from "mongodb";
import { createCompressor } from "../compression/index.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { deserializeInStoredOrder, inStoredOrderAnywhere } from "../format/field-order.ts";
import { createCountingStream } from "../format/hashing.ts";
import { dataFileKey, resolveBackupKey } from "../format/layout.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import { toBackupError } from "./backup-errors.ts";
import {
  encryptionTransforms,
  type NamespaceDumpContext,
  writeMetadataFile,
} from "./backup-namespace.ts";
import { writeStoredFile } from "./backup-write.ts";

/** Where users and roles are stored: the namespaces the server keeps them in. */
export const AUTHZ_NAMESPACES = {
  users: { db: "admin", collection: "system.users" },
  roles: { db: "admin", collection: "system.roles" },
} as const;

/**
 * Fields `usersInfo` / `rolesInfo` compute on the fly that are not part of the stored
 * documents. `_mergeAuthzCollections` validates documents strictly, so they go.
 */
const COMPUTED_USER_FIELDS = ["mechanisms", "inheritedRoles", "inheritedPrivileges"] as const;
const COMPUTED_ROLE_FIELDS = [
  "isBuiltin",
  "inheritedRoles",
  "inheritedPrivileges",
  "inheritedAuthenticationRestrictions",
] as const;

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/** Which databases' users and roles to capture. */
export type AuthzScope =
  /** Every database: the backup had no `include` patterns. */
  | { readonly kind: "all" }
  /** The databases of the backed-up namespaces. */
  | { readonly kind: "databases"; readonly databases: readonly string[] };

/** Users and roles as captured, in `system.users` / `system.roles` document shape. */
export interface CapturedAuthz {
  readonly users: Document[];
  readonly roles: Document[];
}

/**
 * Captures users and roles and writes them as two manifest entries ("roles" first,
 * then "users", the order restore needs).
 *
 * @throws MongoShieldError `MS_PERMISSION_DENIED` when the backup user may not view
 *   users or roles (the option was asked for, so silently leaving them out would
 *   produce a backup that looks complete but is not); storage errors as for data files.
 */
export async function backupUsersAndRoles(
  context: NamespaceDumpContext,
  scope: AuthzScope,
  signal: AbortSignal,
): Promise<NamespaceEntry[]> {
  if (context.encryption === undefined) {
    context.logger.warn(
      "Backing up users without encryption: their password hashes (SCRAM) are stored in the clear and can be attacked offline. Encrypt backups that include users.",
    );
  }
  const captured = await captureUsersAndRoles(context.client, scope, signal);
  const roles = await writeAuthzEntry("roles", captured.roles, context, signal);
  const users = await writeAuthzEntry("users", captured.users, context, signal);
  context.logger.info("Backed up users and roles", {
    users: captured.users.length,
    roles: captured.roles.length,
  });
  return [roles, users];
}

/**
 * Reads users (with credentials and custom data) and custom roles (with privileges)
 * of the databases in `scope`, sorted by `_id` so backups are reproducible.
 */
export async function captureUsersAndRoles(
  client: MongoClient,
  scope: AuthzScope,
  signal?: AbortSignal,
): Promise<CapturedAuthz> {
  try {
    const users = await captureUsers(client, scope, signal);
    const databases =
      scope.kind === "all" ? await everyAuthzDatabase(client, users) : [...scope.databases];
    const roles: Document[] = [];
    for (const database of databases) {
      throwIfAborted(signal);
      const reply = await client
        .db(database)
        .command(
          { rolesInfo: 1, showPrivileges: true, showBuiltinRoles: false },
          { fieldsAsRaw: { roles: true } },
        );
      for (const role of rawDocumentsIn(reply.roles))
        roles.push(withoutFields(role, COMPUTED_ROLE_FIELDS));
    }
    return { users: sortById(users), roles: sortById(roles) };
  } catch (error) {
    throw authzReadError(error);
  }
}

/** `usersInfo` for every database at once, or database by database. */
async function captureUsers(
  client: MongoClient,
  scope: AuthzScope,
  signal: AbortSignal | undefined,
): Promise<Document[]> {
  const options = { showCredentials: true, showCustomData: true, showPrivileges: false };
  // The users come back as raw BSON (see the file header).
  const raw = { fieldsAsRaw: { users: true } };
  if (scope.kind === "all") {
    const reply = await client
      .db("admin")
      .command({ usersInfo: { forAllDBs: true }, ...options }, raw);
    return rawDocumentsIn(reply.users).map((user) => withoutFields(user, COMPUTED_USER_FIELDS));
  }
  const users: Document[] = [];
  for (const database of scope.databases) {
    throwIfAborted(signal);
    const reply = await client.db(database).command({ usersInfo: 1, ...options }, raw);
    for (const user of rawDocumentsIn(reply.users))
      users.push(withoutFields(user, COMPUTED_USER_FIELDS));
  }
  return users;
}

/**
 * Every database that may hold custom roles when backing up everything: those that
 * exist, `admin`, and every database a user or a user's role belongs to (a role can
 * be defined in a database that holds no data).
 */
async function everyAuthzDatabase(
  client: MongoClient,
  users: readonly Document[],
): Promise<string[]> {
  const listed = await client
    .db("admin")
    .admin()
    .listDatabases({ nameOnly: true, authorizedDatabases: true });
  const databases = new Set<string>(["admin"]);
  for (const database of listed.databases) databases.add(database.name);
  for (const user of users) {
    if (typeof user.db === "string") databases.add(user.db);
    for (const role of documentsIn(user.roles)) {
      if (typeof role.db === "string") databases.add(role.db);
    }
  }
  // `$external` holds only users (x.509, LDAP, …); roles cannot be defined there.
  databases.delete("$external");
  return [...databases].sort();
}

/** Writes one data file and its metadata file, and returns the manifest entry. */
async function writeAuthzEntry(
  kind: "users" | "roles",
  documents: readonly Document[],
  context: NamespaceDumpContext,
  signal: AbortSignal,
): Promise<NamespaceEntry> {
  const { db, collection } = AUTHZ_NAMESPACES[kind];
  const ns = `${db}.${collection}`;
  try {
    // A plain mongodump-style metadata file (type "collection", no indexes) keeps the
    // entry shaped like every other one; the manifest `type` says what it really holds.
    const metadata = await writeMetadataFile(
      {
        ns,
        db,
        name: collection,
        type: "collection",
        options: {},
        indexes: [],
        estimatedDocuments: documents.length,
      },
      context,
      { uniqueSuffix: undefined, signal },
    );

    const relativeKey = dataFileKey({
      db,
      collection,
      compression: context.compression,
      encrypted: context.encryption !== undefined,
    });
    const key = resolveBackupKey(context.backupId, relativeKey);
    context.writtenKeys.add(key);
    // A few hundred users at most: serializing them up front is fine.
    const counter = createCountingStream();
    const digest = await writeStoredFile({
      storage: context.storage,
      key,
      source: Readable.from(
        documents.map((document) => Buffer.from(BSON.serialize(inStoredOrderAnywhere(document)))),
      ),
      transforms: [
        counter.stream,
        createCompressor(context.compression),
        ...encryptionTransforms(context),
      ],
      contentType: "application/octet-stream",
      retainUntil: context.retainUntil,
      signal,
    });
    const counts = counter.counts();
    return {
      ns,
      db,
      collection,
      type: kind,
      documents: counts.items,
      bytesRaw: counts.bytes,
      files: [{ key: relativeKey, size: digest.size, sha256: digest.sha256 }],
      metadata,
    };
  } catch (error) {
    throw toBackupError(error, { ns });
  }
}

/** A missing viewUser / viewRole privilege gets a hint that names them. */
function authzReadError(error: unknown): MongoShieldError {
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `MongoDB refused to list users and roles: ${error.message}`,
      {
        cause: error,
        hint: "includeUsersAndRoles needs the viewUser and viewRole actions (e.g. the built-in userAdminAnyDatabase role, or userAdmin on each database). Or back up without users and roles.",
      },
    );
  }
  return toBackupError(error);
}

/** The documents of a command reply's array field (anything else is ignored). */
function documentsIn(value: unknown): Document[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Document => typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/**
 * The documents of a reply's array field returned as raw BSON (`fieldsAsRaw`), parsed
 * with their stored field order recorded. The driver's default options are used, so
 * the values are what the driver's own parse gave (plain numbers); only the order is
 * kept in addition.
 */
function rawDocumentsIn(value: unknown): Document[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((item) => deserializeInStoredOrder(item, {}));
}

/**
 * A shallow copy of `document` without the given fields. The copy's root has no
 * recorded order, but its fields are the server's fixed names; nested values (custom
 * data) keep theirs.
 */
function withoutFields(document: Document, fields: readonly string[]): Document {
  const copy: Document = {};
  for (const [name, value] of Object.entries(document)) {
    if (!fields.includes(name)) copy[name] = value;
  }
  return copy;
}

/** Sorted by `_id` (`db.name`), a plain code-unit comparison like namespaces. */
function sortById(documents: Document[]): Document[] {
  return documents.sort((left, right) => {
    const leftId = String(left._id);
    const rightId = String(right._id);
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });
}
