/**
 * Bech32 encoding (BIP 173) as used for age keys.
 *
 * age encodes X25519 recipients with human-readable part (HRP) `age` and
 * identities with HRP `AGE-SECRET-KEY-`. The age spec ("Conventions used in
 * this document") adopts BIP 173 with two clarifications:
 *
 * - there is **no length limit** on the data part (BIP 173 caps strings at 90 chars);
 * - strings are all-lowercase or all-uppercase, and the checksum is always
 *   computed over the lowercase form.
 *
 * This is the original Bech32, *not* Bech32m: the checksum constant is 1.
 * https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
 */

/** The 32 characters of the Bech32 data alphabet, indexed by 5-bit value. */
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Bech32's BCH checksum generator constants (BIP 173, "Checksum"). */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

/** The checksum residue for Bech32 (Bech32m would use 0x2bc830a3). */
const BECH32_CONSTANT = 1;

/** Number of checksum characters at the end of every Bech32 string. */
const CHECKSUM_LENGTH = 6;

/** The result of decoding a Bech32 string. */
export interface Bech32Decoded {
  /** Human-readable part, lowercased (the checksum is defined over lowercase). */
  readonly hrp: string;
  /** The decoded 8-bit payload. */
  readonly data: Buffer;
}

/** BIP 173 polymod: the BCH code that powers the checksum. */
function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit++) {
      if ((top >>> bit) & 1) checksum ^= GENERATOR[bit] ?? 0;
    }
  }
  return checksum;
}

/** Expands the HRP into the values the checksum covers: high bits, a 0 separator, low bits. */
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

function createChecksum(hrp: string, words: readonly number[]): number[] {
  const values = [...expandHrp(hrp), ...words, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ BECH32_CONSTANT;
  const checksum: number[] = [];
  for (let index = 0; index < CHECKSUM_LENGTH; index++) {
    checksum.push((mod >>> (5 * (5 - index))) & 31);
  }
  return checksum;
}

function verifyChecksum(hrp: string, words: readonly number[]): boolean {
  return polymod([...expandHrp(hrp), ...words]) === BECH32_CONSTANT;
}

/**
 * Regroups a bit stream from `fromBits`-wide values into `toBits`-wide values.
 * With `pad`, leftover bits are zero-padded (used when encoding 8→5). Without
 * it (decoding 5→8), leftover bits must be fewer than `fromBits` and all zero,
 * otherwise the encoding is non-canonical and rejected.
 */
function convertBits(
  values: readonly number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] | undefined {
  let accumulator = 0;
  let bitCount = 0;
  const maxValue = (1 << toBits) - 1;
  const result: number[] = [];
  for (const value of values) {
    accumulator = (accumulator << fromBits) | value;
    bitCount += fromBits;
    while (bitCount >= toBits) {
      bitCount -= toBits;
      result.push((accumulator >>> bitCount) & maxValue);
    }
    // Keep only the bits not yet emitted so the accumulator never overflows.
    accumulator &= (1 << bitCount) - 1;
  }
  if (pad) {
    if (bitCount > 0) result.push((accumulator << (toBits - bitCount)) & maxValue);
  } else if (bitCount >= fromBits || accumulator !== 0) {
    return undefined;
  }
  return result;
}

/**
 * Encodes bytes as Bech32. The output is lowercase unless the HRP is
 * uppercase (as with `AGE-SECRET-KEY-`), in which case the whole string is
 * uppercased, as age does for identities.
 */
export function encodeBech32(hrp: string, data: Uint8Array): string {
  const lowerHrp = hrp.toLowerCase();
  const words = convertBits([...data], 8, 5, true) ?? [];
  const checksum = createChecksum(lowerHrp, words);
  let encoded = `${lowerHrp}1`;
  for (const word of [...words, ...checksum]) encoded += CHARSET.charAt(word);
  return hrp === hrp.toUpperCase() && hrp !== lowerHrp ? encoded.toUpperCase() : encoded;
}

/**
 * Decodes a Bech32 string, or returns `undefined` if it is malformed: mixed
 * case, characters outside the alphabet, a missing separator, a bad checksum
 * (including a Bech32m checksum) or non-zero padding bits.
 */
export function decodeBech32(text: string): Bech32Decoded | undefined {
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase()) return undefined;

  // The separator is the *last* "1": the HRP itself may contain "1".
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 1 + CHECKSUM_LENGTH > lower.length) return undefined;

  const hrp = lower.slice(0, separator);
  for (let index = 0; index < hrp.length; index++) {
    const code = hrp.charCodeAt(index);
    if (code < 33 || code > 126) return undefined;
  }

  const words: number[] = [];
  for (const character of lower.slice(separator + 1)) {
    const word = CHARSET.indexOf(character);
    if (word === -1) return undefined;
    words.push(word);
  }
  if (!verifyChecksum(hrp, words)) return undefined;

  const bytes = convertBits(words.slice(0, -CHECKSUM_LENGTH), 5, 8, false);
  if (bytes === undefined) return undefined;
  return { hrp, data: Buffer.from(bytes) };
}
