/**
 * Index changes made during a converge window (or after a journal's base backup):
 * recorded while the change events are replayed, built once the documents are in.
 *
 *   replay:  createIndexes / dropIndexes events → IndexChangeTracker, per target,
 *            in order (a real drop of the collection resets its list, a rename
 *            moves it to the new name)
 *   then:    applyIndexChanges per target that still exists:
 *            [reset → drop every index but _id] → create / drop, in event order
 *
 * Why after the data replay and not when the event comes: the documents of a target
 * pass through intermediate states during the replay (an event may reflect a
 * document that a later event changes again), and a unique index built in the middle
 * could reject one of them. Building at the end sees only the final state, which is
 * the state the index was valid for at the end of the window.
 *
 * Why the same rules work for collections in the backup: their dumped indexes are
 * built first (they were read at some moment inside the window), then every index
 * change of the window is applied in order. Creating an index that already exists
 * with the same definition is a no-op on the server, and dropping one that does not
 * exist is skipped, so each change converges like a document write does.
 */

import type { Document, MongoClient, WriteConcernSettings } from "mongodb";
import { MongoServerError } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { valueInStoredOrder } from "../format/field-order.ts";
import type { Logger } from "../logger.ts";
import { splitNamespace } from "../mongo/index.ts";
import { commandWriteConcern } from "./restore-collections.ts";
import { prepareIndexSpecs } from "./restore-indexes.ts";

/** One index change, as it happened. */
export type IndexChange =
  /** `spec` is the index definition the event recorded (`listIndexes` form). */
  | { readonly kind: "create"; readonly spec: Document }
  | { readonly kind: "drop"; readonly name: string };

/** The index changes to apply to one target after the replay. */
export interface IndexReplayPlan {
  /**
   * The collection was dropped (for real, not by a recorded rename destination)
   * during the window: the indexes it had before are gone, so every index except
   * `_id_` is dropped before `changes` are applied.
   */
  readonly reset: boolean;
  readonly changes: readonly IndexChange[];
}

/** IndexNotFound: dropping an index the target does not have. */
const INDEX_NOT_FOUND_CODE = 27;

/** NamespaceNotFound: the target does not exist (nothing to change). */
const NAMESPACE_NOT_FOUND_CODE = 26;

/**
 * Index definitions that exist in another form: 85 IndexOptionsConflict (same key,
 * different name or options), 86 IndexKeySpecsConflict (same name, different key),
 * 68 IndexAlreadyExists.
 */
const INDEX_CONFLICT_CODES = new Set([85, 86, 68]);

/** Collects the index changes of a replay, per target (see the file header). */
export class IndexChangeTracker {
  readonly #plans = new Map<string, { reset: boolean; changes: IndexChange[] }>();

  /** Appends index changes made to `target`. */
  record(target: string, changes: readonly IndexChange[]): void {
    const plan = this.#planOf(target);
    for (const change of changes) {
      if (change.kind === "drop") {
        // An index built and dropped within the window never needs building.
        plan.changes = plan.changes.filter(
          (earlier) => !(earlier.kind === "create" && earlier.spec.name === change.name),
        );
      }
      plan.changes.push(change);
    }
  }

  /** `target` was dropped: forget its changes, and its earlier indexes are gone too. */
  reset(target: string): void {
    this.#plans.set(target, { reset: true, changes: [] });
  }

  /** `from` was renamed over `to`: `to` now has `from`'s indexes. */
  rename(from: string, to: string): void {
    const plan = this.#plans.get(from);
    this.#plans.delete(from);
    if (plan === undefined) this.#plans.delete(to);
    else this.#plans.set(to, plan);
  }

  /** Every target with something to do, in the order they were first changed. */
  plans(): ReadonlyMap<string, IndexReplayPlan> {
    const result = new Map<string, IndexReplayPlan>();
    for (const [target, plan] of this.#plans) {
      if (plan.reset || plan.changes.length > 0) {
        result.set(target, { reset: plan.reset, changes: [...plan.changes] });
      }
    }
    return result;
  }

  #planOf(target: string): { reset: boolean; changes: IndexChange[] } {
    const existing = this.#plans.get(target);
    if (existing !== undefined) return existing;
    const created = { reset: false, changes: [] };
    this.#plans.set(target, created);
    return created;
  }
}

/** What `applyIndexChanges` needs besides the plan. */
export interface ApplyIndexChangesOptions {
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly logger: Logger;
}

/** What `applyIndexChanges` did to one target. */
export interface AppliedIndexChanges {
  readonly created: number;
  readonly dropped: number;
  /** Index definitions skipped because the target has a conflicting one. */
  readonly conflicts: readonly string[];
}

