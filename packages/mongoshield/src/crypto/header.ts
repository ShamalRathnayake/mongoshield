/**
 * The age v1 text header: encoding, strict parsing and the header MAC
 * (spec: "Header").
 *
 * Layout (every line ends with LF, never CRLF):
 *
 *     age-encryption.org/v1                          version line
 *     -> X25519 <base64 ephemeral share>             stanza argument line ("-> " + args)
 *     <base64 body, 64 columns per line>             zero or more full 64-char lines
 *     <final body line, 0–63 chars>                  always present, may be empty
 *     --- <base64 HMAC-SHA-256, 43 chars>            MAC line, ends the header
 *
 * The MAC covers every byte from the start of the header up to and including
 * the "---" (not the following space), keyed with
 * HKDF-SHA-256(ikm = file key, salt = empty, info = "header").
 *
 * Parsing is deliberately strict (exact spacing, canonical base64, line
 * lengths): the header is authenticated byte-for-byte, so accepting a looser
 * encoding would make files malleable.
 */

import { decodeBase64, encodeBase64, isBase64Text } from "./base64.ts";
import { HEADER_MAC_INFO, STANZA_LINE_COLUMNS, VERSION_LINE, VERSION_PREFIX } from "./constants.ts";
import { headerError } from "./failures.ts";
import { constantTimeEqual, hkdf, hmacSha256 } from "./primitives.ts";

/** One recipient stanza: its arguments (the first is the type) and decoded body. */
export interface Stanza {
  /** Space-separated arguments; `args[0]` is the stanza type, e.g. `X25519`. */
  readonly args: readonly string[];
  /** The decoded body bytes (for native types: the 32-byte wrapped file key). */
  readonly body: Buffer;
}

/**
 * Wraps a file key into a stanza of a type this module does not implement itself
 * (for MongoShield: the cloud KMS stanza, src/crypto/kms/stanza.ts). Called once per
 * encrypted file with that file's fresh 16-byte key. It may be asynchronous because
 * it typically calls a remote service. It must never put the file key itself into
 * the stanza's arguments.
 */
export type FileKeyWrapper = (fileKey: Buffer) => Promise<Stanza>;

/**
 * Tries to recover the file key from one stanza of a custom type.
 *
 * - returns `undefined` when the stanza is not of its type (so other unwrappers, or
 *   none, get a chance: the spec says unknown stanzas are ignored);
 * - returns the file key when it opened the stanza;
 * - throws when the stanza is of its type but could not be opened (e.g. access to
 *   the KMS key was denied). The decryptor keeps trying the other stanzas and only
 *   reports the error when no stanza opens.
 *
 * The returned key is still checked with the header MAC, so an unwrapper cannot
 * make the decryptor accept a modified header.
 */
export type FileKeyUnwrapper = (stanza: Stanza) => Promise<Buffer | undefined>;

/** A parsed header, ready for unwrapping and MAC verification. */
export interface ParsedHeader {
  readonly stanzas: readonly Stanza[];
  /** The 32-byte MAC from the "---" line. */
  readonly mac: Buffer;
  /** The exact bytes the MAC covers: start of header through "---". */
  readonly macInput: Buffer;
}

/** The MAC line marker; the MAC is computed over the header up to and including it. */
const MAC_MARKER = "---";

/** Prefix of a stanza argument line. */
const STANZA_PREFIX = "-> ";

/** The base64 encoding of a 32-byte HMAC-SHA-256 is 43 characters unpadded. */
const ENCODED_MAC_LENGTH = 43;

/** `argument = 1*VCHAR` in the spec's ABNF: printable ASCII 0x21–0x7E, no spaces. */
const ARGUMENT_PATTERN = /^[\x21-\x7e]+$/;

/** The version line as raw bytes, for prefix checks on binary input. */
const VERSION_LINE_BYTES = Buffer.from(VERSION_LINE, "latin1");

/**
 * True if the bytes start with the age v1 version line. Pass at least the
 * first 22 bytes of a file; shorter input is never reported as age.
 */
export function isAgeEncrypted(firstBytes: Uint8Array): boolean {
  if (firstBytes.length < VERSION_LINE_BYTES.length) return false;
  return Buffer.from(firstBytes.buffer, firstBytes.byteOffset, VERSION_LINE_BYTES.length).equals(
    VERSION_LINE_BYTES,
  );
}

/** The HMAC key for the header MAC: HKDF(ikm = file key, salt = empty, info = "header"). */
function headerMacKey(fileKey: Uint8Array): Buffer {
  return hkdf(fileKey, Buffer.alloc(0), HEADER_MAC_INFO);
}

/**
 * Encodes one stanza: the argument line, then the base64 body wrapped at 64
 * columns. The body must end with a line shorter than 64 characters, so a body
 * whose encoding is an exact multiple of 64 (including an empty body) gets an
 * extra empty line.
 */
function encodeStanza(stanza: Stanza): string {
  let text = `${STANZA_PREFIX}${stanza.args.join(" ")}\n`;
  const body = encodeBase64(stanza.body);
  for (let offset = 0; ; offset += STANZA_LINE_COLUMNS) {
    const line = body.slice(offset, offset + STANZA_LINE_COLUMNS);
    text += `${line}\n`;
    if (line.length < STANZA_LINE_COLUMNS) break;
  }
  return text;
}

