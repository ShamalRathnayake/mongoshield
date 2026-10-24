/**
 * Change events, the content of a converge backup's changes file
 * (`_changes/window.bson[.zst][.age]`, see docs/specs/FORMAT.md).
 *
 * The file holds the change stream events of the backup window as concatenated BSON
 * documents, exactly as the server sent them (one exception: see
 * `needsFullDocument`). This module parses them into the few fields capture, replay
 * and verify look at, and reads them back from storage.
 *
 * Parsing is lossless (`LOSSLESS_DESERIALIZE_OPTIONS`): document values keep their exact
 * BSON types (an Int32 stays an Int32), so replaying an event writes back exactly the
 * values the source had. The flip side is that numbers in the event itself (such as
 * `truncatedArrays[].newSize`) arrive as BSON wrappers and are unwrapped here.
 */

import { BSON, type Document, Double, Int32, Long, Timestamp } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import type { ClusterTime, StoredFile } from "../format/manifest.ts";
import { openDocumentStream, type StoredBackupSource } from "./read-pipeline.ts";

/** A change event's `ns` or `to`: a database, plus a collection for collection events. */
export interface ChangeNamespace {
  readonly db: string;
  /** Missing for database-level events such as `dropDatabase`. */
  readonly coll: string | undefined;
}

/** One entry of `updateDescription.truncatedArrays`. */
export interface TruncatedArray {
  /** Dotted path of the array. */
  readonly field: string;
  /** The array's length after the update; elements from this index on were removed. */
  readonly newSize: number;
}

/** The `updateDescription` of an `update` event: what changed, as absolute values. */
export interface UpdateDescription {
  /** Dotted path → new value. */
  readonly updatedFields: Document;
  /** Dotted paths that were removed. */
  readonly removedFields: readonly string[];
  readonly truncatedArrays: readonly TruncatedArray[];
  /**
   * MongoDB 6.1+ (with `showExpandedEvents`): for every path above that is ambiguous,
   * its components. A string is a field name (which may itself contain dots or look
   * like a number), a number is an array index.
   */
  readonly disambiguatedPaths: ReadonlyMap<string, readonly (string | number)[]>;
}

/** The fields of a change event that MongoShield uses. */
export interface ChangeEvent {
  /** `insert`, `update`, `replace`, `delete`, `drop`, `rename`, `dropDatabase`, `create`, … */
  readonly operationType: string;
  readonly clusterTime: ClusterTime;
  readonly ns: ChangeNamespace | undefined;
  /** `rename` events only: the new name. */
  readonly to: ChangeNamespace | undefined;
  /** `_id` (plus the shard key on sharded collections) of the changed document. */
  readonly documentKey: Document | undefined;
  /** `insert` and `replace` events; `update` events enriched by the capture. */
  readonly fullDocument: Document | undefined;
  readonly updateDescription: UpdateDescription | undefined;
  /** DDL events: e.g. the options of a `create`, `dropTarget` of a `rename`. */
  readonly operationDescription: Document | undefined;
  /** The whole event, parsed losslessly, for re-serializing an enriched copy. */
  readonly document: Document;
}

/** A change event together with its exact stored bytes. */
export interface StoredChangeEvent {
  readonly raw: Buffer;
  readonly event: ChangeEvent;
}

/**
 * Parses one raw change event.
 *
 * @throws MongoShieldError `MS_INTEGRITY_FAILED` when the bytes are not BSON or lack the
 *   fields every change event has (`operationType`, `clusterTime`).
 */
export function parseChangeEvent(raw: Uint8Array): ChangeEvent {
  let document: Document;
  try {
    document = BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS);
  } catch (error) {
    throw malformedEvent(`it is not valid BSON (${describe(error)})`, error);
  }

  const { operationType, clusterTime } = document;
  if (typeof operationType !== "string") throw malformedEvent("it has no operationType");
  if (!(clusterTime instanceof Timestamp)) throw malformedEvent("it has no clusterTime");

  return {
    operationType,
    clusterTime: { t: clusterTime.t, i: clusterTime.i },
    ns: parseNamespace(document.ns),
    to: parseNamespace(document.to),
    documentKey: asDocument(document.documentKey),
    fullDocument: asDocument(document.fullDocument),
    updateDescription: parseUpdateDescription(document.updateDescription),
    operationDescription: asDocument(document.operationDescription),
    document,
  };
}

/** `db.coll` (or just `db` for database events), as used everywhere else in MongoShield. */
export function namespaceString(ns: ChangeNamespace): string {
  return ns.coll === undefined ? ns.db : `${ns.db}.${ns.coll}`;
}

/** The full namespace of a collection-level event, or `undefined` for other events. */
export function collectionNamespaceOf(namespace: ChangeNamespace | undefined): string | undefined {
  if (namespace?.coll === undefined) return undefined;
  return `${namespace.db}.${namespace.coll}`;
}

