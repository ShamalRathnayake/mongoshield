/**
 * How mongodump turns collection names into file names in a dump directory, and back.
 *
 *   dump/<db>/<stem>.bson[.gz]            the documents
 *   dump/<db>/<stem>.metadata.json[.gz]   options, indexes, uuid, type
 *
 * The database directory is the database name as is (MongoDB forbids `/`, `\`,
 * `.`, space, `"` and `$` in database names). The collection `stem` is
 * (mongo-tools `mongodump/prepare.go`, `outputPath`, and `common/util/file.go`):
 *
 * 1. the name escaped with Go's `url.QueryEscape`: `A-Z a-z 0-9 - _ . ~` stay as
 *    they are, a space becomes `+`, every other byte of the UTF-8 encoding becomes
 *    `%XX` (uppercase hex). `we/ird name` → `we%2Fird+name`.
 * 2. if that is longer than 238 bytes (so that the longest file name,
 *    `<stem>.metadata.json.gz`, stays within the 255-byte limit of most filesystems):
 *    the first 208 bytes of the escaped name, then `%24` (an escaped `$`), then the
 *    unpadded base64url SHA-1 of the original name (27 characters): 238 bytes exactly.
 *    The cut may fall inside a `%XX` sequence; that is fine, because such a name is
 *    never unescaped: mongorestore (`mongorestore/filepath.go`, `getInfoFromFile`)
 *    recognises a 238-byte stem containing `%24` and reads the real name from the
 *    `collectionName` field of the metadata file instead.
 *
 * Unescaping is Go's `url.QueryUnescape`: `+` becomes a space and `%XX` a byte.
 */

import { createHash } from "node:crypto";
import { MongoShieldError } from "../errors.ts";

/** Longest stem mongodump writes; longer escaped names are shortened (see the file header). */
export const MAX_STEM_BYTES = 238;

/** How many bytes of the escaped name a shortened stem keeps. */
const SHORTENED_PREFIX_BYTES = 208;

/** Separates the kept prefix from the hash in a shortened stem: an escaped `$`. */
const SHORTENED_SEPARATOR = "%24";

/** Bytes Go's `url.QueryEscape` keeps as they are (`shouldEscape`, query-component mode). */
const UNESCAPED_BYTE = /^[A-Za-z0-9\-_.~]$/;

/** Uppercase hex digits, as Go writes them. */
const HEX_DIGITS = "0123456789ABCDEF";

/** Go's `url.QueryEscape` for a collection name. */
export function queryEscape(name: string): string {
  let escaped = "";
  for (const byte of Buffer.from(name, "utf8")) {
    const character = String.fromCharCode(byte);
    if (byte === 0x20) {
      escaped += "+";
    } else if (byte < 0x80 && UNESCAPED_BYTE.test(character)) {
      escaped += character;
    } else {
      escaped += `%${HEX_DIGITS[byte >> 4]}${HEX_DIGITS[byte & 0x0f]}`;
    }
  }
  return escaped;
}

/**
 * Go's `url.QueryUnescape`. Returns `undefined` for input Go would reject (a `%`
 * not followed by two hex digits) or that does not decode to valid UTF-8 (MongoDB
 * names always are).
 */
export function queryUnescape(escaped: string): string | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index];
    if (character === "%") {
      const hex = escaped.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else if (character === "+") {
      bytes.push(0x20);
    } else {
      for (const byte of Buffer.from(character ?? "", "utf8")) bytes.push(byte);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/** The file-name stem mongodump uses for a collection (escaped, shortened if needed). */
export function collectionFileStem(collection: string): string {
  const escaped = queryEscape(collection);
  if (escaped.length <= MAX_STEM_BYTES) return escaped;
  // SHA-1 is not used for security here, only to keep shortened names distinct;
  // it must be SHA-1 to produce the same names as mongodump.
  const hash = createHash("sha1").update(collection, "utf8").digest("base64url");
  return `${escaped.slice(0, SHORTENED_PREFIX_BYTES)}${SHORTENED_SEPARATOR}${hash}`;
}

/** What a stem says about the collection name. */
export type ParsedStem =
  | { readonly kind: "name"; readonly collection: string }
  /** The stem was shortened: the real name is in the metadata file's `collectionName`. */
  | { readonly kind: "shortened" };

/**
 * Recovers the collection name from a file-name stem, as mongorestore does.
 *
 * @throws MS_FORMAT_UNSUPPORTED when the stem is not something mongodump writes.
 */
export function parseCollectionFileStem(stem: string): ParsedStem {
  if (stem.length === MAX_STEM_BYTES && stem.includes(SHORTENED_SEPARATOR)) {
    return { kind: "shortened" };
  }
  const collection = queryUnescape(stem);
  if (collection === undefined || collection === "") {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `"${stem}" is not a collection file name mongodump writes (bad %-escape or invalid UTF-8).`,
      { hint: "Rename the file, or remove it from the dump directory." },
    );
  }
  return { kind: "name", collection };
}
