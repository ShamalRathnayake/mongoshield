/**
 * Reading a mongodump output directory (`mongodump --out <dir>`, optionally `--gzip`):
 *
 *   <dir>/
 *     prelude.json[.gz]                    server and tool version (mongodump 100.12+)
 *     oplog.bson                           only with --oplog (not imported)
 *     <db>/
 *       <stem>.bson[.gz]                   documents (legacy dumps: <stem>.bin)
 *       <stem>.metadata.json[.gz]          options, indexes, uuid, type
 *       system.buckets.<name>.bson[.gz]    time-series bucket data (not imported)
 *
 * `<stem>` is the escaped collection name (see `dump-names.ts`). A dump of one
 * database (`mongodump --db app --out dump`) may also be given as the database
 * directory itself (`dump/app`), which then holds the collection files directly,
 * as mongorestore allows with `--db app dump/app`.
 *
 * `scanDumpDirectory` only lists files and groups them per collection; deciding
 * what to import (and reading metadata) is up to the importer. Each file is gzipped
 * or not according to its own `.gz` suffix, exactly like mongodump writes them.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDecompressor } from "../compression/index.ts";
import { MongoShieldError } from "../errors.ts";

/** A file of the dump and whether it is gzipped (by its `.gz` suffix). */
export interface DumpFile {
  readonly path: string;
  readonly gzip: boolean;
}

/** The files of one collection (or view) in a database directory. */
export interface DumpCollectionFiles {
  readonly db: string;
  /** The escaped file-name stem, e.g. `we%2Fird+name`. */
  readonly stem: string;
  /** `<stem>.bson[.gz]`; absent for views. */
  readonly data: DumpFile | undefined;
  /** `<stem>.metadata.json[.gz]`; absent in hand-made dumps. */
  readonly metadata: DumpFile | undefined;
}

/** A file the scan saw but that is not a collection's data or metadata. */
export interface IgnoredDumpFile {
  readonly path: string;
  readonly reason: string;
}

/** What `scanDumpDirectory` found. */
export interface DumpDirectoryScan {
  /** From `prelude.json`, when present. */
  readonly serverVersion: string | undefined;
  readonly toolVersion: string | undefined;
  /** Grouped per collection, sorted by database and stem. */
  readonly collections: readonly DumpCollectionFiles[];
  readonly ignored: readonly IgnoredDumpFile[];
  /** The newest modification time of any collection file: when the dump finished. */
  readonly newestFileTime: Date | undefined;
}

/** Options for `scanDumpDirectory`. */
export interface ScanDumpDirectoryOptions {
  /**
   * Database name when `root` is a single database's directory. Defaults to the
   * directory's own name. Ignored when `root` holds database directories.
   */
  readonly database?: string | undefined;
}

/** File-name suffixes, longest first so `.metadata.json.gz` wins over `.gz`. */
const SUFFIXES = [
  { suffix: ".metadata.json.gz", role: "metadata", gzip: true },
  { suffix: ".metadata.json", role: "metadata", gzip: false },
  { suffix: ".bson.gz", role: "data", gzip: true },
  { suffix: ".bson", role: "data", gzip: false },
  // mongorestore still accepts the `.bin` extension of very old dumps.
  { suffix: ".bin", role: "data", gzip: false },
] as const;

/** `prelude.json` holds versions only, a few dozen bytes. */
const MAX_PRELUDE_BYTES = 64 * 1024;

/** Metadata files hold options and index definitions; this is far above any real one. */
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/** Files mongodump writes at the top level that are not database directories. */
const PRELUDE_FILE_NAMES = ["prelude.json", "prelude.json.gz"];

/**
 * Lists the collections of a mongodump directory.
 *
 * @throws MS_CONFIG_INVALID when `root` is not a readable directory or holds no dump.
 */
