/**
 * Backup layout: where each file of a backup lives inside a storage location.
 *
 *   backups/
 *     2026-11-14T03-00-04Z_7f3a9c/          ← one directory per backup (the backup id)
 *       manifest.json                        ← written last; its presence means "complete"
 *       app/                                 ← one directory per database
 *         users.metadata.json[.age]          ← mongodump-compatible collection metadata
 *         users.bson[.zst|.gz][.age]         ← the documents, as concatenated BSON
 *         orders.000.bson.zst.age            ← large collections can be split into parts
 *       _changes/
 *         window.bson[.zst|.gz][.age]        ← converge backups: change events of the window
 *
 * The manifest lists every file key, so readers never need to guess file names.
 * The naming rules below only have to produce keys that are safe, unique and
 * recognisable to a human browsing the bucket. See docs/specs/FORMAT.md.
 */

import { createHash, randomBytes } from "node:crypto";
import { MongoShieldError } from "../errors.ts";
import { MANIFEST_FILENAME } from "./manifest.ts";

/** Every backup directory lives under this prefix. */
export const BACKUPS_PREFIX = "backups/";

/** Extension added to files encrypted with age. */
export const ENCRYPTED_EXTENSION = ".age";

/** File extension for each compression algorithm. */
export const COMPRESSION_EXTENSIONS = {
  zstd: ".zst",
  gzip: ".gz",
  none: "",
} as const;

// ---------------------------------------------------------------------------
// Backup ids
// ---------------------------------------------------------------------------

/**
 * Backup ids look like `2026-11-14T03-00-04Z_7f3a9c`:
 * the UTC start time (colons replaced so the id is safe in paths and URLs),
 * then 6 random hex characters so two backups started in the same second never collide.
 * Ids sort chronologically as plain strings.
 */
const BACKUP_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z_([0-9a-f]{6})$/;

/** Creates a new backup id for a backup starting at `startedAt`. */
export function newBackupId(startedAt: Date = new Date()): string {
  // toISOString() gives "2026-11-14T03:00:04.123Z"; drop the milliseconds and the colons.
  const seconds = startedAt.toISOString().slice(0, 19).replaceAll(":", "-");
  const suffix = randomBytes(3).toString("hex");
  return `${seconds}Z_${suffix}`;
}

/** Returns true if `value` is a well-formed backup id. */
export function isBackupId(value: string): boolean {
  return BACKUP_ID_PATTERN.test(value);
}

/** Extracts the start time encoded in a backup id. Throws on malformed ids. */
export function backupIdToDate(id: string): Date {
  const match = BACKUP_ID_PATTERN.exec(id);
  if (!match) {
    // A malformed id is a mistake in the input, not a missing backup.
    throw new MongoShieldError("MS_CONFIG_INVALID", `"${id}" is not a valid backup id.`, {
      hint: 'Backup ids look like "2026-11-14T03-00-04Z_7f3a9c". Run `mongoshield list` to see them.',
    });
  }
  const [, day, hours, minutes, seconds] = match;
  return new Date(`${day}T${hours}:${minutes}:${seconds}Z`);
}

// ---------------------------------------------------------------------------
// Keys of a backup's files
// ---------------------------------------------------------------------------

/** Directory (with trailing slash) holding everything for one backup. */
export function backupDir(id: string): string {
  return `${BACKUPS_PREFIX}${id}/`;
}

/** Full storage key of a backup's manifest. */
export function manifestKey(id: string): string {
  return `${backupDir(id)}${MANIFEST_FILENAME}`;
}

/**
 * Checkpoints of resumable backups live under this prefix, outside `backups/`, so
 * a backup directory stays mongodump-shaped (see docs/specs/PARTS-AND-RESUME.md).
 */
export const CHECKPOINTS_PREFIX = "_state/checkpoints/";

/** Full storage key of a backup's checkpoint, `_state/checkpoints/<id>.json`. */
export function checkpointKey(id: string): string {
  return `${CHECKPOINTS_PREFIX}${id}.json`;
}

/** Turns a key relative to the backup directory into a full storage key. */
export function resolveBackupKey(id: string, relativeKey: string): string {
  return `${backupDir(id)}${relativeKey}`;
}

export interface DataFileKeyOptions {
  readonly db: string;
  readonly collection: string;
  readonly compression: keyof typeof COMPRESSION_EXTENSIONS;
  readonly encrypted: boolean;
  /** Part number for split collections. Omit for single-part collections. */
  readonly part?: number;
  /**
   * Extra text appended to the file name to keep it unique, from
   * `caseCollisionSuffixes()`. Omit in the normal case.
   */
  readonly uniqueSuffix?: string;
}

/**
 * Key (relative to the backup directory) of a collection's BSON data,
 * e.g. `app/users.bson.zst.age` or `app/orders.002.bson.zst`.
 */
export function dataFileKey(options: DataFileKeyOptions): string {
  const partSuffix = options.part === undefined ? "" : `.${String(options.part).padStart(3, "0")}`;
  const extensions =
    ".bson" +
    COMPRESSION_EXTENSIONS[options.compression] +
    (options.encrypted ? ENCRYPTED_EXTENSION : "");
  return `${collectionPath(options)}${partSuffix}${extensions}`;
}

