/**
 * Rekey records: what `rekeyBackups` (src/extras/rekey.ts) changed about a backup's
 * encryption, stored next to the backup because its manifest is immutable.
 *
 *   annotations/<backup id>/rekey/<time>.json
 *
 * A rekey rewrites the age header of some stored files (the key envelope
 * `backup-key.age`, or every data, metadata and changes file of a recipient backup),
 * which changes their size and SHA-256. The record lists the new digests and the new
 * `encryption.recipients`, and the catalog lays it over the manifest when listing
 * (`applyRekeyRecords`), so verify, restore, find and `list` all see the backup as it
 * is now stored. The manifest file itself is never touched.
 *
 * Crash safety: a rekey first writes its record with `status: "pending"`, holding the
 * prepared new header of every file but no new digests yet. Pending records are NOT
 * applied. Only when every file has been rewritten is the record replaced by its
 * `"complete"` form, which has the digests and no longer carries the headers. A rekey
 * that stopped half-way is finished by the next rekey run (no keys needed: the headers
 * are in the pending record); until then the rewritten files fail their checksum, which
 * verify reports.
 *
 * Object lock: while a backup's `immutableUntil` lies in the future, its records are
 * ignored. Rekeying is refused during that time anyway (the storage would refuse to
 * rewrite locked files), so a record dated inside it was not written by MongoShield;
 * the locked manifest stays the only truth.
 */

import { z } from "zod";
import type { Manifest, StoredFile } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";

/**
 * Same as `ANNOTATIONS_PREFIX` in annotations.ts, repeated so the two files do not
 * import each other (annotations.ts reads these records).
 */
const ANNOTATIONS_PREFIX = "annotations/";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** One rewritten file. Keys are relative to the backup directory, as in the manifest. */
export const RekeyedFileSchema = z.object({
  key: z.string().min(1),
  /** Size and SHA-256 before this rekey (what the rewrite checks it is reading). */
  previousSize: z.number().int().nonnegative(),
  previousSha256: sha256Hex,
  /** Size and SHA-256 after the rewrite. Only in complete records. */
  size: z.number().int().nonnegative().optional(),
  sha256: sha256Hex.optional(),
  /**
   * Pending records only: the prepared new age header, base64. Not secret (it is what
   * the file starts with), but dropped from the complete record so old wraps for
   * removed recipients do not linger in storage.
   */
  header: z.string().optional(),
});

export const RekeyRecordSchema = z.object({
  backupId: z.string(),
  rekeyedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "complete"]),
  /** The backup's `encryption.recipients` after the rekey (public labels only). */
  recipients: z.array(z.string()).min(1),
  files: z.array(RekeyedFileSchema),
  tool: z.string(),
});

/** One file of a rekey record. */
export type RekeyedFile = z.infer<typeof RekeyedFileSchema>;
/** A stored rekey record. */
export type RekeyRecord = z.infer<typeof RekeyRecordSchema>;

/** Directory of a backup's rekey records (inside its annotations). */
export function rekeyRecordsPrefix(backupId: string): string {
  return `${ANNOTATIONS_PREFIX}${backupId}/rekey/`;
}

/** Storage key of one record. The time comes first so listing sorts chronologically. */
export function rekeyRecordKey(backupId: string, rekeyedAt: string): string {
  // "2026-11-14T03:00:04.123Z" → "2026-11-14T03-00-04-123Z": safe in keys, still sortable.
  const stamp = rekeyedAt.replaceAll(":", "-").replace(".", "-");
  return `${rekeyRecordsPrefix(backupId)}${stamp}.json`;
}

/** Writes (or replaces, when a pending record completes) a rekey record. */
export async function writeRekeyRecord(
  storage: StorageAdapter,
  record: RekeyRecord,
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await storage.put(rekeyRecordKey(record.backupId, record.rekeyedAt), body, {
    contentType: "application/json",
    sizeHint: body.length,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * The manifest as the backup is stored now: complete rekey records applied in time
 * order (new file sizes and digests, new recipient labels). Pending records, and all
 * records while the backup is locked (see the file header), are ignored. Pure.
 */
export function applyRekeyRecords(
  manifest: Manifest,
  records: readonly RekeyRecord[],
  now: Date = new Date(),
): Manifest {
  if (manifest.encryption === null) return manifest;
  if (isLocked(manifest, now)) return manifest;
  const applicable = records
    .filter((record) => record.status === "complete" && record.backupId === manifest.id)
    .sort((a, b) => Date.parse(a.rekeyedAt) - Date.parse(b.rekeyedAt));
  if (applicable.length === 0) return manifest;

  const digests = new Map<string, { size: number; sha256: string }>();
  for (const record of applicable) {
    for (const file of record.files) {
      if (file.size !== undefined && file.sha256 !== undefined) {
        digests.set(file.key, { size: file.size, sha256: file.sha256 });
      }
    }
  }
  const latest = applicable.at(-1);
  const recipients = latest?.recipients ?? manifest.encryption.recipients;

  /** The file with its rewritten digest, if it was rewritten. */
  function current<File extends StoredFile>(file: File): File {
    const digest = digests.get(file.key);
    return digest === undefined ? file : { ...file, ...digest };
  }

  const { keyFile } = manifest.encryption;
  return {
    ...manifest,
    encryption: {
      ...manifest.encryption,
      recipients,
      ...(keyFile !== undefined ? { keyFile: current(keyFile) } : {}),
    },
    namespaces: manifest.namespaces.map((entry) => ({
      ...entry,
      metadata: current(entry.metadata),
      files: entry.files.map((file) => current(file)),
    })),
    ...(manifest.changes !== undefined ? { changes: current(manifest.changes) } : {}),
  };
}

/** True while the backup's write-once retention is in force. */
export function isLocked(manifest: Manifest, now: Date): boolean {
  return (
    manifest.immutableUntil !== undefined && Date.parse(manifest.immutableUntil) > now.getTime()
  );
}
