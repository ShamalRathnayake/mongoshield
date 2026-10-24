/**
 * Rekeying: change who can decrypt existing backups WITHOUT re-encrypting their data.
 *
 *   await rekeyBackups(storage, {
 *     backups: "all",
 *     addRecipients: ["age1…new-ops-key"],
 *     removeRecipients: ["age1…departed-admin"],
 *     decryption: { identities: [currentIdentity] },
 *   });
 *
 * Only age headers are rewritten (src/crypto/header-rewrite.ts); payloads stay
 * byte-for-byte as they are. Which headers depends on how the backup is protected:
 *
 *   recipients  (no key file)  every data, metadata and changes file is encrypted to
 *                              the recipients directly, so each file's header is rewritten
 *                              for the new recipient set (opened with a current identity)
 *   passphrase  (key file)     only `backup-key.age` is rewritten, for the new passphrase
 *                              (opened with the current one): one file, one scrypt
 *   KMS         (key file)     KMS key changes rewrite `backup-key.age` (opened through the
 *                              KMS); recovery recipient changes rewrite every content file,
 *                              keeping its first stanza (the backup's own one-off recipient,
 *                              see src/engine/backup-key.ts) and re-wrapping for the new
 *                              recovery set (opened with a recovery identity, or with the
 *                              backup's identity from the envelope via the KMS)
 *
 * The manifest is immutable, so the new digests and recipients go into a rekey record
 * (`annotations/<id>/rekey/<time>.json`) that the catalog lays over the manifest; see
 * src/catalog/rekey-records.ts for the format and the crash-safety protocol:
 *
 *   1. prepare  read each file's header and compute its new header (needs keys, reads
 *               only headers)
 *   2. record   store the pending record with the prepared headers
 *   3. rewrite  stream each file through "check old digest → swap header" back into the
 *               same key (atomic put: a failure leaves the old object)
 *   4. commit   replace the record with its complete form (new digests, no headers)
 *
 * A run that stopped between 2 and 4 is finished by the next run, without keys.
 *
 * Object-locked backups are refused: their files are write-once until `immutableUntil`,
 * so the storage would reject the rewrite, and a rekey record would be ignored anyway
 * (see rekey-records.ts). Removing a recipient does not revoke access already had: see
 * the warning in src/crypto/header-rewrite.ts and docs/specs/ENCRYPTION.md ("Rekeying").
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { readAnnotations } from "../catalog/annotations.ts";
import {
  applyRekeyRecords,
  isLocked,
  type RekeyedFile,
  type RekeyRecord,
  writeRekeyRecord,
} from "../catalog/rekey-records.ts";
import { createHeaderReplacer, readAgeHeader, rewrapHeader } from "../crypto/header-rewrite.ts";
import {
  assertValidRecipient,
  type DecryptStreamOptions,
  type EncryptStreamOptions,
  PASSPHRASE_RECIPIENT_LABEL,
} from "../crypto/index.ts";
import {
  assertValidKmsKeyRef,
  createKmsKeyUnwrapper,
  createKmsKeyWrapper,
  isKmsRecipientLabel,
  kmsRecipientLabel,
} from "../crypto/kms/index.ts";
import { writeStoredFile } from "../engine/backup-write.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import { isKmsBackup, unlockBackupKey } from "../engine/read-pipeline.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { Manifest, StoredFile } from "../format/manifest.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions, KmsKeyRef } from "../types.ts";
import { version } from "../version.ts";
import {
  type BackupSelection,
  contentFilesOf,
  createExpectedDigestCheck,
  type SelectedBackup,
  selectBackups,
} from "./stored-files.ts";

/** Options for {@link rekeyBackups}. */
export interface RekeyOptions {
  /** Which backups: every complete one, the newest, or these ids. */
  readonly backups: BackupSelection;
  /** age recipients (`age1…`) that can open the backups afterwards. */
  readonly addRecipients?: readonly string[];
  /** age recipients that can no longer open the backups afterwards. */
  readonly removeRecipients?: readonly string[];
  /** KMS backups: KMS keys that can unlock the backup's key file afterwards. */
  readonly addKms?: readonly KmsKeyRef[];
  /** KMS backups: KMS keys removed from the key file. At least one must remain. */
  readonly removeKms?: readonly KmsKeyRef[];
  /** Passphrase backups: the new passphrase (the current one goes in `decryption`). */
  readonly newPassphrase?: string;
  /**
   * Keys that open the CURRENT files: an identity among the recipients (recipient
   * backups, or a recovery identity of KMS backups), or the current passphrase.
   * KMS backups need none when the environment may call the KMS.
   */
  readonly decryption?: DecryptionOptions;
  /** Report what would change, without reading keys or writing anything. */
  readonly dryRun?: boolean;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** The current time (rekey record times, object lock checks). For tests. */
  readonly now?: () => Date;
}

