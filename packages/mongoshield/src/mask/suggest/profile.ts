/**
 * Profiling sampled documents: walk every field (embedded documents and arrays
 * included), run the value detectors, and count, per field path, what the values
 * looked like. `classify.ts` turns each profile into at most one finding.
 *
 *   { email: "ada@corp.com", addresses: [{ zip: "94105" }], tags: ["vip"] }
 *
 *   path               key        parents        counted
 *   email              email      []             email ×1
 *   addresses.*.zip    zip        [addresses]    postal:plain ×1 (the name `zip` allows plain digits)
 *   tags.*             tags       []             text ×1, name-like ×1
 *
 * Paths use the mask rule syntax: `*` stands for "every array element", so a finding's
 * path can be pasted into a mask file as is (`classify.ts` drops a trailing `.*`:
 * `tags: "hash"` already masks every tag). Keys that are data themselves (a map keyed
 * by email or user id) become `*` too, "every key", so no path ever shows a value.
 *
 * Bounded on purpose, because the input is somebody's production data:
 * - at most `maxPaths` distinct paths per collection (documents used as maps, with one
 *   key per user id, would otherwise grow without limit), then `truncated` is set;
 * - at most `maxDepth` levels and `maxArrayElements` elements per array;
 * - long strings are only scanned for embedded emails/phones, in their first 10 000
 *   characters.
 * Raw values are only kept in memory for counting distinct values (an enum check), up
 * to 64 per path, and never leave this module: examples are masked shapes.
 */

import type { Document } from "mongodb";
import { Decimal128, Double, Int32, Long } from "mongodb";
import { isEmbeddedDocument } from "../values.ts";
import {
  maskedDate,
  maskedExcerpt,
  maskedGeometry,
  maskedNumber,
  maskedSecret,
  maskedShape,
} from "./example.ts";
import { hintForField, type NameHint } from "./field-names.ts";
import { nationalIdType } from "./national-ids.ts";
import {
  findContactInText,
  ipVersion,
  isCardNumber,
  isCoordinatePair,
  isDateLike,
  isEmail,
  isGeoJsonGeometry,
  isIban,
  isLatitude,
  isLongitude,
  isNameLike,
  isOpaqueIdentifier,
  isStreetAddress,
  isTokenLike,
  phoneFormat,
  postalFormat,
  secretFormat,
} from "./values.ts";

/**
 * What was observed about one value. The "whole value" signals are exclusive: a value
 * gets at most one (`email`, `phone:e164`, `national-id:us-ssn`, …). The others describe
 * plausibility and are counted independently (`name-like`, `date-like`, `token-like`,
 * `text`, `id-like`, `card-like`, `free-text`, `opaque-id`).
 */
export type Signal = string;

/** The type of a value, as far as choosing a mask operation goes. */
export type ValueType = "string" | "number" | "date" | "geo" | "other";

/** Everything counted about one field path. */
export interface FieldProfile {
  /** The path in mask rule syntax, `*` for array elements: `addresses.*.zip`, `tags.*`. */
  readonly path: string;
  /** The field's own key: `zip`. */
  readonly key: string;
  /** Named ancestors, top down: `["addresses"]`. */
  readonly parents: readonly string[];
  /** What the field's name suggests, if anything. */
  readonly hint: NameHint | undefined;
  /** Non-null values seen at the path (a geometry or coordinate pair counts as one). */
  values: number;
  /** Values per type. */
  readonly types: Map<ValueType, number>;
  /** Values per signal (see `Signal`). */
  readonly signals: Map<Signal, number>;
  /** A masked example per signal: the first value that showed it. */
  readonly examples: Map<Signal, string>;
  /** Distinct string values, up to `DISTINCT_LIMIT`, for the enum check. */
  readonly distinct: Set<string>;
}

/** Bounds of a profiler (see the file header). */
export interface ProfileLimits {
  readonly maxPaths?: number;
  readonly maxDepth?: number;
  readonly maxArrayElements?: number;
}

/** Defaults of `ProfileLimits`. */
export const DEFAULT_PROFILE_LIMITS = {
  maxPaths: 1000,
  maxDepth: 20,
  maxArrayElements: 100,
} as const;

