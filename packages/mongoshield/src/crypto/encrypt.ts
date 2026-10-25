/**
 * Streaming age v1 encryption.
 *
 * Output layout (spec: "Encrypted file format"):
 *
 *     header (text, see header.ts) || payload nonce (16 bytes) || STREAM chunks
 *
 * Plaintext is buffered only until a full 64 KiB chunk *and at least one more
 * byte* have arrived: a chunk can be sealed as "not last" only once we know
 * more data follows. At end of input the remainder (0..64 KiB) is sealed as
 * the final chunk, so the final chunk is empty only if the whole input was.
 * Memory therefore stays around one chunk regardless of input size.
 */

import { randomBytes } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { ByteQueue } from "./byte-queue.ts";
import { CHUNK_SIZE, FILE_KEY_SIZE, PAYLOAD_NONCE_SIZE } from "./constants.ts";
import { configError, encryptionError } from "./failures.ts";
import { encodeHeader, type FileKeyWrapper, type Stanza } from "./header.ts";
import { parseRecipient } from "./keys.ts";
import { prepareChaCha20Poly1305 } from "./primitives.ts";
import {
  DEFAULT_MAX_SCRYPT_WORK_FACTOR,
  DEFAULT_SCRYPT_WORK_FACTOR,
  wrapScrypt,
} from "./scrypt.ts";
import { ChunkCipher, derivePayloadKey } from "./stream-cipher.ts";
import { wrapX25519 } from "./x25519.ts";

/** Options for `createEncryptStream`. */
export interface EncryptStreamOptions {
  /** X25519 recipients (`age1…`). Any one of the matching identities can decrypt. */
  readonly recipients?: readonly string[];
  /**
   * Encrypt with a passphrase (scrypt) instead. The age format forbids mixing a
   * passphrase with other recipients in one file.
   */
  readonly passphrase?: string;
  /**
   * log2 of the scrypt cost N, only used with `passphrase`. Default 18 (as the
   * `age` CLI). Each step doubles CPU time and memory; at most 22, the default
   * limit of the `age` CLI and of `createDecryptStream`.
   */
  readonly scryptWorkFactor?: number;
  /**
   * Extra stanzas of custom types, each produced from the file key by a wrapper
   * (MongoShield uses this for cloud KMS stanzas, see src/crypto/kms). They are
   * added after the X25519 stanzas. Cannot be combined with a passphrase, for the
   * same reason as recipients: an scrypt stanza must be the only one in a file.
   */
  readonly keyWrappers?: readonly FileKeyWrapper[];
}

/** What the header needs, after options are validated. */
export type KeyWrapPlan =
  | {
      readonly kind: "recipients";
      readonly recipients: readonly Buffer[];
      readonly keyWrappers: readonly FileKeyWrapper[];
    }
  | { readonly kind: "passphrase"; readonly passphrase: string; readonly workFactor: number };

/**
 * Validates options up front, so misconfiguration fails before any data flows.
 * Exported for the header-only rewrite of `header-rewrite.ts` (rekeying).
 */
export function planKeyWrapping(options: EncryptStreamOptions): KeyWrapPlan {
  const recipients = options.recipients ?? [];
  const keyWrappers = options.keyWrappers ?? [];
  const { passphrase } = options;
  const workFactor = options.scryptWorkFactor ?? DEFAULT_SCRYPT_WORK_FACTOR;

  if (
    !Number.isInteger(workFactor) ||
    workFactor < 1 ||
    workFactor > DEFAULT_MAX_SCRYPT_WORK_FACTOR
  ) {
    throw configError(
      `scryptWorkFactor must be an integer from 1 to ${DEFAULT_MAX_SCRYPT_WORK_FACTOR}.`,
      `Use the default (${DEFAULT_SCRYPT_WORK_FACTOR}) unless you have measured a reason not to.`,
    );
  }
  if (passphrase !== undefined && (recipients.length > 0 || keyWrappers.length > 0)) {
    throw configError(
      "A passphrase cannot be combined with recipients in one age file.",
      "Use either recipients (recommended for unattended backups) or a passphrase.",
    );
  }
  if (passphrase !== undefined) {
    if (passphrase.length === 0) {
      throw configError("The encryption passphrase is empty.", "Provide a non-empty passphrase.");
    }
    return { kind: "passphrase", passphrase, workFactor };
  }
  if (recipients.length === 0 && keyWrappers.length === 0) {
    throw configError(
      "Encryption needs at least one recipient or a passphrase.",
      "Generate a key with `age-keygen -o key.txt` and configure its public recipient (age1…).",
    );
  }
  return {
    kind: "recipients",
    recipients: recipients.map((value) => parseRecipient(value)),
    keyWrappers,
  };
}