/** What happened to one backup. */
export interface RekeyBackupResult {
  readonly backupId: string;
  /**
   * `rekeyed`: headers rewritten; `would-rekey`: the same, in a dry run; `unchanged`:
   * the requested change makes no difference to this backup; `skipped`: the change
   * cannot apply to it (`reason` says why).
   */
  readonly action: "rekeyed" | "would-rekey" | "unchanged" | "skipped";
  readonly reason?: string;
  /** Files whose header was (or would be) rewritten. */
  readonly files: number;
  /** `encryption.recipients` afterwards, as the catalog now reports them. */
  readonly recipients: readonly string[];
  /** True when an interrupted earlier rekey of this backup was finished first. */
  readonly resumed: boolean;
}

/** What {@link rekeyBackups} did. */
export interface RekeyResult {
  readonly dryRun: boolean;
  readonly backups: readonly RekeyBackupResult[];
  readonly durationMs: number;
}

/** Headers read and prepared at the same time (small reads, latency-bound). */
const PREPARE_CONCURRENCY = 8;

/** Files rewritten at the same time (whole-file streams). */
const REWRITE_CONCURRENCY = 4;

/** Prefix of KMS recipient labels in manifests (`kms:<provider>:<key>`). */
const KMS_LABEL_PREFIX = "kms:";

/** One set of files that is rewritten the same way. */
interface RewriteGroup {
  readonly files: readonly StoredFile[];
  /** How to open the current headers. Lazy: unlocking may call a KMS. */
  readonly unwrap: (storage: StorageAdapter, signal: AbortSignal) => Promise<DecryptStreamOptions>;
  readonly wrap: EncryptStreamOptions;
  readonly keepStanzas: readonly number[];
}

/** The change worked out for one backup. */
type BackupPlan =
  | {
      readonly kind: "rewrite";
      readonly groups: readonly RewriteGroup[];
      readonly recipients: string[];
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "skipped"; readonly reason: string };

/** Shared state of a run. */
interface RekeyRun {
  readonly storage: StorageAdapter;
  readonly options: RekeyOptions;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}

/**
 * Changes who can decrypt the selected backups by rewriting age headers only.
 * See the file header for what is rewritten and how it stays crash-safe.
 *
 * @throws MS_CONFIG_INVALID for invalid recipients or KMS keys, a named backup that is
 *   object-locked or unencrypted, or no change requested at all;
 *   MS_BACKUP_NOT_FOUND for unknown ids; MS_NO_IDENTITY / MS_DECRYPTION_FAILED when the
 *   given keys cannot open the current files; MS_INTEGRITY_FAILED when a file changed
 *   since it was written; storage errors; MS_ABORTED.
 */
export async function rekeyBackups(
  storage: StorageAdapter,
  options: RekeyOptions,
): Promise<RekeyResult> {
  const startedAt = performance.now();
  validateRequest(options);
  const run: RekeyRun = {
    storage,
    options,
    logger: options.logger ?? silentLogger,
    signal: options.signal ?? new AbortController().signal,
    now: options.now ?? (() => new Date()),
  };

  const selected = await selectBackups(storage, options.backups, {
    signal: options.signal,
    logger: run.logger,
  });
  const explicit = options.backups !== "all";
  const results: RekeyBackupResult[] = [];
  for (const backup of selected) {
    throwIfAborted(options.signal);
    results.push(await rekeyOne(run, backup, explicit));
  }
  return {
    dryRun: options.dryRun === true,
    backups: results,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

/** Checks the requested change before touching any backup. */
function validateRequest(options: RekeyOptions): void {
  for (const recipient of [...(options.addRecipients ?? []), ...(options.removeRecipients ?? [])]) {
    assertValidRecipient(recipient);
  }
  for (const ref of [...(options.addKms ?? []), ...(options.removeKms ?? [])]) {
    assertValidKmsKeyRef(ref);
  }
  if (options.newPassphrase !== undefined && options.newPassphrase.length === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The new passphrase is empty.", {
      hint: "Pass a long random passphrase.",
    });
  }
}

