/**
 * The per-backup key envelope used by passphrase and KMS backups.
 *
 * Why: age's passphrase recipient runs scrypt (by default about 256 MiB of memory
 * and a good fraction of a second) for every file it encrypts or decrypts. A backup
 * holds two files per collection, so a 200-collection backup would run 400 scrypts on
 * the way in and 400 more on every restore, several in parallel. The scrypt result
 * cannot simply be reused across files either: age wraps each file key with it
 * under a fixed (zero) nonce, so reusing it would reuse a nonce.
 *
 * Instead, each passphrase backup gets its own freshly generated X25519 identity:
 *
 *   backups/<id>/backup-key.age   the identity, as an age-keygen key file,
 *                                 encrypted with the passphrase (ONE scrypt)
 *   every data / metadata file    encrypted to that identity's recipient (fast)
 *
 * Readers decrypt `backup-key.age` once with the passphrase and use the identity
 * inside for all files. The plaintext identity is never written anywhere, and the
 * engine drops it as soon as the envelope is stored. Documented in
 * docs/specs/ENCRYPTION.md ("Passphrase backups").
 *
 * KMS backups use the same envelope for the same reason (one remote call per run,
 * not one per file), with the cloud KMS in place of scrypt:
 *
 *   backups/<id>/backup-key.age   the identity, age-encrypted with one
 *                                 `mongoshield-kms` stanza per configured KMS key
 *   every data / metadata file    encrypted to the identity's recipient AND to every
 *                                 configured `recipients` key
 *
 * The second point is deliberate: an offline recovery recipient opens every data
 * file directly, with the plain `age` CLI and no cloud account, which is what keeps a
 * backup readable if the KMS key is deleted or the cloud account is lost. See
 * docs/specs/ENCRYPTION.md ("KMS backups").
 */

import { Readable, type Transform } from "node:stream";
import {
  createEncryptStream,
  generateIdentity,
  PASSPHRASE_RECIPIENT_LABEL,
} from "../crypto/index.ts";
import { createKmsKeyWrapper, kmsRecipientLabel } from "../crypto/kms/index.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { StoredFile } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { EncryptionPlan } from "./backup-options.ts";
import { writeStoredFile } from "./backup-write.ts";

/** Key of the envelope, relative to the backup directory. */
export const BACKUP_KEY_FILE = "backup-key.age";

/** How the files of one backup run are encrypted, once the envelope (if any) exists. */
export interface FileEncryption {
  /** Every data and metadata file is encrypted to these `age1…` recipients. */
  readonly recipients: readonly string[];
  /**
   * What the manifest records: the recipients; `scrypt` for passphrase backups;
   * `kms:<provider>:<key>` labels plus the recovery recipients for KMS backups.
   */
  readonly manifestRecipients: readonly string[];
  /** The stored envelope (passphrase and KMS backups). */
  readonly keyFile: StoredFile | undefined;
}

/** What `prepareFileEncryption` needs to store an envelope. */
export interface KeyEnvelopeTarget {
  readonly storage: StorageAdapter;
  readonly backupId: string;
  /** Receives the envelope's full key before it is written, for cleanup on failure. */
  readonly writtenKeys: Set<string>;
  /** Write-once retention for the envelope (`backup({ retainDays })`). */
  readonly retainUntil?: Date | undefined;
  readonly signal: AbortSignal;
}

/**
 * Turns the validated plan into the per-file settings. For passphrase and KMS
 * backups this generates the backup's identity and stores its envelope first.
 *
 * @throws MS_ENCRYPTION_FAILED when a KMS refuses to wrap the key (the hint names the
 *   missing permission), MS_CONFIG_INVALID when a KMS SDK is not installed.
 */
export async function prepareFileEncryption(
  plan: EncryptionPlan,
  target: KeyEnvelopeTarget,
): Promise<FileEncryption> {
  if (plan.kind === "recipients") {
    return { recipients: plan.recipients, manifestRecipients: plan.recipients, keyFile: undefined };
  }
  if (plan.kind === "kms") {
    // One stanza per KMS key: any of them can unlock the envelope (e.g. keys in two
    // regions, so one region's outage does not block restores).
    const encryptor = createEncryptStream({
      keyWrappers: plan.kms.map((ref) => createKmsKeyWrapper(ref)),
    });
    const { recipient, keyFile } = await writeKeyEnvelope(encryptor, target);
    return {
      // The backup's own recipient first, then the recovery recipients.
      recipients: [recipient, ...plan.recipients],
      // The one-off recipient is not useful to anyone (its identity is in the
      // envelope), so the manifest names what can actually open the backup.
      manifestRecipients: [...plan.kms.map((ref) => kmsRecipientLabel(ref)), ...plan.recipients],
      keyFile,
    };
  }
  // The single scrypt of the whole backup runs when this stream encrypts the envelope.
  const encryptor = createEncryptStream({ passphrase: plan.passphrase });
  const { recipient, keyFile } = await writeKeyEnvelope(encryptor, target);
  return {
    recipients: [recipient],
    // The one-off recipient is not useful to anyone (its identity is behind the
    // passphrase), so the manifest keeps saying what unlocks the backup: a passphrase.
    manifestRecipients: [PASSPHRASE_RECIPIENT_LABEL],
    keyFile,
  };
}

/**
 * Generates the backup's identity and stores it as `backup-key.age`, encrypted by
 * `encryptor` (passphrase or KMS). Returns the identity's public recipient and the
 * stored file.
 */
async function writeKeyEnvelope(
  encryptor: Transform,
  target: KeyEnvelopeTarget,
): Promise<{ readonly recipient: string; readonly keyFile: StoredFile }> {
  const generated = generateIdentity();
  const plaintext = Buffer.from(formatIdentityFile(generated, new Date()), "utf8");
  const key = resolveBackupKey(target.backupId, BACKUP_KEY_FILE);
  target.writtenKeys.add(key);
  try {
    const digest = await writeStoredFile({
      storage: target.storage,
      key,
      source: Readable.from([plaintext]),
      transforms: [encryptor],
      contentType: "application/octet-stream",
      retainUntil: target.retainUntil,
      signal: target.signal,
    });
    return {
      recipient: generated.recipient,
      keyFile: { key: BACKUP_KEY_FILE, size: digest.size, sha256: digest.sha256 },
    };
  } finally {
    // Best effort: wipe our copy of the secret bytes. (The identity string itself
    // cannot be wiped in JavaScript; it is simply never kept beyond this function.)
    plaintext.fill(0);
  }
}

/**
 * Formats an identity the way `age-keygen` writes key files, so the decrypted
 * envelope can be passed straight to `age -d -i`:
 *
 *   # created: 2026-11-14T03:00:04Z
 *   # public key: age1…
 *   AGE-SECRET-KEY-1…
 */
export function formatIdentityFile(
  identity: { readonly identity: string; readonly recipient: string },
  createdAt: Date,
): string {
  // age-keygen writes RFC 3339 times without fractional seconds.
  const created = `${createdAt.toISOString().slice(0, 19)}Z`;
  return `# created: ${created}\n# public key: ${identity.recipient}\n${identity.identity}\n`;
}
