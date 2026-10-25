/**
 * Local filesystem storage adapter (entry point `mongoshield/storage/file`).
 *
 * Stores every object as a regular file under one root directory. Keys map
 * one-to-one onto relative paths, so `backups/<id>/manifest.json` becomes
 * `<root>/backups/<id>/manifest.json`. Works for local disks and for network
 * mounts (NFS, SMB) as long as they support `rename`. Hard links are used for
 * conditional writes where the filesystem has them; FAT/exFAT and some SMB or
 * FUSE mounts do not, and get a lock-directory fallback (see below).
 *
 *   import { fileStorage } from "mongoshield/storage/file";
 *   const storage = fileStorage({ path: "./backups" });
 *   await storage.put("hello.txt", Buffer.from("hi"));
 *
 * Guarantees, matching the `StorageAdapter` contract:
 * - Writes are atomic. Data is streamed into a hidden temp file next to the
 *   target, flushed with fsync and then renamed into place, so readers see
 *   either the old object, the new object, or nothing; never a partial file.
 * - `list()` returns keys in lexicographic (UTF-8 byte) order, exactly like
 *   S3, not in directory-walk order.
 * - Empty directories are not objects: `delete()` prunes them, and
 *   `listPrefixes()` ignores directories that contain no objects.
 * - Conditional writes (`ifNoneMatch: "*"`) publish with link(2), which is an
 *   atomic create-if-absent. On filesystems without hard links (link fails with
 *   EPERM, ENOTSUP, EOPNOTSUPP, EXDEV or ENOSYS) the adapter instead takes a lock
 *   directory next to the target (`.<name>.mongoshield-lock`, created with an
 *   atomic mkdir), checks that the target does not exist, renames the temp file
 *   into place and removes the lock. With the fallback, conditional writers
 *   (in any process using this adapter) still exclude each other, so exactly one
 *   of several racing creates wins; but a concurrent *unconditional* put of the
 *   same key may be overwritten, and a lock left by a crashed process is only
 *   broken after a minute (until then, conditional writes of that key wait).
 *
 * Known limitation: a key cannot be both an object and a "directory" (for
 * example `a` and `a/b`), which S3 allows. MongoShield's layout never does this.
 */

import { randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import { rejectRetention } from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** Options for {@link fileStorage}. */
export interface FileStorageOptions {
  /**
   * Root directory for all objects. Relative paths are resolved against the
   * current working directory. Created on the first write if it does not exist.
   */
  readonly path: string;
}

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  objectLock: false,
};

/**
 * Temp files look like `.<final name>.<16 hex chars>.tmp`. The leading dot hides
 * them from casual `ls`, and the exact shape lets `list()` skip them reliably.
 */
const TEMP_FILE_PATTERN = /^\..+\.[0-9a-f]{16}\.tmp$/;

/** Temp files older than this are leftovers from a crashed process; `list()` removes them lazily. */
const STALE_TEMP_FILE_MS = 24 * 60 * 60 * 1000;

/**
 * Lock directories of the no-hard-link fallback look like `.<final name>.mongoshield-lock`.
 * The name is derived from the target alone, so every writer of one key contends
 * for the same lock. Reserved: no key segment may have this shape.
 */
const LOCK_DIRECTORY_PATTERN = /^\..+\.mongoshield-lock$/;

/**
 * A lock directory older than this is assumed to be left by a crashed writer and
 * is removed. The lock is only held for one stat and one rename, so a live
 * holder never comes close; the margin covers slow network mounts and clock
 * skew between the client and a file server (which sets the mtime).
 */
const STALE_LOCK_MS = 60 * 1000;

/** How long a conditional writer waits between attempts to take a busy lock. */
const LOCK_RETRY_MS = 25;

/**
 * Errno codes from link(2) that mean "this filesystem cannot make hard links":
 * EPERM (Linux on FAT/exFAT and many FUSE mounts), ENOTSUP/EOPNOTSUPP (SMB and
 * other network filesystems), EXDEV (overlay and union mounts) and ENOSYS
 * (filesystems that do not implement the call at all).
 */
