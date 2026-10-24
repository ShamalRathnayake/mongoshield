import { z } from "zod";

/**
 * The manifest is the commit marker of a backup: it is written last, and a backup
 * directory without `manifest.json` is incomplete by definition.
 *
 * Manifests are immutable once written (they may live under object lock).
 * Anything learned later, such as verification results, is stored as separate
 * objects next to the manifest, never by rewriting it.
 *
 * Changing this schema in a way older readers cannot handle requires bumping
 * `MANIFEST_FORMAT_VERSION` and an RFC. See docs/specs/FORMAT.md.
 */

export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_FILENAME = "manifest.json";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 digest");
const isoDate = z.iso.datetime({ offset: true });

/** A MongoDB cluster time (BSON Timestamp) in JSON form. */
export const ClusterTimeSchema = z.object({
  t: z.number().int().nonnegative(),
  i: z.number().int().nonnegative(),
});

export const StoredFileSchema = z.object({
  /** Key relative to the backup directory, e.g. `app/users.bson.zst.age`. */
  key: z.string().min(1),
  /** Size in bytes of the stored object (after compression and encryption). */
  size: z.number().int().nonnegative(),
  /** SHA-256 of the stored bytes, so integrity can be checked without the key. */
  sha256: sha256Hex,
});

/**
 * The changes file of a `converge` backup: every change event of the backup window,
 * as concatenated BSON, compressed and encrypted like a data file.
 */
export const ChangesFileSchema = StoredFileSchema.extend({
  /** Number of change events in the file (after dropping those past `consistency.to`). */
  events: z.number().int().nonnegative(),
});

/**
 * The `_id` range of one part of a split collection, as canonical Extended JSON:
 * documents with `from <= _id < to` in index order (`{ "$minKey": 1 }` and
 * `{ "$maxKey": 1 }` stand for the open ends; the last part also holds a `MaxKey` _id).
 * Informational for restore (parts are simply concatenated in order) and what makes
 * resuming a backup part by part well defined. See docs/specs/PARTS-AND-RESUME.md.
 */
export const PartRangeSchema = z.object({
  from: z.custom<unknown>((value) => value !== undefined, "from is required"),
  to: z.custom<unknown>((value) => value !== undefined, "to is required"),
});

/**
 * One data part of a namespace. Added in MongoShield 2.0 without a format bump:
 * `range` is optional, and readers that ignore it lose nothing.
 */
export const DataFileSchema = StoredFileSchema.extend({
  /** Only for parts of split collections. */
  range: PartRangeSchema.optional(),
});

/** Entry types that describe a collection, view or time series (restored as such). */
export const COLLECTION_ENTRY_TYPES = ["collection", "view", "timeseries"] as const;

/**
 * Entry types that hold the deployment's users (`admin.system.users`) and custom roles
 * (`admin.system.roles`) rather than a collection, written by
 * `backup({ includeUsersAndRoles: true })`. Their data file holds one document per user
 * or role, in the shape of the server's `admin.system.users` / `admin.system.roles`
 * documents; restore recreates them with user-management commands, never as a
 * collection. Added in MongoShield 2.0 without a format bump (only backups taken with
 * the option have them). See docs/specs/FORMAT.md.
 */
export const AUTHZ_ENTRY_TYPES = ["users", "roles"] as const;

export const NamespaceEntrySchema = z.object({
  /** Full namespace, `<db>.<collection>`. */
  ns: z.string().min(3),
  db: z.string().min(1),
  collection: z.string().min(1),
  type: z.enum([...COLLECTION_ENTRY_TYPES, ...AUTHZ_ENTRY_TYPES]),
  /** Number of documents written. Always 0 for views. */
  documents: z.number().int().nonnegative(),
  /** Size of the BSON documents before compression and encryption. */
  bytesRaw: z.number().int().nonnegative(),
  /** Data parts in order. Empty for views. Large collections have several parts. */
  files: z.array(DataFileSchema),
  /** mongodump-compatible `<collection>.metadata.json` (options, indexes, uuid, type). */
  metadata: StoredFileSchema,
});

