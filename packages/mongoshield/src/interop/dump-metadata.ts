/**
 * Reading collection metadata written by mongodump, which is more varied than what
 * MongoShield writes. `src/format/metadata.ts` already accepts mongodump's shape;
 * this adds what only comes up with real dumps:
 *
 * - an empty metadata string (archive prelude entries of namespaces without
 *   metadata, such as the oplog) or a missing metadata file (a hand-made dump with
 *   only `.bson` files): treated as a plain collection with no options or indexes;
 * - no `collectionName` (mongodump before 100.x, or legacy dumps): taken from the
 *   file name or prelude entry, which is authoritative anyway;
 * - no `type` (old mongodump): inferred from the options the way mongorestore
 *   does (`viewOn` means a view, `timeseries` a time-series collection).
 *
 * The JSON is parsed and re-written with the order-keeping Extended JSON functions
 * (src/format/ordered-json.ts), so index keys and validators keep the field order
 * mongodump wrote, integer-like field names included.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { type CollectionMetadata, parseCollectionMetadata } from "../format/metadata.ts";
import { parseExtendedJson, stringifyExtendedJson } from "../format/ordered-json.ts";

/**
 * Parses mongodump metadata for the collection `collection`.
 *
 * @param text the metadata JSON (canonical or relaxed Extended JSON), or "" for none
 * @param collection the collection name from the file name or prelude entry; it wins
 *   over the file's `collectionName`, as it does in mongorestore
 * @param where a human-readable location for error messages
 * @throws MS_INTEGRITY_FAILED for malformed metadata, MS_FORMAT_UNSUPPORTED for an unknown type
 */
export function parseDumpMetadata(
  text: string,
  collection: string,
  where: string,
): CollectionMetadata {
  if (text.trim() === "") {
    return { collectionName: collection, type: "collection", options: {}, indexes: [] };
  }

  const raw = parseObject(text, where);
  const options: unknown = raw.options;
  const completed: Document = {
    ...raw,
    collectionName: collection,
    ...(raw.type === undefined ? { type: inferType(options) } : {}),
  };
  // Hand the completed document to the strict parser, which validates every field.
  return parseCollectionMetadata(stringifyExtendedJson(completed, { relaxed: false }), where);
}

/** The collection name a metadata file records, if any (needed for shortened file names). */
export function recordedCollectionName(text: string, where: string): string | undefined {
  const value: unknown = parseObject(text, where).collectionName;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `view` when the options name a source collection, `timeseries` for time-series options. */
function inferType(options: unknown): string {
  if (typeof options !== "object" || options === null) return "collection";
  if (Reflect.get(options, "viewOn") !== undefined) return "view";
  if (Reflect.get(options, "timeseries") !== undefined) return "timeseries";
  return "collection";
}

/** Parses Extended JSON into a plain object, keeping BSON types (relaxed: false). */
function parseObject(text: string, where: string): Document {
  let value: unknown;
  try {
    value = parseExtendedJson(text, { relaxed: false });
  } catch (error) {
    throw new MongoShieldError("MS_INTEGRITY_FAILED", `${where} is not valid Extended JSON.`, {
      cause: error,
      hint: "The metadata file of the dump is damaged; re-run mongodump.",
    });
  }
  // EJSON turns a bare number into an Int32 or Double object: a value, not a document.
  const isValue = typeof value === "object" && value !== null && "_bsontype" in value;
  if (typeof value !== "object" || value === null || Array.isArray(value) || isValue) {
    throw new MongoShieldError("MS_INTEGRITY_FAILED", `${where} is not a JSON object.`, {
      hint: "The metadata file of the dump is damaged; re-run mongodump.",
    });
  }
  return { ...value };
}