/**
 * True when an `update` event cannot be replayed as `$set`/`$unset` because a changed
 * path contains a field name that update operators cannot address: one with a dot in
 * it, one starting with `$`, or an empty one. The capture then adds the document as it
 * was right after the update (`fullDocument`), and replay uses a replacement instead.
 *
 * Detecting dotted field names needs `disambiguatedPaths` (MongoDB 6.1+); on 6.0 such
 * paths look like ordinary nested paths, which is recorded as a manifest warning.
 */
export function needsFullDocument(event: ChangeEvent): boolean {
  if (event.operationType !== "update" || event.fullDocument !== undefined) return false;
  const update = event.updateDescription;
  if (update === undefined) return false;
  const paths = [
    ...Object.keys(update.updatedFields),
    ...update.removedFields,
    ...update.truncatedArrays.map((truncated) => truncated.field),
  ];
  return paths.some((path) => !isAddressablePath(pathComponents(update, path)));
}

/**
 * The components of a changed path: from `disambiguatedPaths` when the server gave
 * them, otherwise by splitting the dotted path.
 */
export function pathComponents(
  update: UpdateDescription,
  path: string,
): readonly (string | number)[] {
  return update.disambiguatedPaths.get(path) ?? path.split(".");
}

/** True when update operators can address every component through a dotted path. */
function isAddressablePath(components: readonly (string | number)[]): boolean {
  return components.every(
    (component) =>
      typeof component === "number" ||
      (component.length > 0 && !component.includes(".") && !component.startsWith("$")),
  );
}

/**
 * Reads every event of a stored changes file, in order, with its raw bytes.
 * Integrity, decryption and decompression work exactly as for data files (it is read
 * through the same pipeline), so the same errors apply: `MS_INTEGRITY_FAILED`,
 * `MS_DECRYPTION_FAILED`, `MS_STORAGE_NOT_FOUND`, `MS_ABORTED`.
 */
export async function* readChangeEvents(
  source: StoredBackupSource,
  file: StoredFile,
  signal: AbortSignal | undefined,
): AsyncGenerator<StoredChangeEvent> {
  for await (const chunk of openDocumentStream(source, file, { signal })) {
    const raw = chunk as Buffer;
    yield { raw, event: parseChangeEvent(raw) };
  }
}

// ---------------------------------------------------------------------------
// Field parsers
// ---------------------------------------------------------------------------

function parseNamespace(value: unknown): ChangeNamespace | undefined {
  const document = asDocument(value);
  if (document === undefined || typeof document.db !== "string") return undefined;
  return { db: document.db, coll: typeof document.coll === "string" ? document.coll : undefined };
}

function parseUpdateDescription(value: unknown): UpdateDescription | undefined {
  const document = asDocument(value);
  if (document === undefined) return undefined;

  const removedFields = Array.isArray(document.removedFields)
    ? document.removedFields.filter((field): field is string => typeof field === "string")
    : [];

  const truncatedArrays: TruncatedArray[] = [];
  if (Array.isArray(document.truncatedArrays)) {
    for (const entry of document.truncatedArrays) {
      const truncated = asDocument(entry);
      const newSize = numberOf(truncated?.newSize);
      if (typeof truncated?.field === "string" && newSize !== undefined) {
        truncatedArrays.push({ field: truncated.field, newSize });
      }
    }
  }

  return {
    updatedFields: asDocument(document.updatedFields) ?? {},
    removedFields,
    truncatedArrays,
    disambiguatedPaths: parseDisambiguatedPaths(document.disambiguatedPaths),
  };
}

/** `{ "a.b": ["a.b"], "arr.0": ["arr", 0] }` → a map of components (numbers unwrapped). */
function parseDisambiguatedPaths(value: unknown): Map<string, (string | number)[]> {
  const paths = new Map<string, (string | number)[]>();
  const document = asDocument(value);
  if (document === undefined) return paths;
  for (const [path, components] of Object.entries(document)) {
    if (!Array.isArray(components)) continue;
    const parsed: (string | number)[] = [];
    for (const component of components) {
      if (typeof component === "string") parsed.push(component);
      else {
        const index = numberOf(component);
        if (index !== undefined) parsed.push(index);
      }
    }
    paths.set(path, parsed);
  }
  return paths;
}

/**
 * A plain number from a lossless-parsed BSON number (Int32, Long and Double arrive
 * as wrapper objects), or `undefined` for anything else.
 */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value instanceof Int32 || value instanceof Double) return value.valueOf();
  if (value instanceof Long) return value.toNumber();
  return undefined;
}

function asDocument(value: unknown): Document | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  // Lossless parsing keeps BSON wrapper objects (Int32, ObjectId, …); those are values.
  if (Reflect.get(value, "_bsontype") !== undefined) return undefined;
  return value;
}

function malformedEvent(problem: string, cause?: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `A change event in the backup's changes file is malformed: ${problem}.`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint: "The backup is damaged. Run `mongoshield verify --deep` and restore from another backup.",
    },
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
