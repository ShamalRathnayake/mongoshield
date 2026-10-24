/**
 * What replaying one change event means: the translation table of
 * docs/specs/CONSISTENCY.md ("Restore"), as pure functions so every case is unit-tested.
 *
 *   insert, replace           replaceOne({ _id }, fullDocument, { upsert: true })
 *   update                    updateOne({ _id }, { $push: { <array>: { $each: [], $slice: n } } })
 *                               for each truncated array, then
 *                             updateOne({ _id }, { $set: updatedFields, $unset: removedFields })
 *   update with fullDocument  replaceOne (see `needsFullDocument` in converge-events.ts)
 *   delete                    deleteOne({ _id })
 *   create                    create the collection with the recorded options
 *   drop, dropDatabase,       steps the replayer applies to the restore target
 *   rename
 *   anything else             ignored (indexes and options come from the dump)
 *
 * Every write sets absolute values, so applying an event to a document that already
 * reflects it changes nothing: that is why replay converges (see the spec).
 */

import type { AnyBulkWriteOperation, Document } from "mongodb";
import {
  type ChangeEvent,
  collectionNamespaceOf,
  type UpdateDescription,
} from "./converge-events.ts";
import { createOptionsFrom } from "./restore-collections.ts";

/**
 * Writes match on `_id` with the simple (binary) collation, so a collection's default
 * collation can never make an event touch a different document whose `_id` merely
 * compares equal.
 */
export const BINARY_COLLATION = { locale: "simple" } as const;

/** One step of a replay. */
export type ReplayStep =
  /** Document writes on one namespace, in order. */
  | { readonly kind: "write"; readonly ns: string; readonly operations: AnyBulkWriteOperation[] }
  /** A collection created during the window, with its options. */
  | { readonly kind: "create"; readonly ns: string; readonly options: Document }
  | { readonly kind: "drop"; readonly ns: string }
  | { readonly kind: "dropDatabase"; readonly db: string }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  /** Nothing to do; `reason` is logged at debug level. */
  | { readonly kind: "ignore"; readonly reason: string };

/** Translates one change event into its replay step. */
export function replayStepFor(event: ChangeEvent): ReplayStep {
  const ns = collectionNamespaceOf(event.ns);
  switch (event.operationType) {
    case "insert":
    case "replace":
    case "update":
    case "delete":
      return ns === undefined ? ignore(event, "it has no namespace") : documentStep(event, ns);
    case "create":
      return ns === undefined ? ignore(event, "it has no namespace") : createStep(event, ns);
    case "drop":
      return ns === undefined ? ignore(event, "it has no namespace") : { kind: "drop", ns };
    case "dropDatabase":
      return event.ns === undefined
        ? ignore(event, "it has no database")
        : { kind: "dropDatabase", db: event.ns.db };
    case "rename": {
      const to = collectionNamespaceOf(event.to);
      if (ns === undefined || to === undefined) return ignore(event, "it lacks a namespace");
      return { kind: "rename", from: ns, to };
    }
    default:
      // createIndexes, dropIndexes, modify, shardCollection, …: indexes and options
      // are restored from the dumped metadata.
      return ignore(event, "indexes and collection options come from the dump");
  }
}

/** The writes of an insert, replace, update or delete event. */
function documentStep(event: ChangeEvent, ns: string): ReplayStep {
  // documentKey also holds the shard key on sharded collections; `_id` alone is unique.
  const id: unknown = event.documentKey?._id;
  if (id === undefined) return ignore(event, "it has no documentKey._id");
  const filter: Document = { _id: id };

  if (event.operationType === "delete") {
    return {
      kind: "write",
      ns,
      operations: [{ deleteOne: { filter, collation: BINARY_COLLATION } }],
    };
  }
  if (event.fullDocument !== undefined) {
    return { kind: "write", ns, operations: [replaceOperation(filter, event.fullDocument)] };
  }
  if (event.operationType !== "update" || event.updateDescription === undefined) {
    return ignore(event, "it carries no document");
  }
  const operations = updateOperations(filter, event.updateDescription);
  if (operations.length === 0) return ignore(event, "it changes nothing");
  return { kind: "write", ns, operations };
}

function replaceOperation(filter: Document, document: Document): AnyBulkWriteOperation {
  return {
    replaceOne: { filter, replacement: document, upsert: true, collation: BINARY_COLLATION },
  };
}

/**
 * The writes that reproduce an update description.
 *
 * Truncations come first, as their own write: the server truncates an array before it
 * sets elements in it, and one update cannot both `$push` to `arr` and `$set` `arr.1`
 * (MongoDB rejects conflicting paths). `$push` with an empty `$each` and a `$slice`
 * is the only update operator that shortens an array in place.
 */
export function updateOperations(
  filter: Document,
  update: UpdateDescription,
): AnyBulkWriteOperation[] {
  const operations: AnyBulkWriteOperation[] = [];

  if (update.truncatedArrays.length > 0) {
    const push: Document = {};
    for (const truncated of update.truncatedArrays) {
      push[truncated.field] = { $each: [], $slice: truncated.newSize };
    }
    operations.push(updateOne(filter, { $push: push }));
  }

  const set = update.updatedFields;
  const unset: Document = {};
  for (const field of update.removedFields) unset[field] = "";
  const change: Document = {};
  if (Object.keys(set).length > 0) change.$set = set;
  if (Object.keys(unset).length > 0) change.$unset = unset;
  if (Object.keys(change).length > 0) operations.push(updateOne(filter, change));

  return operations;
}

function updateOne(filter: Document, update: Document): AnyBulkWriteOperation {
  return { updateOne: { filter, update, collation: BINARY_COLLATION } };
}

/**
 * A `create` event. Views (and time series collections, which the server reports as
 * views over their buckets) are restored from the dump, so only plain collections are
 * created here, with the options the event recorded, minus `idIndex` (implied) and the
 * options `create` rejects (such as `temp` on `$out` scratch collections).
 */
function createStep(event: ChangeEvent, ns: string): ReplayStep {
  const description = event.operationDescription ?? {};
  if (description.viewOn !== undefined) {
    return ignore(event, "views and time series collections come from the dump");
  }
  const { idIndex: _idIndex, ...options } = description;
  return { kind: "create", ns, options: createOptionsFrom(options) };
}

function ignore(event: ChangeEvent, reason: string): ReplayStep {
  return { kind: "ignore", reason: `${event.operationType} event ignored: ${reason}` };
}
