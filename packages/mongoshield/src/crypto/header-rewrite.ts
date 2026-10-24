/**
 * Header-only rewrite of age files: change who can open a file without
 * re-encrypting its contents (used by `rekeyBackups`, src/extras/rekey.ts).
 *
 * Why this works: an age file is
 *
 *     header (stanzas + MAC) || payload nonce || STREAM chunks
 *
 * and the payload is encrypted under HKDF(file key, payload nonce). The stanzas
 * only wrap that 16-byte file key for each recipient. So once the file key has
 * been recovered with a current identity (or passphrase, or KMS key), a new header
 * that wraps the SAME file key for a new set of recipients can be put in front of
 * the unchanged payload. The header MAC is keyed from the file key too, so it is
 * simply recomputed for the new stanzas (spec: "Header MAC").
 *
 * What this does NOT do: change the file key. Anyone who once could open the file
 * and kept a copy of its old header (or of the file key) can still open the
 * payload. Rekeying controls who can open the files from now on; it is not a
 * revocation of past access. See docs/specs/ENCRYPTION.md ("Rekeying").
 *
 * The rewrite is split in two so the expensive, key-holding part never streams data:
 *
 *   rewrapHeader          header bytes in → new header bytes out (needs keys)
 *   createHeaderReplacer  a Transform that swaps the header of a streamed file for
 *                         given bytes and passes the payload through (needs no keys)
 */

import type { Readable } from "node:stream";
import { Transform, type TransformCallback } from "node:stream";
import { MAX_HEADER_SIZE } from "./constants.ts";
import { type DecryptStreamOptions, prepareKeys, unwrapFileKey } from "./decrypt.ts";
import { type EncryptStreamOptions, planKeyWrapping, wrapFileKey } from "./encrypt.ts";
import { configError, headerError, headerMacError } from "./failures.ts";
import {
  assertPlausibleHeaderStart,
  encodeHeader,
  findHeaderEnd,
  parseHeader,
  type Stanza,
  verifyHeaderMac,
} from "./header.ts";
import { SCRYPT_STANZA_TYPE } from "./scrypt.ts";

/** What `rewrapHeader` needs. */
export interface RewrapHeaderOptions {
  /** Keys that open the CURRENT header (identities, passphrase or KMS unwrappers). */
  readonly unwrap: DecryptStreamOptions;
  /** Who can open the file afterwards: recipients, KMS wrappers, or a passphrase. */
  readonly wrap: EncryptStreamOptions;
  /**
   * Indexes of current stanzas to copy into the new header unchanged, before the
   * fresh ones. Used for stanzas whose recipient is not known by its public key
   * (a KMS backup's own one-off recipient, see src/extras/rekey.ts). Copying a stanza
   * is safe: it is an independent wrap of the same file key, and the new MAC covers it.
   */
  readonly keepStanzas?: readonly number[];
}

/**
 * Opens an age header, checks its MAC, and returns a new header that wraps the same
 * file key as described by `options`. The input must be exactly one complete header
 * (as returned by `readAgeHeader`).
 *
 * @throws MS_NO_IDENTITY when no given key opens the header, MS_DECRYPTION_FAILED for
 *   a malformed or tampered header or a wrong passphrase, MS_CONFIG_INVALID for
 *   invalid new recipients or a passphrase combined with kept stanzas.
 */
export async function rewrapHeader(header: Buffer, options: RewrapHeaderOptions): Promise<Buffer> {
  const parsed = parseHeader(header);
  const fileKey = await unwrapFileKey(parsed, prepareKeys(options.unwrap));
  try {
    // Never re-sign a header we could not authenticate: that would launder a
    // modified header into one with a valid MAC.
    if (!verifyHeaderMac(parsed, fileKey)) throw headerMacError();

    const kept = keptStanzas(parsed.stanzas, options.keepStanzas ?? []);
    // Kept stanzas alone are a valid header (a KMS backup whose last recovery
    // recipient is removed keeps only its own stanza), so an empty wrap is allowed then.
    if (kept.length > 0 && isEmptyWrap(options.wrap)) return encodeHeader(kept, fileKey);

    const plan = planKeyWrapping(options.wrap);
    if (plan.kind === "passphrase" && kept.length > 0) {
      // The age spec allows an scrypt stanza only as the sole stanza of a file.
      throw configError(
        "A passphrase cannot be combined with other stanzas in one age file.",
        "Rekey a passphrase backup to a new passphrase only.",
      );
    }
    const fresh = await wrapFileKey(plan, fileKey);
    return encodeHeader([...kept, ...fresh], fileKey);
  } finally {
    // Best effort: the file key is the one secret that opens the payload.
    fileKey.fill(0);
  }
}

