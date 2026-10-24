/**
 * How an erasure's filter is stored in the ledger, and how stored filters are matched
 * against documents. Pure functions, no I/O; the ledger itself is in erasure.ts.
 *
 * The problem: the ledger must say WHAT was erased, but the filter of an erasure is
 * usually the very personal data being erased (`{ email: "ada@example.com" }`). The
 * ledger is append-only and lives as long as any backup might be restored, so storing
 * that filter as written would keep the data forever, in a file whose purpose is to
 * prove it is gone.
 *
 * The rule:
 *
 * - An EXACT-MATCH filter on scalar values with at least one string value (emails,
 *   usernames, phone numbers: strings are what identify people on their own) is stored
 *   HASHED: one digest per field, `HMAC-SHA-256(key, "mongoshield/erasure/v1" ‖ 0 ‖
 *   path ‖ 0 ‖ canonical value)`. Applying it scans the restored collection, hashes each
 *   document's values at those paths, and deletes the documents whose every field
 *   matches. Nothing readable about the person is left in the ledger.
 * - With an erasure `secret` (recommended), the HMAC key is derived from it, so someone
 *   who can read the ledger cannot confirm a guess ("was ada@example.com erased?") by
 *   hashing it. Without one, a fixed public key is used: still not readable, but guesses
 *   can be confirmed. The record says which (`keyed`), with a short key id so a wrong
 *   secret is caught before anything is restored.
 * - Every other filter (only ObjectIds or numbers, which are opaque ids; or any query
 *   operator) is stored as written, as canonical Extended JSON, and applied with an
 *   ordinary `deleteMany` (using indexes). Prefer exact matches on ids or emails.
 *
 * Equality follows MongoDB where it matters for ids: numbers compare by value whatever
 * their BSON type (int, long, double), a field holding an array matches when any element
 * matches, and dotted paths descend into sub-documents and arrays of them. Decimal128
 * values compare by their decimal text, so `5` and `5.0` differ (rare in ids).
 */

import { createHmac } from "node:crypto";
import { Decimal128, type Document, Double, Int32, Long, ObjectId } from "mongodb";
import { MongoShieldError } from "../errors.ts";

/** Shortest erasure secret accepted (same bar as masking secrets, src/mask/keyed.ts). */
export const MIN_ERASURE_SECRET_LENGTH = 16;

/** Domain-separation label; versioned so a change of scheme can never collide. */
const DIGEST_LABEL = "mongoshield/erasure/v1";

/** The public key used when no secret is configured (see the file header). */
const UNKEYED_KEY = Buffer.from(`${DIGEST_LABEL}/unkeyed`, "utf8");

/** One hashed field of a stored erasure filter. */
export interface HashedField {
  /** The field path, e.g. `email` or `profile.email`. Paths are not personal data. */
  readonly path: string;
  /** Lowercase hex HMAC-SHA-256 of the canonical value (see the file header). */
  readonly digest: string;
}

/** How a filter is kept in the ledger. */
export type StoredMatch =
  | {
      /** Applied with `deleteMany(filter)`. */
      readonly kind: "filter";
      /** The filter as canonical Extended JSON (parse with `EJSON.deserialize`). */
      readonly filter: Document;
    }
  | {
      /** Applied by scanning and hashing (see the file header). */
      readonly kind: "hashed";
      /** True when the HMAC key comes from the erasure secret. */
      readonly keyed: boolean;
      /** Keyed records: 16 hex characters identifying the secret (not the secret). */
      readonly keyId?: string;
      readonly fields: readonly HashedField[];
    };

/** The HMAC key and its id, derived once from the (optional) secret. */
export interface ErasureKey {
  readonly key: Buffer;
  readonly keyed: boolean;
  readonly keyId: string | undefined;
}

/**
 * Derives the hashing key. Without a secret, the fixed public key.
 *
 * @throws MS_CONFIG_INVALID for a secret shorter than 16 characters.
 */
