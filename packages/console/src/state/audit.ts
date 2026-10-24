/**
 * The audit log: `<data>/audit.jsonl`, one JSON `AuditEntry` per line.
 *
 * - Append-only: entries are written with O_APPEND and never edited. The API
 *   has no endpoint that changes or deletes them.
 * - Rotation: when the file would grow past {@link MAX_AUDIT_BYTES} it is
 *   renamed to `audit.jsonl.1` (older files shift to `.2`, `.3`), keeping
 *   {@link KEPT_ROTATIONS} old files. Reading pages through the current file
 *   and then the rotated ones, newest first.
 * - No secrets: `details` only takes strings, numbers and booleans chosen by
 *   the route that writes the entry, and routes never put secrets there (the
 *   integration tests scan the whole log for them).
 */

import { open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AuditEntry } from "../shared/api.ts";

/** File name of the current audit log. */
export const AUDIT_FILE = "audit.jsonl";
/** Rotate before the file grows past this: 50 MiB. */
export const MAX_AUDIT_BYTES = 50 * 1024 * 1024;
/** Rotated files kept (`.1` … `.3`), so about 200 MiB of history in total. */
export const KEPT_ROTATIONS = 3;

/** Read backwards in chunks of this size, so paging never loads a whole file. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Options for {@link AuditLog}. */
export interface AuditLogOptions {
  readonly dataDir: string;
  /** Rotation threshold; tests make it small. */
  readonly maxBytes?: number;
}

/** Appends to and pages through the audit log. */
export class AuditLog {
  readonly #dataDir: string;
  readonly #maxBytes: number;
  /** Appends are serialized so rotation and size tracking stay consistent. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: AuditLogOptions) {
    this.#dataDir = options.dataDir;
    this.#maxBytes = options.maxBytes ?? MAX_AUDIT_BYTES;
  }

  /** Path of the current file (`rotation` 0) or a rotated one. */
  pathOf(rotation = 0): string {
    const base = join(this.#dataDir, AUDIT_FILE);
    return rotation === 0 ? base : `${base}.${rotation}`;
  }

  /** Appends one entry. Resolves once it is on disk. */
  append(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const run = async (): Promise<void> => {
      const size = await sizeOf(this.pathOf());
      if (size > 0 && size + Buffer.byteLength(line) > this.#maxBytes) await this.#rotate();
      // "a": O_APPEND, so even a concurrent writer could never overwrite earlier lines.
      const handle = await open(this.pathOf(), "a", 0o600);
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Entries newest first. `before` (exclusive, ISO date) pages backwards;
   * `limit` caps the page.
   */
  async read(options: { readonly limit: number; readonly before?: string }): Promise<AuditEntry[]> {
    await this.#queue;
    const beforeMs =
      options.before === undefined ? Number.POSITIVE_INFINITY : Date.parse(options.before);
    const entries: AuditEntry[] = [];
    for (let rotation = 0; rotation <= KEPT_ROTATIONS; rotation++) {
      for await (const line of readLinesBackwards(this.pathOf(rotation))) {
        const entry = parseEntry(line);
        if (entry === undefined || Date.parse(entry.at) >= beforeMs) continue;
        entries.push(entry);
        if (entries.length >= options.limit) return entries;
      }
    }
    return entries;
  }

  /** Shifts `.2` → `.3`, `.1` → `.2`, current → `.1`, dropping the oldest. */
  async #rotate(): Promise<void> {
    await rm(this.pathOf(KEPT_ROTATIONS), { force: true });
    for (let rotation = KEPT_ROTATIONS - 1; rotation >= 0; rotation--) {
      try {
        await rename(this.pathOf(rotation), this.pathOf(rotation + 1));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }
}

/** Parses one line; malformed lines (a torn write after a crash) are skipped. */
function parseEntry(line: string): AuditEntry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof Reflect.get(value, "at") === "string" &&
      typeof Reflect.get(value, "action") === "string"
    ) {
      // Written by append() from an AuditEntry; the shape check above guards against garbage.
      return value as AuditEntry;
    }
  } catch {
    // Skip.
  }
  return undefined;
}

/** Size of a file, 0 if it does not exist. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

/**
 * Yields the lines of a file from last to first, reading fixed-size chunks
 * from the end. Yields nothing if the file does not exist.
 */
async function* readLinesBackwards(path: string): AsyncGenerator<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  try {
    let position = (await handle.stat()).size;
    // Bytes of a line whose start lies in an earlier chunk. Kept as bytes so a
    // multi-byte character split across chunks is decoded correctly.
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      let buffer = Buffer.concat([chunk, carry]);
      let newline = buffer.lastIndexOf(0x0a);
      while (newline !== -1) {
        const line = buffer.subarray(newline + 1).toString("utf8");
        if (line.trim() !== "") yield line;
        buffer = buffer.subarray(0, newline);
        newline = buffer.lastIndexOf(0x0a);
      }
      carry = buffer;
    }
    const first = carry.toString("utf8");
    if (first.trim() !== "") yield first;
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}
