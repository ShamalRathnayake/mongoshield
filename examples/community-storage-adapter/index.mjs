/**
 * mongoshield-flat-folder: an example community storage adapter.
 *
 * It keeps every object as ONE file in ONE folder (no sub-directories), with the key
 * percent-encoded into the file name: `backups/2026-…/manifest.json` becomes
 * `backups%2F2026-…%2Fmanifest.json`. That is a different layout from the built-in
 * file adapter, which is the point: it shows everything a third-party adapter has to
 * get right, and registers itself under its own scheme:
 *
 *   import "mongoshield-flat-folder";      // registers flatdir://
 *   // mongoshield backup --storage flatdir:///srv/backups
 *
 * The contract (src/storage/types.ts in mongoshield) and how this file meets it:
 * - Atomic writes: data goes to a hidden temp file first and is renamed into place
 *   (or linked, for create-if-absent), so readers never see half an object.
 * - Conditional writes (`ifNoneMatch: "*"`): link(2) refuses an existing name, which
 *   becomes MS_STORAGE_PRECONDITION_FAILED.
 * - `list()` returns keys in lexicographic order, `listPrefixes()` the immediate
 *   "sub-directories" of a prefix, both derived from the decoded file names.
 * - No write-once retention: a put with `retainUntil` fails with MS_CONFIG_INVALID
 *   before the body is read.
 * - Every error is a MongoShieldError with an MS_STORAGE_* code; an aborted signal
 *   gives MS_ABORTED.
 * - `space()` reports the volume's size, so backups get the free-space check.
 *
 * Tested with mongoshield's contract test kit, `mongoshield/testing/storage`
 * (test/conformance.test.mjs).
 */

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readdir, rename, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertValidKey,
  assertValidPrefix,
  MongoShieldError,
  registerStorageScheme,
  throwIfAborted,
} from "mongoshield";

/** The URL scheme this package registers: `flatdir:///absolute/folder`. */
export const SCHEME = "flatdir";

/** Temp files start with a dot, which encoded keys never do (`.` is encoded as %2E). */
const TEMP_PREFIX = ".tmp-";

/**
 * Creates the adapter for one folder.
 *
 * @param {{ folder: string }} options the folder that holds the objects; created on first write.
 * @returns {import("mongoshield").StorageAdapter}
 */
export function flatFolderStorage(options) {
  const folder = resolve(options.folder);
  const location = `${SCHEME}://${folder}/`;

  /** The file that holds `key`. */
  function pathOf(key) {
    assertValidKey(key);
    return join(folder, encodeKey(key));
  }

  /** @type {import("mongoshield").StorageAdapter["put"]} */
  async function put(key, body, putOptions = {}) {
    const path = pathOf(key);
    const { signal } = putOptions;
    if (putOptions.retainUntil !== undefined) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `${location} cannot retain objects.`, {
        hint: "Use storage with object lock (S3, GCS, Azure) for immutable backups.",
      });
    }
    throwIfAborted(signal);
    await mkdir(folder, { recursive: true });
    const temp = join(folder, `${TEMP_PREFIX}${randomBytes(8).toString("hex")}`);
    try {
      const source = body instanceof Uint8Array ? Readable.from([body]) : body;
      const file = await open(temp, "wx");
      // pipeline closes the file, respects backpressure, and stops on abort.
      await pipeline(source, file.createWriteStream(), signal ? { signal } : {});
      throwIfAborted(signal);
      if (putOptions.ifNoneMatch === "*") {
        // link(2) is an atomic create-if-absent.
        await link(temp, path);
      } else {
        await rename(temp, path);
      }
    } catch (error) {
      throw storageError(error, `write ${key}`, signal);
    } finally {
      await rm(temp, { force: true });
    }
    return infoOf(key, await stat(path));
  }

  /** @type {import("mongoshield").StorageAdapter["get"]} */
  async function get(key, getOptions = {}) {
    const path = pathOf(key);
    throwIfAborted(getOptions.signal);
    try {
      // stat first turns a missing object into MS_STORAGE_NOT_FOUND right away,
      // instead of an error event on the returned stream.
      await stat(path);
      const range = getOptions.range;
      return createReadStream(path, {
        // Both ends are inclusive, as in the contract.
        ...(range === undefined ? {} : { start: range.start }),
        ...(range?.end === undefined ? {} : { end: range.end }),
        ...(getOptions.signal ? { signal: getOptions.signal } : {}),
      });
    } catch (error) {
      throw storageError(error, `read ${key}`, getOptions.signal);
    }
  }

  /** @type {import("mongoshield").StorageAdapter["head"]} */
  async function head(key, headOptions = {}) {
    const path = pathOf(key);
    throwIfAborted(headOptions.signal);
    try {
      return infoOf(key, await stat(path));
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw storageError(error, `stat ${key}`, headOptions.signal);
    }
  }

  /** Every key in the folder, sorted. Temp files are skipped. */
  async function allKeys(signal) {
    throwIfAborted(signal);
    let names;
    try {
      names = await readdir(folder);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw storageError(error, "list", signal);
    }
    return names
      .filter((name) => !name.startsWith(TEMP_PREFIX))
      .map((name) => decodeKey(name))
      .sort(compareKeys);
  }

  /** @type {import("mongoshield").StorageAdapter["list"]} */
  async function* list(prefix, listOptions = {}) {
    if (prefix !== "") assertValidPrefix(prefix);
    for (const key of await allKeys(listOptions.signal)) {
      if (!key.startsWith(prefix)) continue;
      throwIfAborted(listOptions.signal);
      const info = await head(key, listOptions);
      if (info !== undefined) yield info;
    }
  }

  /** @type {import("mongoshield").StorageAdapter["listPrefixes"]} */
  async function* listPrefixes(prefix, listOptions = {}) {
    if (prefix !== "") assertValidPrefix(prefix);
    const seen = new Set();
    for (const key of await allKeys(listOptions.signal)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) seen.add(`${prefix}${rest.slice(0, slash)}/`);
    }
    yield* [...seen].sort(compareKeys);
  }

  /** @type {import("mongoshield").StorageAdapter["delete"]} */
  async function deleteObjects(keys, deleteOptions = {}) {
    const paths = keys.map((key) => pathOf(key));
    throwIfAborted(deleteOptions.signal);
    for (const path of paths) {
      // `force` ignores missing files, as the contract asks.
      await rm(path, { force: true }).catch((error) => {
        throw storageError(error, "delete", deleteOptions.signal);
      });
    }
  }

  /** @type {NonNullable<import("mongoshield").StorageAdapter["space"]>} */
  async function space(spaceOptions = {}) {
    throwIfAborted(spaceOptions.signal);
    // Before the first write the folder may not exist; its parent is on the same disk.
    for (let current = folder; ; current = resolve(current, "..")) {
      try {
        const stats = await statfs(current);
        return {
          totalBytes: stats.blocks * stats.bsize,
          usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
          freeBytes: stats.bavail * stats.bsize,
        };
      } catch (error) {
        if (error?.code !== "ENOENT" || current === resolve(current, "..")) return undefined;
      }
    }
  }

  return {
    kind: "flat-folder",
    location,
    capabilities: { conditionalWrites: true, rangeReads: true, objectLock: false },
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    space,
    async close() {
      // Nothing is kept open between calls.
    },
  };
}