const LINK_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

/**
 * How often `put()` retries creating its temp file when the target directory
 * vanishes underneath it (a concurrent `delete()` may prune an empty directory
 * between our `mkdir` and `open`).
 */
const MAX_TEMP_OPEN_ATTEMPTS = 5;

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

/** Creates a storage adapter that keeps objects as files under `options.path`. */
export function fileStorage(options: FileStorageOptions): StorageAdapter {
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "fileStorage() needs a non-empty `path`.");
  }
  const root = resolve(options.path);
  const location = locationFor(root);

  /**
   * Maps a key to its absolute path. `assertValidKey` already rejects `..`,
   * absolute keys and backslashes; the containment check is a second,
   * independent guard so that no future change to the key rules can ever let
   * a key escape the root directory.
   */
  function pathForKey(key: string): string {
    assertValidKey(key);
    const fullPath = join(root, ...key.split("/"));
    assertInsideRoot(fullPath, key);
    if (TEMP_FILE_PATTERN.test(baseName(key))) {
      // Such a key could be written but never listed, so refuse it up front.
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `Invalid storage key "${key}": names shaped like temp files (.name.<hex>.tmp) are reserved.`,
      );
    }
    if (key.split("/").some((segment) => LOCK_DIRECTORY_PATTERN.test(segment))) {
      // A lock directory is never listed, and an object inside one would block the lock.
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `Invalid storage key "${key}": names shaped like lock directories (.name.mongoshield-lock) are reserved.`,
      );
    }
    return fullPath;
  }

  /** The directory a listing prefix points into: `a/b/c` → `<root>/a/b`, `a/b/` → `<root>/a/b`. */
  function directoryForPrefix(prefix: string): string {
    assertValidPrefix(prefix);
    const segments = directoryKeyOf(prefix)
      .split("/")
      .filter((segment) => segment.length > 0);
    const fullPath = join(root, ...segments);
    assertInsideRoot(fullPath, prefix);
    return fullPath;
  }

  function assertInsideRoot(fullPath: string, key: string): void {
    const fromRoot = relative(root, fullPath);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `Invalid storage key "${key}": it resolves outside ${location}.`,
      );
    }
  }

  /** Wraps any failure in a `MongoShieldError` that names the key and what we were doing. */
  function fail(
    error: unknown,
    operation: Operation,
    key: string,
    signal?: AbortSignal,
  ): MongoShieldError {
    return storageError(error, operation, `${location}${key}`, root, signal);
  }

  /**
   * Removes `directory` and then each parent while they are empty, stopping at
   * the root (which is never removed). Best effort: a directory that is not
   * empty, or any other error, simply ends the walk.
   */
  async function pruneEmptyDirectories(directory: string): Promise<void> {
    let current = directory;
    while (current !== root && current.startsWith(root + sep)) {
      try {
        await rmdir(current);
      } catch (error) {
        // ENOENT: someone else removed it already; keep going up.
        if (errnoCode(error) !== "ENOENT") return;
      }
      current = dirname(current);
    }
  }

  /**
   * Opens a fresh temp file next to `finalPath`, creating parent directories as
   * needed. Retries when a concurrent `delete()` prunes the directory between
   * `mkdir` and `open` (see {@link MAX_TEMP_OPEN_ATTEMPTS}).
   */
  async function openTempFile(finalPath: string): Promise<{ path: string; handle: FileHandle }> {
    const directory = dirname(finalPath);
    for (let attempt = 1; ; attempt++) {
      await mkdir(directory, { recursive: true });
      const path = join(directory, tempNameFor(finalPath));
      try {
        // "wx" = create exclusively, so two writers can never share a temp file.
        return { path, handle: await open(path, "wx") };
      } catch (error) {
        if (errnoCode(error) !== "ENOENT" || attempt >= MAX_TEMP_OPEN_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Set once link(2) has failed with one of {@link LINK_UNSUPPORTED_CODES}, so later
   * conditional writes go straight to the lock-directory fallback. All objects
   * live under one root, which sits on one filesystem.
   */
  let hardLinksUnsupported = false;

  /**
   * Moves a finished temp file into place.
   *
   * Plain writes use `rename`, which atomically replaces any existing object.
   * Conditional writes (`ifNoneMatch: "*"`) cannot use `rename`, because it
   * always overwrites. Instead we hard-link the temp file to the final name:
   * `link` fails with EEXIST if the name is taken, and that check-and-create is
   * one atomic filesystem operation, so two racing writers can never both win.
   * The linked file is already complete and fsynced, so readers never see
   * partial content (unlike `open(final, "wx")` followed by writes). The temp
   * name is unlinked afterwards by the caller. Filesystems without hard links
   * use {@link publishUnderLock} instead.
   */
  async function publishTempFile(
    tempPath: string,
    finalPath: string,
    key: string,
    ifNoneMatch: boolean,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (!ifNoneMatch) {
      await rename(tempPath, finalPath);
      return;
    }
    if (hardLinksUnsupported) {
      await publishUnderLock(tempPath, finalPath, key, signal);
      return;
    }
    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") throw alreadyExists(key, error);
      if (!LINK_UNSUPPORTED_CODES.has(errnoCode(error) ?? "")) throw error;
      hardLinksUnsupported = true;
      await publishUnderLock(tempPath, finalPath, key, signal);
    }
  }

  /**
   * The conditional publish for filesystems without hard links: while holding
   * the target's lock directory, check that the target is absent and rename the
   * temp file onto it. Every conditional writer of this key takes the same lock,
   * so the check and the rename cannot interleave with another one's. The lock
   * is removed on every path, including failures.
   */
  async function publishUnderLock(
    tempPath: string,
    finalPath: string,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const lockPath = lockPathFor(finalPath);
    await acquireLock(lockPath, finalPath, key, signal);
    try {
      if (await pathExists(finalPath)) throw alreadyExists(key);
      await rename(tempPath, finalPath);
    } finally {
      await rmdir(lockPath).catch(() => {});
    }
  }

  /**
   * Takes the lock directory with an exclusive mkdir (atomic on every
   * filesystem, including FAT and SMB). While another writer holds it, waits;
   * but if the target appears meanwhile, the answer is already known and the
   * write fails at once. A lock older than {@link STALE_LOCK_MS} is broken.
   */
  async function acquireLock(
    lockPath: string,
    finalPath: string,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      try {
        await mkdir(lockPath);
        return;
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      if (await pathExists(finalPath)) throw alreadyExists(key);
      if (await removeIfStaleLock(lockPath)) continue;
      await sleep(LOCK_RETRY_MS, undefined, signal ? { signal } : {});
    }
  }

  function alreadyExists(key: string, cause?: unknown): MongoShieldError {
    return new MongoShieldError(
      "MS_STORAGE_PRECONDITION_FAILED",
      `${location}${key} already exists.`,
      cause === undefined ? {} : { cause },
    );
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    const finalPath = pathForKey(key);
    const { signal } = putOptions;
    throwIfAborted(signal);
    // A filesystem cannot enforce write-once retention (root can always delete),
    // so a retained put is refused before the body is read. See ./retention.ts.
    rejectRetention(putOptions, body, "file", location);

    let tempPath: string | undefined;
    let succeeded = false;
    try {
      const temp = await openTempFile(finalPath);
      tempPath = temp.path;
      const stats = await writeAndSync(temp.handle, body, signal);
      throwIfAborted(signal);
      await publishTempFile(temp.path, finalPath, key, putOptions.ifNoneMatch === "*", signal);
      await syncDirectory(dirname(finalPath));
      succeeded = true;
      // rename/link keep the inode, so the temp file's size and mtime are the object's.
      return { key, size: stats.size, lastModified: stats.mtime };
    } catch (error) {
      // Make sure an upstream pipeline does not wait forever on a stream we gave up on.
      if (body instanceof Readable) body.destroy();
      throw fail(error, "write", key, signal);
    } finally {
      // After a rename the temp name is gone and this is a no-op; after a link
      // (or a failure) it removes the leftover temp name.
      if (tempPath !== undefined) await rm(tempPath, { force: true }).catch(() => {});
      // A failed write must not leave the directories it created behind.
      if (!succeeded) await pruneEmptyDirectories(dirname(finalPath));
    }
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    const path = pathForKey(key);
    const { signal, range } = getOptions;
    throwIfAborted(signal);
    if (range) assertValidRange(range, key);

    // Open eagerly so a missing object is reported here as MS_STORAGE_NOT_FOUND
    // rather than later as an error event on the stream.
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      throw fail(error, "read", key, signal);
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw notAFileError();
    } catch (error) {
      await handle.close();
      throw fail(error, "read", key, signal);
    }

    // createReadStream's `end` is inclusive, just like our range contract.
    // The stream closes the handle when it ends or is destroyed (autoClose).
    const stream = handle.createReadStream({
      start: range?.start ?? 0,
      ...(range?.end === undefined ? {} : { end: range.end }),
    });
    destroyOnAbort(stream, signal);
    return stream;
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    const path = pathForKey(key);
    throwIfAborted(headOptions.signal);
    try {
      const stats = await stat(path);
      return stats.isFile() ? objectInfo(key, stats) : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw fail(error, "stat", key, headOptions.signal);
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    const directory = directoryForPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const directoryKey = directoryKeyOf(prefix);
    yield* walk(directory, directoryKey, prefix.slice(directoryKey.length), signal);
  }

  /**
   * Yields every object under `directory` in key order. Only entries whose name
   * starts with `namePrefix` are considered at this level; that is how a prefix
   * ending in a partial name (`backups/2026-0`) is handled. Deeper levels use
   * an empty name prefix.
   */
  async function* walk(
    directory: string,
    directoryKey: string,
    namePrefix: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ObjectInfo> {
    const entries = await readDirectorySorted(directory, directoryKey, signal);
    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.name.startsWith(namePrefix)) continue;
      const entryPath = join(directory, entry.name);
      const key = directoryKey + entry.name;
      // A conditional writer's lock (see publishUnderLock): never an object, never walked.
      if (entry.isDirectory() && LOCK_DIRECTORY_PATTERN.test(entry.name)) continue;
      if (entry.isDirectory()) {
        yield* walk(entryPath, `${key}/`, "", signal);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks, sockets, …: not objects, never followed
      if (TEMP_FILE_PATTERN.test(entry.name)) {
        await removeIfStale(entryPath);
        continue;
      }
      const stats = await statIfExists(entryPath, key, signal);
      if (stats?.isFile()) yield objectInfo(key, stats);
    }
  }

  /**
   * Reads a directory and sorts its entries so that a depth-first walk yields
   * keys in byte order. Directories sort as `name/`, because every key below
   * them starts with `name/`: e.g. `a-c` (0x2d) comes before `a/b` (0x2f), even
   * though the directory `a` sorts before the file `a-c` by name alone.
   * A missing directory is simply empty.
   */
  async function readDirectorySorted(
    directory: string,
    directoryKey: string,
    signal: AbortSignal | undefined,
  ): Promise<Dirent[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw fail(error, "list", directoryKey, signal);
    }
    const sortName = (entry: Dirent) => (entry.isDirectory() ? `${entry.name}/` : entry.name);
    return entries.sort((left, right) => compareBytes(sortName(left), sortName(right)));
  }

  async function statIfExists(
    path: string,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<Stats | undefined> {
    try {
      return await stat(path);
    } catch (error) {
      // Deleted between readdir and stat: it is no longer an object.
      if (isMissing(error)) return undefined;
      throw fail(error, "stat", key, signal);
    }
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    const directory = directoryForPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const directoryKey = directoryKeyOf(prefix);
    const namePrefix = prefix.slice(directoryKey.length);

    const entries = await readDirectorySorted(directory, directoryKey, signal);
    for (const entry of entries) {
      throwIfAborted(signal);
      if (!entry.isDirectory() || !entry.name.startsWith(namePrefix)) continue;
      if (LOCK_DIRECTORY_PATTERN.test(entry.name)) continue;
      // Like S3, a "sub-directory" only exists while some object lives below it.
      if (await containsObject(join(directory, entry.name))) yield `${directoryKey}${entry.name}/`;
    }
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    const targets = keys.map((key) => ({ key, path: pathForKey(key) }));
    for (const { key, path } of targets) {
      throwIfAborted(signal);
      try {
        await deleteFile(path);
      } catch (error) {
        throw fail(error, "delete", key, signal);
      }
      await pruneEmptyDirectories(dirname(path));
    }
  }

  return {
    kind: "file",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    async close() {
      // Every call opens and closes its own handles; nothing to release.
    },
  };
}

/**
 * Returns the free space, in bytes, available to this process at `path`
 * (or at its nearest existing parent). Used for pre-flight checks before a
 * backup, so that we fail early instead of halfway through with ENOSPC.
 */
export async function availableBytes(path: string): Promise<number> {
  let current = resolve(path);
  for (;;) {
    try {
      const stats = await statfs(current);
      // bavail (not bfree) excludes blocks reserved for the superuser.
      return stats.bavail * stats.bsize;
    } catch (error) {
      const parent = dirname(current);
      if (errnoCode(error) !== "ENOENT" || parent === current) {
        throw storageError(error, "stat", current, current);
      }
      current = parent;
    }
  }
}

/** `file:///abs/path/`, always with a trailing slash so `location + key` reads naturally. */
function locationFor(root: string): string {
  const url = pathToFileURL(root).href;
  return url.endsWith("/") ? url : `${url}/`;
}

/** The "directory" part of a key or prefix, including the trailing slash: `a/b/c` → `a/b/`. */
function directoryKeyOf(prefix: string): string {
  return prefix.slice(0, prefix.lastIndexOf("/") + 1);
}

/** The last segment of a key. */
function baseName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** `.<name>.<random>.tmp`, unique per write so concurrent writers never collide. */
function tempNameFor(finalPath: string): string {
  const name = finalPath.slice(finalPath.lastIndexOf(sep) + 1);
  return `.${name}.${randomBytes(8).toString("hex")}.tmp`;
}

/** `.<name>.mongoshield-lock`, next to the target; the same for every writer of that key. */
function lockPathFor(finalPath: string): string {
  const name = finalPath.slice(finalPath.lastIndexOf(sep) + 1);
  return join(dirname(finalPath), `.${name}.mongoshield-lock`);
}

/** True if something (file or directory) exists at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/**
 * Removes a lock directory left by a crashed writer. Returns true if the lock was
 * stale (or is already gone), so the caller should try to take it right away.
 * Two waiters may both find the same lock stale; only one rmdir removes it, and
 * mkdir then still lets only one of them in.
 */
async function removeIfStaleLock(lockPath: string): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (Date.now() - stats.mtimeMs <= STALE_LOCK_MS) return false;
  await rmdir(lockPath).catch(() => {});
  return true;
}

/**
 * Writes the whole body to the open temp file, fsyncs it and closes it.
 * `FileHandle.writeFile` accepts streams and handles backpressure and partial
 * writes for us. The fsync makes sure the data is on disk before the rename
 * makes it visible; otherwise a crash could leave a complete-looking but
 * truncated object.
 */
async function writeAndSync(
  handle: FileHandle,
  body: Readable | Uint8Array,
  signal: AbortSignal | undefined,
): Promise<Stats> {
  try {
    // writeFile only checks the signal between chunks; destroying the body
    // also interrupts a source that is stalled waiting for data.
    if (body instanceof Readable) destroyOnAbort(body, signal);
    await handle.writeFile(body, signal ? { signal } : {});
    await handle.sync();
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

/**
 * Fsyncs a directory so that a rename into it survives a crash. Not supported
 * on every platform (Windows cannot open directories), so failures are ignored.
 */
async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability of the directory entry is best effort.
  }
}

/** True if the directory (recursively) holds at least one object. Stops at the first one. */
async function containsObject(directory: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && !TEMP_FILE_PATTERN.test(entry.name)) return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (await containsObject(join(directory, entry.name)))) return true;
  }
  return false;
}

