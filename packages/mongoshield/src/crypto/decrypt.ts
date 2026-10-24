/**
 * Streaming age v1 decryption.
 *
 * The input is processed in three phases:
 *
 * 1. header  buffer until the "---" MAC line arrives (at most 1 MiB), parse it
 *            strictly, unwrap the file key with an identity or the passphrase,
 *            then verify the header MAC;
 * 2. nonce   read the 16-byte payload nonce and derive the payload key;
 * 3. payload open STREAM chunks one at a time.
 *
 * Security properties (spec: "Payload"):
 *
 * - Plaintext is pushed downstream only after its chunk's Poly1305 tag has
 *   verified, so consumers never see unauthenticated bytes.
 * - Every full-size chunk is first tried as a non-final chunk. If it
 *   authenticates, it is released at once: the flag proves more chunks follow.
 * - A full-size chunk that fails as non-final may be a full final chunk, so it
 *   is held until more data arrives (then: corruption or trailing data) or the
 *   input ends (then it must open as final).
 * - Whatever remains at end of input must open as the final chunk. Truncation
 *   at a chunk boundary leaves no final chunk; an empty final chunk is only
 *   valid for an empty file; data after a final chunk is rejected.
 * - Memory is bounded by the header limit plus about one encrypted chunk.
 */

import { Transform, type TransformCallback } from "node:stream";
import { MongoShieldError } from "../errors.ts";
import { ByteQueue } from "./byte-queue.ts";
import {
  ENCRYPTED_CHUNK_SIZE,
  FILE_KEY_SIZE,
  MAX_HEADER_SIZE,
  PAYLOAD_NONCE_SIZE,
} from "./constants.ts";
import {
  configError,
  headerError,
  headerMacError,
  noIdentityError,
  payloadError,
  unexpectedDecryptionError,
  wrongPassphraseError,
} from "./failures.ts";
import {
  assertPlausibleHeaderStart,
  type FileKeyUnwrapper,
  findHeaderEnd,
  type ParsedHeader,
  parseHeader,
  verifyHeaderMac,
} from "./header.ts";
import { parseIdentity } from "./keys.ts";
import { DEFAULT_MAX_SCRYPT_WORK_FACTOR, SCRYPT_STANZA_TYPE, unwrapScrypt } from "./scrypt.ts";
import { ChunkCipher, derivePayloadKey } from "./stream-cipher.ts";
import { unwrapX25519, X25519_STANZA_TYPE, type X25519KeyPair } from "./x25519.ts";

/**
 * Options for `createDecryptStream`. At least one identity, a passphrase or a key
 * unwrapper is required.
 */
export interface DecryptStreamOptions {
  /** X25519 identities (`AGE-SECRET-KEY-1…`); any one matching a stanza suffices. */
  readonly identities?: readonly string[];
  /** Passphrase for files encrypted with a passphrase (scrypt stanza). */
  readonly passphrase?: string;
  /**
   * Refuse scrypt stanzas above this log2 work factor (default 22, as the `age`
   * CLI). Protects against files crafted to exhaust CPU and memory.
   */
  readonly maxScryptWorkFactor?: number;
  /**
   * Openers for stanzas of custom types (MongoShield: cloud KMS stanzas, see
   * src/crypto/kms). Tried after the X25519 identities, on every stanza they
   * recognise. Stanzas no unwrapper recognises are ignored, as the spec requires.
   */
  readonly keyUnwrappers?: readonly FileKeyUnwrapper[];
}

/** Highest value accepted for `maxScryptWorkFactor` (2^30 would need 1 TiB of memory). */
const MAX_ALLOWED_WORK_FACTOR_LIMIT = 30;

/** The keys we may unwrap with, after options are validated. */
export interface UnwrapKeys {
  readonly identities: readonly X25519KeyPair[];
  readonly keyUnwrappers: readonly FileKeyUnwrapper[];
  readonly passphrase: string | undefined;
  readonly maxScryptWorkFactor: number;
}

/** Where the decryptor is in the file. */
type DecryptState =
  | { readonly phase: "header" }
  | { readonly phase: "nonce"; readonly fileKey: Buffer }
  | { readonly phase: "payload"; readonly cipher: ChunkCipher };

/**
 * Validates options up front; key errors never echo the secret. Exported for the
 * header-only rewrite of `header-rewrite.ts` (rekeying), which unwraps like a decryptor.
 */