/** Distinct values remembered per path: enough to tell an enum from free values. */
export const DISTINCT_LIMIT = 64;

/** Strings longer than this are only scanned for embedded emails and phone numbers. */
const MAX_SCANNED_LENGTH = 10_000;

/** Strings longer than this are prose, not a value (no name/date/token checks). */
const MAX_VALUE_LENGTH = 512;

/** Builds the profiles of one collection's sampled documents. */
export class CollectionProfiler {
  readonly #collection: string;
  readonly #limits: Required<ProfileLimits>;
  readonly #profiles = new Map<string, FieldProfile>();
  /** Name hints per path, computed once (arrays are checked before their profile exists). */
  readonly #hints = new Map<string, NameHint | undefined>();
  #documents = 0;
  #truncated = false;

  /** @param collection the collection name (not the namespace): it gives `name` fields context. */
  constructor(collection: string, limits: ProfileLimits = {}) {
    this.#collection = collection;
    this.#limits = { ...DEFAULT_PROFILE_LIMITS, ...limits };
  }

  /** Documents profiled so far. */
  get documents(): number {
    return this.#documents;
  }

  /** True when some paths were left out because of `maxPaths`. */
  get truncated(): boolean {
    return this.#truncated;
  }

  /** Every profile, in the order the paths were first seen. */
  profiles(): FieldProfile[] {
    return [...this.#profiles.values()];
  }

  /** Profiles one document. */
  add(document: Document): void {
    this.#documents += 1;
    this.#visitDocument(document, [], 0);
  }

  /** The fields of an embedded document (or the top-level document). */
  #visitDocument(document: Document, segments: readonly string[], depth: number): void {
    if (depth >= this.#limits.maxDepth) return;
    for (const [key, value] of Object.entries(document)) {
      // Keys with dots or a leading `$` cannot be written as a mask path.
      if (key === "" || key.includes(".") || key.startsWith("$")) continue;
      // A key that is itself data (a document used as a map keyed by email or user id)
      // becomes `*`, "every key": the path then names the structure, never the data,
      // and a map with a million keys is still one path.
      const segment = isDataKey(key) ? "*" : key;
      this.#visitValue(value, [...segments, segment], depth + 1);
    }
  }

  /** One value at a path: a container to walk into, or a leaf to observe. */
  #visitValue(value: unknown, segments: readonly string[], depth: number): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      this.#visitArray(value, segments, depth);
      return;
    }
    if (isEmbeddedDocument(value)) {
      if (isGeoJsonGeometry(value)) {
        this.#observeGeometry(value, segments);
        return;
      }
      this.#visitDocument(value, segments, depth);
      return;
    }
    const profile = this.#profileFor(segments);
    if (profile !== undefined) observeLeaf(profile, value);
  }

  /**
   * An array: a `[lng, lat]` pair under a location-like name is one coordinate value;
   * anything else is walked element by element under `<path>.*`.
   */
  #visitArray(array: readonly unknown[], segments: readonly string[], depth: number): void {
    if (depth >= this.#limits.maxDepth) return;
    if (array.length === 2 && this.#hintFor(segments)?.kind === "geolocation") {
      const numbers = array.map(numericValue);
      if (isCoordinatePair(numbers)) {
        const profile = this.#profileFor(segments);
        const [longitude = 0] = numbers;
        if (profile !== undefined) {
          record(profile, "geo:pair", "geo", () => `[${maskedNumber(longitude)}, ##.####]`);
        }
        return;
      }
    }
    const elements = array.slice(0, this.#limits.maxArrayElements);
    for (const element of elements) this.#visitValue(element, [...segments, "*"], depth + 1);
  }

  /** A GeoJSON geometry is one value at its own path; its coordinates are not walked. */
  #observeGeometry(geometry: object, segments: readonly string[]): void {
    const profile = this.#profileFor(segments);
    if (profile === undefined) return;
    const type = String(Reflect.get(geometry, "type"));
    record(profile, "geo:geojson", "geo", () => maskedGeometry(type));
  }

  /**
   * The profile of a path, creating it (with the field name's hint) on first sight.
   * `undefined` once `maxPaths` paths exist.
   */
  #profileFor(segments: readonly string[]): FieldProfile | undefined {
    const path = segments.join(".");
    const existing = this.#profiles.get(path);
    if (existing !== undefined) return existing;
    if (this.#profiles.size >= this.#limits.maxPaths) {
      this.#truncated = true;
      return undefined;
    }
    const { key, parents } = namedSegments(segments);
    const created: FieldProfile = {
      path,
      key,
      parents,
      hint: this.#hintFor(segments),
      values: 0,
      types: new Map(),
      signals: new Map(),
      examples: new Map(),
      distinct: new Set(),
    };
    this.#profiles.set(path, created);
    return created;
  }

  /** What the field name at a path suggests, computed once per path. */
  #hintFor(segments: readonly string[]): NameHint | undefined {
    const path = segments.join(".");
    if (!this.#hints.has(path)) {
      const { key, parents } = namedSegments(segments);
      this.#hints.set(path, hintForField({ key, parents, collection: this.#collection }));
    }
    return this.#hints.get(path);
  }
}