/**
 * `flatdir:///srv/backups` → the adapter for `/srv/backups`. The `owner` lets this
 * module be evaluated twice in one process (the CLI loads config files without a
 * module cache) without "already registered" errors.
 */
registerStorageScheme(
  SCHEME,
  ({ url }) => {
    let folder;
    try {
      folder = fileURLToPath(url.replace(/^flatdir:/i, "file:"));
    } catch (error) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid ${SCHEME} URL "${url}".`, {
        cause: error,
        hint: `Use ${SCHEME}:///absolute/folder.`,
      });
    }
    return flatFolderStorage({ folder });
  },
  { owner: "mongoshield-flat-folder" },
);

/** `a/b.json` → `a%2Fb.json`; dots are encoded too, so no file name starts with ".". */
function encodeKey(key) {
  return encodeURIComponent(key).replaceAll(".", "%2E");
}

function decodeKey(name) {
  return decodeURIComponent(name);
}

/** UTF-8 byte order, as S3 lists keys (plain `<` on JS strings compares UTF-16 units). */
function compareKeys(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** @returns {import("mongoshield").ObjectInfo} */
function infoOf(key, stats) {
  return { key, size: stats.size, lastModified: stats.mtime };
}

/**
 * Turns a file system error into the MongoShieldError the contract asks for.
 * Messages name the key, never anything secret (there is nothing secret here).
 */
function storageError(error, what, signal) {
  if (error instanceof MongoShieldError) return error;
  if (signal?.aborted || error?.name === "AbortError") {
    return new MongoShieldError("MS_ABORTED", `Aborted: ${what}.`, { cause: error });
  }
  switch (error?.code) {
    case "ENOENT":
      return new MongoShieldError("MS_STORAGE_NOT_FOUND", `Not found: ${what}.`, { cause: error });
    case "EEXIST":
      return new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", `Already exists: ${what}.`, {
        cause: error,
      });
    case "EACCES":
    case "EPERM":
      return new MongoShieldError("MS_STORAGE_FORBIDDEN", `Permission denied: ${what}.`, {
        cause: error,
      });
    case "ENOSPC":
      return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", `Disk full: ${what}.`, {
        cause: error,
      });
    default:
      return new MongoShieldError("MS_STORAGE_IO", `Could not ${what}.`, { cause: error });
  }
}
