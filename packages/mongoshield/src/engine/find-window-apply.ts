/**
 * Applying a converge backup's document change events to a document in memory, with
 * the rules restore's replay uses on the server (converge-operations.ts), so `find`
 * can show documents as they were at the end of the backup window without a server.
 *
 *   insert, replace, update with fullDocument   the event's document (an upsert)
 *   update                                      truncate arrays, then $set / $unset the
 *                                               dotted paths of `updateDescription`
 *   delete                                      the document is gone
 *
 * An update of a document that does not exist changes nothing (replay's `updateOne`
 * does not upsert). The two writes of an update (truncation, then set/unset) each
 * apply completely or not at all, and one whose path no longer fits the document
 * (`$set` through a number, `$push` to a non-array) is skipped, exactly as replay
 * tolerates those errors: a later event of the window sets that field absolutely.
 *
 * Dotted paths are resolved the way the server resolves update paths: a numeric
 * component indexes an array and names a field of a document; missing documents on
 * the way are created; setting past the end of an array pads it with nulls.
 *
 * Documents are never modified in place: every write works on a copy, so a skipped
 * write leaves no half-applied trace and callers' documents stay intact.
 */

import type { Document } from "mongodb";
import type { ChangeEvent, UpdateDescription } from "./converge-events.ts";
import {
  bsonTag,
  isIntegerLikeKey,
  orderedEntries,
  recordStoredFieldOrder,
  storedFieldOrder,
} from "./filter-values.ts";

/** A document, or `undefined` for "no document with this `_id`". */
export type DocumentState = Document | undefined;

/** The change event types that write documents. */
const DOCUMENT_EVENT_TYPES = new Set(["insert", "replace", "update", "delete"]);

/** True for events that change one document (insert, replace, update, delete). */
export function isDocumentEvent(event: ChangeEvent): boolean {
  return DOCUMENT_EVENT_TYPES.has(event.operationType);
}

/**
 * True when the event's outcome does not depend on the document before it: deletes,
 * and events that carry the whole new document.
 */
export function replacesDocument(event: ChangeEvent): boolean {
  return event.operationType === "delete" || event.fullDocument !== undefined;
}

/**
 * The document after one document event. `before` is not modified.
 *
 * Events that carry nothing applicable (an update without a description) leave the
 * document as it was, like replay ignores them.
 */
export function applyDocumentEvent(before: DocumentState, event: ChangeEvent): DocumentState {
  if (event.operationType === "delete") return undefined;
  if (event.fullDocument !== undefined) return cloneValue(event.fullDocument) as Document;
  if (event.operationType !== "update" || event.updateDescription === undefined) return before;
  return applyUpdateDescription(before, event.updateDescription);
}

/**
 * Applies an update description as replay's two writes would: first the array
 * truncations (one `$push … $slice` write), then `$set` + `$unset` (one write).
 */
export function applyUpdateDescription(
  before: DocumentState,
  update: UpdateDescription,
): DocumentState {
  if (before === undefined) return undefined;
  let document = before;
  if (update.truncatedArrays.length > 0) {
    document = applyWrite(document, (copy) => {
      for (const truncated of update.truncatedArrays) {
        truncateArray(copy, splitUpdatePath(truncated.field), truncated.newSize);
      }
    });
  }
  // In the event's stored order: new fields are appended in that order (see
  // `noteAppendedField`), and JavaScript would list integer-like paths first.
  const set = orderedEntries(update.updatedFields);
  if (set.length + update.removedFields.length > 0) {
    document = applyWrite(document, (copy) => {
      for (const [path, value] of set) setPath(copy, splitUpdatePath(path), cloneValue(value));
      for (const path of update.removedFields) unsetPath(copy, splitUpdatePath(path));
    });
  }
  return document;
}

// ---------------------------------------------------------------------------
// One write: all or nothing
// ---------------------------------------------------------------------------

/** Thrown by a write whose path does not fit the document (replay tolerates these). */
class PathNotViable extends Error {}

/** Runs `write` on a copy of `document`; when the path does not fit, the original stays. */
function applyWrite(document: Document, write: (copy: Document) => void): Document {
  const copy = cloneValue(document) as Document;
  try {
    write(copy);
    return copy;
  } catch (error) {
    if (error instanceof PathNotViable) return document;
    throw error;
  }
}

/** `"a.0.b"` → `["a", "0", "b"]`. Change events report update paths dotted. */
function splitUpdatePath(path: string): string[] {
  return path.split(".");
}

/** The array index a path component names, when the container is an array. */
function arrayIndex(component: string): number | undefined {
  if (!/^\d+$/.test(component)) return undefined;
  const index = Number(component);
  return Number.isSafeInteger(index) ? index : undefined;
}

