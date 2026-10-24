/**
 * Validation of backup options and settings, done before the backup reads any data,
 * so a typo in a recipient or a pattern fails in milliseconds instead of after an
 * hour of dumping. Also turns the encryption settings into what the encrypt stream
 * and the manifest need.
 */

import type { Document } from "mongodb";
import { assertValidRecipient, describeRecipient } from "../crypto/index.ts";
import { assertValidKmsKeyRef } from "../crypto/kms/index.ts";
import { MongoShieldError } from "../errors.ts";
import { isBackupId } from "../format/layout.ts";
import { compileNamespaceFilter } from "../mongo/index.ts";
import type { BackupOptions, EncryptionOptions, KmsKeyRef } from "../types.ts";
import { DEFAULT_PART_SIZE_BYTES } from "./backup-parts.ts";
import { DEFAULT_READ_PREFERENCE } from "./backup-reads.ts";

/** How many collections are dumped at once when `parallelism` is not set. */
export const DEFAULT_BACKUP_PARALLELISM = 4;

/**
 * Encryption settings, validated. Recipient backups encrypt every file to the
 * given public keys. Passphrase and KMS backups first create a per-backup key (see
 * `backup-key.ts`); the passphrase or the KMS keys only ever protect that key.
 */
export type EncryptionPlan =
  | {
      readonly kind: "recipients";
      /** Normalized `age1…` recipients: every file is encrypted to all of them. */
      readonly recipients: readonly string[];
    }
  | { readonly kind: "passphrase"; readonly passphrase: string }
  | {
      readonly kind: "kms";
      /** Cloud KMS keys; any one of them can unlock the backup's key file. */
      readonly kms: readonly KmsKeyRef[];
      /**
       * Normalized `age1…` recovery recipients (may be empty). Every file is also
       * encrypted to them directly, so they open the backup without any KMS.
       */
      readonly recipients: readonly string[];
    };

/**
 * Checks the per-run options that can be checked without a database.
 *
 * @returns the effective parallelism.
 * @throws MS_CONFIG_INVALID for a bad parallelism, malformed namespace patterns or
 *   malformed `query` entries.
 */
export function validateBackupOptions(options: BackupOptions): number {
  const parallelism = options.parallelism ?? DEFAULT_BACKUP_PARALLELISM;
  if (!Number.isInteger(parallelism) || parallelism < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `parallelism must be a whole number of at least 1, got ${String(parallelism)}.`,
      { hint: `Omit it to use the default (${DEFAULT_BACKUP_PARALLELISM}).` },
    );
  }

  // Compiling the filter validates every include/exclude pattern; discovery
  // compiles it again later, which is cheap.
  compileNamespaceFilter({ include: options.include, exclude: options.exclude });

  for (const [ns, filter] of Object.entries(options.query ?? {})) {
    if (!isPlainDocument(filter)) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `query["${ns}"] must be a filter document such as { createdAt: { $gte: … } }.`,
      );
    }
  }
  return parallelism;
}

/** The read, split and resume settings of a run, validated and with defaults applied. */
export interface RunSettings {
  readonly partSizeBytes: number;
  /**
   * True when the run may stop early or continues an earlier one (`maxDurationMs` or
   * `resume`): it then keeps a checkpoint and reads with consistency `none`.
   */
  readonly resumable: boolean;
}

/** `resume` values other than a backup id. */
const RESUME_KEYWORDS = new Set(["latest", "auto"]);

const READ_PREFERENCES = new Set([
  "primary",
  "primaryPreferred",
  "secondary",
  "secondaryPreferred",
  "nearest",
]);

/**
 * Checks the split, resume, read and retention options (see
 * docs/specs/PARTS-AND-RESUME.md) and applies their defaults.
 *
 * @throws MS_CONFIG_INVALID for out-of-range numbers, an unknown read preference,
 *   malformed tag sets or `resume` values, and for `snapshot`/`converge` consistency
 *   combined with `maxDurationMs` or `resume` (a run spread over several invocations
 *   cannot be consistent).
 */