export async function scanDumpDirectory(
  root: string,
  options: ScanDumpDirectoryOptions = {},
): Promise<DumpDirectoryScan> {
  const entries = await listDirectory(root);
  const ignored: IgnoredDumpFile[] = [];
  const collections: DumpCollectionFiles[] = [];
  let prelude = await readPrelude(root, entries);

  const holdsCollectionFiles = entries.some(
    (entry) => entry.isFile() && classify(entry.name) !== undefined && entry.name !== "oplog.bson",
  );
  if (holdsCollectionFiles) {
    // `root` is one database's directory.
    const db = options.database ?? basename(root);
    collections.push(...groupCollectionFiles(root, db, entries, ignored));
  } else {
    for (const entry of entries) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        const dbEntries = await listDirectory(path);
        prelude ??= await readPrelude(path, dbEntries);
        collections.push(...groupCollectionFiles(path, entry.name, dbEntries, ignored));
      } else if (entry.name === "oplog.bson" || entry.name === "oplog.bson.gz") {
        ignored.push({
          path,
          reason: "oplog from `mongodump --oplog`; replaying it is not supported",
        });
      } else if (!PRELUDE_FILE_NAMES.includes(entry.name)) {
        ignored.push({ path, reason: "not part of a mongodump directory" });
      }
    }
  }

  if (collections.length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${root} does not contain a mongodump output.`,
      {
        hint: "Pass the directory given to `mongodump --out` (it holds one directory per database), or a database directory inside it.",
      },
    );
  }

  collections.sort((a, b) => compareStrings(`${a.db}\0${a.stem}`, `${b.db}\0${b.stem}`));
  return {
    serverVersion: prelude?.serverVersion,
    toolVersion: prelude?.toolVersion,
    collections,
    ignored,
    newestFileTime: await newestModificationTime(collections),
  };
}

/** A dump file as a source stream plus the transforms that turn it into plain bytes. */
export interface DumpFileStreams {
  readonly source: Readable;
  /** `[gunzip]` for gzipped files, otherwise empty. */
  readonly transforms: readonly Transform[];
}

/**
 * Opens a dump file for streaming. The caller pipes `source → transforms…` itself
 * (with `pipeline()`), so a failure or abort anywhere also closes the file.
 */
export function openDumpFile(file: DumpFile): DumpFileStreams {
  return {
    source: createReadStream(file.path),
    transforms: file.gzip ? [createDecompressor("gzip")] : [],
  };
}

/** Reads a small dump file (metadata, prelude) as text, gunzipping it when needed. */
export async function readDumpTextFile(
  file: DumpFile,
  maxBytes = MAX_METADATA_BYTES,
): Promise<string> {
  const { source, transforms } = openDumpFile(file);
  const chunks: Buffer[] = [];
  let total = 0;
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new MongoShieldError(
            "MS_INTEGRITY_FAILED",
            `${file.path} is larger than ${maxBytes} bytes.`,
            {
              hint: "This is not a metadata file mongodump writes.",
            },
          ),
        );
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline([source, ...transforms, collect]);
  return Buffer.concat(chunks, total).toString("utf8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DirectoryEntry = Awaited<ReturnType<typeof listDirectory>>[number];

async function listDirectory(path: string) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.sort((a, b) => compareStrings(a.name, b.name));
  } catch (error) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Cannot read the directory ${path}.`, {
      cause: error,
      hint: "Check the path to the mongodump output.",
    });
  }
}

/** Groups the files of one database directory by stem. */
function groupCollectionFiles(
  directory: string,
  db: string,
  entries: readonly DirectoryEntry[],
  ignored: IgnoredDumpFile[],
): DumpCollectionFiles[] {
  const byStem = new Map<string, { data?: DumpFile; metadata?: DumpFile }>();
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile()) {
      // mongorestore: "don't know what to do with subdirectory …, skipping".
      ignored.push({ path, reason: "unexpected subdirectory" });
      continue;
    }
    if (PRELUDE_FILE_NAMES.includes(entry.name)) continue;
    const match = classify(entry.name);
    if (match === undefined) {
      ignored.push({ path, reason: "not a .bson or .metadata.json file" });
      continue;
    }
    const files = byStem.get(match.stem) ?? {};
    const existing = match.role === "data" ? files.data : files.metadata;
    if (existing !== undefined) {
      // e.g. both users.bson and users.bson.gz: refuse rather than pick one silently.
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `${existing.path} and ${path} hold the same collection.`,
        { hint: "Remove one of them, then run the import again." },
      );
    }
    byStem.set(match.stem, { ...files, [match.role]: { path, gzip: match.gzip } });
  }

  return [...byStem].map(([stem, files]) => ({
    db,
    stem,
    data: files.data,
    metadata: files.metadata,
  }));
}

/** The stem, role and compression of a collection file name, or undefined for other files. */
function classify(
  name: string,
):
  | { readonly stem: string; readonly role: "data" | "metadata"; readonly gzip: boolean }
  | undefined {
  for (const candidate of SUFFIXES) {
    if (name.endsWith(candidate.suffix) && name.length > candidate.suffix.length) {
      return {
        stem: name.slice(0, -candidate.suffix.length),
        role: candidate.role,
        gzip: candidate.gzip,
      };
    }
  }
  return undefined;
}

/** Versions from `prelude.json` (`{"ServerVersion":"7.0.12","ToolVersion":"100.12.0"}`), if present. */
async function readPrelude(
  directory: string,
  entries: readonly DirectoryEntry[],
): Promise<{ serverVersion?: string; toolVersion?: string } | undefined> {
  const entry = entries.find((candidate) => PRELUDE_FILE_NAMES.includes(candidate.name));
  if (entry === undefined) return undefined;
  const file: DumpFile = { path: join(directory, entry.name), gzip: entry.name.endsWith(".gz") };
  try {
    const parsed: unknown = JSON.parse(await readDumpTextFile(file, MAX_PRELUDE_BYTES));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const serverVersion: unknown = Reflect.get(parsed, "ServerVersion");
    const toolVersion: unknown = Reflect.get(parsed, "ToolVersion");
    return {
      ...(typeof serverVersion === "string" ? { serverVersion } : {}),
      ...(typeof toolVersion === "string" ? { toolVersion } : {}),
    };
  } catch {
    // prelude.json is informational (mongorestore also works without it).
    return undefined;
  }
}

async function newestModificationTime(
  collections: readonly DumpCollectionFiles[],
): Promise<Date | undefined> {
  let newest: number | undefined;
  for (const collection of collections) {
    for (const file of [collection.data, collection.metadata]) {
      if (file === undefined) continue;
      const info = await stat(file.path);
      newest = Math.max(newest ?? 0, info.mtimeMs);
    }
  }
  return newest === undefined ? undefined : new Date(newest);
}

/** Plain code-unit order, the same on every platform and locale. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