/** Cleans up a temp file left by a crashed writer. Best effort; never fails a listing. */
async function removeIfStale(tempPath: string): Promise<void> {
  try {
    const stats = await lstat(tempPath);
    if (Date.now() - stats.mtimeMs > STALE_TEMP_FILE_MS) await rm(tempPath, { force: true });
  } catch {
    // Already gone, or a read-only filesystem: either way nothing to do.
  }
}

/** Unlinks a file. Missing files and directories (which are not objects) are ignored. */
async function deleteFile(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isDirectory()) return;
    await rm(path, { force: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Destroys `stream` with a typed MS_ABORTED error when the signal fires. */
function destroyOnAbort(stream: Readable, signal: AbortSignal | undefined): void {
  if (!signal) return;
  const onAbort = () => stream.destroy(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  stream.once("close", () => signal.removeEventListener("abort", onAbort));
}

/** Ranges must be non-negative integers with `end >= start` (both inclusive). */
function assertValidRange(range: { readonly start: number; readonly end?: number }, key: string) {
  const { start, end } = range;
  const validStart = Number.isSafeInteger(start) && start >= 0;
  const validEnd = end === undefined || (Number.isSafeInteger(end) && end >= start);
  if (!validStart || !validEnd) {
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      `Invalid byte range ${start}-${end ?? ""} for "${key}".`,
    );
  }
}

function objectInfo(key: string, stats: Stats): ObjectInfo {
  return { key, size: stats.size, lastModified: stats.mtime };
}

/** Compares strings by their UTF-8 bytes, which is the order S3 uses for keys. */
function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** The `code` of a Node.js system error (`ENOENT`, `EACCES`, …), if there is one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** ENOENT and ENOTDIR both mean "there is no object at this path". */
function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A directory sitting where an object was expected is reported like a missing object. */
function notAFileError(): Error {
  return Object.assign(new Error("not a regular file"), { code: "ENOENT" });
}

/**
 * Maps a filesystem error to a `MongoShieldError`:
 * ENOENT/ENOTDIR → NOT_FOUND, EACCES/EPERM/EROFS → FORBIDDEN,
 * ENOSPC/EDQUOT → INSUFFICIENT_SPACE, anything else → IO.
 * Errors that are already typed (aborts, precondition failures, invalid keys,
 * typed errors thrown by the body stream) pass through unchanged.
 */
function storageError(
  error: unknown,
  operation: Operation,
  target: string,
  root: string,
  signal?: AbortSignal,
): MongoShieldError {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;

  const reason = error instanceof Error ? error.message : String(error);
  const message = `Could not ${operation} ${target}: ${reason}`;
  switch (errnoCode(error)) {
    case "ENOENT":
    case "ENOTDIR":
      return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, { cause: error });
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
        cause: error,
        hint: `Check that this process may read and write ${root} and that the filesystem is not read-only.`,
      });
    case "ENOSPC":
    case "EDQUOT":
      return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", message, {
        cause: error,
        hint: `Free up space on the disk holding ${root}, or back up to another location.`,
      });
    default:
      return new MongoShieldError("MS_STORAGE_IO", message, { cause: error });
  }
}
