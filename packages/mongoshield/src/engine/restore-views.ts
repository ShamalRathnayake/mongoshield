/**
 * Views under restore rename rules: which collections a restored view reads from.
 *
 * A view names its sources by collection name in its own database: `viewOn`, and
 * inside its pipeline `$lookup.from`, `$graphLookup.from`, `$unionWith` (and, should a
 * stored pipeline ever hold them, `$merge.into` / `$out`). When the rename rules move
 * those collections, the view follows them, so a restored view reads the restored
 * data rather than whatever lives under the old names:
 *
 *   rename { "app.orders": "app.orders_old" }
 *   view app.recent: viewOn "orders", $lookup from "orders"  →  "orders_old", "orders_old"
 *
 * A view can only read from its own database. When a source was renamed into another
 * database, the reference keeps its old name (the view then reads whatever the target
 * database holds under that name) and a warning names it. `$merge` / `$out` given as
 * `{ db, coll }` may name any database, so those follow the rename completely.
 *
 * Pipelines nest (`$lookup.pipeline`, `$unionWith.pipeline`, `$facet`), and every level
 * is rewritten. Pure functions, unit-tested in restore-views.test.ts.
 */

import type { Document } from "mongodb";
import { withStoredFieldOrderOf } from "../format/field-order.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { NamespaceMapper } from "./restore-rename.ts";

/** Where a view lives, before and after the rename rules. */
export interface ViewLocation {
  /** The view's database in the backup. */
  readonly sourceDatabase: string;
  /** The database the view is restored into. */
  readonly targetDatabase: string;
  readonly rename: NamespaceMapper;
}

/** A source reference that could not follow its rename (see the file header). */
export interface UnfollowedSource {
  /** Where the name appears: `viewOn`, `$lookup.from`, … */
  readonly field: string;
  /** The collection name the view keeps. */
  readonly collection: string;
  /** Where the rename rules restored that collection, `db.collection`. */
  readonly restoredTo: string;
}

/** A view definition after the rename rules. */
export interface RenamedView {
  /** The view's `viewOn`, unchanged when it was not a string. */
  readonly viewOn: unknown;
  /** The pipeline with every source reference renamed; the original when nothing changed. */
  readonly pipeline: unknown;
  /** References that keep their old name because the rename left the view's database. */
  readonly unfollowed: readonly UnfollowedSource[];
}

/**
 * Applies the rename rules to a view's `viewOn` and pipeline.
 *
 *   renameView({ viewOn: "orders", pipeline: [...] }, location)
 */
export function renameView(
  definition: { readonly viewOn: unknown; readonly pipeline: unknown },
  location: ViewLocation,
): RenamedView {
  const renamer = new SourceRenamer(location);
  const viewOn =
    typeof definition.viewOn === "string"
      ? renamer.sameDatabase(definition.viewOn, "viewOn")
      : definition.viewOn;
  const pipeline = renamer.pipeline(definition.pipeline);
  return { viewOn, pipeline, unfollowed: renamer.unfollowed };
}

/** Renames the source references of one view, collecting those that cannot follow. */
class SourceRenamer {
  readonly unfollowed: UnfollowedSource[] = [];
  readonly #location: ViewLocation;

  constructor(location: ViewLocation) {
    this.#location = location;
  }

  /** A collection name in the view's database: its new name, or the old one (recorded). */
  sameDatabase(collection: string, field: string): string {
    const { sourceDatabase, targetDatabase, rename } = this.#location;
    const restored = splitNamespace(rename(`${sourceDatabase}.${collection}`));
    if (restored.database === targetDatabase) return restored.collection;
    this.unfollowed.push({
      field,
      collection,
      restoredTo: `${restored.database}.${restored.collection}`,
    });
    return collection;
  }

  /** A `{ db, coll }` reference ($merge / $out): both parts follow the rename. */
  #anyDatabase(reference: Document): Document {
    const { db, coll } = reference;
    if (typeof db !== "string" || typeof coll !== "string") return reference;
    const restored = splitNamespace(this.#location.rename(`${db}.${coll}`));
    return { ...reference, db: restored.database, coll: restored.collection };
  }

