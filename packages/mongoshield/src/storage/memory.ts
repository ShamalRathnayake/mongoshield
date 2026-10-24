/**
 * In-memory storage adapter.
 *
 * Useful for tests, for the `mongoshield/testing` helpers, and for piping a
 * backup straight into a restore without touching disk. Everything is lost
 * when the process exits.
 *
 *   import { memoryStorage } from "mongoshield/storage/memory";
 *   const storage = memoryStorage();
 *
 * Object lock test mode: `memoryStorage({ objectLock: true })` accepts
 * `PutOptions.retainUntil` and enforces it the way GCS and Azure do: deleting or
 * overwriting an object before its retention ends fails with `MS_STORAGE_FORBIDDEN`.
 * That lets engine and prune tests exercise immutable backups without a cloud
 * account. Pass `now` to control the store's clock. Without `objectLock`, a retained put
 * fails with `MS_CONFIG_INVALID` before the body is read, like the file adapter.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import { assertValidRetainUntil, objectLockedError, rejectRetention } from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** One stored object. */
interface StoredObject {
  readonly data: Buffer;
  readonly lastModified: Date;
  readonly etag: string;
  /** Object lock mode only: the object cannot be deleted or overwritten before this. */
  readonly retainUntil?: Date;
}

export interface MemoryStorageOptions {
  /** Shown in `location` as `memory://<name>/`. Defaults to `"default"`. */
  readonly name?: string;
  /**
   * Test mode that emulates write-once retention: `capabilities.objectLock` becomes
   * `true`, `retainUntil` is stored per object, and deleting or overwriting a
   * retained object fails with `MS_STORAGE_FORBIDDEN`. Defaults to `false`.
   */
  readonly objectLock?: boolean;
  /**
   * The store's clock, used for `lastModified` and retention checks, so tests can
   * move time. Defaults to `new Date()`.
   */
  readonly now?: () => Date;
}

/** The adapter type, with a few test-only helpers on top of `StorageAdapter`. */
export interface MemoryStorage extends StorageAdapter {
  /** Every key currently stored, sorted. Handy in tests. */
  keys(): string[];
  /** Object lock mode: when `key`'s retention ends, or `undefined` if it has none (or is missing). */
  retainUntilOf(key: string): Date | undefined;
  /** Removes everything, ignoring retention (a test helper, not a storage operation). */
  clear(): void;
}

/** In memory, objects can be as large as we like, but guard against runaway tests. */
const MAX_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

/** Capabilities with and without the object lock test mode. */
function capabilitiesFor(objectLock: boolean): StorageCapabilities {
  return { conditionalWrites: true, rangeReads: true, objectLock };
}

