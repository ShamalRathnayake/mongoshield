/**
 * Reading stored backup files back: the shared front half of restore and verify.
 *
 *   data file:      storage.get → integrity check → age decrypt? → decompress → BSON splitter
 *                   → one raw BSON Buffer per document
 *   metadata file:  storage.get → integrity check → age decrypt? → Extended JSON → CollectionMetadata
 *
 * Passphrase and KMS backups (manifest `encryption.keyFile`) are opened in two steps:
 * the key envelope `backup-key.age` is decrypted ONCE (with the passphrase, or by
 * asking the cloud KMS), and the identity inside it decrypts every other file (see
 * `openBackupSource` and src/engine/backup-key.ts for why). KMS backups can also be
 * opened without any KMS by a recovery identity that the data files are encrypted to.
 *
 * The integrity check compares the stored bytes with the size and SHA-256 the
 * manifest recorded for the file. It sits first, so it covers exactly the bytes
 * that were stored, and needs no key.
 *
 * Why corruption is double-checked: a flipped byte in an encrypted or compressed
 * file is usually noticed by the decryptor or decompressor long before the end of
 * the file, where the checksum is compared. Those stages then report "payload
 * rejected" or "zstd data corrupt", which hides the real story ("this file is not
 * the file the backup wrote"). So when a later stage fails, the file is read once
 * more just to hash it, and a checksum mismatch is reported as `MS_INTEGRITY_FAILED`
 * with the original error as its cause. This only happens on the failure path.
 */

