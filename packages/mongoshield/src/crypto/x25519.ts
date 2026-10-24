/**
 * The native age X25519 recipient type (spec: "The X25519 recipient type").
 *
 * Recipient side (wrapping the file key for a public key):
 *
 *     ephemeral secret = random(32)
 *     ephemeral share  = X25519(ephemeral secret, basepoint)
 *     shared secret    = X25519(ephemeral secret, recipient)
 *     wrap key         = HKDF-SHA-256(ikm = shared secret,
 *                                     salt = ephemeral share || recipient,
 *                                     info = "age-encryption.org/v1/X25519")
 *     body             = ChaCha20-Poly1305(wrap key, nonce = 12 zero bytes, file key)
 *     stanza           = "-> X25519 <base64(ephemeral share)>" + body
 *
 * Identity side reverses it with `shared secret = X25519(identity, share)`.
 *
 * node:crypto has no raw-bytes X25519 API, so keys are imported as KeyObjects:
 * private keys via a fixed PKCS#8 DER prefix (JWK import would also need the
 * public half), public keys via JWK.
 */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { WRAPPED_FILE_KEY_SIZE, X25519_INFO } from "./constants.ts";
import { headerError } from "./failures.ts";
import type { Stanza } from "./header.ts";
import { hkdf, open, seal, ZERO_NONCE } from "./primitives.ts";

/** X25519 scalars and points are both 32 bytes (RFC 7748). */
export const X25519_KEY_SIZE = 32;

/** The first stanza argument that identifies an X25519 stanza (case-sensitive). */
export const X25519_STANZA_TYPE = "X25519";

/**
 * DER encoding of a PKCS#8 PrivateKeyInfo for X25519 (OID 1.3.101.110), up to
 * the 32-byte private key that follows it:
 * SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.110 }, OCTET STRING { OCTET STRING (32) } }.
 */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** A raw X25519 key pair. */
export interface X25519KeyPair {
  readonly secretKey: Buffer;
  readonly publicKey: Buffer;
}

/** Imports a raw 32-byte X25519 secret as a node:crypto KeyObject. */
function importSecretKey(secretKey: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, secretKey]),
    format: "der",
    type: "pkcs8",
  });
}

/** Imports a raw 32-byte X25519 public key (a Montgomery u-coordinate). */
function importPublicKey(publicKey: Uint8Array): KeyObject {
  return createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: Buffer.from(publicKey).toString("base64url") },
    format: "jwk",
  });
}

/** Reads the raw 32-byte public key out of a KeyObject via its JWK form. */
function exportPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("X25519 key export did not include x");
  return Buffer.from(jwk.x, "base64url");
}

/** Reads the raw 32-byte secret out of a private KeyObject via its JWK form. */
function exportSecretKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.d !== "string") throw new Error("X25519 key export did not include d");
  return Buffer.from(jwk.d, "base64url");
}

/** Generates a fresh X25519 key pair from the CSPRNG. */
export function generateX25519KeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { secretKey: exportSecretKey(privateKey), publicKey: exportPublicKey(publicKey) };
}

/** `X25519(secret, basepoint)`: the public key for a 32-byte secret. */
export function x25519PublicKey(secretKey: Uint8Array): Buffer {
  return exportPublicKey(createPublicKey(importSecretKey(secretKey)));
}

/**
 * `X25519(secret, point)`, or `undefined` if the result is all zeros.
 *
 * The spec requires aborting on an all-zero shared secret: it means the peer
 * sent a low-order point, which would make the "secret" predictable. OpenSSL
 * already refuses to derive in that case (it throws), and we also check the
 * output explicitly so the guarantee does not depend on the OpenSSL version.
 */
function sharedSecret(secretKey: Uint8Array, point: Uint8Array): Buffer | undefined {
  let secret: Buffer;
  try {
    secret = diffieHellman({
      privateKey: importSecretKey(secretKey),
      publicKey: importPublicKey(point),
    });
  } catch {
    return undefined;
  }
  return secret.every((byte) => byte === 0) ? undefined : secret;
}

/** HKDF wrap key with salt = ephemeral share || recipient, as the spec defines. */
function deriveWrapKey(secret: Buffer, ephemeralShare: Buffer, recipient: Uint8Array): Buffer {
  return hkdf(secret, Buffer.concat([ephemeralShare, recipient]), X25519_INFO);
}

/** Wraps the file key for one X25519 recipient (raw 32-byte public key). */
export function wrapX25519(fileKey: Uint8Array, recipient: Uint8Array): Stanza {
  // A new ephemeral key for every stanza and every file (spec MUST).
  const ephemeral = generateX25519KeyPair();
  const secret = sharedSecret(ephemeral.secretKey, recipient);
  if (secret === undefined) {
    // Only reachable with a malicious low-order "recipient".
    throw new Error("X25519 recipient is a low-order point");
  }
  const wrapKey = deriveWrapKey(secret, ephemeral.publicKey, recipient);
  return {
    args: [X25519_STANZA_TYPE, encodeBase64(ephemeral.publicKey)],
    body: seal(wrapKey, ZERO_NONCE, fileKey),
  };
}

/**
 * Tries to unwrap an X25519 stanza with one identity key pair.
 *
 * Returns the file key, or `undefined` if this stanza is not for this identity
 * (the AEAD tag does not verify). Throws a header error for a malformed stanza,
 * because the spec says such stanzas MUST be rejected, not skipped:
 * - exactly two arguments, the second a canonical base64 32-byte share;
 * - a body of exactly 32 bytes, checked *before* decrypting (partitioning oracles);
 * - an all-zero shared secret aborts.
 */
export function unwrapX25519(stanza: Stanza, identity: X25519KeyPair): Buffer | undefined {
  const share = parseX25519Share(stanza);
  if (stanza.body.length !== WRAPPED_FILE_KEY_SIZE) {
    throw headerError(`X25519 stanza body must be ${WRAPPED_FILE_KEY_SIZE} bytes.`);
  }
  const secret = sharedSecret(identity.secretKey, share);
  if (secret === undefined) {
    throw headerError("X25519 stanza uses a low-order share (all-zero shared secret).");
  }
  return open(deriveWrapKey(secret, share, identity.publicKey), ZERO_NONCE, stanza.body);
}

/** Validates the X25519 stanza arguments and returns the decoded ephemeral share. */
function parseX25519Share(stanza: Stanza): Buffer {
  if (stanza.args.length !== 2) {
    throw headerError("X25519 stanza must have exactly one argument after its type.");
  }
  const share = decodeBase64(stanza.args[1] ?? "");
  if (share === undefined || share.length !== X25519_KEY_SIZE) {
    throw headerError("X25519 stanza share is not canonical base64 of 32 bytes.");
  }
  return share;
}