/** Builds the stanzas that wrap the file key according to the plan. */
export async function wrapFileKey(plan: KeyWrapPlan, fileKey: Buffer): Promise<Stanza[]> {
  // Loads the portable cipher on runtimes without a native one (see primitives.ts).
  // Every encryption wraps its file key before sealing anything, so this covers
  // the payload chunks too.
  await prepareChaCha20Poly1305();
  if (plan.kind === "passphrase") {
    return [await wrapScrypt(fileKey, plan.passphrase, plan.workFactor)];
  }
  const stanzas = plan.recipients.map((recipient) => wrapX25519(fileKey, recipient));
  // One at a time, in order, so the header is deterministic in stanza order and a
  // failing wrapper (e.g. KMS access denied) stops before calling the next service.
  for (const wrap of plan.keyWrappers) stanzas.push(await wrap(fileKey));
  return stanzas;
}

/**
 * Creates a Transform that age-encrypts everything written to it.
 *
 * Throws MS_CONFIG_INVALID synchronously for invalid options. Failures while
 * streaming surface as MS_ENCRYPTION_FAILED stream errors.
 */
export function createEncryptStream(options: EncryptStreamOptions): Transform {
  const plan = planKeyWrapping(options);
  const pending = new ByteQueue();
  let cipher: ChunkCipher | undefined;

  /**
   * Emits the header and payload nonce on first use. Done lazily because the
   * scrypt KDF is asynchronous and should not run for streams never written.
   */
  async function start(stream: Transform): Promise<ChunkCipher> {
    if (cipher !== undefined) return cipher;
    // Fresh file key and payload nonce for every file (spec MUSTs).
    const fileKey = randomBytes(FILE_KEY_SIZE);
    const payloadNonce = randomBytes(PAYLOAD_NONCE_SIZE);
    const header = encodeHeader(await wrapFileKey(plan, fileKey), fileKey);
    stream.push(Buffer.concat([header, payloadNonce]));
    cipher = new ChunkCipher(derivePayloadKey(fileKey, payloadNonce));
    return cipher;
  }

  /** Seals every chunk that is known not to be the last one. */
  async function write(stream: Transform, chunk: Buffer): Promise<void> {
    const chunkCipher = await start(stream);
    pending.push(chunk);
    // Strictly greater: with exactly 64 KiB buffered we cannot yet tell
    // whether this is the final chunk.
    while (pending.length > CHUNK_SIZE) {
      stream.push(chunkCipher.seal(pending.take(CHUNK_SIZE), false));
    }
  }

  /** Seals the remaining 0..64 KiB as the final chunk. */
  async function finish(stream: Transform): Promise<void> {
    const chunkCipher = await start(stream);
    stream.push(chunkCipher.seal(pending.takeAll(), true));
  }

  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      write(this, chunk).then(
        () => done(),
        (error: unknown) => done(encryptionError(error)),
      );
    },
    flush(this: Transform, done: TransformCallback) {
      finish(this).then(
        () => done(),
        (error: unknown) => done(encryptionError(error)),
      );
    },
  });
}
