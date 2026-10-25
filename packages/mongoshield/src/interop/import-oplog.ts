/**
 * Importing the oplog of a `mongodump --oplog` dump as a converge backup's changes
 * file, which makes the imported backup restore as of the end of the dump (see
 * oplog-events.ts for the conversion and why it is sound):
 *
 *   oplog entries → OplogConverter → change events → coalesce → compress → (encrypt) → _changes/window.bson…
 *
 * The directory importer feeds it `oplog.bson[.gz]` through the BSON splitter, the
 * archive importer the documents of the archive's oplog namespace.
 */

import { type Readable, Transform, type TransformCallback } from "node:stream";
import type { CapturedWindow } from "../engine/converge-capture.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { type ImportTarget, writeImportedChanges } from "./import-target.ts";
import { OplogConverter } from "./oplog-events.ts";

/** The reason given when the oplog is left out on request. */
export const IGNORED_OPLOG_REASON =
  "oplog from `mongodump --oplog`, left out (ignoreOplog): the backup reflects the collections as mongodump read them";

/**
 * Converts and stores an oplog.
 *
 * @param entries the raw oplog entries (after `before`), in oplog order
 * @returns the window for the manifest, or undefined for an oplog without entries
 *   (nothing is stored then)
 * @throws MS_FORMAT_UNSUPPORTED for an oplog that cannot be replayed (oplog-events.ts)
 */
export async function importOplog(
  target: ImportTarget,
  entries: Readable,
  before: readonly Transform[],
  options: {
    readonly filter: NamespaceFilter;
    readonly where: string;
    readonly signal: AbortSignal;
  },
): Promise<CapturedWindow | undefined> {
  const converter = new OplogConverter(options.filter, options.where);
  const convert = new Transform({
    objectMode: true,
    transform(entry: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        for (const event of converter.convert(entry)) this.push(event);
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  const file = await writeImportedChanges(target, entries, [...before, convert], options.signal);
  const window = converter.finish();
  if (window === undefined) {
    // No entries, so no window: leave no unreferenced file behind.
    const key = resolveBackupKey(target.backupId, file.key);
    await target.storage.delete([key], { signal: options.signal });
    target.writtenKeys.delete(key);
    return undefined;
  }
  target.logger.info("Converted the oplog of the dump", {
    events: window.events,
    from: window.from,
    to: window.to,
  });
  return { from: window.from, to: window.to, file, warnings: window.warnings };
}