/** Encodes a complete header, including the MAC line, for the given file key. */
export function encodeHeader(stanzas: readonly Stanza[], fileKey: Uint8Array): Buffer {
  let text = VERSION_LINE;
  for (const stanza of stanzas) text += encodeStanza(stanza);
  text += MAC_MARKER;
  const macInput = Buffer.from(text, "latin1");
  const mac = hmacSha256(headerMacKey(fileKey), macInput);
  return Buffer.concat([macInput, Buffer.from(` ${encodeBase64(mac)}\n`, "latin1")]);
}

/** Checks the header MAC in constant time. */
export function verifyHeaderMac(header: ParsedHeader, fileKey: Uint8Array): boolean {
  const expected = hmacSha256(headerMacKey(fileKey), header.macInput);
  return constantTimeEqual(expected, header.mac);
}

/**
 * Finds where the header ends in a buffer that starts at the beginning of the
 * file: the byte after the LF that terminates the first line starting with
 * "---". Returns `undefined` if that line has not fully arrived yet.
 *
 * No other header line can start with "---" (stanza lines start with "-> ",
 * body lines are base64), so the first such line is the MAC line.
 */
export function findHeaderEnd(buffer: Buffer): number | undefined {
  const markerLine = buffer.indexOf(`\n${MAC_MARKER}`, 0, "latin1");
  if (markerLine === -1) return undefined;
  const lineEnd = buffer.indexOf(0x0a, markerLine + 1);
  return lineEnd === -1 ? undefined : lineEnd + 1;
}

/**
 * Checks that the input could be the start of an age file, so garbage input
 * is rejected as soon as possible instead of after buffering a megabyte.
 */
export function assertPlausibleHeaderStart(buffer: Buffer): void {
  const length = Math.min(buffer.length, VERSION_PREFIX.length);
  if (!buffer.subarray(0, length).equals(Buffer.from(VERSION_PREFIX.slice(0, length), "latin1"))) {
    throw headerError(
      "the data does not start with an age header.",
      "This file is not age-encrypted. If the backup is unencrypted, do not pass decryption options.",
    );
  }
}

/** Validates the version line ("age-encryption.org/v1"). */
function checkVersionLine(line: string): void {
  if (`${line}\n` === VERSION_LINE) return;
  if (line.endsWith("\r")) throw headerError("header lines must end with LF, not CRLF.");
  if (line.startsWith(VERSION_PREFIX)) {
    throw headerError(
      "unsupported age format version.",
      "The file was written by a newer age implementation; upgrade MongoShield.",
    );
  }
  throw headerError("missing the age-encryption.org/v1 version line.");
}

/** Splits and validates a stanza argument line ("-> arg1 arg2 ..."). */
function parseArguments(line: string): string[] {
  const args = line.slice(STANZA_PREFIX.length).split(" ");
  for (const arg of args) {
    if (!ARGUMENT_PATTERN.test(arg)) {
      throw headerError("stanza arguments must be non-empty printable ASCII separated by a space.");
    }
  }
  return args;
}

/** Validates the MAC line ("--- " + 43 base64 chars) and decodes the MAC. */
function parseMacLine(line: string): Buffer {
  const encoded = line.slice(MAC_MARKER.length + 1);
  const mac =
    line.startsWith(`${MAC_MARKER} `) && encoded.length === ENCODED_MAC_LENGTH
      ? decodeBase64(encoded)
      : undefined;
  if (mac === undefined) throw headerError("the MAC line is malformed.");
  return mac;
}

/**
 * Parses a complete header (as delimited by `findHeaderEnd`), enforcing the
 * spec's ABNF exactly. Throws a header error on any deviation.
 */
export function parseHeader(header: Buffer): ParsedHeader {
  // latin1 maps each byte to one char, so any non-ASCII byte simply fails the
  // ASCII-only patterns below instead of being reinterpreted as UTF-8.
  const lines = header.toString("latin1").split("\n");
  // The header ends with LF, so the last split element must be empty.
  if (lines.pop() !== "") throw headerError("the header does not end with a line feed.");

  checkVersionLine(lines[0] ?? "");
  const stanzas: Stanza[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith(MAC_MARKER)) {
      if (index !== lines.length - 1) throw headerError("data after the MAC line.");
      if (stanzas.length === 0) throw headerError("the header contains no recipient stanzas.");
      const macInputLength = header.length - line.length - 1 + MAC_MARKER.length;
      return { stanzas, mac: parseMacLine(line), macInput: header.subarray(0, macInputLength) };
    }
    if (!line.startsWith(STANZA_PREFIX)) {
      throw headerError("expected a stanza line starting with '-> ' or the MAC line.");
    }
    const args = parseArguments(line);
    const body = parseStanzaBody(lines, index + 1);
    stanzas.push({ args, body: body.bytes });
    index = body.nextIndex;
  }
  throw headerError("the header has no MAC line.");
}

/**
 * Reads stanza body lines starting at `start`: full 64-column lines followed by
 * exactly one shorter (possibly empty) final line, then decodes the base64.
 */
function parseStanzaBody(
  lines: readonly string[],
  start: number,
): { bytes: Buffer; nextIndex: number } {
  let encoded = "";
  for (let index = start; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.length > STANZA_LINE_COLUMNS || !isBase64Text(line)) {
      throw headerError("stanza body lines must be base64 of at most 64 columns, ending short.");
    }
    encoded += line;
    if (line.length < STANZA_LINE_COLUMNS) {
      const bytes = decodeBase64(encoded);
      if (bytes === undefined) throw headerError("stanza body is not canonical base64.");
      return { bytes, nextIndex: index + 1 };
    }
  }
  throw headerError("stanza body is missing its final short line.");
}