/**
 * True for an object key that holds data rather than naming a field: a phone number,
 * an IP address, an ObjectId/UUID/hash, anything with five digits in a row (user ids,
 * dates, account numbers), or with whitespace or an `@` (names, emails, handles):
 * field names have none of those.
 */
export function isDataKey(key: string): boolean {
  return (
    /[0-9]{5}|\s|@/.test(key) ||
    isOpaqueIdentifier(key) ||
    ipVersion(key) !== undefined ||
    phoneFormat(key) !== undefined
  );
}

/** The key (last named segment: `tags` for `tags.*`) and the named ancestors of a path. */
function namedSegments(segments: readonly string[]): { key: string; parents: string[] } {
  const named = segments.filter((segment) => segment !== "*");
  return { key: named.at(-1) ?? "", parents: named.slice(0, -1) };
}

// ---------------------------------------------------------------------------
// Observing leaf values
// ---------------------------------------------------------------------------

/** Counts one value of a type, with an optional signal and its masked example. */
function record(
  profile: FieldProfile,
  signal: Signal | undefined,
  type: ValueType,
  example: () => string,
): void {
  profile.values += 1;
  increment(profile.types, type);
  if (signal !== undefined) count(profile, signal, example);
}

/** Counts a signal, remembering the first example of it. */
function count(profile: FieldProfile, signal: Signal, example: () => string): void {
  increment(profile.signals, signal);
  if (!profile.examples.has(signal)) profile.examples.set(signal, example());
}

function increment<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Observes a leaf: a string, a number, a date or anything else. */
function observeLeaf(profile: FieldProfile, value: unknown): void {
  if (typeof value === "string") {
    observeString(profile, value);
    return;
  }
  if (value instanceof Date) {
    const signal = profile.hint?.kind === "date-of-birth" ? "date-like" : undefined;
    record(profile, signal, "date", maskedDate);
    return;
  }
  const number = numericValue(value);
  if (number !== undefined) {
    observeNumber(profile, number);
    return;
  }
  // ObjectIds, binaries, booleans, …: they count as values, so they lower every share.
  record(profile, undefined, "other", () => "");
}

/** Kinds whose identifiers are sometimes stored as numbers (a phone without its +). */
const NUMERIC_IDENTIFIER_KINDS = new Set(["phone", "national-id", "credit-card", "postal-code"]);

/**
 * Numbers mean something only when the field name says what: a latitude, a longitude,
 * or a phone/ID/card/postal code stored as an integer. Counters, prices and ids never
 * get a signal, which is how they stay out of the findings.
 */
function observeNumber(profile: FieldProfile, number: number): void {
  record(profile, undefined, "number", () => "");
  const hint = profile.hint;
  if (hint === undefined) return;
  const example = () => maskedNumber(number);
  if (hint.detail === "latitude" && isLatitude(number)) count(profile, "geo:latitude", example);
  if (hint.detail === "longitude" && isLongitude(number)) count(profile, "geo:longitude", example);
  if (NUMERIC_IDENTIFIER_KINDS.has(hint.kind) && Number.isSafeInteger(number) && number >= 0) {
    const signal = wholeValueSignal(String(number), hint);
    if (signal !== undefined) count(profile, signal, example);
  }
}

