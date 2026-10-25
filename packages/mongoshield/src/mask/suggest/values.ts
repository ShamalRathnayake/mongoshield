/**
 * What a single VALUE looks like: an email, a phone number, a card number, a JWT, a
 * coordinate pair, …. Pure functions, one question each, no knowledge of fields.
 *
 * Every detector is written to be precise rather than eager: a false positive costs
 * the user a review ("why does it want to mask `status`?"), and a classifier that
 * cries wolf is ignored. So:
 *
 * - checksums are verified where the format has one (cards, IBANs, national ids);
 * - shapes that collide with everyday data (plain digit strings, 5-digit numbers) only
 *   count when the field name agrees, and the caller says so with `hinted`;
 * - opaque identifiers (ObjectIds, UUIDs, hex digests) are recognised so they are
 *   never mistaken for tokens or numbers.
 *
 * Deciding what a whole FIELD holds, from the share of its values that match, is
 * `classify.ts`'s job.
 */

import { isIPv4, isIPv6 } from "node:net";
import { ibanValid, luhnValid } from "./checksums.ts";

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * An email address: a dot-atom local part (RFC 5322, without quoted strings or
 * comments, which nobody stores), `@`, a domain with at least one dot and a letter TLD.
 */
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

/** The longest address SMTP allows (RFC 5321: 254 characters). */
const MAX_EMAIL_LENGTH = 254;

/** True when the whole value is an email address. */
export function isEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL.test(value.trim());
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * How a value looks as a phone number:
 *
 *   e164      +44 20 7946 0958, +14155550123 (a leading + and 8–15 digits)
 *   national  (020) 7946 0958, 555-123-4567, 07700 900123 (separated digit groups)
 *   digits    07700900123 (7–15 plain digits: only a phone when the field name says so)
 */
export type PhoneFormat = "e164" | "national" | "digits";

/** Characters a written phone number is made of. */
const PHONE_CHARACTERS = /^\+?[0-9 ().-]+$/;

/**
 * Two to six groups of 1–6 digits separated by spaces, dots or dashes, optionally in
 * parentheses: `(020) 7946 0958`, `07700 900123`.
 */
const SEPARATED_GROUPS = /^\(?[0-9]{1,6}\)?(?:[ .-]+\(?[0-9]{1,6}\)?){1,5}$/;

/** `1 234 567`, `1.234.567`: a number with thousands separators, not a phone. */
const THOUSANDS = /^[0-9]{1,3}(?:[ ,.][0-9]{3})+$/;

/** E.164 numbers have at most 15 digits; real ones at least 7 (8 with the country code). */
const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15;
const MIN_E164_DIGITS = 8;

/** Formatted numbers are short; anything longer is text that happens to hold digits. */
const MAX_PHONE_LENGTH = 24;