export function prepareKeys(options: DecryptStreamOptions): UnwrapKeys {
  const identities = (options.identities ?? []).map((identity) => parseIdentity(identity));
  const keyUnwrappers = options.keyUnwrappers ?? [];
  const { passphrase } = options;
  const maxScryptWorkFactor = options.maxScryptWorkFactor ?? DEFAULT_MAX_SCRYPT_WORK_FACTOR;

  if (
    !Number.isInteger(maxScryptWorkFactor) ||
    maxScryptWorkFactor < 1 ||
    maxScryptWorkFactor > MAX_ALLOWED_WORK_FACTOR_LIMIT
  ) {
    throw configError(
      `maxScryptWorkFactor must be an integer from 1 to ${MAX_ALLOWED_WORK_FACTOR_LIMIT}.`,
      `Leave it at the default (${DEFAULT_MAX_SCRYPT_WORK_FACTOR}) unless a trusted file needs more.`,
    );
  }
  if (passphrase !== undefined && passphrase.length === 0) {
    throw configError("The decryption passphrase is empty.", "Provide the backup's passphrase.");
  }
  if (identities.length === 0 && passphrase === undefined && keyUnwrappers.length === 0) {
    throw new MongoShieldError(
      "MS_NO_IDENTITY",
      "Decryption needs at least one identity or a passphrase.",
      { hint: "Pass the age identity (AGE-SECRET-KEY-1…) or passphrase used for the backup." },
    );
  }
  return { identities, keyUnwrappers, passphrase, maxScryptWorkFactor };
}

/**
 * Recovers the file key from the header's stanzas.
 *
 * Unrecognized stanza types are ignored, as the spec requires. An scrypt
 * stanza must be the only stanza (spec: "scrypt recipient stanza"), which keeps
 * the implicit guarantee that a passphrase-encrypted file was made by someone
 * who knew the passphrase.
 */
export async function unwrapFileKey(header: ParsedHeader, keys: UnwrapKeys): Promise<Buffer> {
  const { stanzas } = header;
  const scryptStanza = stanzas.find((stanza) => stanza.args[0] === SCRYPT_STANZA_TYPE);
  if (scryptStanza !== undefined) {
    if (stanzas.length !== 1) throw headerError("an scrypt stanza must be the only stanza.");
    if (keys.passphrase === undefined) {
      throw noIdentityError(
        "The file is encrypted with a passphrase, but no passphrase was given.",
        "Provide the passphrase used when the backup was created.",
      );
    }
    const fileKey = await unwrapScrypt(scryptStanza, keys.passphrase, keys.maxScryptWorkFactor);
    if (fileKey === undefined) throw wrongPassphraseError();
    return fileKey;
  }

  // Local identities first: they are free, while custom unwrappers may call a
  // remote service (and be billed or audited per call).
  for (const stanza of stanzas) {
    if (stanza.args[0] !== X25519_STANZA_TYPE) continue;
    for (const identity of keys.identities) {
      const fileKey = unwrapX25519(stanza, identity);
      if (fileKey !== undefined) return fileKey;
    }
  }
  const customFileKey = await unwrapCustomStanzas(header, keys.keyUnwrappers);
  if (customFileKey !== undefined) return customFileKey;
  throw noIdentityError(
    "None of the given identities can decrypt this file.",
    keys.identities.length === 0
      ? "The file is encrypted to age recipients (public keys); provide the matching identity instead of a passphrase."
      : "Use the identity whose recipient (age1…) was used for this backup; it is listed in the backup manifest.",
  );
}

/**
 * Offers every stanza to the custom unwrappers. Returns the first file key found.
 *
 * An unwrapper that throws (say, access to one of two KMS keys is denied) does not
 * stop the search: another stanza may still open. Only when none does is the first
 * such error rethrown, because "access denied" says far more than "no identity".
 */
async function unwrapCustomStanzas(
  header: ParsedHeader,
  unwrappers: readonly FileKeyUnwrapper[],
): Promise<Buffer | undefined> {
  const failures: unknown[] = [];
  for (const stanza of header.stanzas) {
    // Native types are never handed to custom code.
    if (stanza.args[0] === X25519_STANZA_TYPE) continue;
    for (const unwrap of unwrappers) {
      let fileKey: Buffer | undefined;
      try {
        fileKey = await unwrap(stanza);
      } catch (error) {
        failures.push(error);
        continue;
      }
      if (fileKey === undefined) continue;
      // A file key is always 16 bytes; anything else means the stanza is not what
      // it claims to be. The header MAC would reject it too, but this is clearer.
      if (fileKey.length !== FILE_KEY_SIZE) {
        throw headerError(`a ${stanza.args[0] ?? ""} stanza did not yield a 16-byte file key.`);
      }
      return fileKey;
    }
  }
  if (failures.length > 0) throw failures[0];
  return undefined;
}

/**
 * Creates a Transform that decrypts an age v1 file written to it and emits
 * the authenticated plaintext.
 *
 * Throws MS_CONFIG_INVALID / MS_NO_IDENTITY synchronously for invalid options.
 * Stream errors: MS_NO_IDENTITY when no stanza matches, MS_DECRYPTION_FAILED
 * for everything else (`error.details.stage` says which part failed).
 */
