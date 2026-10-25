/**
 * Field-level differences between two documents, for the "Review changes" step of the
 * live document editor: which fields an edit adds, removes or changes, by dotted path.
 *
 * Both sides are relaxed Extended JSON as `JSON.parse` returns it. EJSON type wrappers
 * (`{"$oid": …}`, `{"$date": …}`) are compared as values, never walked into, so changing
 * a date shows one change at `createdAt`, not at `createdAt.$date`. Arrays are compared
 * element by element (`tags.0`, `tags.1`); a longer or shorter array shows the extra
 * elements as added or removed.
 *
 * The server merges an edit the same way (untouched fields keep their exact BSON type),
 * so what this lists is what will change.
 */

import { describeWrapper, isJsonObject, type JsonValue } from "./ejson.ts";

/** One differing field. Values are compact JSON text, ready to show. */
export interface FieldChange {
  /** Dotted path, e.g. `address.city` or `tags.2`. */
  readonly path: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: string;
  readonly after?: string;
}

/** Most changes listed; an edit that rewrites a huge document is summarised. */
export const MAX_LISTED_CHANGES = 200;

/** The fields that differ between `before` and `after`, in document order. */
export function diffDocuments(before: JsonValue, after: JsonValue): FieldChange[] {
  const changes: FieldChange[] = [];
  diffValue(before, after, "", changes);
  return changes.slice(0, MAX_LISTED_CHANGES);
}

/** Compact JSON of a value, for display. */
export function showValue(value: JsonValue): string {
  return describeWrapper(value)?.text ?? JSON.stringify(value);
}

/** True when a value is walked into (a plain object or an array, not an EJSON wrapper). */
function isContainer(value: JsonValue): boolean {
  if (Array.isArray(value)) return true;
  return isJsonObject(value) && describeWrapper(value) === undefined;
}

function diffValue(
  before: JsonValue,
  after: JsonValue,
  path: string,
  changes: FieldChange[],
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffEntry(before[index], after[index], join(path, String(index)), changes);
    }
    return;
  }
  if (isContainer(before) && isContainer(after) && isJsonObject(before) && isJsonObject(after)) {
    // Keys of `before` first (in its order), then the keys only `after` has.
    const keys = [...Object.keys(before)];
    for (const key of Object.keys(after)) if (!keys.includes(key)) keys.push(key);
    for (const key of keys) diffEntry(before[key], after[key], join(path, key), changes);
    return;
  }
  changes.push({
    path: path === "" ? "(document)" : path,
    change: "changed",
    before: showValue(before),
    after: showValue(after),
  });
}

/** One key or index that may be missing on either side. */
function diffEntry(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
  changes: FieldChange[],
): void {
  if (before === undefined && after === undefined) return;
  if (before === undefined && after !== undefined) {
    changes.push({ path, change: "added", after: showValue(after) });
  } else if (after === undefined && before !== undefined) {
    changes.push({ path, change: "removed", before: showValue(before) });
  } else if (before !== undefined && after !== undefined) {
    diffValue(before, after, path, changes);
  }
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}
