/**
 * Deciding what a field holds, from its profile (`profile.ts`): at most one finding
 * per field path, with a confidence and the evidence behind it.
 *
 * Three kinds of evidence, combined into candidate findings; the most confident wins:
 *
 * 1. VALUE evidence: the share of values with a whole-value signal of a kind (97% are
 *    emails), times how reliable that signal is (a valid IBAN is nearly conclusive, a
 *    separated digit group less so). Without a matching field name at least 60% of the
 *    values must match; with one, 30%. A matching name adds a bonus.
 *
 *      confidence = share × reliability (+ 0.15 strong name, + 0.08 weak name), at most 1
 *
 * 2. NAME evidence, for kinds values cannot reveal on their own (person names, dates of
 *    birth, passwords, tokens, unchecked IDs, street parts): the name's strength times
 *    the share of values that are plausible for it (name-like, date-like, token-like…).
 *    At least half must be plausible, and, unless the name is strong (`firstName`), a field
 *    with only a handful of distinct values over many documents is an enum ("active",
 *    "pending"), not personal data.
 *
 *      confidence = 0.9 (strong) or 0.7 (weak) × plausible share × kind factor
 *
 * 3. FREE TEXT: notes and messages where emails or phone numbers appear. Any share
 *    matters here (one note in twenty with a phone number is still a leak), so the
 *    confidence grows quickly with it: 0.5 + 2 × share, at most 0.9.
 *
 * Findings under `minConfidence` (default 0.5) are dropped. Numbers, ObjectIds, UUIDs,
 * hashes and enums never produce value evidence (see values.ts), which is what keeps
 * counters, ids and statuses out of the report.
 */

import type { Document } from "mongodb";
import { KIND_LABELS, type PiiKind } from "./kinds.ts";
import { NATIONAL_ID_LABELS, type NationalIdType } from "./national-ids.ts";
import {
  CollectionProfiler,
  DISTINCT_LIMIT,
  type FieldProfile,
  type ProfileLimits,
  type Signal,
  type ValueType,
} from "./profile.ts";

/** What a field holds, and why the detector thinks so. */
export interface PiiFinding {
  /** The field path in mask rule syntax: `email`, `addresses.*.zip`, `tags`. */
  readonly path: string;
  readonly kind: PiiKind;
  /**
   * The variant, when the kind has several: the national id (`us-ssn`, `uk-nino`, …),
   * the secret (`jwt`, `api-key`, `password-hash`, `password`, `token`), the phone
   * format (`e164`, `national`, `digits`), the geolocation (`geojson`, `pair`,
   * `latitude`, `longitude`), the IP version (`4`, `6`).
   */
  readonly detail?: string;
  /** How sure the detector is, from 0 to 1 (two decimals). */
  readonly confidence: number;
  /** Share of the sampled values at the path that matched (0 to 1, two decimals). */
  readonly share: number;
  /** Values that matched. */
  readonly matched: number;
  /** Non-null values sampled at the path. */
  readonly sampled: number;
  /** A masked example: the shape of a matching value, never the value (see example.ts). */
  readonly example: string;
  /** One sentence of evidence: "100% of 1,000 values are email addresses". */
  readonly reason: string;
  /** The values' type (or `mixed`), which decides the suggested mask operation. */
  readonly valueType: ValueType | "mixed";
}

/** Options of `classifyProfile` and `detectPii`. */
export interface DetectOptions {
  /** Findings below this confidence are left out. Defaults to 0.5. */
  readonly minConfidence?: number;
}

/** Default of `DetectOptions.minConfidence`. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Detects personal data in documents of one collection, without a database: the pure
 * core of `suggestMasks`. Returns findings sorted by confidence, highest first.
 *
 *   detectPii(sampleDocuments, { collection: "users" })
 *   // [{ path: "email", kind: "email", confidence: 1, share: 1, example: "xxx@xxxx.xxx", … }]
 *
 * @param collection the collection name: `name` fields in `users` are people's names.
 */
export function detectPii(
  documents: Iterable<Document>,
  options: DetectOptions & { readonly collection?: string; readonly limits?: ProfileLimits } = {},
): PiiFinding[] {
  const profiler = new CollectionProfiler(options.collection ?? "", options.limits);
  for (const document of documents) profiler.add(document);
  return classifyProfiles(profiler.profiles(), options);
}

