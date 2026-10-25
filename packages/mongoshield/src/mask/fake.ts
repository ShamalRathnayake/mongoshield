/**
 * The `fake` mask operation: replace a value with a realistic-looking, deterministic
 * fake of a given kind.
 *
 *   kind        input           output
 *   email       string          ada.costa.k3x9q2mw@example.com (RFC 2606 domains only)
 *   name        string          "Ada Costa"
 *   phone       string          every digit replaced, formatting kept: "+44 20 7946 0958"
 *                                 → "+81 37 2290 4416"
 *   address     string          "4127 Maple Lane, Riverton"
 *   ip          string          IPv4 → 10.x.y.z (private range); IPv6 → 2001:db8::/32
 *                                 (documentation prefix)
 *   uuid        string | UUID   a version-4 UUID, as a string or a BSON UUID (subtype 4, or
 *                                 the legacy subtype 3) like the input
 *   date-shift  Date            the date moved by a keyed offset of ±1…`days` days
 *
 * Each fake is seeded by HMAC(secret, kind, value): the same input always gives the
 * same fake, in every collection, so an email used as a join key still joins.
 * Emails get an 8-character keyed suffix (40 bits) so distinct inputs practically
 * never collide, which matters for unique indexes. Names and addresses may repeat
 * (they are realistic, not unique), so do not use them on uniquely indexed fields.
 */

import { Binary } from "mongodb";
import {
  CITIES,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  LAST_NAMES,
  STREET_NAMES,
  STREET_SUFFIXES,
} from "./fake-data.ts";
import { base32, markAsUuidV4, streamFor, UNSUPPORTED } from "./hash.ts";
import type { KeyedStream, MaskKeys } from "./keyed.ts";
import { bsonTag } from "./values.ts";

/** The kinds of fake value. */
export type FakeKind = "email" | "name" | "phone" | "address" | "ip" | "uuid" | "date-shift";

/** Every fake kind, for validation and help text. */
export const FAKE_KINDS: readonly FakeKind[] = [
  "email",
  "name",
  "phone",
  "address",
  "ip",
  "uuid",
  "date-shift",
];

/** Options of the `fake` operation. */
export interface FakeOptions {
  /** `date-shift` only: the largest shift in days, either way. Defaults to 30. */
  readonly days?: number;
}

/** Default maximum shift of `date-shift`. */
export const DEFAULT_SHIFT_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/** Length of the keyed part of a fake email. */
const EMAIL_SUFFIX_LENGTH = 8;

/** House numbers run from 1 to this. */
const MAX_HOUSE_NUMBER = 9999;

/** BSON binary subtypes of UUIDs: 4, and 3 for the legacy (driver-specific byte order) form. */
const UUID_SUBTYPE = 4;
const LEGACY_UUID_SUBTYPE = 3;

/**
 * Fakes one value of the given kind (see the header comment).
 *
 * @returns the fake value, or `UNSUPPORTED` when the kind does not apply to the value's type.
 */
export function fakeValue(
  value: unknown,
  kind: FakeKind,
  keys: MaskKeys,
  options: FakeOptions = {},
): unknown | typeof UNSUPPORTED {
  const stream = streamFor(value, keys, `fake:${kind}`);
  if (stream === undefined) return UNSUPPORTED;
  switch (kind) {
    case "email":
      return typeof value === "string" ? fakeEmail(stream) : UNSUPPORTED;
    case "name":
      return typeof value === "string"
        ? `${stream.pick(FIRST_NAMES)} ${stream.pick(LAST_NAMES)}`
        : UNSUPPORTED;
    case "phone":
      return typeof value === "string" ? fakePhone(value, stream) : UNSUPPORTED;
    case "address":
      return typeof value === "string" ? fakeAddress(stream) : UNSUPPORTED;
    case "ip":
      return typeof value === "string" ? fakeIp(value, stream) : UNSUPPORTED;
    case "uuid":
      return fakeUuid(value, stream);
    case "date-shift":
      return value instanceof Date
        ? shiftDate(value, stream, options.days ?? DEFAULT_SHIFT_DAYS)
        : UNSUPPORTED;
  }
}

function fakeEmail(stream: KeyedStream): string {
  const first = stream.pick(FIRST_NAMES).toLowerCase();
  const last = stream.pick(LAST_NAMES).toLowerCase();
  const suffix = base32(stream, EMAIL_SUFFIX_LENGTH);
  return `${first}.${last}.${suffix}@${stream.pick(EMAIL_DOMAINS)}`;
}

/** Keeps the shape (spaces, dashes, a leading +) and replaces each digit. */
function fakePhone(value: string, stream: KeyedStream): string {
  if (!/[0-9]/.test(value)) return `555-01${String(stream.int(100)).padStart(2, "0")}`;
  return value.replace(/[0-9]/g, () => String(stream.int(10)));
}

function fakeAddress(stream: KeyedStream): string {
  const number = 1 + stream.int(MAX_HOUSE_NUMBER);
  return `${number} ${stream.pick(STREET_NAMES)} ${stream.pick(STREET_SUFFIXES)}, ${stream.pick(CITIES)}`;
}

/** IPv6 when the input looks like one (has a colon), IPv4 otherwise. */
function fakeIp(value: string, stream: KeyedStream): string {
  if (value.includes(":")) {
    const groups = Array.from({ length: 6 }, () => stream.int(0x10000).toString(16));
    return `2001:db8:${groups.join(":")}`;
  }
  return `10.${stream.int(256)}.${stream.int(256)}.${stream.int(256)}`;
}

/** A UUID string for strings (case kept), a BSON UUID for BSON UUIDs. */
function fakeUuid(value: unknown, stream: KeyedStream): unknown {
  const bytes = stream.bytes(16);
  markAsUuidV4(bytes);
  if (typeof value === "string") {
    const hex = bytes.toString("hex");
    const text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return value === value.toUpperCase() && /[A-F]/.test(value) ? text.toUpperCase() : text;
  }
  if (bsonTag(value) === "Binary" && value instanceof Binary && isUuidSubtype(value.sub_type)) {
    return new Binary(bytes, value.sub_type);
  }
  return UNSUPPORTED;
}

function isUuidSubtype(subtype: number): boolean {
  return subtype === UUID_SUBTYPE || subtype === LEGACY_UUID_SUBTYPE;
}

/**
 * Moves a date by 1…`days` days, earlier or later. Never by zero, so every date
 * actually changes. The time of day is kept (the shift is whole days).
 */
function shiftDate(value: Date, stream: KeyedStream, days: number): Date {
  const magnitude = 1 + stream.int(Math.max(1, Math.floor(days)));
  const direction = stream.int(2) === 0 ? -1 : 1;
  return new Date(value.getTime() + direction * magnitude * MS_PER_DAY);
}
