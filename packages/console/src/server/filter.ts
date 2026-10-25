/**
 * Parsing MongoDB filters sent as Extended JSON, for the document browser
 * (`?filter=`) and for restoring selected documents (`RestoreRequest.filter`).
 *
 * The filter is only ever evaluated in-process by the library against documents
 * read from a backup (or, for a `drop` document restore, sent as a delete filter
 * to the target the caller is already allowed to restore into). It is never run
 * against any other database.
 */

import { BSON, type Document } from "mongodb";
import { invalid } from "./errors.ts";
import { asObject } from "./validate.ts";

/**
 * Longest accepted filter. Selecting documents in the browser produces an
 * `{"_id": {"$in": [...]}}` filter; 16 KiB fits a few hundred ObjectIds.
 */
export const MAX_FILTER_LENGTH = 16 * 1024;

/**
 * Parses a filter. Relaxed and canonical Extended JSON are both accepted;
 * parsing with `relaxed: false` keeps `{"$numberLong": …}`, `{"$oid": …}` and
 * friends as their BSON types, so they match the backed-up values exactly.
 *
 * @returns `undefined` for an absent or blank filter.
 */
export function parseExtendedJsonFilter(
  raw: string | undefined,
  label: string,
): Document | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.length > MAX_FILTER_LENGTH) {
    throw invalid(`${label} must be at most ${MAX_FILTER_LENGTH} characters.`);
  }
  let parsed: unknown;
  try {
    parsed = BSON.EJSON.parse(raw, { relaxed: false });
  } catch {
    throw invalid(`${label} is not valid Extended JSON.`);
  }
  return asObject(parsed, label);
}