/**
 * Walks to the container of the path's last component, creating missing documents
 * on the way (as `$set` and `$push` do). Throws PathNotViable through a scalar.
 */
function containerFor(root: Document, components: readonly string[]): Document | unknown[] {
  let container: Document | unknown[] = root;
  for (const component of components.slice(0, -1)) {
    const next = childOf(container, component);
    if (next === undefined || next === null) {
      // A missing field is created as an empty document; null is a value and blocks.
      if (next === null) throw new PathNotViable();
      const created: Document = {};
      assignChild(container, component, created);
      container = created;
    } else if (Array.isArray(next) || isPlainDocument(next)) {
      container = next;
    } else {
      throw new PathNotViable();
    }
  }
  return container;
}

/** The value under `component`, or `undefined` when there is none. */
function childOf(container: Document | unknown[], component: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(component);
    if (index === undefined) throw new PathNotViable();
    return container[index];
  }
  return Object.hasOwn(container, component) ? container[component] : undefined;
}

/** Sets `component` of a container; arrays are padded with nulls up to the index. */
function assignChild(container: Document | unknown[], component: string, value: unknown): void {
  if (!Array.isArray(container)) {
    if (!Object.hasOwn(container, component)) noteAppendedField(container, component);
    container[component] = value;
    return;
  }
  const index = arrayIndex(component);
  if (index === undefined) throw new PathNotViable();
  while (container.length < index) container.push(null);
  container[index] = value;
}

/**
 * `$set` of a field a document does not have appends it, as the server does (in the
 * order the change event lists the new fields). JavaScript would list an integer-like
 * name first instead, so the stored order is recorded, or extended, to say where the
 * field goes (see find-parse.ts). A document without integer-like names needs nothing:
 * its JavaScript order is already its stored order.
 */
function noteAppendedField(document: Document, field: string): void {
  const order = storedFieldOrder(document);
  if (order === undefined && !isIntegerLikeKey(field)) return;
  recordStoredFieldOrder(document, [...(order ?? Object.keys(document)), field]);
}

/** `$set: { path: value }`. */
function setPath(root: Document, components: readonly string[], value: unknown): void {
  const container = containerFor(root, components);
  assignChild(container, lastOf(components), value);
}

/**
 * `$unset: { path: "" }`: removes a field; an array element becomes null. A path
 * that does not exist (or runs through a scalar) changes nothing.
 */
function unsetPath(root: Document, components: readonly string[]): void {
  let container: unknown = root;
  for (const component of components.slice(0, -1)) {
    container = existingChild(container, component);
    if (container === undefined) return;
  }
  const last = lastOf(components);
  if (Array.isArray(container)) {
    const index = arrayIndex(last);
    if (index !== undefined && index < container.length) container[index] = null;
  } else if (isPlainDocument(container)) {
    delete container[last];
  }
}

/** The child of a document or array, for $unset: undefined when the path stops. */
function existingChild(container: unknown, component: string): unknown {
  if (Array.isArray(container)) {
    const index = arrayIndex(component);
    return index === undefined ? undefined : container[index];
  }
  if (isPlainDocument(container) && Object.hasOwn(container, component)) {
    return container[component];
  }
  return undefined;
}

/**
 * `$push: { path: { $each: [], $slice: size } }`: keeps the first `size` elements. A
 * missing field becomes an empty array (that is what `$push` does); a field that is
 * not an array makes the write fail.
 */
function truncateArray(root: Document, components: readonly string[], size: number): void {
  const container = containerFor(root, components);
  const last = lastOf(components);
  const current = childOf(container, last);
  if (current === undefined) {
    assignChild(container, last, []);
    return;
  }
  if (!Array.isArray(current)) throw new PathNotViable();
  current.length = Math.min(current.length, Math.max(0, size));
}

function lastOf(components: readonly string[]): string {
  return components.at(-1) ?? "";
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/**
 * A deep copy of the documents and arrays in a value, keeping recorded stored field
 * orders. BSON values (ObjectId, Int32, dates, …) are shared: nothing here modifies
 * them.
 */
export function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((element: unknown) => cloneValue(element));
  if (!isPlainDocument(value)) return value;
  const copy: Document = {};
  for (const [field, child] of Object.entries(value)) copy[field] = cloneValue(child);
  // Keep the stored order of integer-like field names (see find-parse.ts).
  const order = storedFieldOrder(value);
  if (order !== undefined) recordStoredFieldOrder(copy, order);
  return copy;
}

/** An embedded document: an object that is not an array, a Date, a RegExp or a BSON value. */
function isPlainDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (value instanceof Date || value instanceof RegExp) return false;
  return bsonTag(value) === undefined;
}