/** Creates an empty in-memory store. */
export function memoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const objects = new Map<string, StoredObject>();
  const location = `memory://${options.name ?? "default"}/`;
  const objectLock = options.objectLock ?? false;
  const now = options.now ?? (() => new Date());

  /** True while `object` is under retention: it may be read but not replaced or removed. */
  function isLocked(object: StoredObject | undefined): boolean {
    return object?.retainUntil !== undefined && object.retainUntil.getTime() > now().getTime();
  }

  /** The error the real providers give for touching a locked object, in our terms. */
  function lockedError(key: string, verb: string): MongoShieldError {
    const until = objects.get(key)?.retainUntil?.toISOString() ?? "?";
    return objectLockedError(`Cannot ${verb} ${location}${key}: it is immutable until ${until}.`);
  }

  /** Info for a stored object, in the shape every adapter returns. */
  function infoFor(key: string, object: StoredObject): ObjectInfo {
    return { key, size: object.data.length, lastModified: object.lastModified, etag: object.etag };
  }

  /**
   * All keys starting with `prefix`, sorted by their UTF-8 bytes. That is the order
   * S3 and other object stores use; JavaScript's default sort compares UTF-16 code
   * units, which differs for some non-ASCII characters.
   */
  function sortedKeysWithPrefix(prefix: string): string[] {
    return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(compareUtf8);
  }

  return {
    kind: "memory",
    location,
    capabilities: capabilitiesFor(objectLock),

    async put(key: string, body: Readable | Uint8Array, putOptions: PutOptions = {}) {
      assertValidKey(key);
      throwIfAborted(putOptions.signal);
      // Retention problems are configuration errors: report them before reading the body.
      const { retainUntil } = putOptions;
      if (!objectLock) rejectRetention(putOptions, body, "memory", location);
      if (retainUntil !== undefined)
        assertValidRetainUntil(retainUntil, `${location}${key}`, now());

      // Read the full body first, so a failed or aborted stream never leaves a
      // half-written object behind (writes must be atomic).
      const data =
        body instanceof Uint8Array
          ? Buffer.from(body)
          : await readBodyUnlessAborted(body, putOptions.signal);
      throwIfAborted(putOptions.signal);

      if (putOptions.ifNoneMatch === "*" && objects.has(key)) {
        throw new MongoShieldError(
          "MS_STORAGE_PRECONDITION_FAILED",
          `${location}${key} already exists.`,
        );
      }
      // Like GCS and Azure, a locked object cannot be replaced. (S3 would add a new
      // version instead; that difference does not matter to MongoShield, which never
      // overwrites backup files.)
      if (isLocked(objects.get(key))) throw lockedError(key, "overwrite");

      const object: StoredObject = {
        data,
        lastModified: now(),
        etag: createHash("md5").update(data).digest("hex"),
        ...(retainUntil === undefined ? {} : { retainUntil: new Date(retainUntil.getTime()) }),
      };
      objects.set(key, object);
      return infoFor(key, object);
    },

    async get(key: string, getOptions: GetOptions = {}) {
      assertValidKey(key);
      throwIfAborted(getOptions.signal);
      const object = objects.get(key);
      if (!object) {
        throw new MongoShieldError("MS_STORAGE_NOT_FOUND", `${location}${key} does not exist.`);
      }

      // Ranges are inclusive on both ends, like HTTP Range headers.
      const start = getOptions.range?.start ?? 0;
      const end = getOptions.range?.end ?? object.data.length - 1;
      return Readable.from([object.data.subarray(start, end + 1)]);
    },

    async head(key: string, headOptions: SignalOptions = {}) {
      assertValidKey(key);
      throwIfAborted(headOptions.signal);
      const object = objects.get(key);
      return object ? infoFor(key, object) : undefined;
    },

    async *list(prefix: string, listOptions: SignalOptions = {}) {
      assertValidPrefix(prefix);
      // Check up front too: with no matching keys the loop below never runs.
      throwIfAborted(listOptions.signal);
      for (const key of sortedKeysWithPrefix(prefix)) {
        throwIfAborted(listOptions.signal);
        const object = objects.get(key);
        if (object) yield infoFor(key, object);
      }
    },

    async *listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
      assertValidPrefix(prefix);
      throwIfAborted(listOptions.signal);
      // A "sub-directory" is the part of a key up to and including the next "/".
      const seen = new Set<string>();
      for (const key of sortedKeysWithPrefix(prefix)) {
        throwIfAborted(listOptions.signal);
        const slash = key.indexOf("/", prefix.length);
        if (slash === -1) continue; // a plain object directly under the prefix
        const subPrefix = key.slice(0, slash + 1);
        if (!seen.has(subPrefix)) {
          seen.add(subPrefix);
          yield subPrefix;
        }
      }
    },

    async delete(keys: readonly string[], deleteOptions: SignalOptions = {}) {
      throwIfAborted(deleteOptions.signal);
      // Validate every key before deleting anything, so one bad key cannot leave
      // a delete half done.
      for (const key of keys) assertValidKey(key);
      // Same for retention: refuse the whole call if any key is locked, so a
      // refused delete never leaves a backup half removed.
      for (const key of keys) {
        if (isLocked(objects.get(key))) throw lockedError(key, "delete");
      }
      for (const key of keys) objects.delete(key);
    },

    async close() {
      // Nothing to release.
    },

    keys() {
      return [...objects.keys()].sort(compareUtf8);
    },

    retainUntilOf(key: string) {
      const until = objects.get(key)?.retainUntil;
      return until === undefined ? undefined : new Date(until.getTime());
    },

    clear() {
      objects.clear();
    },
  };
}

/** Orders strings by their UTF-8 bytes, the way object stores order keys. */
function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/**
 * Reads a body stream, but stops immediately when the signal aborts. Without
 * this, a stalled stream would only notice the abort after it ended (if ever).
 */
async function readBodyUnlessAborted(body: Readable, signal: AbortSignal | undefined) {
  if (!signal) return readStreamToBuffer(body, { maxBytes: MAX_OBJECT_BYTES });

  // Destroying the stream with the abort error makes the pending read reject.
  const onAbort = (): void => {
    body.destroy(abortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await readStreamToBuffer(body, { maxBytes: MAX_OBJECT_BYTES });
  } catch (error) {
    // Report the abort itself rather than whatever the destroyed stream threw.
    throwIfAborted(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