export const ManifestSchema = z
  .object({
    formatVersion: z.literal(MANIFEST_FORMAT_VERSION),
    /** Backup id, e.g. `2026-11-14T03-00-04Z_7f3a9c`. Also the directory name. */
    id: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{6}$/),
    /** Writer, e.g. `mongoshield@2.0.0`. */
    tool: z.string().min(1),
    status: z.literal("complete"),
    startedAt: isoDate,
    completedAt: isoDate,
    source: z.object({
      topology: z.enum(["standalone", "replicaSet", "sharded", "unknown"]),
      serverVersion: z.string(),
      /** Stable, non-secret identifier for the source deployment (a hash, never a URI). */
      clusterId: z.string().optional(),
    }),
    consistency: z.object({
      mode: z.enum(["none", "snapshot", "converge"]),
      from: ClusterTimeSchema.optional(),
      to: ClusterTimeSchema.optional(),
      /** Set when a stronger mode was requested but could not be used. */
      warning: z.string().optional(),
    }),
    compression: z.enum(["zstd", "gzip", "none"]),
    encryption: z
      .object({
        scheme: z.literal("age-v1"),
        /** Public recipient strings (age1…) or labels such as `scrypt`. Never secrets. */
        recipients: z.array(z.string()).min(1),
        /**
         * Passphrase backups only: the per-backup key envelope, `backup-key.age`. It holds
         * a one-off age identity, encrypted with the passphrase (one scrypt per backup);
         * every data and metadata file is encrypted to that identity's recipient.
         * Added in MongoShield 2.0 without a format bump: readers that ignore it cannot
         * decrypt passphrase backups, which they could not before either.
         */
        keyFile: StoredFileSchema.optional(),
      })
      .nullable(),
    labels: z.record(z.string(), z.string()),
    namespaces: z.array(NamespaceEntrySchema),
    /**
     * `converge` backups only: the change events of the window between
     * `consistency.from` and `consistency.to`, which restore replays after loading the
     * documents. Added in MongoShield 2.0 without a format bump: a reader that ignores
     * it restores the documents as read, the same result as consistency `none`.
     */
    changes: ChangesFileSchema.optional(),
    /**
     * Set when the backup was written with write-once retention (`backup({ retainDays })`):
     * every file and the manifest itself are locked by the storage until this time.
     * Prune keeps the backup until then instead of trying (and failing) to delete it.
     * Added in MongoShield 2.0 without a format bump: a reader that ignores it can still
     * restore the backup; only its prune would try to delete locked objects, which the
     * storage refuses. See docs/guides/immutable-backups.md.
     */
    immutableUntil: isoDate.optional(),
    totals: z.object({
      namespaces: z.number().int().nonnegative(),
      documents: z.number().int().nonnegative(),
      bytesRaw: z.number().int().nonnegative(),
      /**
       * Sum of the sizes of every stored data, metadata and changes file, excluding the
       * manifest and the key envelope.
       */
      bytesStored: z.number().int().nonnegative(),
    }),
  })
  // A backup cannot finish before it starts; catching this guards retention
  // decisions, which are based on completion times.
  .refine((manifest) => Date.parse(manifest.completedAt) >= Date.parse(manifest.startedAt), {
    message: "completedAt must not be earlier than startedAt",
    path: ["completedAt"],
  });

export type ClusterTime = z.infer<typeof ClusterTimeSchema>;
export type StoredFile = z.infer<typeof StoredFileSchema>;
export type ChangesFile = z.infer<typeof ChangesFileSchema>;
/** The `_id` bounds of one part of a split collection (canonical Extended JSON). */
export type PartRange = z.infer<typeof PartRangeSchema>;
/** A data part: a stored file, plus its `_id` range for split collections. */
export type DataFile = z.infer<typeof DataFileSchema>;
export type NamespaceEntry = z.infer<typeof NamespaceEntrySchema>;
/** A manifest entry describing a collection, view or time series (not users or roles). */
export type CollectionEntry = NamespaceEntry & {
  readonly type: (typeof COLLECTION_ENTRY_TYPES)[number];
};
/** A manifest entry holding users or roles. */
export type AuthzEntry = NamespaceEntry & { readonly type: (typeof AUTHZ_ENTRY_TYPES)[number] };

/** True for the users and roles entries of `includeUsersAndRoles` backups. */
export function isAuthzEntry(entry: NamespaceEntry): entry is AuthzEntry {
  return entry.type === "users" || entry.type === "roles";
}

/** True for entries describing a collection, view or time series. */
export function isCollectionEntry(entry: NamespaceEntry): entry is CollectionEntry {
  return !isAuthzEntry(entry);
}

/**
 * The entries describing collections, views and time series: everything except
 * users and roles. Most readers (restore plans, exports, drills) only want these.
 */
export function collectionEntries(namespaces: readonly NamespaceEntry[]): CollectionEntry[] {
  return namespaces.filter(isCollectionEntry);
}
export type Manifest = z.infer<typeof ManifestSchema>;
export type Compression = Manifest["compression"];
export type ConsistencyMode = Manifest["consistency"]["mode"];
