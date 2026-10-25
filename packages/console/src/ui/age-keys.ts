/**
 * age key pairs made in the browser, for "Who can read the backups" in the plan editor.
 *
 * An age X25519 key pair has two halves:
 *
 *   public key   age1…               safe to share; anyone can encrypt backups for it
 *   private key  AGE-SECRET-KEY-1…   the only thing that can decrypt them; keep it secret
 *
 * Everything here runs in the browser with WebCrypto: the private key is never sent to
 * the console server. The strings are encoded exactly like age (and the library's
 * packages/mongoshield/src/crypto/keys.ts): Bech32 (BIP 173, not Bech32m) of the raw
 * 32-byte keys, the public key lowercase with prefix "age", the private key uppercase
 * with prefix "AGE-SECRET-KEY-". So `mongoshield`, `age` and `rage` all read them.
 *
 * The library's own Bech32 encoder is not imported because it uses Node's `Buffer`
 * and the library's entry point pulls in node:crypto, which the browser bundle cannot
 * load; the small encoder below mirrors packages/mongoshield/src/crypto/bech32.ts.
 *
 * Also here: the age key file text (`# created: …`, `# public key: …`, the secret line)
 * the panel offers as a download, and reading the private keys back out of such a file.
 */

/** The Bech32 prefix ("human-readable part") of age public keys. */
const RECIPIENT_HRP = "age";

/** The Bech32 prefix of age private keys; uppercase, so the whole key is uppercased. */
const IDENTITY_HRP = "AGE-SECRET-KEY-";

/** X25519 keys (public and private) are 32 bytes. */
const KEY_SIZE = 32;

/**
 * The DER header WebCrypto puts before an X25519 private key in PKCS#8 (RFC 8410):
 * SEQUENCE { version 0, AlgorithmIdentifier { OID 1.3.101.110 (X25519) },
 * OCTET STRING { OCTET STRING (32 bytes) } }. The 32 bytes after it are the scalar.
 */
const PKCS8_X25519_PREFIX = "302e020100300506032b656e04220420";

/** The 32 characters of the Bech32 alphabet, indexed by 5-bit value. */
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Bech32's checksum generator constants (BIP 173, "Checksum"). */
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

/** A key pair in age's text format. */
export interface AgeKeyPair {
  /** The public key, `age1…`: goes in the plan's recipients. */
  readonly publicKey: string;
  /** The private key, `AGE-SECRET-KEY-1…`: shown once, never stored or sent anywhere. */
  readonly privateKey: string;
}

/**
 * Thrown when this browser cannot make X25519 keys: WebCrypto is missing (pages opened
 * over plain http:// on another machine get no `crypto.subtle`) or it has no X25519
 * (Chrome/Edge before 133, Firefox before 130, Safari before 17). The UI then explains
 * how to make a key with `mongoshield keygen` or `age-keygen` instead.
 */
export class AgeKeysUnsupportedError extends Error {
  /** True when WebCrypto itself is missing, which usually means an insecure (http://) page. */
  readonly insecureContext: boolean;

  constructor(insecureContext: boolean) {
    super(
      insecureContext
        ? "This page has no Web Crypto (open the console over HTTPS or on localhost)."
        : "This browser cannot create X25519 keys.",
    );
    this.name = "AgeKeysUnsupportedError";
    this.insecureContext = insecureContext;
  }
}

/* ------------------------------------------------------------------------------------ */
/* Bech32 (encoding only; mirrors the library's bech32.ts)                               */
/* ------------------------------------------------------------------------------------ */

/** BIP 173 polymod: the BCH code behind the 6-character checksum. */
function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit] ?? 0;
    }
  }
  return checksum;
}

