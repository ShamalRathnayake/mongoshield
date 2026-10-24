/**
 * Helpers shared by the recovery extras that move or rewrite whole stored files
 * (`replicate.ts`, `rekey.ts`): which backups to work on, which files a backup
 * consists of, and a streaming check that the bytes read are the bytes the
 * manifest (or a rekey record) promises.
 */

import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { type CatalogEntry, listBackups } from "../catalog/catalog.ts";
import { selectBackup } from "../catalog/select.ts";
import { MongoShieldError } from "../errors.ts";
import type { Manifest, StoredFile } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** Which backups an operation covers: every complete one, the newest, or these ids. */
export type BackupSelection = "all" | "latest" | readonly string[];

/** A complete backup as the catalog reports it (manifest with rekey records applied). */
export interface SelectedBackup {
  readonly id: string;
  readonly manifest: Manifest;
}

/**
 * Resolves a selection against the catalog of `storage`, oldest first (so copies and
 * rewrites proceed in the order the backups were made).
 *
 * @throws MS_BACKUP_NOT_FOUND when a named backup does not exist or is incomplete,
 *   or when `"latest"` finds no complete backup.
 */
export async function selectBackups(
  storage: StorageAdapter,
  selection: BackupSelection,
  options: { readonly signal?: AbortSignal | undefined; readonly logger?: Logger | undefined },
): Promise<SelectedBackup[]> {
  const entries = await listBackups(storage, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const chosen: CatalogEntry[] =
    selection === "all"
      ? entries.filter((entry) => entry.status === "complete")
      : (selection === "latest" ? ["latest"] : selection).map((selector) =>
          selectBackup(entries, selector),
        );

  const selected: SelectedBackup[] = [];
  const seen = new Set<string>();
  for (const entry of chosen) {
    if (entry.manifest === undefined || seen.has(entry.id)) continue;
    seen.add(entry.id);
    selected.push({ id: entry.id, manifest: entry.manifest });
  }
  return selected.sort(
    (a, b) => Date.parse(a.manifest.startedAt) - Date.parse(b.manifest.startedAt),
  );
}

/**
 * Every encrypted-or-not data, metadata and changes file of a backup, in manifest
 * order. The key envelope is not included (it is listed separately as `keyFile`).
 */
export function contentFilesOf(manifest: Manifest): StoredFile[] {
  const files: StoredFile[] = [];
  for (const entry of manifest.namespaces) files.push(entry.metadata, ...entry.files);
  if (manifest.changes !== undefined) files.push(manifest.changes);
  return files;
}

/** Every file the manifest lists, key envelope first. */
export function allFilesOf(manifest: Manifest): StoredFile[] {
  const keyFile = manifest.encryption?.keyFile;
  return keyFile === undefined ? contentFilesOf(manifest) : [keyFile, ...contentFilesOf(manifest)];
}

/**
 * A pass-through stream that fails with `MS_INTEGRITY_FAILED` unless exactly `size`
 * bytes with SHA-256 `sha256` pass through. It fails as soon as there are too many
 * bytes, otherwise at the end, which makes the storage `put` it feeds fail too, so a
 * damaged source is never copied or rewritten as if it were intact.
 */
export function createExpectedDigestCheck(
  file: Pick<StoredFile, "key" | "size" | "sha256">,
  where: string,
): Transform {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      size += chunk.length;
      if (size > file.size) {
        callback(digestError(file, where, `it is longer than the recorded ${file.size} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      if (size !== file.size) {
        callback(digestError(file, where, `it has ${size} bytes, not the recorded ${file.size}`));
      } else if (hash.digest("hex") !== file.sha256) {
        callback(digestError(file, where, "its SHA-256 does not match the recorded one"));
      } else {
        callback();
      }
    },
  });
}

function digestError(
  file: Pick<StoredFile, "key">,
  where: string,
  problem: string,
): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `${file.key} in ${where} failed its integrity check: ${problem}.`,
    {
      hint: "The stored file is damaged or was changed. Run `mongoshield verify` on it first.",
      details: { key: file.key },
    },
  );
}