/** The phone format of `value`, or `undefined` when it is not one. */
export function phoneFormat(value: string): PhoneFormat | undefined {
  const text = value.trim();
  if (text.length > MAX_PHONE_LENGTH || !PHONE_CHARACTERS.test(text)) return undefined;
  const digits = text.replace(/[^0-9]/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return undefined;
  if (text.startsWith("+")) {
    // Country codes never start with 0.
    return digits.length >= MIN_E164_DIGITS && !digits.startsWith("0") ? "e164" : undefined;
  }
  if (/^[0-9]+$/.test(text)) return "digits";
  if (isDateLike(text) || isIPv4(text) || THOUSANDS.test(text)) return undefined;
  return SEPARATED_GROUPS.test(text) ? "national" : undefined;
}

// ---------------------------------------------------------------------------
// Payment: cards and IBANs
// ---------------------------------------------------------------------------

/** Card numbers: 13–19 digits, in groups separated by single spaces or dashes. */
const CARD_SHAPE = /^[0-9]+(?:[ -][0-9]+)*$/;

/**
 * True for a payment card number: 13–19 digits passing Luhn, starting with a digit
 * issuers use (2 Mastercard, 3 Amex/Diners/JCB, 4 Visa, 5 Mastercard/Maestro,
 * 6 Discover/UnionPay/Maestro). A run of one repeated digit is a placeholder.
 */
export function isCardNumber(value: string): boolean {
  const text = value.trim();
  if (!CARD_SHAPE.test(text)) return false;
  const digits = text.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (!/^[2-6]/.test(digits) || /^(.)\1+$/.test(digits)) return false;
  return luhnValid(digits);
}

/** True for a valid IBAN (country length and mod-97 checksum; see checksums.ts). */
export function isIban(value: string): boolean {
  return ibanValid(value.trim());
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** 4 or 6 for an IP address, `undefined` otherwise. */
export function ipVersion(value: string): 4 | 6 | undefined {
  const text = value.trim();
  if (isIPv4(text)) return 4;
  if (isIPv6(text)) return 6;
  return undefined;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Which kind of secret a value is:
 *
 *   jwt            a JSON Web Token (three base64url parts; the header decodes to JSON with `alg`)
 *   api-key        a key with a vendor's well-known prefix (Stripe, GitHub, AWS, Slack, …)
 *   password-hash  a bcrypt / argon2 / scrypt / PBKDF2 / crypt(3) / Django password hash
 */
export type SecretFormat = "jwt" | "api-key" | "password-hash";

/** JWTs: header and payload are base64url JSON objects, so both start with `eyJ` (`{"`). */
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/;

/** Vendor key formats, each specific enough that a match is a real key (or a test one). */
const API_KEY_PATTERNS: readonly RegExp[] = [
  /^(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}$/, //   Stripe secret / restricted keys
  /^whsec_[0-9A-Za-z]{20,}$/, //                     Stripe webhook secrets
  /^gh[pousr]_[A-Za-z0-9]{36,}$/, //                 GitHub tokens
  /^github_pat_[A-Za-z0-9_]{22,}$/, //               GitHub fine-grained tokens
  /^glpat-[A-Za-z0-9_-]{20,}$/, //                   GitLab personal access tokens
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/, //              Slack tokens
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, //                  AWS access key ids
  /^AIza[0-9A-Za-z_-]{35}$/, //                      Google API keys
  /^sk-ant-[A-Za-z0-9_-]{20,}$/, //                  Anthropic API keys
  /^sk-(?:proj-)?[A-Za-z0-9_-]{20,}$/, //            OpenAI API keys
  /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, // SendGrid API keys
  /^npm_[A-Za-z0-9]{36}$/, //                        npm tokens
  /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/, //               age secret keys
];

/** Password hash formats (modular crypt format and Django's `algorithm$…`). */
const PASSWORD_HASH_PATTERNS: readonly RegExp[] = [
  /^\$2[abxy]?\$[0-9]{2}\$[./A-Za-z0-9]{53}$/, //    bcrypt
  /^\$argon2(?:id|i|d)\$/, //                        argon2
  /^\$scrypt\$/, //                                  scrypt
  /^\$pbkdf2(?:-sha[0-9]+)?\$/, //                   PBKDF2 (passlib)
  /^\$[156]\$[^$]{1,16}\$[./A-Za-z0-9]{22,}$/, //    md5-crypt, sha256-crypt, sha512-crypt
  /^(?:pbkdf2_sha[0-9]+|argon2|bcrypt_sha256|bcrypt)\$/, // Django
];

/** The secret format of `value`, or `undefined`. */
export function secretFormat(value: string): SecretFormat | undefined {
  const text = value.trim();
  if (isJwt(text)) return "jwt";
  if (API_KEY_PATTERNS.some((pattern) => pattern.test(text))) return "api-key";
  if (PASSWORD_HASH_PATTERNS.some((pattern) => pattern.test(text))) return "password-hash";
  return undefined;
}

/** A JWT: the right shape AND a header that decodes to a JSON object naming an algorithm. */
function isJwt(text: string): boolean {
  if (!JWT.test(text)) return false;
  const header = text.slice(0, text.indexOf("."));
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    return typeof decoded === "object" && decoded !== null && "alg" in decoded;
  } catch {
    return false;
  }
}

/**
 * Shannon entropy in bits per character: about 4–6 for random tokens (hex ≈ 4,
 * base64 ≈ 6), about 2–3.5 for words and identifiers people type.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  const length = [...value].length;
  for (const count of counts.values()) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Shortest value that can be a random token (shorter keys are guessable anyway). */
const MIN_TOKEN_LENGTH = 16;

/** Entropy (bits per character) of random tokens; see `shannonEntropy`. */
const MIN_TOKEN_ENTROPY = 3.5;

/**
 * Looks like a random token: at least 16 characters, no whitespace, letters AND digits,
 * high entropy, and not an opaque identifier (an ObjectId or UUID is a reference, not
 * a secret). Only meaningful for fields whose NAME says token/secret/key: nanoid-style
 * ids look exactly like this.
 */
export function isTokenLike(value: string): boolean {
  if (value.length < MIN_TOKEN_LENGTH || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (isObjectIdHex(value) || isUuid(value)) return false;
  return shannonEntropy(value) >= MIN_TOKEN_ENTROPY;
}

// ---------------------------------------------------------------------------
// Things that are NOT personal data
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lengths of hex digests: MD5 32, SHA-1 40, SHA-224 56, SHA-256 64, SHA-384 96, SHA-512 128. */
const HEX_DIGEST_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);

/** A UUID string (any version). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** An ObjectId as 24 hex characters. */
export function isObjectIdHex(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

/** A hex digest (MD5, SHA-1, SHA-2): content hashes and checksums, not personal data. */
export function isHexDigest(value: string): boolean {
  return HEX_DIGEST_LENGTHS.has(value.length) && /^[0-9a-f]+$/i.test(value);
}

/** Any of the opaque identifiers above. */
export function isOpaqueIdentifier(value: string): boolean {
  return isUuid(value) || isObjectIdHex(value) || isHexDigest(value);
}

// ---------------------------------------------------------------------------
// Postal codes and addresses
// ---------------------------------------------------------------------------

/**
 * How a value looks as a postal code:
 *
 *   distinctive  formats rare outside addresses: US ZIP+4 (94105-1804), UK with its
 *                space (SW1A 1AA), Canada (K1A 0B1)
 *   plain        formats that could be anything: 5 digits (94105), 4 digits + letters
 *                (1012 AB), 123-4567, …; only a postal code when the field name says so
 */
export type PostalFormat = "distinctive" | "plain";

const US_ZIP_PLUS_FOUR = /^[0-9]{5}-[0-9]{4}$/;
const UK_POSTCODE_SPACED = /^(?:GIR 0AA|[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2})$/i;
const UK_POSTCODE_COMPACT = /^(?:GIR0AA|[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2})$/i;
const CANADIAN_POSTAL_CODE =
  /^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z] ?[0-9][ABCEGHJ-NPRSTV-Z][0-9]$/i;
const PLAIN_POSTAL_CODES: readonly RegExp[] = [
  /^[0-9]{3,10}$/, //                  most countries: 4, 5 or 6 digits
  /^[0-9]{4} ?[A-Z]{2}$/i, //          Netherlands
  /^[0-9]{2,5}-[0-9]{3,4}$/, //        Poland, Japan, Brazil, Portugal
  UK_POSTCODE_COMPACT,
];

/** The postal code format of `value`, or `undefined`. */
export function postalFormat(value: string): PostalFormat | undefined {
  const text = value.trim();
  if (text.length < 3 || text.length > 10) return undefined;
  if (US_ZIP_PLUS_FOUR.test(text) || UK_POSTCODE_SPACED.test(text)) return "distinctive";
  if (CANADIAN_POSTAL_CODE.test(text)) return "distinctive";
  return PLAIN_POSTAL_CODES.some((pattern) => pattern.test(text)) ? "plain" : undefined;
}

/** Street types in several languages, as words that end a street name. */
const STREET_TYPES =
  "street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way|court|ct|place|pl|terrace|close|crescent|square|sq|parkway|pkwy|highway|hwy|circle|cir|trail|row|mews|gardens|grove|hill";

/** `221B Baker Street`, `12 Rue de Rivoli`: a house number, up to five words, a street type. */
const NUMBER_FIRST_ADDRESS = new RegExp(
  `(?:^|[\\s,])[0-9]{1,5}[A-Za-z]?(?:[-/][0-9]{1,5})?,?\\s+(?:[\\p{L}'’.-]+\\s+){0,4}(?:${STREET_TYPES})\\.?(?=$|[\\s,;])`,
  "iu",
);

/** `Rue de Rivoli 12`, `Hauptstraße 5`, `Calle Mayor 3`: street words first, number after. */
const NUMBER_LAST_ADDRESS =
  /(?:^|[\s,])(?:rue|calle|via|avenida|rua|[\p{L}]+(?:straße|strasse|str\.|gasse|weg|platz|laan|gracht|vej|gatan|katu))(?:\s+[\p{L}'’.-]+){0,4}\s+[0-9]{1,5}[A-Za-z]?(?=$|[\s,;])/iu;

/** Street addresses are short; long text with an address in it is free text. */
const MAX_ADDRESS_LENGTH = 200;

/** True when the value is (or starts with) a street address. */
export function isStreetAddress(value: string): boolean {
  if (value.length > MAX_ADDRESS_LENGTH) return false;
  return NUMBER_FIRST_ADDRESS.test(value) || NUMBER_LAST_ADDRESS.test(value);
}

// ---------------------------------------------------------------------------
// Names and dates
// ---------------------------------------------------------------------------

/**
 * One to five words of letters (any script), with the apostrophes, hyphens and dots
 * names have: "Ada Costa", "Seán O'Brien-Murphy", "J. R. R. Tolkien", "李小龍".
 */
const NAME_LIKE = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,4}$/u;

/** True when the value could be a person's name (it says nothing about whether it is). */
export function isNameLike(value: string): boolean {
  const text = value.trim();
  return text.length >= 1 && text.length <= 80 && NAME_LIKE.test(text);
}

const ISO_DATE = /^([0-9]{4})-[0-9]{2}-[0-9]{2}(?:[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
const DAY_MONTH_YEAR = /^[0-9]{1,2}[./-][0-9]{1,2}[./-]([0-9]{4})$/;
const YEAR_MONTH_DAY = /^([0-9]{4})[./][0-9]{1,2}[./][0-9]{1,2}$/;

/** Years a stored date of birth plausibly has. */
const MIN_BIRTH_YEAR = 1900;
const MAX_BIRTH_YEAR = 2100;

/** True for a string holding a calendar date: 1990-05-01, 01/05/1990, 1990.05.01, …. */
export function isDateLike(value: string): boolean {
  const text = value.trim();
  const match = ISO_DATE.exec(text) ?? DAY_MONTH_YEAR.exec(text) ?? YEAR_MONTH_DAY.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  return year >= MIN_BIRTH_YEAR && year <= MAX_BIRTH_YEAR;
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

/** An email address somewhere inside text. */
const EMBEDDED_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/;

/** An international (+…) or separated national phone number somewhere inside text. */
const EMBEDDED_PHONE =
  /(?:\+[1-9][0-9]{0,3}[ .-]?)?\(?[0-9]{2,5}\)?[ .-][0-9]{3,4}[ .-]?[0-9]{3,4}(?![0-9])/;

/** Text shorter than this is a value, not prose. */
const MIN_FREE_TEXT_LENGTH = 20;

/**
 * The email address or phone number inside free text (notes, messages, comments), or
 * `undefined`. Only for text: at least 20 characters and several words, so a field that
 * IS an email is an email, not "text containing an email".
 */
export function findContactInText(value: string): string | undefined {
  if (value.length < MIN_FREE_TEXT_LENGTH || !/\S\s+\S/.test(value)) return undefined;
  const email = EMBEDDED_EMAIL.exec(value);
  if (email !== null) return email[0];
  const phone = EMBEDDED_PHONE.exec(value);
  if (phone === null) return undefined;
  // "between 2024-01-05 and …" and "order 1234 5678" are not phones; require 8+ digits.
  const digits = phone[0].replace(/[^0-9]/g, "");
  return digits.length >= 8 && !isDateLike(phone[0].trim()) ? phone[0].trim() : undefined;
}

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------

/** GeoJSON geometry types (RFC 7946) MongoDB's 2dsphere indexes accept. */
const GEOJSON_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

/**
 * True for a GeoJSON geometry: `{ type: "Point", coordinates: [lng, lat] }` and the
 * other types, with a coordinates array. (`GeometryCollection` holds geometries, not
 * coordinates, and is rare in application data.)
 */
export function isGeoJsonGeometry(value: object): boolean {
  const type: unknown = Reflect.get(value, "type");
  const coordinates: unknown = Reflect.get(value, "coordinates");
  return typeof type === "string" && GEOJSON_TYPES.has(type) && Array.isArray(coordinates);
}

/**
 * True for `[longitude, latitude]` (MongoDB's legacy coordinate pairs; GeoJSON order).
 * The caller converts BSON numbers first (`numericValue` in profile.ts); anything that
 * is not a number arrives as `undefined`.
 */
export function isCoordinatePair(values: readonly (number | undefined)[]): boolean {
  if (values.length !== 2) return false;
  const [longitude, latitude] = values;
  return (
    longitude !== undefined &&
    latitude !== undefined &&
    isLongitude(longitude) &&
    isLatitude(latitude)
  );
}

/** A latitude: a finite number in [-90, 90]. */
export function isLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

/** A longitude: a finite number in [-180, 180]. */
export function isLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
