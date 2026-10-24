/**
 * The base64 flavour used throughout age headers.
 *
 * age uses standard base64 (RFC 4648 §4) *without* `=` padding. The spec
 * ("Conventions used in this document") requires encoders to produce canonical
 * output and decoders to reject non-canonical input and any `=` padding.
 * Non-canonical means the unused low bits of the last character are not zero,
 * which would let two different strings decode to the same bytes (malleability).
 */

/** Characters allowed in age base64: the standard alphabet, no padding, no URL-safe variants. */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*$/;

/** Encodes bytes as canonical, unpadded standard base64. */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "");
}

/** True if every character is in the base64 alphabet (an empty string qualifies). */
export function isBase64Text(text: string): boolean {
  return BASE64_CHARACTERS.test(text);
}

/**
 * Decodes canonical unpadded base64, or returns `undefined` if the text is not
 * valid canonical age base64.
 *
 * Node's decoder is lenient (it skips invalid characters and ignores non-zero
 * trailing bits), so we validate the alphabet first and then re-encode the
 * result: only canonical input survives the round trip unchanged.
 */
export function decodeBase64(text: string): Buffer | undefined {
  if (!isBase64Text(text)) return undefined;
  // A single leftover character carries only 6 bits, never a whole byte.
  if (text.length % 4 === 1) return undefined;
  const bytes = Buffer.from(text, "base64");
  if (encodeBase64(bytes) !== text) return undefined;
  return bytes;
}
