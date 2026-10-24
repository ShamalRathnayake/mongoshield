/**
 * Bringing a restored collection's options and index properties up to date with the
 * newest metadata of an incremental chain (docs/specs/FORMAT.md, "Incremental backups").
 *
 * Change events do not carry `collMod`: a validator added, a TTL changed or an index
 * hidden after the chain's base would be lost if the restore only used the base's
 * metadata. Every incremental therefore records the metadata of every selected
 * namespace, and a chain restore, once the documents are in, the changes replayed and
 * the indexes built, compares each collection with the chain's newest metadata and
 * applies the differences with `collMod`:
 *
 *   validator, validationLevel, validationAction     schema validation
 *   expireAfterSeconds                                TTL of a clustered collection
 *   changeStreamPreAndPostImages                     pre- and post-images
 *   index { name, expireAfterSeconds | hidden }      TTL and hidden indexes
 *
 * Why at the end and not when the collection is created: a stricter validator added
 * after the base could reject base documents (or replayed changes) that were valid
 * when they were written; MongoDB itself never re-validates existing documents on
 * `collMod`. Indexes themselves (created and dropped) come from the replayed index
 * events as before; only properties `collMod` changes in place are aligned here.
 *
 * Values are compared and sent in their stored field order (field-order.ts): the
 * target's options are read as raw BSON, and a validator with integer-like field names
 * would otherwise compare (and be written) in a different order.
 */

import { BSON, type Db, type Document, type WriteConcernSettings } from "mongodb";
import { deserializeInStoredOrder, valueInStoredOrder } from "../format/field-order.ts";
import type { CollectionMetadata } from "../format/metadata.ts";
import { stringifyExtendedJson } from "../format/ordered-json.ts";
import type { Logger } from "../logger.ts";
import { commandWriteConcern } from "./restore-collections.ts";

/** Collection options `collMod` can change in place, in the order they are applied. */
export const MODIFIABLE_OPTIONS = [
  "validator",
  "validationLevel",
  "validationAction",
  "expireAfterSeconds",
  "changeStreamPreAndPostImages",
] as const;

/**
 * What to send when the newest metadata no longer has an option the target has:
 * `collMod` turns validation, a clustered TTL or pre- and post-images off this way.
 * Options without a reset (`validationLevel`, `validationAction`) keep the target's.
 */
const RESET_VALUES: Partial<Record<(typeof MODIFIABLE_OPTIONS)[number], unknown>> = {
  validator: {},
  expireAfterSeconds: "off",
  changeStreamPreAndPostImages: { enabled: false },
};

/** What aligning one collection did. */
export interface MetadataAlignment {
  /** The options and index properties changed, e.g. `validator`, `index ttl_1.expireAfterSeconds`. */
  readonly changed: readonly string[];
  /** Differences `collMod` refused or cannot express, for the restore's log. */
  readonly warnings: readonly string[];
}

/**
 * Applies to `collection` the options and index properties of `latest` it lacks (see
 * the file header). A collection that no longer exists is left alone.
 */
export async function alignWithLatestMetadata(
  db: Db,
  collection: string,
  latest: CollectionMetadata,
  options: {
    readonly writeConcern: WriteConcernSettings | undefined;
    readonly includeIndexes: boolean;
    readonly logger: Logger;
  },
): Promise<MetadataAlignment> {
  const current = await currentOptions(db, collection);
  if (current === undefined) return { changed: [], warnings: [] };
  const changed: string[] = [];
  const warnings: string[] = [];
  const collMod = async (label: string, fields: Document): Promise<void> => {
    try {
      await db.command({
        collMod: collection,
        ...fields,
        ...commandWriteConcern(options.writeConcern),
      });
      changed.push(label);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`${db.databaseName}.${collection}: could not apply ${label} (${reason})`);
    }
  };

  for (const name of optionChanges(current, latest.options)) {
    const value = Object.hasOwn(latest.options, name) ? latest.options[name] : RESET_VALUES[name];
    if (value === undefined) continue;
    await collMod(name, { [name]: valueInStoredOrder(value) });
  }
  if (options.includeIndexes) {
    const existing = await db.collection(collection).listIndexes().toArray();
    for (const change of indexChanges(existing, latest.indexes)) {
      await collMod(`index ${change.name}.${change.field}`, {
        index: { name: change.name, [change.field]: change.value },
      });
    }
  }
  if (changed.length > 0) {
    options.logger.info("Brought a collection up to its newest metadata", {
      ns: `${db.databaseName}.${collection}`,
      changed,
    });
  }
  return { changed, warnings };
}

/**
 * The modifiable options whose newest value differs from the target's (absent on one
 * side counts as a difference). Pure, for unit tests.
 */
export function optionChanges(
  current: Document,
  latest: Document,
): (typeof MODIFIABLE_OPTIONS)[number][] {
  return MODIFIABLE_OPTIONS.filter((name) => canonical(current[name]) !== canonical(latest[name]));
}

/** One index property to change in place. */
export interface IndexPropertyChange {
  readonly name: string;
  readonly field: "expireAfterSeconds" | "hidden";
  readonly value: number | boolean;
}

/**
 * The TTL and hidden flags of the newest index definitions that the target's indexes of
 * the same name lack. Indexes missing on either side are left to the index events.
 * Pure, for unit tests.
 */
export function indexChanges(
  existing: readonly Document[],
  latest: readonly Document[],
): IndexPropertyChange[] {
  const changes: IndexPropertyChange[] = [];
  for (const index of latest) {
    if (typeof index.name !== "string") continue;
    const target = existing.find((candidate) => candidate.name === index.name);
    if (target === undefined) continue;
    const ttl = numberOf(index.expireAfterSeconds);
    if (ttl !== undefined && ttl !== numberOf(target.expireAfterSeconds)) {
      changes.push({ name: index.name, field: "expireAfterSeconds", value: ttl });
    }
    if ((index.hidden === true) !== (target.hidden === true)) {
      changes.push({ name: index.name, field: "hidden", value: index.hidden === true });
    }
  }
  return changes;
}

/** The target's `listCollections` options in stored order, or undefined when it is gone. */
async function currentOptions(db: Db, collection: string): Promise<Document | undefined> {
  const reply = await db.command(
    { listCollections: 1, filter: { name: collection } },
    { fieldsAsRaw: { firstBatch: true } },
  );
  const batch: unknown = reply.cursor?.firstBatch;
  const [raw] = Array.isArray(batch) ? batch : [];
  if (!(raw instanceof Uint8Array)) return undefined;
  const info = deserializeInStoredOrder(raw);
  const options: unknown = info.options;
  return typeof options === "object" && options !== null ? (options as Document) : {};
}

/** A value as canonical Extended JSON in stored order (`undefined` for absent). */
function canonical(value: unknown): string | undefined {
  return value === undefined ? undefined : stringifyExtendedJson(value, { relaxed: false });
}

/** A number of any BSON numeric type as a JavaScript number. */
function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (value instanceof BSON.Int32 || value instanceof BSON.Double || value instanceof BSON.Long) {
    return Number(value.valueOf());
  }
  return undefined;
}