  /** A pipeline (an array of stages); anything else is returned unchanged. */
  pipeline(pipeline: unknown): unknown {
    if (!Array.isArray(pipeline)) return pipeline;
    return pipeline.map((stage: unknown) => this.#stage(stage));
  }

  /** One stage `{ $name: spec }`. Stages that name no collection are kept as they are. */
  #stage(stage: unknown): unknown {
    if (!isPlainDocument(stage)) return stage;
    const renamed: Document = {};
    for (const [name, spec] of Object.entries(stage)) {
      renamed[name] = this.#stageSpec(name, spec);
    }
    return renamed;
  }

  #stageSpec(name: string, spec: unknown): unknown {
    switch (name) {
      case "$lookup":
        return this.#lookup(spec);
      case "$graphLookup":
        return this.#graphLookup(spec);
      case "$unionWith":
        return this.#unionWith(spec);
      case "$facet":
        return this.#facet(spec);
      case "$merge":
        return this.#merge(spec);
      case "$out":
        return this.#out(spec);
      default:
        return spec;
    }
  }

  /** `{ from, localField, …, pipeline? }`; `from` is absent for `$documents` pipelines. */
  #lookup(spec: unknown): unknown {
    if (!isPlainDocument(spec)) return spec;
    const renamed: Document = { ...spec };
    if (typeof spec.from === "string") renamed.from = this.sameDatabase(spec.from, "$lookup.from");
    else if (isPlainDocument(spec.from)) renamed.from = this.#anyDatabase(spec.from);
    if (spec.pipeline !== undefined) renamed.pipeline = this.pipeline(spec.pipeline);
    return renamed;
  }

  #graphLookup(spec: unknown): unknown {
    if (!isPlainDocument(spec) || typeof spec.from !== "string") return spec;
    return { ...spec, from: this.sameDatabase(spec.from, "$graphLookup.from") };
  }

  /** `"coll"` or `{ coll, pipeline? }`. */
  #unionWith(spec: unknown): unknown {
    if (typeof spec === "string") return this.sameDatabase(spec, "$unionWith");
    if (!isPlainDocument(spec)) return spec;
    const renamed: Document = { ...spec };
    if (typeof spec.coll === "string") {
      renamed.coll = this.sameDatabase(spec.coll, "$unionWith.coll");
    }
    if (spec.pipeline !== undefined) renamed.pipeline = this.pipeline(spec.pipeline);
    return renamed;
  }

  /**
   * `{ output: [stages], … }`: every sub-pipeline. The outputs are the fields of the
   * result, so the copy keeps their stored order (an output may be named "0"; see
   * src/format/field-order.ts).
   */
  #facet(spec: unknown): unknown {
    if (!isPlainDocument(spec)) return spec;
    const renamed: Document = {};
    for (const [output, pipeline] of Object.entries(spec)) {
      renamed[output] = this.pipeline(pipeline);
    }
    return withStoredFieldOrderOf(renamed, spec);
  }

  /** `"coll"` or `{ into: "coll" | { db, coll }, … }`. */
  #merge(spec: unknown): unknown {
    if (typeof spec === "string") return this.sameDatabase(spec, "$merge.into");
    if (!isPlainDocument(spec)) return spec;
    if (typeof spec.into === "string") {
      return { ...spec, into: this.sameDatabase(spec.into, "$merge.into") };
    }
    if (isPlainDocument(spec.into)) return { ...spec, into: this.#anyDatabase(spec.into) };
    return spec;
  }

  /** `"coll"` or `{ db, coll, … }`. */
  #out(spec: unknown): unknown {
    if (typeof spec === "string") return this.sameDatabase(spec, "$out");
    if (isPlainDocument(spec)) return this.#anyDatabase(spec);
    return spec;
  }
}

/** A plain document (not an array, and not a BSON value such as an ObjectId). */
function isPlainDocument(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Reflect.get(value, "_bsontype") === undefined && !(value instanceof Date);
}
