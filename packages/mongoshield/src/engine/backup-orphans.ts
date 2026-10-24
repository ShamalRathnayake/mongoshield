/**
 * Deleting the objects a backup run wrote but its manifest does not reference, right
 * before the manifest is committed.
 *
 * How orphans arise: a split collection dropped while it is backed up in mode `none`
 * is left out of the manifest (backup-dump.ts deletes its files), but a part of it may
 * still be uploading at that moment and land after the deletion. Readers ignore such
 * objects, but they cost storage and confuse anyone listing the directory.
 *
 * What it looks at: only `backups/<id>/`, the run's own directory, and only once every
 * part and file has settled (the dumps, the change capture and the key file are
 * done). Annotations (`annotations/<id>/`) and checkpoints (`_state/`) live outside it
 * and are never touched. The manifest itself is not written yet, so it cannot be
 * deleted by mistake; it is also named in the kept set for safety.
 */

import { backupDir, manifestKey, resolveBackupKey } from "../format/layout.ts";
import type { Manifest } from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";

/** Every full key a manifest references, plus the manifest's own key. */
export function referencedKeys(manifest: Manifest): Set<string> {
  const relative: string[] = [];
  for (const entry of manifest.namespaces) {
    relative.push(entry.metadata.key);
    for (const file of entry.files) relative.push(file.key);
  }
  if (manifest.changes !== undefined) relative.push(manifest.changes.key);
  const keyFile = manifest.encryption?.keyFile;
  if (keyFile !== undefined) relative.push(keyFile.key);
  const keys = new Set(relative.map((key) => resolveBackupKey(manifest.id, key)));
  keys.add(manifestKey(manifest.id));
  return keys;
}

/**
 * Deletes every object under the backup's directory that `manifest` does not
 * reference (see the file header). Best effort: a failure to list or delete is
 * logged and the backup goes on, since orphans never affect restores.
 *
 * @returns the keys deleted.
 */
export async function deleteOrphans(
  storage: StorageAdapter,
  manifest: Manifest,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const keep = referencedKeys(manifest);
  const orphans: string[] = [];
  try {
    for await (const object of storage.list(backupDir(manifest.id), signal ? { signal } : {})) {
      if (!keep.has(object.key)) orphans.push(object.key);
    }
    if (orphans.length === 0) return [];
    for (const key of orphans) {
      logger.debug("Deleting an object the manifest does not reference", { key });
    }
    await storage.delete(orphans, signal ? { signal } : {});
    return orphans;
  } catch (error) {
    logger.debug("Could not delete objects the manifest does not reference", {
      id: manifest.id,
      error: String(error),
    });
    return [];
  }
}