/**
 * One finding per path that has one, sorted by confidence (then path). A finding inside
 * a path that already has one is dropped: a GeoJSON point's coordinates are not a
 * second finding.
 */
export function classifyProfiles(
  profiles: readonly FieldProfile[],
  options: DetectOptions = {},
): PiiFinding[] {
  const findings = profiles
    .map((profile) => classifyProfile(profile, options))
    .filter((finding): finding is PiiFinding => finding !== undefined);
  const kept = findings.filter(
    (finding) => !findings.some((other) => isInside(finding.path, other.path)),
  );
  return kept.sort(
    (left, right) => right.confidence - left.confidence || left.path.localeCompare(right.path),
  );
}

/** True when `path` is strictly inside `ancestor` (`location.coordinates` in `location`). */
function isInside(path: string, ancestor: string): boolean {
  return path !== ancestor && path.startsWith(`${ancestor}.`);
}

/** The finding for one field, or `undefined` when nothing (confident enough) was found. */
export function classifyProfile(
  profile: FieldProfile,
  options: DetectOptions = {},
): PiiFinding | undefined {
  if (profile.values === 0) return undefined;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const candidates = [
    ...valueCandidates(profile),
    nameCandidate(profile),
    freeTextCandidate(profile),
  ].filter((candidate): candidate is Candidate => candidate !== undefined);
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || candidate.confidence > best.confidence) best = candidate;
  }
  if (best === undefined || best.confidence < minConfidence) return undefined;
  return toFinding(profile, best);
}