import { createHash } from "node:crypto";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import { createDecompressor } from "../compression/index.ts";
import {
  createDecryptStream,
  type FileKeyUnwrapper,
  identityToRecipient,
  parseIdentityFile,
} from "../crypto/index.ts";
import { createKmsKeyUnwrapper, isKmsRecipientLabel } from "../crypto/kms/index.ts";
import { abortError, isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { createBsonSplitter } from "../format/bson-stream.ts";
import { resolveBackupKey } from "../format/layout.ts";
import type { Compression, Manifest, StoredFile } from "../format/manifest.ts";
import { type CollectionMetadata, parseCollectionMetadata } from "../format/metadata.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";
import { readStreamToBuffer } from "../util/streams.ts";

/**
 * Metadata files hold options and index definitions only. Even huge validators
 * stay far below this; anything larger is not a metadata file.
 */
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/** A key envelope holds one identity line plus two comments: well under 1 KiB. */
const MAX_KEY_FILE_BYTES = 64 * 1024;

/** `details.stage` of errors raised by the integrity check itself. */
const CHECKSUM_STAGE = "checksum";

/** Where to read a backup's files from, and how they were written. */
export interface StoredBackupSource {
  readonly storage: StorageAdapter;
  /** Backup id: file keys in the manifest are relative to its directory. */
  readonly backupId: string;
  readonly compression: Compression;
  /** True when the manifest says the backup is age-encrypted. */
  readonly encrypted: boolean;
  /** Keys for encrypted backups. Ignored for unencrypted ones. */
  readonly decryption?: DecryptionOptions | undefined;
  /**
   * Openers for custom stanzas (only the KMS stanza, and only while unlocking a KMS
   * backup's key envelope). Internal: data files never need them.
   */
  readonly keyUnwrappers?: readonly FileKeyUnwrapper[] | undefined;
}

/** Options shared by the readers in this file. */
export interface ReadOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Builds a `StoredBackupSource` from a manifest. */
export function sourceFromManifest(
  storage: StorageAdapter,
  manifest: Manifest,
  decryption: DecryptionOptions | undefined,
): StoredBackupSource {
  return {
    storage,
    backupId: manifest.id,
    compression: manifest.compression,
    encrypted: manifest.encryption !== null,
    decryption,
  };
}

/**
 * True for backups whose key envelope is protected by cloud KMS keys: the manifest
 * lists `kms:<provider>:<key>` labels (and maybe recovery recipients) next to its
 * `keyFile`. Passphrase backups list only `scrypt`.
 */
export function isKmsBackup(manifest: Manifest): boolean {
  const encryption = manifest.encryption;
  if (encryption === null || encryption.keyFile === undefined) return false;
  return encryption.recipients.some((label) => isKmsRecipientLabel(label));
}

/**
 * Fails fast when a backup is encrypted but the keys given cannot open it, so
 * restore can refuse before it writes anything and verify before it reads data:
 * no identity or passphrase at all, or (for passphrase backups, which have a key
 * envelope) no passphrase. KMS backups need no keys here: the KMS is asked with the
 * credentials of the environment, and refusals surface when the envelope is opened.
 *
 * @throws MongoShieldError `MS_NO_IDENTITY`
 */
export function assertCanDecrypt(
  manifest: Manifest,
  decryption: DecryptionOptions | undefined,
): void {
  if (manifest.encryption === null) return;
  if (isKmsBackup(manifest)) return;
  const hasIdentity = (decryption?.identities?.length ?? 0) > 0;
  const hasPassphrase = decryption?.passphrase !== undefined;

  if (manifest.encryption.keyFile !== undefined) {
    if (hasPassphrase) return;
    throw new MongoShieldError(
      "MS_NO_IDENTITY",
      `Backup ${manifest.id} is protected with a passphrase, but no passphrase was given.`,
      {
        hint: "This backup is protected with a passphrase: pass the passphrase used for the backup (age identities cannot open it).",
      },
    );
  }

  if (hasIdentity || hasPassphrase) return;
  const recipients = manifest.encryption.recipients.join(", ");
  throw new MongoShieldError(
    "MS_NO_IDENTITY",
    `Backup ${manifest.id} is encrypted (recipients: ${recipients}), but no identity or passphrase was given.`,
    {
      hint: "Pass the age identity (AGE-SECRET-KEY-1…, e.g. --identity key.txt) or the passphrase used for the backup.",
    },
  );
}

/**
 * Prepares to read an encrypted or plain backup: checks the keys (`assertCanDecrypt`)
 * and, for passphrase and KMS backups, unlocks the key envelope once, so every file
 * of the run is decrypted with the identity inside it (no scrypt or KMS call per
 * file).
 *
 * KMS backups: when a given identity is one of the backup's recovery recipients, it
 * opens the data files directly and the KMS is not contacted at all (the recovery
 * path must work when the KMS cannot be reached). Otherwise the envelope is unlocked
 * through the KMS named in it.
 *
 * @throws MongoShieldError `MS_NO_IDENTITY` for missing keys, `MS_DECRYPTION_FAILED` for
 *   a wrong passphrase or a refused KMS call (hint: the missing permission),
 *   `MS_CONFIG_INVALID` when a KMS SDK is not installed, `MS_INTEGRITY_FAILED` /
 *   `MS_STORAGE_NOT_FOUND` for a damaged or missing key envelope, `MS_ABORTED`.
 */
export async function openBackupSource(
  storage: StorageAdapter,
  manifest: Manifest,
  decryption: DecryptionOptions | undefined,
  options: ReadOptions = {},
): Promise<StoredBackupSource> {
  assertCanDecrypt(manifest, decryption);
  const keyFile = manifest.encryption?.keyFile;
  if (keyFile === undefined) return sourceFromManifest(storage, manifest, decryption);

  if (isKmsBackup(manifest)) {
    const recoveryIdentities = matchingIdentities(manifest, decryption);
    if (recoveryIdentities.length > 0) {
      return sourceFromManifest(storage, manifest, { identities: recoveryIdentities });
    }
    const identity = await unlockBackupKey(
      storage,
      manifest.id,
      keyFile,
      { keyUnwrappers: [createKmsKeyUnwrapper()] },
      options,
    );
    return sourceFromManifest(storage, manifest, { identities: [identity] });
  }

  if (decryption?.passphrase === undefined) {
    return sourceFromManifest(storage, manifest, decryption);
  }
  const identity = await unlockBackupKey(
    storage,
    manifest.id,
    keyFile,
    { decryption: { passphrase: decryption.passphrase } },
    options,
  );
  return sourceFromManifest(storage, manifest, { identities: [identity] });
}

/**
 * The given identities whose recipient (`age1…`) the manifest lists, i.e. that open
 * every data file directly. Invalid identity strings fail with MS_CONFIG_INVALID,
 * as they would when decrypting.
 */
function matchingIdentities(
  manifest: Manifest,
  decryption: DecryptionOptions | undefined,
): string[] {
  const listed = new Set(manifest.encryption?.recipients ?? []);
  return (decryption?.identities ?? []).filter((identity) =>
    listed.has(identityToRecipient(identity)),
  );
}

/**
 * Decrypts a backup's key envelope (after checking its size and SHA-256) with the
 * passphrase or the KMS unwrapper, and returns the age identity inside it.
 */
export async function unlockBackupKey(
  storage: StorageAdapter,
  backupId: string,
  keyFile: StoredFile,
  keys: Pick<StoredBackupSource, "decryption" | "keyUnwrappers">,
  options: ReadOptions,
): Promise<string> {
  const source: StoredBackupSource = {
    storage,
    backupId,
    compression: "none",
    encrypted: true,
    ...keys,
  };
  const plaintext = await readSmallFile(source, keyFile, MAX_KEY_FILE_BYTES, options.signal);
  let identities: string[] = [];
  let cause: unknown;
  try {
    identities = parseIdentityFile(plaintext.toString("utf8"));
  } catch (error) {
    cause = error;
  } finally {
    // Best effort: wipe our copy of the decrypted secret.
    plaintext.fill(0);
  }

  const [identity] = identities;
  if (identity === undefined) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The key file ${keyFile.key} decrypted, but does not contain an age identity.`,
      { cause, hint: "The backup's key file is damaged. Restore from another backup." },
    );
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Data files
// ---------------------------------------------------------------------------

/**
 * Opens one stored data file as an object-mode stream of raw BSON documents
 * (one Buffer per document, unparsed).
 *
 * The stream fails with:
 * - `MS_STORAGE_NOT_FOUND` when the file is missing;
 * - `MS_INTEGRITY_FAILED` when its size or SHA-256 differs from the manifest, or its
 *   content is not valid compressed BSON;
 * - `MS_NO_IDENTITY` / `MS_DECRYPTION_FAILED` when it cannot be decrypted with the keys;
 * - `MS_ABORTED` when the signal fires.
 *
 * Documents arrive before the checksum can be compared (that needs the last byte),
 * so a consumer must read to the end, and treat the data as valid only if the
 * stream ends without an error.
 */
export function openDocumentStream(
  source: StoredBackupSource,
  file: StoredFile,
  options: ReadOptions = {},
): Readable {
  return Readable.from(readDocuments(source, file, options.signal), { objectMode: true });
}

/** The generator behind `openDocumentStream`: yields documents, explains failures. */
async function* readDocuments(
  source: StoredBackupSource,
  file: StoredFile,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  throwIfAborted(signal);
  const stages = [createIntegrityCheck(file)];
  if (source.encrypted) stages.push(createDecryptor(source));
  stages.push(createDecompressor(source.compression));

  const stored = await getStoredFile(source, file, signal);
  const documents = connect(stored, stages, createBsonSplitter());
  try {
    for await (const document of documents) {
      throwIfAborted(signal);
      yield document as Buffer;
    }
  } catch (error) {
    throw await explainReadFailure(error, source, file, signal);
  } finally {
    // Stops the storage download when the consumer stops early or fails.
    documents.destroy();
  }
}

// ---------------------------------------------------------------------------
// Metadata files
// ---------------------------------------------------------------------------

/**
 * Reads and parses one `<collection>.metadata.json[.age]` file. Metadata files are
 * never compressed, but are encrypted when the backup is.
 *
 * @throws MongoShieldError as `openDocumentStream`, plus `MS_INTEGRITY_FAILED` /
 *   `MS_FORMAT_UNSUPPORTED` from `parseCollectionMetadata` for malformed content.
 */
export async function readMetadataFile(
  source: StoredBackupSource,
  file: StoredFile,
  options: ReadOptions = {},
): Promise<CollectionMetadata> {
  const bytes = await readSmallFile(source, file, MAX_METADATA_BYTES, options.signal);
  return parseCollectionMetadata(bytes.toString("utf8"), file.key);
}

/**
 * Reads a small, uncompressed stored file (metadata, key envelope) into memory:
 * integrity check, then decryption when the source is encrypted.
 */
async function readSmallFile(
  source: StoredBackupSource,
  file: StoredFile,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  throwIfAborted(signal);
  const stages = [createIntegrityCheck(file)];
  if (source.encrypted) stages.push(createDecryptor(source));

  const stored = await getStoredFile(source, file, signal);
  const plaintext = connect(stored, stages.slice(0, -1), lastOf(stages));
  try {
    return await readStreamToBuffer(plaintext, { maxBytes });
  } catch (error) {
    throw await explainReadFailure(error, source, file, signal);
  } finally {
    plaintext.destroy();
  }
}

// ---------------------------------------------------------------------------
// Checksums only
// ---------------------------------------------------------------------------

/** What `checkStoredFile` found. */
export type StoredFileCheck =
  | { readonly ok: true; readonly size: number }
  | { readonly ok: false; readonly size: number; readonly problem: string };

/**
 * Streams a stored file and compares its size and SHA-256 with the manifest,
 * without decrypting or decompressing anything (no key needed). Used by fast
 * verification and to explain read failures.
 *
 * A missing file is reported as a problem, not thrown. Other storage errors and
 * aborts are thrown.
 */
export async function checkStoredFile(
  source: Pick<StoredBackupSource, "storage" | "backupId">,
  file: StoredFile,
  options: ReadOptions = {},
): Promise<StoredFileCheck> {
  let stored: Readable;
  try {
    stored = await getStoredFile(source, file, options.signal);
  } catch (error) {
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) {
      return { ok: false, size: 0, problem: "The file is missing from storage." };
    }
    throw error;
  }

  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of stored) {
      throwIfAborted(options.signal);
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.length;
    }
  } finally {
    stored.destroy();
  }

  const problem = describeDigestMismatch(file, size, hash.digest("hex"));
  return problem === undefined ? { ok: true, size } : { ok: false, size, problem };
}

// ---------------------------------------------------------------------------
// Pipeline pieces
// ---------------------------------------------------------------------------

/** Opens the stored object for a manifest file entry. */
async function getStoredFile(
  source: Pick<StoredBackupSource, "storage" | "backupId">,
  file: StoredFile,
  signal: AbortSignal | undefined,
): Promise<Readable> {
  const key = resolveBackupKey(source.backupId, file.key);
  return source.storage.get(key, signal ? { signal } : {});
}

/**
 * Connects `first → stages… → last` and returns `last`. Any error in any stage
 * destroys every stage with that error, so it surfaces when `last` is read.
 */
function connect(first: Readable, stages: readonly Transform[], last: Transform): Transform {
  // The callback is required by the callback form of pipeline; errors reach the
  // reader through `last`, which pipeline destroys with the first error.
  pipeline([first, ...stages, last], () => {});
  return last;
}

function lastOf(stages: readonly Transform[]): Transform {
  const last = stages.at(-1);
  if (last === undefined) throw new MongoShieldError("MS_INTERNAL", "Empty read pipeline.");
  return last;
}

/** Validates the keys up front (bad key strings fail before any download). */
function createDecryptor(source: StoredBackupSource): Transform {
  const { decryption, keyUnwrappers } = source;
  return createDecryptStream({
    ...(keyUnwrappers ? { keyUnwrappers } : {}),
    ...(decryption?.identities ? { identities: decryption.identities } : {}),
    ...(decryption?.passphrase !== undefined ? { passphrase: decryption.passphrase } : {}),
  });
}

/**
 * A pass-through stream that hashes and counts the stored bytes and fails when
 * they differ from the manifest: as soon as there are more bytes than recorded,
 * otherwise at the end.
 */
function createIntegrityCheck(file: StoredFile): Transform {
  const hash = createHash("sha256");
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      size += chunk.length;
      if (size > file.size) {
        callback(integrityError(file, `it is longer than the recorded ${file.size} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback: TransformCallback) {
      const problem = describeDigestMismatch(file, size, hash.digest("hex"));
      callback(problem === undefined ? null : integrityError(file, problem));
    },
  });
}