/** True when the options ask for any change at all (otherwise a run only resumes). */
function requestsChange(options: RekeyOptions): boolean {
  return (
    (options.addRecipients?.length ?? 0) > 0 ||
    (options.removeRecipients?.length ?? 0) > 0 ||
    (options.addKms?.length ?? 0) > 0 ||
    (options.removeKms?.length ?? 0) > 0 ||
    options.newPassphrase !== undefined
  );
}

/** Rekeys one backup: refuses locked ones, finishes a pending rekey, then applies the change. */
async function rekeyOne(
  run: RekeyRun,
  backup: SelectedBackup,
  explicit: boolean,
): Promise<RekeyBackupResult> {
  const { manifest } = backup;
  const refusal = refusalReason(manifest, run.now());
  if (refusal !== undefined) {
    // A backup the user named must not be silently passed over; "all" just reports it.
    if (explicit) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Cannot rekey backup ${backup.id}: ${refusal}`,
        {
          hint: refusalHint(manifest),
        },
      );
    }
    return skipped(backup, refusal);
  }

  // A dry run must not write, so it does not finish an interrupted rekey either.
  const resumed = run.options.dryRun === true ? false : await finishPendingRekeys(run, backup.id);
  const current = resumed ? await currentManifest(run, backup.id, manifest) : manifest;

  const plan = planBackup(current, run.options);
  if (plan.kind === "skipped")
    return skipped({ id: backup.id, manifest: current }, plan.reason, resumed);
  if (plan.kind === "unchanged") {
    return { ...summary(current, "unchanged", 0), resumed };
  }
  const fileCount = plan.groups.reduce((sum, group) => sum + group.files.length, 0);
  if (run.options.dryRun === true) {
    return {
      backupId: backup.id,
      action: "would-rekey",
      files: fileCount,
      recipients: plan.recipients,
      resumed,
    };
  }

  run.logger.info("Rekeying backup", { backupId: backup.id, files: fileCount });
  const prepared = await prepareHeaders(run, current, plan.groups);
  const record: RekeyRecord = {
    backupId: backup.id,
    rekeyedAt: run.now().toISOString(),
    status: "pending",
    recipients: plan.recipients,
    files: prepared,
    tool: `mongoshield@${version}`,
  };
  await writeRekeyRecord(run.storage, record, { signal: run.signal });
  await commitRecord(run, record);
  return {
    backupId: backup.id,
    action: "rekeyed",
    files: fileCount,
    recipients: plan.recipients,
    resumed,
  };
}

/** Why a backup cannot be rekeyed at all, or `undefined`. */
function refusalReason(manifest: Manifest, now: Date): string | undefined {
  if (manifest.encryption === null) {
    return "it is not encrypted (rekeying changes keys; it cannot add encryption).";
  }
  if (isLocked(manifest, now)) {
    return `it is object-locked until ${manifest.immutableUntil ?? "?"}: its files are write-once, so their headers cannot be rewritten.`;
  }
  return undefined;
}

function refusalHint(manifest: Manifest): string {
  if (manifest.encryption === null) {
    return "To get an encrypted copy, restore it into a scratch database and take a new, encrypted backup.";
  }
  return "Wait until the lock expires, or restore it and take a new backup with the new keys.";
}

function skipped(backup: SelectedBackup, reason: string, resumed = false): RekeyBackupResult {
  return { ...summary(backup.manifest, "skipped", 0), reason, resumed };
}

function summary(
  manifest: Manifest,
  action: RekeyBackupResult["action"],
  files: number,
): Omit<RekeyBackupResult, "resumed"> {
  return {
    backupId: manifest.id,
    action,
    files,
    recipients: manifest.encryption?.recipients ?? [],
  };
}

// ---------------------------------------------------------------------------
// Planning: which files, which keys
// ---------------------------------------------------------------------------

/** Works out what changes for one backup, from its (rekey-applied) manifest. */
function planBackup(manifest: Manifest, options: RekeyOptions): BackupPlan {
  if (!requestsChange(options)) return { kind: "unchanged" };
  const encryption = manifest.encryption;
  if (encryption === null) return { kind: "skipped", reason: "it is not encrypted." };
  if (encryption.keyFile === undefined) return planRecipientBackup(manifest, options);
  if (isKmsBackup(manifest)) return planKmsBackup(manifest, encryption.keyFile, options);
  return planPassphraseBackup(manifest, encryption.keyFile, options);
}

/** Recipient backups: rewrite every content file for the new recipient set. */
function planRecipientBackup(manifest: Manifest, options: RekeyOptions): BackupPlan {
  if (options.newPassphrase !== undefined || hasKmsChange(options)) {
    return {
      kind: "skipped",
      reason: "it is encrypted to age recipients: only recipients can be added or removed.",
    };
  }
  const current = manifest.encryption?.recipients ?? [];
  const target = applyListChange(current, options.addRecipients, options.removeRecipients);
  if (target.length === 0) {
    return { kind: "skipped", reason: "the change would leave no recipient that can open it." };
  }
  if (sameSet(current, target)) return { kind: "unchanged" };
  return {
    kind: "rewrite",
    recipients: target,
    groups: [
      {
        files: contentFilesOf(manifest),
        unwrap: async () => identitiesOnly(options.decryption, manifest),
        wrap: { recipients: target },
        keepStanzas: [],
      },
    ],
  };
}

/** Passphrase backups: rewrite the key envelope for the new passphrase. */
function planPassphraseBackup(
  manifest: Manifest,
  keyFile: StoredFile,
  options: RekeyOptions,
): BackupPlan {
  if (hasRecipientChange(options) || hasKmsChange(options)) {
    return {
      kind: "skipped",
      reason: "it is protected with a passphrase: only the passphrase can be changed.",
    };
  }
  const newPassphrase = options.newPassphrase;
  if (newPassphrase === undefined) return { kind: "unchanged" };
  const passphrase = options.decryption?.passphrase;
  return {
    kind: "rewrite",
    recipients: [PASSPHRASE_RECIPIENT_LABEL],
    groups: [
      {
        files: [keyFile],
        unwrap: async () => {
          if (passphrase === undefined) {
            throw new MongoShieldError(
              "MS_NO_IDENTITY",
              `Backup ${manifest.id} is protected with a passphrase, but the current passphrase was not given.`,
              { hint: "Pass the current passphrase as decryption (e.g. --passphrase-env)." },
            );
          }
          return { passphrase };
        },
        wrap: { passphrase: newPassphrase },
        keepStanzas: [],
      },
    ],
  };
}

/**
 * KMS backups: KMS key changes rewrite the envelope; recovery recipient changes
 * rewrite every content file (keeping stanza #1, the backup's own recipient).
 */
function planKmsBackup(manifest: Manifest, keyFile: StoredFile, options: RekeyOptions): BackupPlan {
  if (options.newPassphrase !== undefined) {
    return {
      kind: "skipped",
      reason: "it is protected with KMS keys: only KMS keys and recovery recipients can change.",
    };
  }
  const labels = manifest.encryption?.recipients ?? [];
  const currentKms = labels.flatMap((label) => {
    const ref = parseKmsLabel(label);
    return ref === undefined ? [] : [ref];
  });
  const currentRecovery = labels.filter((label) => !isKmsRecipientLabel(label));

  const targetKmsLabels = applyListChange(
    currentKms.map((ref) => kmsRecipientLabel(ref)),
    options.addKms?.map((ref) => kmsRecipientLabel(ref)),
    options.removeKms?.map((ref) => kmsRecipientLabel(ref)),
  );
  if (targetKmsLabels.length === 0) {
    return {
      kind: "skipped",
      reason: "the change would leave no KMS key on its key file (at least one is required).",
    };
  }
  const targetRecovery = applyListChange(
    currentRecovery,
    options.addRecipients,
    options.removeRecipients,
  );

  const groups: RewriteGroup[] = [];
  if (!sameSet(currentRecovery, targetRecovery)) {
    groups.push({
      files: contentFilesOf(manifest),
      unwrap: (storage, signal) => kmsContentUnwrap(storage, manifest, keyFile, options, signal),
      wrap: { recipients: targetRecovery },
      // The backup's own one-off recipient is always the first stanza of a content
      // file (src/engine/backup-key.ts), and nobody knows its public key without
      // opening the envelope, so its stanza is copied rather than re-made.
      keepStanzas: [0],
    });
  }
  const currentKmsLabels = currentKms.map((ref) => kmsRecipientLabel(ref));
  if (!sameSet(currentKmsLabels, targetKmsLabels)) {
    const targetKms = targetKmsLabels.flatMap((label) => {
      const ref = parseKmsLabel(label);
      return ref === undefined ? [] : [ref];
    });
    groups.push({
      files: [keyFile],
      unwrap: async () => ({ keyUnwrappers: [createKmsKeyUnwrapper()] }),
      wrap: { keyWrappers: targetKms.map((ref) => createKmsKeyWrapper(ref)) },
      keepStanzas: [],
    });
  }
  if (groups.length === 0) return { kind: "unchanged" };
  return { kind: "rewrite", groups, recipients: [...targetKmsLabels, ...targetRecovery] };
}

/**
 * How to open a KMS backup's content files: with a given recovery identity when there
 * is one (no KMS call), else with the backup's own identity from its key envelope,
 * unlocked through the KMS.
 */
async function kmsContentUnwrap(
  storage: StorageAdapter,
  manifest: Manifest,
  keyFile: StoredFile,
  options: RekeyOptions,
  signal: AbortSignal,
): Promise<DecryptStreamOptions> {
  const identities = options.decryption?.identities ?? [];
  if (identities.length > 0) return { identities };
  const identity = await unlockBackupKey(
    storage,
    manifest.id,
    keyFile,
    { keyUnwrappers: [createKmsKeyUnwrapper()] },
    { signal },
  );
  return { identities: [identity] };
}

/** Identity decryption options for recipient backups, or a clear error. */
function identitiesOnly(
  decryption: DecryptionOptions | undefined,
  manifest: Manifest,
): DecryptStreamOptions {
  const identities = decryption?.identities ?? [];
  if (identities.length === 0) {
    throw new MongoShieldError(
      "MS_NO_IDENTITY",
      `Rekeying backup ${manifest.id} needs an identity that can open it today.`,
      {
        hint: "Pass the age identity of one of its current recipients (e.g. --identity-file key.txt).",
      },
    );
  }
  return { identities };
}

function hasRecipientChange(options: RekeyOptions): boolean {
  return (options.addRecipients?.length ?? 0) > 0 || (options.removeRecipients?.length ?? 0) > 0;
}

function hasKmsChange(options: RekeyOptions): boolean {
  return (options.addKms?.length ?? 0) > 0 || (options.removeKms?.length ?? 0) > 0;
}

/** `current − remove + add`, keeping the current order and dropping duplicates. */
function applyListChange(
  current: readonly string[],
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): string[] {
  const removed = new Set(remove ?? []);
  const result: string[] = [];
  for (const value of [...current, ...(add ?? [])]) {
    if (!removed.has(value) && !result.includes(value)) result.push(value);
  }
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** `kms:aws:arn:aws:kms:…` → `{ provider: "aws", key: "arn:aws:kms:…" }`. */
export function parseKmsLabel(label: string): KmsKeyRef | undefined {
  if (!label.startsWith(KMS_LABEL_PREFIX)) return undefined;
  const rest = label.slice(KMS_LABEL_PREFIX.length);
  const separator = rest.indexOf(":");
  const provider = rest.slice(0, separator);
  const key = rest.slice(separator + 1);
  if (separator <= 0 || key === "") return undefined;
  if (provider !== "aws" && provider !== "gcp" && provider !== "azure") return undefined;
  return { provider, key };
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Step 1: reads every file's header and prepares its replacement. */
async function prepareHeaders(
  run: RekeyRun,
  manifest: Manifest,
  groups: readonly RewriteGroup[],
): Promise<RekeyedFile[]> {
  const prepared: RekeyedFile[] = [];
  for (const group of groups) {
    const unwrap = await group.unwrap(run.storage, run.signal);
    const files = await mapWithConcurrency(
      group.files,
      async (file, _index, signal) => {
        const stored = await run.storage.get(resolveBackupKey(manifest.id, file.key), { signal });
        const header = await readAgeHeader(stored);
        const newHeader = await rewrapHeader(header, {
          unwrap,
          wrap: group.wrap,
          keepStanzas: group.keepStanzas,
        });
        const entry: RekeyedFile = {
          key: file.key,
          previousSize: file.size,
          previousSha256: file.sha256,
          header: newHeader.toString("base64"),
        };
        return entry;
      },
      { concurrency: PREPARE_CONCURRENCY, signal: run.signal },
    );
    prepared.push(...files);
  }
  return prepared;
}

/**
 * Steps 3 and 4: rewrites every file of a pending record (or confirms it was already
 * rewritten by an interrupted run), then stores the complete record.
 */
async function commitRecord(run: RekeyRun, record: RekeyRecord): Promise<void> {
  const files = await mapWithConcurrency(
    record.files,
    (file, _index, signal) => rewriteFile(run, record.backupId, file, signal),
    { concurrency: REWRITE_CONCURRENCY, signal: run.signal },
  );
  await writeRekeyRecord(
    run.storage,
    { ...record, status: "complete", files },
    {
      signal: run.signal,
    },
  );
}

/** Rewrites one file with its prepared header; returns its complete record entry. */
async function rewriteFile(
  run: RekeyRun,
  backupId: string,
  file: RekeyedFile,
  signal: AbortSignal,
): Promise<RekeyedFile> {
  if (file.header === undefined) {
    // Already complete (should not happen in a pending record): keep it as it is.
    return file;
  }
  const newHeader = Buffer.from(file.header, "base64");
  const key = resolveBackupKey(backupId, file.key);

  // Resuming: an interrupted run may have rewritten this file already. Then its
  // header IS the prepared one; it only needs hashing for the record.
  const currentHeader = await readAgeHeader(await run.storage.get(key, { signal }));
  if (currentHeader.equals(newHeader)) {
    const digest = await hashStoredObject(run.storage, key, signal);
    return completeEntry(file, digest);
  }

  const digest = await writeStoredFile({
    storage: run.storage,
    key,
    source: await run.storage.get(key, { signal }),
    transforms: [
      // The old bytes must be exactly what the manifest (or the last rekey) recorded;
      // otherwise the file changed and must not be "repaired" with a new header.
      createExpectedDigestCheck(
        { key: file.key, size: file.previousSize, sha256: file.previousSha256 },
        `backup ${backupId}`,
      ),
      createHeaderReplacer(newHeader),
    ],
    contentType: "application/octet-stream",
    signal,
  });
  return completeEntry(file, digest);
}

/** The complete form of a record entry: new digest, no header. */
function completeEntry(
  file: RekeyedFile,
  digest: { readonly size: number; readonly sha256: string },
): RekeyedFile {
  return {
    key: file.key,
    previousSize: file.previousSize,
    previousSha256: file.previousSha256,
    size: digest.size,
    sha256: digest.sha256,
  };
}

/** Hashes a stored object without writing anything. */
async function hashStoredObject(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  const hash = createHash("sha256");
  let size = 0;
  const stream: Readable = await storage.get(key, { signal });
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { size, sha256: hash.digest("hex") };
}

/**
 * Finishes rekeys that an earlier run left pending (see the file header). Returns
 * true when there was one. Needs no keys: the prepared headers are in the record.
 */
async function finishPendingRekeys(run: RekeyRun, backupId: string): Promise<boolean> {
  const annotations = await readAnnotations(run.storage, backupId, { signal: run.signal });
  const pending = annotations.rekeys.filter((record) => record.status === "pending");
  for (const record of pending) {
    run.logger.warn("Finishing an interrupted rekey", { backupId, startedAt: record.rekeyedAt });
    await commitRecord(run, record);
  }
  return pending.length > 0;
}

/** The manifest with every complete rekey record applied, re-read after a resume. */
async function currentManifest(
  run: RekeyRun,
  backupId: string,
  manifest: Manifest,
): Promise<Manifest> {
  const annotations = await readAnnotations(run.storage, backupId, { signal: run.signal });
  return applyRekeyRecords(manifest, annotations.rekeys, run.now());
}