export function createDecryptStream(options: DecryptStreamOptions): Transform {
  const keys = prepareKeys(options);
  const pending = new ByteQueue();
  let state: DecryptState = { phase: "header" };

  /** Header phase: returns true once the header is consumed and verified. */
  async function readHeader(): Promise<boolean> {
    const buffered = pending.peekAll();
    assertPlausibleHeaderStart(buffered);
    const headerEnd = findHeaderEnd(buffered);
    if (headerEnd === undefined || headerEnd > MAX_HEADER_SIZE) {
      if (buffered.length > MAX_HEADER_SIZE) {
        throw headerError(`the header is larger than ${MAX_HEADER_SIZE} bytes.`);
      }
      return false;
    }
    const header = parseHeader(pending.take(headerEnd));
    const fileKey = await unwrapFileKey(header, keys);
    // The MAC is checked only after unwrapping, because its key derives from
    // the file key. Until it verifies, nothing after the header is trusted.
    if (!verifyHeaderMac(header, fileKey)) throw headerMacError();
    state = { phase: "nonce", fileKey };
    return true;
  }

  /** Nonce phase: returns true once the 16-byte payload nonce has been read. */
  function readNonce(fileKey: Buffer): boolean {
    if (pending.length < PAYLOAD_NONCE_SIZE) return false;
    const payloadNonce = pending.take(PAYLOAD_NONCE_SIZE);
    state = { phase: "payload", cipher: new ChunkCipher(derivePayloadKey(fileKey, payloadNonce)) };
    return true;
  }

  /**
   * Opens and releases every complete chunk that can be decided now.
   * Stops when less than a full chunk is buffered, or when exactly one full
   * chunk is buffered that is not a valid non-final chunk (it may be the final
   * chunk; only the end of input or more data can tell).
   */
  function openAvailableChunks(stream: Transform, cipher: ChunkCipher): void {
    while (pending.length >= ENCRYPTED_CHUNK_SIZE) {
      const sealed = pending.peek(ENCRYPTED_CHUNK_SIZE);
      const plaintext = cipher.open(sealed, false);
      if (plaintext !== undefined) {
        pending.take(ENCRYPTED_CHUNK_SIZE);
        stream.push(plaintext);
        continue;
      }
      if (pending.length === ENCRYPTED_CHUNK_SIZE) return;
      // More data follows a chunk that is not a valid non-final chunk.
      rejectChunkBeforeMoreData(stream, cipher, pending.take(ENCRYPTED_CHUNK_SIZE));
    }
  }

  async function write(stream: Transform, chunk: Buffer): Promise<void> {
    pending.push(chunk);
    if (state.phase === "header" && !(await readHeader())) return;
    if (state.phase === "nonce" && !readNonce(state.fileKey)) return;
    if (state.phase === "payload") openAvailableChunks(stream, state.cipher);
  }

  /** End of input: whatever is left must be exactly one valid final chunk. */
  function finish(stream: Transform): void {
    if (state.phase === "header") {
      throw headerError(
        pending.length === 0
          ? "the input is empty."
          : "the header is incomplete (truncated file?).",
      );
    }
    if (state.phase === "nonce") throw headerError("the payload nonce is missing or truncated.");

    const { cipher } = state;
    const sealed = pending.takeAll();
    const isFirstChunk = cipher.chunkIndex === 0;
    if (sealed.length === 0) {
      throw payloadError(
        isFirstChunk
          ? "the payload has no chunks (truncated file?)."
          : "the file is truncated: the final chunk is missing.",
      );
    }
    const plaintext = cipher.open(sealed, true);
    if (plaintext === undefined) {
      throw payloadError(
        `final chunk ${cipher.chunkIndex} failed authentication (corrupted or truncated).`,
      );
    }
    // An empty final chunk is only valid as the sole chunk of an empty file.
    if (plaintext.length === 0 && !isFirstChunk) {
      throw payloadError("the final chunk is empty, which is only allowed for an empty file.");
    }
    stream.push(plaintext);
  }

  return new Transform({
    transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      write(this, chunk).then(
        () => done(),
        (error: unknown) => done(unexpectedDecryptionError(error)),
      );
    },
    flush(this: Transform, done: TransformCallback) {
      try {
        finish(this);
        done();
      } catch (error) {
        done(unexpectedDecryptionError(error));
      }
    },
  });
}

/**
 * Handles a full-size chunk that failed to open as non-final although more
 * data follows it. If it opens as the final chunk, it is genuine and
 * authenticated, so its plaintext is released (matching the reference
 * implementation) before rejecting the data appended after it. Otherwise the
 * chunk itself is corrupted. Always throws.
 */
function rejectChunkBeforeMoreData(stream: Transform, cipher: ChunkCipher, sealed: Buffer): never {
  const index = cipher.chunkIndex;
  const finalPlaintext = cipher.open(sealed, true);
  if (finalPlaintext === undefined) throw payloadError(`chunk ${index} failed authentication.`);
  stream.push(finalPlaintext);
  throw payloadError("unexpected data after the final chunk.");
}