/** Observes a string: one whole-value signal at most, plus the plausibility signals. */
function observeString(profile: FieldProfile, value: string): void {
  const hint = profile.hint;
  if (value.length > MAX_VALUE_LENGTH) {
    record(profile, undefined, "string", () => "");
    count(profile, "text", () => maskedShape(value));
    observeFreeText(profile, value.slice(0, MAX_SCANNED_LENGTH));
    return;
  }
  const signal = value.trim() === "" ? undefined : wholeValueSignal(value, hint);
  record(profile, signal, "string", () => exampleFor(signal, value));
  if (profile.distinct.size < DISTINCT_LIMIT) profile.distinct.add(value);
  if (signal === undefined) observeFreeText(profile, value);
  observePlausibility(profile, value);
}

/** Embedded emails and phone numbers in text. */
function observeFreeText(profile: FieldProfile, text: string): void {
  const contact = findContactInText(text);
  if (contact !== undefined) count(profile, "free-text", () => maskedExcerpt(contact));
}

/** The signals that say what a value COULD be, for fields whose name says what it is. */
function observePlausibility(profile: FieldProfile, value: string): void {
  const shape = () => maskedShape(value);
  if (/\p{L}/u.test(value)) count(profile, "text", shape);
  if (isNameLike(value)) count(profile, "name-like", shape);
  if (isDateLike(value)) count(profile, "date-like", shape);
  if (isTokenLike(value)) count(profile, "token-like", () => maskedSecret(value));
  if (isOpaqueIdentifier(value)) count(profile, "opaque-id", shape);
  if (isIdLike(value)) count(profile, "id-like", shape);
  if (value.replace(/[^0-9]/g, "").length >= 12) count(profile, "card-like", shape);
}

/**
 * An identifier someone could have typed from a card: 5–20 letters, digits, spaces,
 * dots and dashes, with at least four digits (`AB123456C`, `X-1234567`).
 */
function isIdLike(value: string): boolean {
  const text = value.trim();
  return /^[A-Za-z0-9 .-]{5,20}$/.test(text) && text.replace(/[^0-9]/g, "").length >= 4;
}

/**
 * The exclusive whole-value signal of a string, most specific first: secrets, email,
 * IBAN, card, national id, IP, phone, postal code, street address. Formats that
 * collide with ordinary data (plain digits as a phone or postal code) only count when
 * the field name asks for them.
 */
function wholeValueSignal(value: string, hint: NameHint | undefined): Signal | undefined {
  const secret = secretFormat(value);
  if (secret !== undefined) return `secret:${secret}`;
  if (isEmail(value)) return "email";
  if (isIban(value)) return "iban";
  if (isCardNumber(value)) return "credit-card";
  const nationalId = nationalIdType(value, hint?.kind === "national-id");
  if (nationalId !== undefined) return `national-id:${nationalId}`;
  const ip = ipVersion(value);
  if (ip !== undefined) return `ip:${ip}`;
  const phone = phoneFormat(value);
  if (phone === "e164" || phone === "national") return `phone:${phone}`;
  if (phone === "digits" && hint?.kind === "phone") return "phone:digits";
  const postal = postalFormat(value);
  if (postal === "distinctive") return "postal:distinctive";
  if (postal === "plain" && hint?.kind === "postal-code") return "postal:plain";
  if (isStreetAddress(value)) return "address";
  return undefined;
}

/** The masked example of a string with a whole-value signal. */
function exampleFor(signal: Signal | undefined, value: string): string {
  return signal?.startsWith("secret:") === true ? maskedSecret(value) : maskedShape(value);
}

/**
 * A JavaScript number for any BSON number (js-bson classes when documents were read
 * losslessly, plain numbers and bigints otherwise), or `undefined` for other values.
 * Precision does not matter here: the number is only compared with ranges.
 */
export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Int32 || value instanceof Double) return value.valueOf();
  if (value instanceof Long) return value.toNumber();
  if (value instanceof Decimal128) return Number(value.toString());
  return undefined;
}
