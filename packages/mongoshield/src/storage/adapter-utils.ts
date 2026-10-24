/**
 * Small helpers shared by the remote storage adapters (GCS, Azure Blob, SFTP).
 * Nothing here is public API; each adapter re-states its own guarantees in its
 * header comment, and these helpers only remove copy-paste between them.
 *
 *   const basePrefix = normalizePrefix(options.prefix, "GCS");  // "prod/mongo/"
 *   const key = storageKeyOf(basePrefix, "prod/mongo/a/b.bson"); // "a/b.bson"
 *   await forEachWithConcurrency(keys, 16, async (key) => remove(key));
 */

import { Readable } from "node:stream";
import { abortError, MongoShieldError } from "../errors.ts";
import { assertValidKey } from "./keys.ts";

/** An inclusive byte range, as in `GetOptions.range`. */
export interface ByteRange {
  readonly start: number;
  readonly end?: number;
}

/**
 * Normalizes a key prefix inside a bucket/container: `"/a/b"`, `"a/b"` and
 * `"a/b/"` all become `"a/b/"`; empty stays empty. `label` names the adapter in
 * the error message ("Invalid GCS prefix …").
 */
export function normalizePrefix(prefix: string | undefined, label: string): string {
  const trimmed = (prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return "";
  try {
    assertValidKey(trimmed);
  } catch (error) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Invalid ${label} prefix "${prefix}".`, {
      cause: error,
      hint: 'Use a relative path such as "prod/mongo", without ".." or empty segments.',
    });
  }
  return `${trimmed}/`;
}

/**
 * Converts a full object name from a listing back into a storage key, or
 * returns `undefined` for names we must not expose: those outside our prefix
 * and those that are not valid storage keys (for example zero-byte `folder/`
 * markers created by web consoles).
 */
export function storageKeyOf(basePrefix: string, fullName: string | undefined): string | undefined {
  if (fullName === undefined || !fullName.startsWith(basePrefix)) return undefined;
  const key = fullName.slice(basePrefix.length);
  try {
    assertValidKey(key);
    return key;
  } catch {
    return undefined;
  }
}

/**
 * Like {@link storageKeyOf} for a "directory" name from a delimiter listing
 * (`base/backups/2026-…/`). Returns the storage prefix with its trailing `/`.
 */
export function storagePrefixOf(
  basePrefix: string,
  fullPrefix: string | undefined,
): string | undefined {
  if (fullPrefix === undefined || !fullPrefix.endsWith("/")) return undefined;
  // A common prefix ends in "/", which is not a valid key; validate without it.
  const withoutSlash = storageKeyOf(basePrefix, fullPrefix.slice(0, -1));
  return withoutSlash === undefined ? undefined : `${withoutSlash}/`;
}

/** Ranges must be non-negative integers with `end >= start` (both inclusive). */
export function assertValidRange(range: ByteRange, key: string): void {
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

/** Passes stream chunks through unchanged while counting bytes, for the returned `size`. */
export function countBytes(source: Readable, counter: { bytes: number }): Readable {
  async function* counted() {
    for await (const piece of source) {
      const buffer = toBuffer(piece);
      counter.bytes += buffer.length;
      yield buffer;
    }
  }
  return Readable.from(counted());
}

/** Normalizes a stream chunk (Buffer, Uint8Array or string) to a Buffer. */
export function toBuffer(piece: unknown): Buffer {
  if (Buffer.isBuffer(piece)) return piece;
  if (piece instanceof Uint8Array) return Buffer.from(piece.buffer, piece.byteOffset, piece.length);
  return Buffer.from(String(piece));
}

/**
 * Destroys `stream` with a typed MS_ABORTED error when the signal fires.
 * Returns a function that detaches the listener early (it is also detached
 * automatically when the stream closes).
 */
export function destroyOnAbort(stream: Readable, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  const onAbort = () => stream.destroy(abortError(signal));
  const detach = () => signal.removeEventListener("abort", onAbort);
  signal.addEventListener("abort", onAbort, { once: true });
  stream.once("close", detach);
  return detach;
}

/** Splits `items` into consecutive batches of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * Runs `task` for every item with at most `concurrency` tasks in flight.
 * Stops starting new tasks after the first failure and rethrows it once the
 * tasks already running have settled, so no request is left dangling.
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  async function worker(): Promise<void> {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (failure !== undefined) throw failure.error;
}

/** Reads a property of an unknown value (usually an error) without trusting its shape. */
export function propertyOf(value: unknown, property: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[property];
}

/** `propertyOf` narrowed to strings. */
export function stringProperty(value: unknown, property: string): string | undefined {
  const found = propertyOf(value, property);
  return typeof found === "string" ? found : undefined;
}

/** `propertyOf` narrowed to numbers. */
export function numberProperty(value: unknown, property: string): number | undefined {
  const found = propertyOf(value, property);
  return typeof found === "number" ? found : undefined;
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True if an `import()` failed because a package is not installed. Loaders and
 * bundlers sometimes wrap the original error, so the `cause` chain is checked too.
 */
export function isModuleNotFound(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    const code = propertyOf(current, "code");
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
    if (/Cannot find (module|package)/.test(current instanceof Error ? current.message : "")) {
      return true;
    }
    current = propertyOf(current, "cause");
  }
  return false;
}

/**
 * Turns a failed lazy import of an optional peer dependency into a clear
 * configuration error with the install command as the hint. Other import
 * errors (a broken install, a syntax error) are rethrown unchanged.
 */
export function missingPackageError(error: unknown, what: string, installCommand: string): unknown {
  if (!isModuleNotFound(error)) return error;
  return new MongoShieldError("MS_CONFIG_INVALID", `${what} needs an optional package.`, {
    hint: installCommand,
    cause: error,
  });
}

/** Removes the surrounding double quotes HTTP ETags carry; other adapters return bare values. */
export function unquote(etag: string | undefined): string | undefined {
  return etag?.replace(/^"(.*)"$/, "$1");
}

/** Compares strings by their UTF-8 bytes, which is the order object stores list keys in. */
export function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