export function validateRunSettings(options: BackupOptions): RunSettings {
  const partSizeBytes = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  assertPositive("partSizeBytes", partSizeBytes, { integer: true });
  if (options.maxDurationMs !== undefined) {
    assertPositive("maxDurationMs", options.maxDurationMs, {});
  }
  if (options.maxDocumentsPerSecond !== undefined) {
    assertPositive("maxDocumentsPerSecond", options.maxDocumentsPerSecond, {});
  }
  if (options.maxBytesPerSecond !== undefined) {
    assertPositive("maxBytesPerSecond", options.maxBytesPerSecond, {});
  }
  if (options.retainDays !== undefined) {
    assertPositive("retainDays", options.retainDays, { integer: true });
  }
  assertValidReadPreference(options);

  const { resume } = options;
  if (resume !== undefined && !RESUME_KEYWORDS.has(resume) && !isBackupId(resume)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `resume must be a backup id, "latest" or "auto", got "${resume}".`,
      { hint: 'Backup ids look like "2026-11-14T03-00-04Z_7f3a9c".' },
    );
  }

  const resumable = options.maxDurationMs !== undefined || resume !== undefined;
  const consistency = options.consistency ?? "auto";
  if (resumable && consistency !== "auto" && consistency !== "none") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Consistency "${consistency}" cannot be combined with maxDurationMs or resume.`,
      {
        hint: 'A backup spread over several invocations reads collections at different times; use consistency "none" (or "auto"), or drop maxDurationMs/resume.',
      },
    );
  }
  return { partSizeBytes, resumable };
}

/** Throws MS_CONFIG_INVALID unless `value` is a positive finite number (and whole if asked). */
function assertPositive(name: string, value: number, rules: { readonly integer?: boolean }): void {
  const valid =
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    (rules.integer !== true || Number.isInteger(value));
  if (valid) return;
  const kind = rules.integer === true ? "a whole number above 0" : "a number above 0";
  throw new MongoShieldError("MS_CONFIG_INVALID", `${name} must be ${kind}, got ${String(value)}.`);
}

function assertValidReadPreference(options: BackupOptions): void {
  const { readPreference, readPreferenceTags } = options;
  if (readPreference !== undefined && !READ_PREFERENCES.has(readPreference)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Unknown readPreference "${String(readPreference)}".`,
      { hint: `Use one of ${[...READ_PREFERENCES].join(", ")}.` },
    );
  }
  if (readPreferenceTags === undefined) return;
  const valid =
    Array.isArray(readPreferenceTags) &&
    readPreferenceTags.every(
      (tagSet) =>
        isPlainDocument(tagSet) && Object.values(tagSet).every((tag) => typeof tag === "string"),
    );
  if (!valid) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      'readPreferenceTags must be a list of tag sets such as [{ use: "backup" }, {}].',
    );
  }
  if ((readPreference ?? DEFAULT_READ_PREFERENCE) === "primary" && readPreferenceTags.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      'readPreferenceTags cannot be combined with readPreference "primary".',
      { hint: "Tags select secondaries; drop them or pick another read preference." },
    );
  }
}

/**
 * Validates the encryption settings and plans how to apply them.
 * Returns `undefined` for unencrypted backups.
 *
 * @throws MS_CONFIG_INVALID for invalid recipients or KMS keys, an empty
 *   passphrase, a passphrase combined with recipients or KMS keys, or nothing at all.
 */
export function planEncryption(
  encryption: EncryptionOptions | undefined,
): EncryptionPlan | undefined {
  if (encryption === undefined) return undefined;
  const recipients = encryption.recipients ?? [];
  const kms = encryption.kms ?? [];
  const { passphrase } = encryption;

  // Why a passphrase stands alone: age requires an scrypt stanza to be the only
  // stanza in a file. That rule is what guarantees a passphrase-encrypted file was
  // made by someone who knew the passphrase; mixing in public-key recipients would
  // silently drop that guarantee. A passphrase backup's key file is therefore
  // passphrase-only, and adding recipients or KMS keys next to it is refused rather
  // than half-applied.
  if (passphrase !== undefined && (recipients.length > 0 || kms.length > 0)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Encryption cannot combine a passphrase with ${recipients.length > 0 ? "recipients" : "KMS keys"}.`,
      {
        hint: "Use recipients and/or KMS keys (recommended for unattended backups), or a passphrase alone.",
      },
    );
  }

  if (passphrase !== undefined) {
    if (passphrase.length === 0) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "The encryption passphrase is empty.", {
        hint: "Provide a non-empty passphrase, or remove the encryption settings.",
      });
    }
    return { kind: "passphrase", passphrase };
  }

  if (recipients.length === 0 && kms.length === 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Encryption is configured without any recipient, KMS key or passphrase.",
      {
        hint: "Add a recipient (age1…, e.g. from `age-keygen -y key.txt`), a KMS key, a passphrase, or remove the encryption settings.",
      },
    );
  }
  for (const recipient of recipients) assertValidRecipient(recipient);
  const normalized = recipients.map((recipient) => describeRecipient(recipient));
  if (kms.length === 0) return { kind: "recipients", recipients: normalized };

  // Checked here, before any data is read, so a typo in a key ARN fails in
  // milliseconds. Whether the KMS accepts the key is only known when the key file
  // is written, which happens before the first collection is dumped.
  for (const ref of kms) assertValidKmsKeyRef(ref);
  return { kind: "kms", kms: dedupeKmsKeys(kms), recipients: normalized };
}

/** Drops repeated KMS keys: wrapping twice with the same key adds nothing. */
function dedupeKmsKeys(kms: readonly KmsKeyRef[]): KmsKeyRef[] {
  const seen = new Set<string>();
  const unique: KmsKeyRef[] = [];
  for (const ref of kms) {
    const id = `${ref.provider}:${ref.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push({ provider: ref.provider, key: ref.key });
  }
  return unique;
}

/**
 * Checks that every `query` entry names a namespace this backup covers, so a typo
 * (`app.user` instead of `app.users`) does not silently dump the full collection.
 *
 * @throws MS_CONFIG_INVALID listing the unknown namespaces.
 */
export function assertQueriesMatchNamespaces(
  query: BackupOptions["query"],
  namespaces: readonly string[],
): void {
  const known = new Set(namespaces);
  const unknown = Object.keys(query ?? {}).filter((ns) => !known.has(ns));
  if (unknown.length === 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `query names namespaces this backup does not include: ${unknown.join(", ")}.`,
    { hint: "Check the namespace names (db.collection) and the include/exclude patterns." },
  );
}

function isPlainDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
