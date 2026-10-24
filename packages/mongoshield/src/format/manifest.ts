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

/**
 * The highest manifest format version this release reads (and writes).
 *
 * Version 2 exists for incremental backups only: an incremental holds the changes
 * since its parent, not the data, and a version-1 reader that ignored `kind` would
 * restore it as an (empty) backup plus a replay, silently producing the wrong data.
 * Version 2 makes such a reader stop with "please upgrade" instead. Full backups are
 * still written as version 1 ({@link FULL_BACKUP_FORMAT_VERSION}), so every reader of
 * the first format keeps reading them. See docs/specs/FORMAT.md, "Incremental backups".
 */
export const MANIFEST_FORMAT_VERSION = 2;

/** The format version written for full backups (readable by every 2.x release). */
export const FULL_BACKUP_FORMAT_VERSION = 1;

/** The format version written for incremental backups (the first that knows `kind`). */
export const INCREMENTAL_BACKUP_FORMAT_VERSION = 2;

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
  /**
   * Incremental backups only (and required there): what the entry holds.
   * `"metadata"`: the namespace's metadata file as of the backup (options, validators,
   * indexes, a view's definition), no documents; its documents come from the chain.
   * `"full"`: metadata and every document, as a full backup holds them (time series
   * collections, which change events do not report, and users and roles).
   * Absent in full backups, where every entry is complete.
   */
  content: z.enum(["full", "metadata"]).optional(),
});

/**
 * What a backup was asked to back up: its include/exclude patterns and the namespaces
 * it filtered with a `query`. Recorded so an incremental backup can check that it
 * continues a chain of the same selection (a chain of `app.*` must not get an
 * incremental of `*`). Added in MongoShield 2.0 without a format bump: readers that
 * ignore it lose nothing.
 */
export const SelectionSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  /** The namespaces given a `query` (their filters are not recorded). */
  query: z.array(z.string()),
});

/**
 * Where an incremental backup sits in its chain (`kind: "incremental"` only).
 * The changes it holds are those after its parent's end time (`consistency.from`,
 * exclusive) up to its own (`consistency.to`, inclusive).
 */
export const ChainSchema = z.object({
  /** The full backup the chain starts from. */
  base: z.string().min(1),
  /** The backup this one continues: the base itself, or the previous incremental. */
  parent: z.string().min(1),
  /** This backup's position after the base: 1 for the first incremental, 2 for the next, … */
  length: z.number().int().positive(),
});

export const ManifestSchema = z
  .object({
    /**
     * 1 for full backups, 2 for incremental ones (see {@link MANIFEST_FORMAT_VERSION}).
     * A reader also accepts a full backup written as version 2.
     */
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    /**
     * `"incremental"` for a backup that holds only the changes since its parent
     * (`chain`); absent (or `"full"`) for a backup that holds the data itself.
     * Added with format version 2.
     */
    kind: z.enum(["full", "incremental"]).optional(),
    /** Incremental backups only: their place in the chain. */
    chain: ChainSchema.optional(),
    /** The include/exclude selection the backup was taken with (see SelectionSchema). */
    selection: SelectionSchema.optional(),
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
  })
  .superRefine(checkIncrementalFields);

/**
 * The fields an incremental backup cannot do without, and that only incrementals may
 * carry: a reader must never mistake one kind for the other (see FORMAT.md).
 */
function checkIncrementalFields(
  manifest: {
    readonly formatVersion: number;
    readonly kind?: "full" | "incremental" | undefined;
    readonly namespaces: readonly {
      readonly ns: string;
      readonly content?: "full" | "metadata" | undefined;
      readonly files: readonly unknown[];
      readonly documents: number;
    }[];
    readonly chain?: unknown;
    readonly changes?: unknown;
    readonly consistency: {
      readonly mode: string;
      readonly from?: unknown;
      readonly to?: unknown;
    };
  },
  context: z.RefinementCtx,
): void {
  const issue = (message: string, path: string): void => {
    context.addIssue({ code: "custom", message, path: [path] });
  };
  if (manifest.kind !== "incremental") {
    if (manifest.chain !== undefined)
      issue("chain is only allowed on incremental backups", "chain");
    if (manifest.namespaces.some((entry) => entry.content === "metadata")) {
      issue('only incremental backups hold "metadata" entries', "namespaces");
    }
    return;
  }
  for (const entry of manifest.namespaces) {
    if (entry.content === undefined) {
      issue(
        `${entry.ns}: every entry of an incremental backup says what it holds (content)`,
        "namespaces",
      );
    } else if (entry.content === "metadata" && (entry.files.length > 0 || entry.documents > 0)) {
      issue(`${entry.ns}: a "metadata" entry holds no data files`, "namespaces");
    }
  }
  if (manifest.formatVersion < INCREMENTAL_BACKUP_FORMAT_VERSION) {
    issue("incremental backups need formatVersion 2", "formatVersion");
  }
  if (manifest.chain === undefined) issue("an incremental backup needs its chain", "chain");
  if (manifest.changes === undefined)
    issue("an incremental backup needs its changes file", "changes");
  const { consistency } = manifest;
  if (
    consistency.mode !== "converge" ||
    consistency.from === undefined ||
    consistency.to === undefined
  ) {
    issue(
      'an incremental backup records its change range as consistency "converge" with from and to',
      "consistency",
    );
  }
}

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
/** Where an incremental backup sits in its chain. */
export type ChainInfo = z.infer<typeof ChainSchema>;
/** The include/exclude selection recorded in a manifest. */
export type Selection = z.infer<typeof SelectionSchema>;
/** An incremental backup's manifest: its `chain` and `changes` are always present. */
export type IncrementalManifest = Manifest & {
  readonly kind: "incremental";
  readonly chain: ChainInfo;
  readonly changes: ChangesFile;
};

/** True for the manifest of an incremental backup (one that holds only changes). */
export function isIncrementalManifest(manifest: Manifest): manifest is IncrementalManifest {
  return (
    manifest.kind === "incremental" &&
    manifest.chain !== undefined &&
    manifest.changes !== undefined
  );
}
export type Compression = Manifest["compression"];
export type ConsistencyMode = Manifest["consistency"]["mode"];