/**
 * Applies one target's index changes (see the file header). Identical existing
 * indexes are fine (the server treats the create as a no-op), as are drops of
 * indexes the target does not have; an index that conflicts with a different one of
 * the same name or key is skipped with a warning, since the target keeps a valid one.
 *
 * @throws MongoShieldError `MS_RESTORE_FAILED` when an index cannot be built or dropped
 *   (`MS_PERMISSION_DENIED` when the server refuses).
 */
export async function applyIndexChanges(
  client: MongoClient,
  target: string,
  plan: IndexReplayPlan,
  options: ApplyIndexChangesOptions,
): Promise<AppliedIndexChanges> {
  const { database, collection } = splitNamespace(target);
  const db = client.db(database);
  const collectionOptions = await optionsOf(client, target);
  if (collectionOptions === undefined) {
    // Nothing to index: the replay left no collection here (e.g. a view replaced it).
    return { created: 0, dropped: 0, conflicts: [] };
  }

  let created = 0;
  let dropped = 0;
  const conflicts: string[] = [];
  try {
    if (plan.reset) {
      await db.command({ dropIndexes: collection, index: "*", ...concern(options) });
    }
    for (const change of plan.changes) {
      if (change.kind === "drop") {
        if (await dropIndex(db, collection, change.name, options)) dropped += 1;
        continue;
      }
      // The same cleanup as indexes from a dump (no `v`, simple collation made explicit).
      const [spec] = prepareIndexSpecs([change.spec], collectionOptions);
      if (spec === undefined) continue;
      if (await createIndex(db, collection, spec, options)) created += 1;
      else conflicts.push(String(spec.name));
    }
  } catch (error) {
    throw indexReplayError(target, error);
  }
  if (created > 0 || dropped > 0) {
    options.logger.info("Applied the index changes made while the backup ran", {
      ns: target,
      created,
      dropped,
    });
  }
  return { created, dropped, conflicts };
}

/** The collection's options, or `undefined` when it does not exist or is not a collection. */
async function optionsOf(client: MongoClient, target: string): Promise<Document | undefined> {
  const { database, collection } = splitNamespace(target);
  const [info] = await client
    .db(database)
    .listCollections({ name: collection }, { authorizedCollections: true })
    .toArray();
  if (info === undefined || (info.type !== undefined && info.type !== "collection")) {
    return undefined;
  }
  const options: unknown = Reflect.get(info, "options");
  return typeof options === "object" && options !== null ? options : {};
}

/** Creates one index; false when a conflicting one exists (logged). */
async function createIndex(
  db: ReturnType<MongoClient["db"]>,
  collection: string,
  spec: Document,
  options: ApplyIndexChangesOptions,
): Promise<boolean> {
  try {
    // In stored order: the spec comes from a change event, whose key may hold
    // integer-like field names (src/format/field-order.ts).
    await db.command({
      createIndexes: collection,
      indexes: [valueInStoredOrder(spec)],
      ...concern(options),
    });
    return true;
  } catch (error) {
    if (!(error instanceof MongoServerError && INDEX_CONFLICT_CODES.has(Number(error.code)))) {
      throw error;
    }
    options.logger.warn(
      "Kept the target's index instead of a conflicting one created during the backup",
      {
        ns: `${db.databaseName}.${collection}`,
        index: String(spec.name),
        reason: error.message,
      },
    );
    return false;
  }
}

/** Drops one index; false when the target does not have it. */
async function dropIndex(
  db: ReturnType<MongoClient["db"]>,
  collection: string,
  name: string,
  options: ApplyIndexChangesOptions,
): Promise<boolean> {
  try {
    await db.command({ dropIndexes: collection, index: name, ...concern(options) });
    return true;
  } catch (error) {
    const code = error instanceof MongoServerError ? error.code : undefined;
    if (code === INDEX_NOT_FOUND_CODE || code === NAMESPACE_NOT_FOUND_CODE) return false;
    throw error;
  }
}

function concern(options: ApplyIndexChangesOptions): Document {
  return commandWriteConcern(options.writeConcern);
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

function indexReplayError(target: string, error: unknown): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError(
      "MS_PERMISSION_DENIED",
      `Applying the index changes made during the backup to ${target} was refused: ${reason}`,
      {
        cause: error,
        hint: "Grant createIndex and dropIndex on the target (e.g. the restore role).",
      },
    );
  }
  return new MongoShieldError(
    "MS_RESTORE_FAILED",
    `Applying the index changes made during the backup to ${target} failed: ${reason}`,
    {
      cause: error,
      hint: "The documents were restored; fix the cause and recreate the index, or restore again with --drop (or --skip-indexes).",
    },
  );
}