/** A possible finding, before the best one is chosen. */
interface Candidate {
  readonly kind: PiiKind;
  readonly detail: string | undefined;
  readonly confidence: number;
  readonly matched: number;
  /** The signal whose example illustrates the finding. */
  readonly exampleSignal: Signal;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// 1. Value evidence
// ---------------------------------------------------------------------------

/** What a whole-value signal is evidence of, and how reliable it is (0–1). */
interface SignalMeaning {
  readonly kind: PiiKind;
  readonly reliability: number;
  /** Plural description, for reasons: "email addresses". */
  readonly describes: string;
}

/**
 * Every whole-value signal (see profile.ts). Reliabilities reflect how often the
 * format shows up in data that is NOT this kind: almost never for a valid IBAN or JWT,
 * sometimes for a separated group of digits.
 */
const SIGNAL_MEANINGS: Readonly<Record<string, SignalMeaning>> = {
  "secret:jwt": { kind: "secret", reliability: 0.98, describes: "JSON Web Tokens" },
  "secret:api-key": { kind: "secret", reliability: 0.95, describes: "API keys" },
  "secret:password-hash": { kind: "secret", reliability: 0.98, describes: "password hashes" },
  email: { kind: "email", reliability: 0.98, describes: "email addresses" },
  iban: { kind: "iban", reliability: 0.98, describes: "IBANs with a valid checksum" },
  "credit-card": {
    kind: "credit-card",
    reliability: 0.95,
    describes: "card numbers with a valid Luhn checksum",
  },
  "ip:4": { kind: "ip-address", reliability: 0.9, describes: "IPv4 addresses" },
  "ip:6": { kind: "ip-address", reliability: 0.95, describes: "IPv6 addresses" },
  "phone:e164": { kind: "phone", reliability: 0.9, describes: "international phone numbers" },
  "phone:national": { kind: "phone", reliability: 0.75, describes: "phone numbers" },
  "phone:digits": { kind: "phone", reliability: 0.6, describes: "phone-length digit strings" },
  "postal:distinctive": { kind: "postal-code", reliability: 0.85, describes: "postal codes" },
  "postal:plain": { kind: "postal-code", reliability: 0.6, describes: "postal-code-like values" },
  address: { kind: "address", reliability: 0.8, describes: "street addresses" },
  "geo:geojson": { kind: "geolocation", reliability: 0.95, describes: "GeoJSON geometries" },
  "geo:pair": { kind: "geolocation", reliability: 0.85, describes: "[longitude, latitude] pairs" },
  "geo:latitude": { kind: "geolocation", reliability: 0.8, describes: "latitudes" },
  "geo:longitude": { kind: "geolocation", reliability: 0.8, describes: "longitudes" },
};

/** Reliability of each checkable national id (see national-ids.ts). */
const NATIONAL_ID_RELIABILITY: Readonly<Record<NationalIdType, number>> = {
  "us-ssn": 0.9,
  "uk-nino": 0.95,
  "es-dni": 0.9,
  "es-nie": 0.95,
  "br-cpf": 0.95,
  "lk-nic": 0.85,
  "in-aadhaar": 0.8,
  "ca-sin": 0.9,
  "nl-bsn": 0.9,
};

/** The meaning of a whole-value signal, or `undefined` for plausibility signals. */
function meaningOf(signal: Signal): SignalMeaning | undefined {
  const type = signal.slice("national-id:".length);
  if (signal.startsWith("national-id:") && isNationalIdType(type)) {
    return {
      kind: "national-id",
      reliability: NATIONAL_ID_RELIABILITY[type],
      describes: `${NATIONAL_ID_LABELS[type]}s`,
    };
  }
  return SIGNAL_MEANINGS[signal];
}

function isNationalIdType(value: string): value is NationalIdType {
  return Object.hasOwn(NATIONAL_ID_LABELS, value);
}

/** Share of values a kind needs without, and with, a field name that agrees. */
const MIN_VALUE_SHARE = 0.6;
const MIN_HINTED_VALUE_SHARE = 0.3;

/** Bonus for a field name that agrees with the values. */
const NAME_BONUS = { strong: 0.15, weak: 0.08 } as const;

/** One candidate per kind that has whole-value signals. */
function valueCandidates(profile: FieldProfile): Candidate[] {
  const byKind = new Map<PiiKind, { signal: Signal; count: number; meaning: SignalMeaning }[]>();
  for (const [signal, count] of profile.signals) {
    const meaning = meaningOf(signal);
    if (meaning === undefined) continue;
    const list = byKind.get(meaning.kind) ?? [];
    list.push({ signal, count, meaning });
    byKind.set(meaning.kind, list);
  }

  const candidates: Candidate[] = [];
  for (const [kind, signals] of byKind) {
    const matched = signals.reduce((sum, entry) => sum + entry.count, 0);
    const share = matched / profile.values;
    const hinted = profile.hint?.kind === kind;
    if (share < (hinted ? MIN_HINTED_VALUE_SHARE : MIN_VALUE_SHARE)) continue;
    // Several formats of one kind (E.164 and national phones): weigh by how often each appears.
    const reliability =
      signals.reduce((sum, entry) => sum + entry.count * entry.meaning.reliability, 0) / matched;
    const bonus = hinted && profile.hint !== undefined ? NAME_BONUS[profile.hint.strength] : 0;
    const main = signals.reduce((top, entry) => (entry.count > top.count ? entry : top));
    candidates.push({
      kind,
      detail: detailOf(main.signal),
      confidence: Math.min(1, share * reliability + bonus),
      matched,
      exampleSignal: main.signal,
      reason:
        `${percent(share)} of ${formatNumber(profile.values)} values are ${main.meaning.describes}` +
        (hinted ? ", and the field name agrees" : ""),
    });
  }
  return candidates;
}

/** `phone:e164` → `e164`, `geo:pair` → `pair`, `email` → none. */
function detailOf(signal: Signal): string | undefined {
  const separator = signal.indexOf(":");
  return separator === -1 ? undefined : signal.slice(separator + 1);
}

// ---------------------------------------------------------------------------
// 2. Name evidence
// ---------------------------------------------------------------------------

/** How strong a name alone is (before the share of plausible values). */
const NAME_STRENGTH = { strong: 0.9, weak: 0.7 } as const;

/**
 * For each name-driven kind: the signal that makes a value plausible, and a factor for
 * how much a name alone proves for that kind. IDs, card and account numbers that fail
 * every checksum might be internal references, so the name counts for less there.
 */
const NAME_DRIVEN: Partial<
  Record<
    PiiKind,
    { readonly plausible: Signal; readonly factor: number; readonly looksLike: string }
  >
> = {
  "person-name": { plausible: "name-like", factor: 1, looksLike: "names" },
  "date-of-birth": { plausible: "date-like", factor: 1, looksLike: "dates" },
  "national-id": { plausible: "id-like", factor: 0.85, looksLike: "identifiers" },
  "credit-card": { plausible: "card-like", factor: 0.8, looksLike: "card-length numbers" },
  iban: { plausible: "id-like", factor: 0.75, looksLike: "account numbers" },
  address: { plausible: "text", factor: 0.85, looksLike: "text" },
};

/** Fewest values before a field with very few distinct values counts as an enum. */
const ENUM_MIN_VALUES = 20;

/** An enum has at most this many distinct values. */
const ENUM_MAX_DISTINCT = 5;

/** The candidate a field name gives, confirmed by plausible values. */
function nameCandidate(profile: FieldProfile): Candidate | undefined {
  const hint = profile.hint;
  if (hint === undefined) return undefined;
  // A strong name (`firstName`, `ssn`) is believed even with few distinct values (a small
  // team, seeded test data); weak names, and secrets (`passwordPolicy: "strict"`), are not.
  const trustName = hint.strength === "strong" && hint.kind !== "secret";
  if (!trustName && isEnumLike(profile)) return undefined;
  const rule =
    hint.kind === "secret"
      ? {
          plausible: hint.detail === "password" ? "text" : "token-like",
          factor: 1,
          looksLike: hint.detail === "password" ? "text" : "random tokens",
        }
      : NAME_DRIVEN[hint.kind];
  if (rule === undefined) return undefined;
  const plausible = profile.signals.get(rule.plausible) ?? 0;
  const share = plausible / profile.values;
  if (share < 0.5) return undefined;
  return {
    kind: hint.kind,
    detail: hint.detail,
    confidence: NAME_STRENGTH[hint.strength] * share * rule.factor,
    matched: plausible,
    exampleSignal: rule.plausible,
    reason: `the field name suggests a ${singularLabel(hint.kind, hint.detail)}, and ${percent(share)} of ${formatNumber(profile.values)} values look like ${rule.looksLike}`,
  };
}

/** A few distinct values repeated over many documents: a status, not a person. */
function isEnumLike(profile: FieldProfile): boolean {
  const strings = profile.types.get("string") ?? 0;
  return (
    strings >= ENUM_MIN_VALUES &&
    profile.distinct.size <= ENUM_MAX_DISTINCT &&
    profile.distinct.size < DISTINCT_LIMIT
  );
}

function singularLabel(kind: PiiKind, detail: string | undefined): string {
  if (kind === "secret" && detail !== undefined) return detail;
  return KIND_LABELS[kind];
}

// ---------------------------------------------------------------------------
// 3. Free text
// ---------------------------------------------------------------------------

/** Free-text confidence: 0.5 plus twice the share, at most 0.9 (see the file header). */
const FREE_TEXT_BASE = 0.5;
const FREE_TEXT_SLOPE = 2;
const FREE_TEXT_MAX = 0.9;

function freeTextCandidate(profile: FieldProfile): Candidate | undefined {
  const matched = profile.signals.get("free-text") ?? 0;
  const strings = profile.types.get("string") ?? 0;
  if (matched === 0 || strings === 0) return undefined;
  const share = matched / strings;
  return {
    kind: "free-text",
    detail: undefined,
    confidence: Math.min(FREE_TEXT_MAX, FREE_TEXT_BASE + FREE_TEXT_SLOPE * share),
    matched,
    exampleSignal: "free-text",
    reason: `${percent(share)} of ${formatNumber(strings)} texts contain an email address or phone number`,
  };
}

// ---------------------------------------------------------------------------
// Assembling the finding
// ---------------------------------------------------------------------------

function toFinding(profile: FieldProfile, candidate: Candidate): PiiFinding {
  const finding: PiiFinding = {
    path: rulePath(profile.path),
    kind: candidate.kind,
    confidence: round(candidate.confidence),
    share: round(candidate.matched / profile.values),
    matched: candidate.matched,
    sampled: profile.values,
    example: profile.examples.get(candidate.exampleSignal) ?? "",
    reason: candidate.reason,
    valueType: dominantType(profile),
  };
  return candidate.detail === undefined ? finding : { ...finding, detail: candidate.detail };
}

/**
 * The path to write in a rule: without trailing `.*`, because leaf operations already
 * apply to every element of an array (`tags: "hash"` hashes each tag).
 */
function rulePath(path: string): string {
  return path.replace(/(?:\.\*)+$/, "");
}

/** Share a type needs to be THE type of a field; below it the field is `mixed`. */
const DOMINANT_TYPE_SHARE = 0.9;

function dominantType(profile: FieldProfile): ValueType | "mixed" {
  for (const [type, count] of profile.types) {
    if (count / profile.values >= DOMINANT_TYPE_SHARE) return type;
  }
  return "mixed";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `0.973` → `97%`. Rounded down, so 99.6% never shows as a misleading 100%. */
function percent(share: number): string {
  return `${Math.floor(share * 100)}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