/** True when `wrap` names nobody: no recipients, no key wrappers, no passphrase. */
function isEmptyWrap(wrap: EncryptStreamOptions): boolean {
  return (
    (wrap.recipients ?? []).length === 0 &&
    (wrap.keyWrappers ?? []).length === 0 &&
    wrap.passphrase === undefined
  );
}

/** The stanzas at `indexes`, validated: they must exist and must not be scrypt stanzas. */
function keptStanzas(stanzas: readonly Stanza[], indexes: readonly number[]): Stanza[] {
  const kept: Stanza[] = [];
  for (const index of indexes) {
    const stanza = stanzas[index];
    if (stanza === undefined) {
      throw headerError(`the header has no stanza #${index + 1} to keep.`);
    }
    if (stanza.args[0] === SCRYPT_STANZA_TYPE) {
      throw headerError("a passphrase (scrypt) stanza cannot be kept next to other stanzas.");
    }
    kept.push(stanza);
  }
  return kept;
}

/**
 * Reads just the header of an age file from the start of `stream`, then destroys
 * the stream (the payload is not needed). Memory is bounded by the 1 MiB header limit.
 *
 * @throws MS_DECRYPTION_FAILED when the data is not an age file or the header is
 *   incomplete or too large.
 */
export async function readAgeHeader(stream: Readable): Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      buffered = Buffer.concat([buffered, chunk as Buffer]);
      assertPlausibleHeaderStart(buffered);
      const end = findHeaderEnd(buffered);
      if (end !== undefined && end <= MAX_HEADER_SIZE) return buffered.subarray(0, end);
      if (buffered.length > MAX_HEADER_SIZE) {
        throw headerError(`the header is larger than ${MAX_HEADER_SIZE} bytes.`);
      }
    }
  } finally {
    stream.destroy();
  }
  throw headerError("the header is incomplete (truncated file?).");
}

/**
 * A Transform that drops the age header of the file streamed through it, emits
 * `newHeader` in its place, and passes every following byte (payload nonce and
 * chunks) through unchanged, with normal backpressure. Needs no keys: the new header
 * was prepared by `rewrapHeader`.
 *
 * When `expectedOldHeader` is given, the header found must be exactly those bytes,
 * so a file that changed since the new header was prepared is never rewritten with it.
 */
export function createHeaderReplacer(newHeader: Buffer, expectedOldHeader?: Buffer): Transform {
  let pending: Buffer | undefined = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      // After the header has been replaced, everything else passes straight through.
      if (pending === undefined) {
        callback(null, chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      try {
        assertPlausibleHeaderStart(pending);
        const end = findHeaderEnd(pending);
        if (end === undefined) {
          if (pending.length > MAX_HEADER_SIZE) {
            throw headerError(`the header is larger than ${MAX_HEADER_SIZE} bytes.`);
          }
          callback();
          return;
        }
        const oldHeader = pending.subarray(0, end);
        if (expectedOldHeader !== undefined && !oldHeader.equals(expectedOldHeader)) {
          throw headerError(
            "the file's header changed since the rekey was prepared.",
            "Another process rewrote the file. Run the rekey again.",
          );
        }
        const rest = pending.subarray(end);
        pending = undefined;
        this.push(newHeader);
        callback(null, rest);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback: TransformCallback) {
      callback(
        pending === undefined ? null : headerError("the header is incomplete (truncated file?)."),
      );
    },
  });
}