/**
 * Key (relative to the backup directory) of a collection's metadata,
 * e.g. `app/users.metadata.json`. Metadata is small, so it is never compressed,
 * but it is encrypted when the backup is (index definitions can reveal a lot).
 */
export function metadataFileKey(options: Omit<DataFileKeyOptions, "compression" | "part">): string {
  const extension = `.metadata.json${options.encrypted ? ENCRYPTED_EXTENSION : ""}`;
  return `${collectionPath(options)}${extension}`;
}

/**
 * `<db>/<collection>` with both names encoded, the shared start of every file key
 * of a collection.
 */
function collectionPath(options: Pick<DataFileKeyOptions, "db" | "collection" | "uniqueSuffix">) {
  let collection = encodeNameSegment(options.collection);

  // A collection literally named "users.000" would otherwise get the same key as
  // part 0 of a split "users" collection. Encoding the last dot keeps them apart.
  if (/\.\d+$/.test(collection)) {
    const lastDot = collection.lastIndexOf(".");
    collection = `${collection.slice(0, lastDot)}%2E${collection.slice(lastDot + 1)}`;
  }

  return `${encodeNameSegment(options.db)}/${collection}${options.uniqueSuffix ?? ""}`;
}

/** Directory of a converge backup's changes file. */
export const CHANGES_DIRECTORY = "_changes";

/** Name (without extensions) of a converge backup's changes file. */
const CHANGES_FILE_NAME = "window";

/**
 * Key (relative to the backup directory) of a converge backup's change events,
 * e.g. `_changes/window.bson.zst.age`. They are BSON like a data file, so they get
 * the same extensions.
 */
export function changesFileKey(
  options: Pick<DataFileKeyOptions, "compression" | "encrypted">,
): string {
  const extensions =
    ".bson" +
    COMPRESSION_EXTENSIONS[options.compression] +
    (options.encrypted ? ENCRYPTED_EXTENSION : "");
  return `${CHANGES_DIRECTORY}/${CHANGES_FILE_NAME}${extensions}`;
}

/**
 * A collection named `window` in a database named `_changes` would get the very key
 * of the changes file (and, on case-insensitive filesystems, so would `_Changes.Window`).
 * Returns the extra suffix that keeps such a collection's files apart, like
 * `caseCollisionSuffixes`, or `undefined` for every other collection.
 */
export function reservedNameSuffix(db: string, collection: string): string | undefined {
  const clashes =
    db.toLowerCase() === CHANGES_DIRECTORY && collection.toLowerCase() === CHANGES_FILE_NAME;
  if (!clashes) return undefined;
  const hash = createHash("sha256").update(`${db}.${collection}`, "utf8").digest("hex").slice(0, 8);
  return `~${hash}`;
}

/**
 * MongoDB allows collections `Users` and `users` in the same database, but on
 * case-insensitive filesystems (the macOS and Windows defaults) their files would
 * overwrite each other. Given the collection names of one database, this returns a
 * suffix for every name that clashes with another when case is ignored, e.g.
 * `~1a2b3c4d`. Names without a clash get no entry and keep their plain file names.
 */
export function caseCollisionSuffixes(collectionNames: readonly string[]): Map<string, string> {
  // Group names by their lower-cased form.
  const groups = new Map<string, string[]>();
  for (const name of collectionNames) {
    const folded = name.toLowerCase();
    groups.set(folded, [...(groups.get(folded) ?? []), name]);
  }

  const suffixes = new Map<string, string>();
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    for (const name of names) {
      const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
      suffixes.set(name, `~${hash}`);
    }
  }
  return suffixes;
}

// ---------------------------------------------------------------------------
// Encoding database and collection names into key segments
// ---------------------------------------------------------------------------

/** Characters that are kept as-is. Everything else is percent-encoded. */
const SAFE_CHARACTER = /[A-Za-z0-9_.-]/;

/** Encoded segments longer than this are shortened (filesystems cap names at 255 bytes). */
const MAX_SEGMENT_LENGTH = 180;

/**
 * Makes a database or collection name safe to use as one path segment.
 *
 * - Unsafe characters (`/`, spaces, `$`, non-ASCII, …) become `%XX` per UTF-8 byte,
 *   like URL encoding, so common names stay readable: `users` stays `users`.
 * - Names made only of dots (`.`, `..`) are fully encoded so they cannot act as
 *   relative path segments.
 * - Very long names are cut and given a hash suffix to stay unique.
 *
 * The encoding does not need to be reversible: the manifest maps every
 * namespace to its file keys.
 */
export function encodeNameSegment(name: string): string {
  if (name.length === 0) {
    throw new MongoShieldError("MS_INTERNAL", "Database and collection names cannot be empty.");
  }

  const onlyDots = /^\.+$/.test(name);
  let encoded = "";
  for (const character of name) {
    if (!onlyDots && SAFE_CHARACTER.test(character)) {
      encoded += character;
    } else {
      // One %XX per UTF-8 byte, e.g. "é" → "%C3%A9".
      for (const byte of Buffer.from(character, "utf8")) {
        encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }

  if (encoded.length > MAX_SEGMENT_LENGTH) {
    const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 16);
    encoded = `${encoded.slice(0, MAX_SEGMENT_LENGTH - 17)}~${hash}`;
  }
  return encoded;
}
