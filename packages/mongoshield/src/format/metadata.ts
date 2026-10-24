/**
 * mongodump-compatible collection metadata: the `<collection>.metadata.json` file
 * stored next to each collection's data. It holds what is needed to recreate the
 * collection before inserting documents: its options (validator, collation,
 * capped size, view pipeline, time-series settings, …), its index definitions,
 * its type and its UUID.
 *
 * The file uses the exact shape mongodump writes, so a decrypted, decompressed
 * MongoShield backup can be restored with `mongorestore` and vice versa:
 *
 *   {"options":{…},"indexes":[{"v":{"$numberInt":"2"},"key":{"_id":{"$numberInt":"1"}},"name":"_id_"}],
 *    "uuid":"0f3b0c2e9d7a4c1b8e6f5a4d3c2b1a09","collectionName":"users","type":"collection"}
 *
 * Details that matter for compatibility (from mongo-tools' `mongodump/metadata_dump.go`):
 *
 * - Field order is `options, indexes, uuid, collectionName, type`, the order of
 *   mongodump's Go `Metadata` struct. mongorestore does not depend on the order,
 *   but matching it keeps files diffable against real mongodump output.
 * - mongodump omits `options` when empty and `uuid` when unknown. We always write
 *   `options` (as `{}` when empty) because mongorestore treats both the same, and
 *   we omit `uuid` when unknown like mongodump does.
 * - The `uuid` is the collection UUID as 32 lowercase hex characters, no dashes
 *   (Go's `hex.EncodeToString` of the 16 UUID bytes).
 * - Values are canonical Extended JSON, so BSON types survive: an int64 index
 *   option stays `{"$numberLong":…}`, a date in a partial filter stays a date,
 *   a regex in a validator stays a regex, and int32 `1` never turns into double `1.0`.
 *
 * MongoShield extension: `searchIndexes`, written after `type` and only when the
 * collection has Atlas Search or Vector Search indexes (mongodump does not capture
 * them). mongorestore parses this file into a Go struct, which ignores unknown
 * fields, so the file stays mongorestore-compatible; mongorestore simply does not
 * create search indexes. See docs/specs/FORMAT.md.
 */

import { type Binary, BSON, type Document } from "mongodb";
import { z } from "zod";
import { MongoShieldError } from "../errors.ts";

/** The kinds of namespace mongodump distinguishes (the `type` field of `listCollections`). */
export const COLLECTION_TYPES = ["collection", "view", "timeseries"] as const;

/** The kind of a namespace: a regular collection, a view or a time-series collection. */
export type CollectionType = (typeof COLLECTION_TYPES)[number];

/** The kinds of Atlas search index (the `type` field of `$listSearchIndexes`). */
export const SEARCH_INDEX_TYPES = ["search", "vectorSearch"] as const;

/** An Atlas Search index (`search`) or an Atlas Vector Search index (`vectorSearch`). */
export type SearchIndexType = (typeof SEARCH_INDEX_TYPES)[number];

/**
 * One Atlas Search / Vector Search index as backed up: exactly what
 * `createSearchIndexes` needs to recreate it. Status fields (`status`, `queryable`,
 * `statusDetail`, …) describe the source cluster's build state and are not kept.
 */
export interface SearchIndexDefinition {
  readonly name: string;
  readonly type: SearchIndexType;
  /** The index definition (`latestDefinition` of `$listSearchIndexes`): mappings, fields, analyzers, … */
  readonly definition: Document;
}

/** Contents of a `<collection>.metadata.json` file. */
export interface CollectionMetadata {
  /** Collection name without the database, e.g. `users`. */
  collectionName: string;
  type: CollectionType;
  /** `listCollections` options: validator, collation, capped, viewOn, pipeline, timeseries, … */
  options: Document;
  /** `listIndexes` results, one document per index. Empty for views. */
  indexes: Document[];
  /** Collection UUID: 32 lowercase hex characters, no dashes, as mongodump writes it. */
  uuid?: string;
  /**
   * Atlas Search and Vector Search indexes (MongoShield extension, see the header).
   * Absent when the collection has none or the server does not support them.
   */
  searchIndexes?: SearchIndexDefinition[];
}

/** 32 lowercase hex characters: the 16 bytes of a UUID without dashes. */
const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/** Collection UUIDs are BSON Binary subtype 4 holding exactly 16 bytes. */
const UUID_BYTES = 16;

/**
 * Formats a collection UUID (the `info.uuid` Binary from `listCollections`) the
 * way mongodump stores it: 32 lowercase hex characters without dashes.
 */