/** The values the checksum covers for the prefix: high bits, a 0, then low bits. */
function expandHrp(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (let index = 0; index < hrp.length; index++) {
    const code = hrp.charCodeAt(index);
    high.push(code >>> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/** Regroups bytes (8 bits each) into 5-bit words, zero-padding the last one. */
function toWords(bytes: Uint8Array): number[] {
  let accumulator = 0;
  let bitCount = 0;
  const words: number[] = [];
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      words.push((accumulator >>> bitCount) & 31);
    }
    // Keep only the bits not yet emitted so the number never grows past 32 bits.
    accumulator &= (1 << bitCount) - 1;
  }
  if (bitCount > 0) words.push((accumulator << (5 - bitCount)) & 31);
  return words;
}

/**
 * Encodes bytes as Bech32 (checksum constant 1, no length limit, as age uses it).
 * The checksum is always computed over the lowercase prefix; an uppercase prefix
 * (AGE-SECRET-KEY-) uppercases the whole result, exactly like age and the library.
 */
export function encodeBech32(hrp: string, data: Uint8Array): string {
  const lowerHrp = hrp.toLowerCase();
  const words = toWords(data);
  // The checksum: polymod over prefix + data + six zeros, XOR the Bech32 constant (1).
  const mod = polymod([...expandHrp(lowerHrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((index) => (mod >>> (5 * (5 - index))) & 31);
  let encoded = `${lowerHrp}1`;
  for (const word of [...words, ...checksum]) encoded += BECH32_CHARSET.charAt(word);
  return hrp !== lowerHrp && hrp === hrp.toUpperCase() ? encoded.toUpperCase() : encoded;
}

/* ------------------------------------------------------------------------------------ */
/* Key generation                                                                        */
/* ------------------------------------------------------------------------------------ */

/** Lowercase hex of some bytes, to compare the PKCS#8 header. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Takes the 32-byte private scalar out of WebCrypto's PKCS#8 export, after checking the
 * header is the X25519 one, so a browser returning anything unexpected fails loudly
 * instead of producing a key that cannot decrypt.
 */
export function scalarFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  const prefixLength = PKCS8_X25519_PREFIX.length / 2;
  if (
    pkcs8.length !== prefixLength + KEY_SIZE ||
    toHex(pkcs8.subarray(0, prefixLength)) !== PKCS8_X25519_PREFIX
  ) {
    throw new Error("The browser exported the private key in an unexpected format.");
  }
  // A copy, so the caller can wipe it without touching the export buffer (and vice versa).
  return pkcs8.slice(prefixLength);
}

/**
 * Creates a new age key pair in this browser. Throws `AgeKeysUnsupportedError` when the
 * browser cannot (see there), or an `Error` if it hands back keys in a form we do not
 * expect. Uses the page's `crypto.subtle` (tests replace it with `vi.stubGlobal`).
 */
export async function generateAgeKeyPair(): Promise<AgeKeyPair> {
  // No crypto.subtle at all: browsers hide it on insecure (plain http://) pages.
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new AgeKeysUnsupportedError(true);

  let keyPair: CryptoKeyPair;
  try {
    // Extractable, so we can export it; "deriveBits" is the only usage X25519 has.
    keyPair = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    // Browsers without X25519 reject with NotSupportedError (some with a TypeError).
    throw new AgeKeysUnsupportedError(false);
  }

  const publicBytes = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey));
  if (publicBytes.length !== KEY_SIZE) {
    throw new Error("The browser exported the public key in an unexpected format.");
  }
  const scalar = scalarFromPkcs8(pkcs8);
  try {
    return {
      publicKey: encodeBech32(RECIPIENT_HRP, publicBytes),
      privateKey: encodeBech32(IDENTITY_HRP, scalar),
    };
  } finally {
    // Best effort: do not leave raw secret bytes lying around in memory longer than needed.
    scalar.fill(0);
    pkcs8.fill(0);
  }
}

/* ------------------------------------------------------------------------------------ */
/* Key files                                                                             */
/* ------------------------------------------------------------------------------------ */

/**
 * The text of an age key file, the same format `age-keygen` and `mongoshield keygen`
 * write: two comment lines (when it was made, its public key), then the private key.
 */
export function ageKeyFileText(keyPair: AgeKeyPair, created: Date = new Date()): string {
  return [
    `# created: ${created.toISOString()}`,
    `# public key: ${keyPair.publicKey}`,
    keyPair.privateKey,
    "",
  ].join("\n");
}

/** The suggested download name, e.g. "mongoshield-backup-key-2026-10-25.txt". */
export function ageKeyFileName(created: Date = new Date()): string {
  // The UTC date part of the ISO timestamp: "2026-10-25".
  return `mongoshield-backup-key-${created.toISOString().slice(0, 10)}.txt`;
}

/** What an age private key line looks like (uppercase Bech32 after the prefix). */
const PRIVATE_KEY_LINE = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]+$/;

/**
 * The private keys in the text of a key file: every line that is an `AGE-SECRET-KEY-1…`
 * key, in order and without repeats. Comments (`# …`), blank lines and anything else are
 * skipped, so a key file from `age-keygen`, `mongoshield keygen` or this console works.
 * This only checks the shape; the server validates the key itself when it is used.
 */
export function privateKeysFromFileText(text: string): string[] {
  const keys: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (PRIVATE_KEY_LINE.test(line) && !keys.includes(line)) keys.push(line);
  }
  return keys;
}