export function deriveErasureKey(secret: string | undefined): ErasureKey {
  if (secret === undefined) return { key: UNKEYED_KEY, keyed: false, keyId: undefined };
  if (secret.length < MIN_ERASURE_SECRET_LENGTH) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The erasure secret must be at least ${MIN_ERASURE_SECRET_LENGTH} characters long.`,
      {
        hint: "Generate one with `openssl rand -base64 32` and set MONGOSHIELD_ERASURE_SECRET.",
      },
    );
  }
  const key = createHmac("sha256", secret).update(`${DIGEST_LABEL}/key`).digest();
  const keyId = createHmac("sha256", secret)
    .update(`${DIGEST_LABEL}/key-id`)
    .digest("hex")
    .slice(0, 16);
  return { key, keyed: true, keyId };
}

/**
 * Decides how to store `filter` (see the file header) and builds the stored form.
 *
 * @throws MS_CONFIG_INVALID for an empty filter (that would erase whole collections,
 *   which is not what an erasure ledger is for).
 */
export function storeFilter(filter: Document, key: ErasureKey): StoredMatch {
  const entries = Object.entries(filter);
  if (entries.length === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "An erasure needs a non-empty filter.", {
      hint: 'Name the person\'s documents, e.g. \'{"_id": …}\' or \'{"email": "ada@example.com"}\'.',
    });
  }
  const canonical: { path: string; text: string }[] = [];
  let hasString = false;
  for (const [path, value] of entries) {
    const text = path.startsWith("$") ? undefined : canonicalScalar(value);
    if (text === undefined) return { kind: "filter", filter };
    if (typeof value === "string") hasString = true;
    canonical.push({ path, text });
  }
  if (!hasString) return { kind: "filter", filter };
  return {
    kind: "hashed",
    keyed: key.keyed,
    ...(key.keyId !== undefined ? { keyId: key.keyId } : {}),
    fields: canonical.map(({ path, text }) => ({ path, digest: digestOf(key, path, text) })),
  };
}

/** True when the document matches every hashed field of the stored filter. */
export function matchesHashed(
  document: Document,
  fields: readonly HashedField[],
  key: ErasureKey,
): boolean {
  return fields.every((field) =>
    valuesAtPath(document, field.path).some((value) => {
      const text = canonicalScalar(value);
      return text !== undefined && digestOf(key, field.path, text) === field.digest;
    }),
  );
}

/** HMAC of one field value; the path is included so equal values in different fields differ. */
function digestOf(key: ErasureKey, path: string, canonical: string): string {
  return createHmac("sha256", key.key)
    .update(`${DIGEST_LABEL}\0${path}\0${canonical}`, "utf8")
    .digest("hex");
}

/**
 * The canonical text of a scalar, or `undefined` for documents, arrays and BSON types
 * without a stable equality (regular expressions, binaries, …). Numbers of every BSON
 * numeric type that are equal as numbers get the same text.
 */
export function canonicalScalar(value: unknown): string | undefined {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number") return `number:${numberText(value)}`;
  if (typeof value === "bigint") return `number:${value.toString()}`;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (value instanceof ObjectId) return `objectId:${value.toHexString()}`;
  if (value instanceof Int32 || value instanceof Double) return `number:${numberText(value.value)}`;
  if (value instanceof Long || value instanceof Decimal128) return `number:${value.toString()}`;
  return undefined;
}

/** `String(n)`, except that -0 and 0 are the same number. */
function numberText(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

/**
 * Every value a MongoDB equality match on `path` would compare against: the value at
 * the path, each element when it is an array, descending through arrays of
 * sub-documents on the way.
 */
export function valuesAtPath(document: Document, path: string): unknown[] {
  const values: unknown[] = [];
  collect(document, path.split("."), values);
  return values;
}

function collect(value: unknown, segments: readonly string[], out: unknown[]): void {
  const [head, ...rest] = segments;
  if (head === undefined) {
    out.push(value);
    if (Array.isArray(value)) out.push(...value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collect(element, segments, out);
    return;
  }
  if (isSubDocument(value)) collect(Reflect.get(value, head), rest, out);
}

/** A plain sub-document (not an array, Date or BSON wrapper). */
function isSubDocument(value: unknown): value is Document {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Reflect.get(value, "_bsontype") === undefined
  );
}