export function formatCollectionUuid(uuid: Binary): string {
  const bytes = uuid.value();
  if (bytes.length !== UUID_BYTES) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      `A collection UUID must be ${UUID_BYTES} bytes, got ${bytes.length}.`,
    );
  }
  return Buffer.from(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Serializes collection metadata as a single line of canonical Extended JSON,
 * with fields in mongodump's order.
 *
 * @throws MS_INTERNAL if `uuid` is not 32 lowercase hex characters (a caller bug).
 */
export function serializeCollectionMetadata(metadata: CollectionMetadata): string {
  if (metadata.uuid !== undefined && !UUID_HEX_PATTERN.test(metadata.uuid)) {
    throw new MongoShieldError(
      "MS_INTERNAL",
      `Collection UUID "${metadata.uuid}" must be 32 lowercase hex characters without dashes.`,
      { hint: "Use formatCollectionUuid() to convert the UUID from listCollections." },
    );
  }

  // Build the object field by field: JSON keeps insertion order, and this is
  // the order mongodump writes.
  const ordered: Document = {
    options: metadata.options,
    indexes: metadata.indexes,
    ...(metadata.uuid === undefined ? {} : { uuid: metadata.uuid }),
    collectionName: metadata.collectionName,
    type: metadata.type,
    // Only written when there are some, so files of collections without search
    // indexes stay byte-for-byte what mongodump writes.
    ...(metadata.searchIndexes === undefined || metadata.searchIndexes.length === 0
      ? {}
      : { searchIndexes: metadata.searchIndexes.map(orderedSearchIndex) }),
  };
  return BSON.EJSON.stringify(ordered, { relaxed: false });
}

/** A search index with its fields in a fixed order (`name, type, definition`). */
function orderedSearchIndex(index: SearchIndexDefinition): Document {
  return { name: index.name, type: index.type, definition: index.definition };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The file shape as mongodump and MongoShield write it. Optional fields reflect
 * what mongodump may omit: `options` when empty, `uuid` when the server has none
 * (before MongoDB 3.6), and `type` in files from old mongodump versions.
 * Unknown extra fields are ignored so newer mongodump output still reads.
 */
const MetadataFileSchema = z.object({
  options: z.record(z.string(), z.unknown()).optional(),
  indexes: z.array(z.record(z.string(), z.unknown())).optional(),
  uuid: z
    .string()
    .regex(/^[0-9a-fA-F]{32}$/, "expected 32 hex characters")
    .optional(),
  collectionName: z.string().min(1),
  type: z.string().optional(),
  searchIndexes: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        definition: z.record(z.string(), z.unknown()),
      }),
    )
    .optional(),
});

/**
 * Parses a `<collection>.metadata.json` file written by MongoShield or mongodump.
 *
 * Error codes, chosen by what the failure says about the backup:
 * - `MS_INTEGRITY_FAILED` when the text is not valid Extended JSON or lacks
 *   required fields. Metadata files are backup data (listed in the manifest with
 *   a checksum), so a malformed one means the backup is damaged, just like a
 *   corrupt data file. `MS_MANIFEST_INVALID` is reserved for the manifest itself.
 * - `MS_FORMAT_UNSUPPORTED` when the file is well-formed but names a collection
 *   `type` this release does not know, e.g. one added by a future MongoDB.
 *   Upgrading is the fix, which is what that code tells the user.
 *
 * @param text the file contents (already decrypted)
 * @param where a human-readable location used in error messages
 */
export function parseCollectionMetadata(text: string, where = "metadata.json"): CollectionMetadata {
  const file = validateShape(parseExtendedJson(text, where), where);

  const type = file.type ?? "collection";
  if (!isCollectionType(type)) {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `${where} describes a namespace of type "${type}", which this release cannot restore.`,
      { hint: `Upgrade mongoshield. Known types: ${COLLECTION_TYPES.join(", ")}.` },
    );
  }

  const searchIndexes = parseSearchIndexes(file.searchIndexes ?? [], where);
  return {
    collectionName: file.collectionName,
    type,
    options: file.options ?? {},
    indexes: file.indexes ?? [],
    ...(file.uuid === undefined ? {} : { uuid: file.uuid.toLowerCase() }),
    ...(searchIndexes.length === 0 ? {} : { searchIndexes }),
  };
}

/**
 * Checks the search index types. An unknown type (one a future Atlas adds) is
 * refused like an unknown collection type: recreating it as something else would
 * build the wrong index, and upgrading is the fix.
 */
function parseSearchIndexes(
  indexes: readonly { name: string; type: string; definition: Document }[],
  where: string,
): SearchIndexDefinition[] {
  const parsed: SearchIndexDefinition[] = [];
  for (const index of indexes) {
    if (!isSearchIndexType(index.type)) {
      throw new MongoShieldError(
        "MS_FORMAT_UNSUPPORTED",
        `${where} holds search index "${index.name}" of type "${index.type}", which this release cannot restore.`,
        {
          hint: `Upgrade mongoshield. Known search index types: ${SEARCH_INDEX_TYPES.join(", ")}.`,
        },
      );
    }
    parsed.push({ name: index.name, type: index.type, definition: index.definition });
  }
  return parsed;
}

/** True for the search index types this release can recreate. */
export function isSearchIndexType(value: unknown): value is SearchIndexType {
  return (SEARCH_INDEX_TYPES as readonly unknown[]).includes(value);
}

/** Parses canonical Extended JSON, keeping BSON wrapper types (Int32, Long, …). */
function parseExtendedJson(text: string, where: string): unknown {
  try {
    // relaxed: false keeps {"$numberInt":"1"} as Int32 and {"$numberDouble":"1.0"}
    // as Double, so writing the metadata back produces the same types.
    return BSON.EJSON.parse(text, { relaxed: false });
  } catch (error) {
    throw new MongoShieldError("MS_INTEGRITY_FAILED", `${where} is not valid Extended JSON.`, {
      cause: error,
      hint: "The metadata file is damaged. Verify the backup or restore from another one.",
    });
  }
}

function validateShape(raw: unknown, where: string): z.infer<typeof MetadataFileSchema> {
  const result = MetadataFileSchema.safeParse(raw);
  if (!result.success) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `${where} is not valid collection metadata:\n${z.prettifyError(result.error)}`,
      { hint: "The metadata file is damaged. Verify the backup or restore from another one." },
    );
  }
  return result.data;
}

function isCollectionType(value: string): value is CollectionType {
  return (COLLECTION_TYPES as readonly string[]).includes(value);
}
