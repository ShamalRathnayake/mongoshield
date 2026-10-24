/**
 * What each namespace of a mongodump output becomes in an import. Shared by the
 * directory and archive importers so both treat exactly the same things the same way.
 *
 * MongoShield backups hold what `mongoshield backup` captures: user collections,
 * views, time-series collections (as plain measurements), `system.js`, and
 * optionally users and roles. A dump can contain more, or the same in another form:
 *
 * - time-series collections: mongodump writes the collection's metadata under its
 *   own name and its internal *bucket* documents under `system.buckets.<name>`;
 *   the importer unpacks the buckets into measurements (timeseries-buckets.ts);
 * - users and roles: `admin.system.users` / `admin.system.roles` in a full dump, or
 *   `<db>.$admin.system.users` / `<db>.$admin.system.roles` from
 *   `mongodump --db <db> --dumpDbUsersAndRoles`; both become the backup's users and
 *   roles entries (the same documents `backup({ includeUsersAndRoles })` stores);
 * - `admin.system.version` / `$admin.system.version`: the auth schema version, which
 *   only mongorestore needs (exports write it again);
 * - other `system.*` collections (`system.profile`, `system.views`, …), which
 *   `mongoshield backup` does not capture either.
 */

import { TIMESERIES_BUCKET_PREFIX } from "./archive-format.ts";

/** What becomes of one namespace of a dump. */
export type ImportRole =
  /** A collection, view or time-series collection, imported as such. */
  | { readonly kind: "namespace" }
  /** One half of a time-series collection: the bucket data of `<db>.<collection>`. */
  | { readonly kind: "buckets"; readonly collection: string }
  /** Users or custom roles, imported into the backup's users / roles entry. */
  | { readonly kind: "users" | "roles" }
  /** Not imported, with the reason shown to the user. */
  | { readonly kind: "skip"; readonly reason: string };

/** Where the per-database dumps of `--dumpDbUsersAndRoles` keep users, roles and the auth version. */
const DB_USERS = "$admin.system.users";
const DB_ROLES = "$admin.system.roles";
const DB_AUTH_VERSION = "$admin.system.version";

/** The reason given for the auth schema version files. */
const AUTH_VERSION_REASON =
  "the auth schema version is only needed by mongorestore (`mongoshield export` writes it again)";

/** What the namespace `db.collection` of a dump becomes. */
export function importRole(db: string, collection: string): ImportRole {
  if (collection === DB_USERS) return { kind: "users" };
  if (collection === DB_ROLES) return { kind: "roles" };
  if (collection === DB_AUTH_VERSION) return { kind: "skip", reason: AUTH_VERSION_REASON };
  if (collection.startsWith("$")) {
    return { kind: "skip", reason: "not a namespace mongodump writes for users and roles" };
  }
  if (db === "admin" && collection === "system.users") return { kind: "users" };
  if (db === "admin" && collection === "system.roles") return { kind: "roles" };
  if (db === "admin" && collection === "system.version") {
    return { kind: "skip", reason: AUTH_VERSION_REASON };
  }
  if (collection.startsWith(TIMESERIES_BUCKET_PREFIX)) {
    return { kind: "buckets", collection: collection.slice(TIMESERIES_BUCKET_PREFIX.length) };
  }
  // system.js holds user-stored JavaScript; `mongoshield backup` treats it as data too.
  if (collection === "system.js") return { kind: "namespace" };
  if (collection.startsWith("system.")) {
    return {
      kind: "skip",
      reason: "system collections are not imported (MongoShield backs up user data only)",
    };
  }
  return { kind: "namespace" };
}

/** The reason for bucket data whose time-series collection is not in the dump. */
export const ORPHAN_BUCKETS_REASON =
  "time-series bucket data without its collection's metadata; mongodump writes both, so the dump is incomplete";
