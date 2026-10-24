/**
 * Importing the users and custom roles of a dump into the backup's users and roles
 * entries (docs/specs/FORMAT.md, "Users and roles entries").
 *
 * mongodump writes them in one of two forms (see import-rules.ts):
 *
 *   full dump                    admin/system.users.bson, admin/system.roles.bson
 *   --db app --dumpDbUsersAndRoles  app/$admin.system.users.bson, app/$admin.system.roles.bson
 *
 * Both hold the server's own `admin.system.users` / `admin.system.roles` documents,
 * which is exactly the shape a MongoShield backup stores (`backup-authz.ts` trims
 * `usersInfo` answers down to it), so the documents are copied byte for byte. Users
 * and roles are few (one document each), so they are collected in memory, filtered
 * with the import's include/exclude patterns the way restore filters them (a user of
 * database D is kept when the patterns select `D.system.users`), de-duplicated by
 * `_id` and written sorted by `_id`, like a native backup.
 */

import { Readable } from "node:stream";
import { BSON } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { NamespaceEntry } from "../format/manifest.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import {
  type ImportNamespace,
  type ImportTarget,
  namespaceEntry,
  writeImportedData,
  writeImportedMetadata,
} from "./import-target.ts";

/** Where the entries are stored: the namespaces the server keeps users and roles in. */
const AUTHZ_COLLECTIONS = { users: "system.users", roles: "system.roles" } as const;

/** Users and roles of a dump, collected while it is read. */
export class AuthzCollector {
  readonly #filter: NamespaceFilter;
  readonly #documents = { users: new Map<string, Buffer>(), roles: new Map<string, Buffer>() };

  constructor(filter: NamespaceFilter) {
    this.#filter = filter;
  }

  /**
   * Adds one user or role document (raw BSON), unless the patterns leave its
   * database out. The first document of each `_id` wins.
   *
   * @throws MS_INTEGRITY_FAILED for a document without string `_id` and `db`
   */
  add(kind: "users" | "roles", document: Buffer, where: string): void {
    const parsed = BSON.deserialize(document);
    const id: unknown = parsed._id;
    const database: unknown = parsed.db;
    if (typeof id !== "string" || typeof database !== "string") {
      throw new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `A document in ${where} is not a ${kind === "users" ? "user" : "role"}: it has no string _id and db.`,
        { hint: "The dump is damaged; take it again with mongodump." },
      );
    }
    if (!this.#filter(`${database}.${AUTHZ_COLLECTIONS[kind]}`)) return;
    const documents = this.#documents[kind];
    if (!documents.has(id)) documents.set(id, document);
  }

  /** Number of users and roles collected so far. */
  get size(): number {
    return this.#documents.users.size + this.#documents.roles.size;
  }

  /**
   * Writes the roles entry, then the users entry (the order restore needs), each only
   * when it has documents.
   */
  async write(target: ImportTarget, signal: AbortSignal): Promise<NamespaceEntry[]> {
    if (this.size > 0 && target.encryption === undefined) {
      target.logger.warn(
        "Importing users without encryption: their password hashes (SCRAM) are stored in the clear and can be attacked offline. Encrypt backups that include users.",
      );
    }
    const entries: NamespaceEntry[] = [];
    for (const kind of ["roles", "users"] as const) {
      const documents = [...this.#documents[kind]]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([, document]) => document);
      if (documents.length > 0)
        entries.push(await writeAuthzEntry(target, kind, documents, signal));
    }
    return entries;
  }
}

/** One users or roles entry: a plain metadata file and the documents. */
async function writeAuthzEntry(
  target: ImportTarget,
  kind: "users" | "roles",
  documents: readonly Buffer[],
  signal: AbortSignal,
): Promise<NamespaceEntry> {
  const collection = AUTHZ_COLLECTIONS[kind];
  const namespace: ImportNamespace = {
    db: "admin",
    collection,
    // Like a native backup: a mongodump-style file of type "collection", no indexes.
    metadata: { collectionName: collection, type: "collection", options: {}, indexes: [] },
    uniqueSuffix: undefined,
  };
  const metadata = await writeImportedMetadata(target, namespace, signal);
  const data = await writeImportedData(target, namespace, Readable.from(documents), [], signal);
  target.logger.info("Imported users and roles", { kind, count: data.documents });
  return { ...namespaceEntry(namespace, metadata, data), type: kind };
}
