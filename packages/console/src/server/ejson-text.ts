/**
 * Relaxed Extended JSON that never loses digits.
 *
 * Relaxed Extended JSON writes every Int64 as a plain JSON number. Beyond 2^53
 * (9,007,199,254,740,992) a JSON number cannot hold every integer: a browser parsing
 * `9007199254740993` gets `9007199254740992`, so the document viewer would show (and an
 * edit would save) a different value. `relaxedText` therefore writes those Int64 values
 * the canonical way, `{"$numberLong": "9007199254740993"}`, and everything else exactly as
 * relaxed Extended JSON does. Int64 values inside the safe range stay plain numbers.
 *
 * Every place that sends documents to the browser as relaxed Extended JSON uses this
 * (live pages, backup pages, samples, exports), and so does the live editor's merge, which
 * compares the user's edit against the text the user was shown.
 */

import { BSON } from "mongodb";

/** Relaxed Extended JSON text of a value, with unsafe Int64 values kept exact. */
export function relaxedText(value: unknown): string {
  const relaxed: unknown = BSON.EJSON.serialize(value, { relaxed: true });
  const canonical: unknown = BSON.EJSON.serialize(value, { relaxed: false });
  return JSON.stringify(keepExactLongs(relaxed, canonical));
}

/** True for `{"$numberLong": "<digits>"}` whose value a JSON number cannot hold exactly. */
function isUnsafeLong(canonical: unknown): canonical is { $numberLong: string } {
  if (typeof canonical !== "object" || canonical === null) return false;
  const keys = Object.keys(canonical);
  if (keys.length !== 1 || keys[0] !== "$numberLong") return false;
  const digits: unknown = Reflect.get(canonical, "$numberLong");
  return typeof digits === "string" && !Number.isSafeInteger(Number(digits));
}

/**
 * Walks the relaxed and canonical forms of the same value together and takes the
 * canonical form wherever it is an unsafe Int64. Other Extended JSON values (`$date`,
 * `$oid`, …) are leaves: they are not walked into.
 */
function keepExactLongs(relaxed: unknown, canonical: unknown): unknown {
  if (isUnsafeLong(canonical)) return canonical;
  if (Array.isArray(relaxed) && Array.isArray(canonical)) {
    return relaxed.map((item, index) => keepExactLongs(item, canonical[index]));
  }
  if (
    typeof relaxed === "object" &&
    relaxed !== null &&
    typeof canonical === "object" &&
    canonical !== null &&
    !Object.keys(relaxed).some((key) => key.startsWith("$"))
  ) {
    return Object.fromEntries(
      Object.entries(relaxed).map(([key, child]) => [
        key,
        keepExactLongs(child, Reflect.get(canonical, key)),
      ]),
    );
  }
  return relaxed;
}