/** A human-readable description of a size/checksum mismatch, or undefined when it matches. */
function describeDigestMismatch(
  file: StoredFile,
  size: number,
  sha256: string,
): string | undefined {
  if (size !== file.size) {
    return `Its size is ${size} bytes, but the manifest recorded ${file.size} bytes (truncated or modified).`;
  }
  if (sha256 !== file.sha256) {
    return "Its SHA-256 does not match the manifest (the file was modified or corrupted).";
  }
  return undefined;
}

function integrityError(file: StoredFile, problem: string): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `Backup file ${file.key} failed its integrity check: ${problem}`,
    {
      hint: "The backup is damaged. Run `mongoshield verify` and restore from another backup.",
      details: { key: file.key, stage: CHECKSUM_STAGE },
    },
  );
}

/**
 * Turns a failure in a later stage into the most useful error (see the header comment).
 * Aborts, missing files and checksum failures are returned unchanged.
 */
async function explainReadFailure(
  error: unknown,
  source: StoredBackupSource,
  file: StoredFile,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (signal?.aborted) return abortError(signal);
  if (!isCorruptionSymptom(error)) return error;

  try {
    const check = await checkStoredFile(source, file, { signal });
    if (!check.ok) {
      return new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `Backup file ${file.key} failed its integrity check: ${check.problem}`,
        {
          cause: error,
          hint: "The backup is damaged. Run `mongoshield verify` and restore from another backup.",
          details: { key: file.key, stage: CHECKSUM_STAGE },
        },
      );
    }
  } catch {
    // The re-check is only an explanation; if it fails too, report the original error.
  }
  return error;
}

/**
 * Errors that a modified file could cause in the decrypt / decompress / split
 * stages. That includes `MS_NO_IDENTITY`: a damaged recipient stanza in the age
 * header looks exactly like a key that does not match, and only the checksum can
 * tell the two apart.
 */
function isCorruptionSymptom(error: unknown): boolean {
  if (isMongoShieldError(error, "MS_DECRYPTION_FAILED")) return true;
  if (isMongoShieldError(error, "MS_NO_IDENTITY")) return true;
  if (isMongoShieldError(error, "MS_INTEGRITY_FAILED")) {
    return error.details?.stage !== CHECKSUM_STAGE;
  }
  return false;
}
