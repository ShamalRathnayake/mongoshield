/**
 * Which namespaces of a mongodump output an import leaves out, and why. Shared by
 * the directory and archive importers so both skip exactly the same things.
 *
 * MongoShield backups hold user collections and views (like `mongoshield backup`,
 * which skips `system.*` collections). A dump can contain more:
 *
 * - `system.*` collections (`admin.system.version`, `system.profile`, `system.js`, …),
 *   which `mongoshield restore` would not write either;
 * - `$admin.system.users` / `$admin.system.roles` from `mongodump --dumpDbUsersAndRoles`;
 * - time-series collections: mongodump stores their internal *bucket* documents
 *   (under `system.buckets.<name>`), compressed column by column, while MongoShield
 *   stores plain measurements and lets the server rebuild buckets on restore.
 *   Converting buckets back to measurements is not supported, so they are skipped
 *   with an explanation instead of being imported wrongly.
 */

import type { CollectionType } from "../format/metadata.ts";
import { TIMESERIES_BUCKET_PREFIX } from "./archive-format.ts";

/** Why `collection` (of type `type`) is not imported, or undefined when it is. */
export function skipReason(collection: string, type: CollectionType): string | undefined {
  if (collection.startsWith("$")) {
    return "users and roles from `mongodump --dumpDbUsersAndRoles` are not imported";
  }
  if (collection.startsWith(TIMESERIES_BUCKET_PREFIX)) {
    return "internal time-series bucket data; time-series collections are not imported";
  }
  if (collection.startsWith("system.")) {
    return "system collections are not imported (MongoShield backs up user data only)";
  }
  if (type === "timeseries") {
    return (
      "time-series collection: mongodump stores internal bucket documents, which MongoShield " +
      "cannot convert to measurements; back it up with `mongoshield backup` instead"
    );
  }
  return undefined;
}
