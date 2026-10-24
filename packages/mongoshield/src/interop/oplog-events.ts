/**
 * Converting the oplog of `mongodump --oplog` (`oplog.bson`, or the archive's oplog
 * namespace) into the change events of a converge backup's changes file
 * (docs/specs/CONSISTENCY.md), so an imported `--oplog` dump restores as of the end
 * of the dump, exactly like `mongorestore --oplogReplay` would.
 *
 * Why this is sound. `mongodump --oplog` reads every collection at some moment
 * between the start of its oplog (T0: the newest entry when the dump began, or the
 * start of the oldest transaction still open then) and its end (T1), and writes
 * every oplog entry between the two. Converge replay applies every change of such a
 * window as an absolute write (insert → replace with the document, update → `$set`
 * the new values, delete → delete by `_id`), which converges to T1 however much of
 * a change a dumped document already reflected. Change streams are themselves
 * derived from the oplog, so each entry converts to the event a change stream would
 * have reported for it:
 *
 *   op "i"                         insert   { documentKey: { _id }, fullDocument: o }
 *   op "u", o = { $v: 2, diff }    update   { updateDescription } from the diff (below)
 *   op "u", o = { $set, $unset }   update   (servers before 5.0, `$v: 1`)
 *   op "u", o = a document         replace  { fullDocument: o }
 *   op "d"                         delete   { documentKey: o }
 *   op "c" create / drop / dropDatabase / createIndexes / commitIndexBuild / dropIndexes
 *                                  the DDL events of the same names
 *   op "c" applyOps                its inner entries, at the outer entry's time; the
 *                                  pieces of a large transaction (`partialTxn`) and
 *                                  prepared transactions wait for their commit, and
 *                                  are dropped when the window ends first (they were
 *                                  not committed at T1)
 *   op "n", collMod, index build start / abort, dbCheck   nothing (no data change;
 *                                  collection options come from the dump)
 *
 * The `$v: 2` update diff (src/mongo/db/update/document_diff_serialization.h) is a
 * tree: `d` (deleted fields), `u` (updated fields), `i` (inserted fields) and
 * `s<field>` (a sub-diff of an embedded document or array); an array diff has
 * `a: true`, an optional new length `l` and `u<index>` / `s<index>` entries. It maps
 * to removedFields, updatedFields (with the new values) and truncatedArrays exactly
 * as the server's change stream does, and every path made of array indices or
 * numeric field names is spelled out in `disambiguatedPaths`.
 *
 * What is refused, with an error that says how to import the dump without its
 * oplog (`ignoreOplog`), because no change event can replay it correctly:
 *
 * - an update of a field whose name contains `.`, starts with `$` or is empty
 *   (`$set` cannot address it; a native capture reads the document instead, which
 *   an oplog cannot);
 * - renames, `emptycapped`, `convertToCapped`, `importCollection` (mongodump itself
 *   refuses renames and imports during `--oplog` dumps) and unknown commands;
 * - a transaction whose first entries are older than the oplog.
 *
 * Ignored: entries of `local`, `config` and `system.*` collections (except
 * `system.js`, which is data), and of namespaces the import's patterns leave out.
 * Writes to time-series buckets are not replayed (as in a native converge backup:
 * the dumped buckets are kept), which the manifest's `consistency.warning` says.
 *
 * Events are built at the byte level (raw-bson.ts) so documents are copied exactly as
 * the oplog holds them, field order included.
 */

import { BSON, type Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import type { ClusterTime } from "../format/manifest.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { BsonType, buildDocument, type RawElement, readElements } from "./raw-bson.ts";

/** The time span and notes of a converted oplog, for the manifest. */
export interface OplogWindow {
  /** Time of the first entry (T0). */
  readonly from: ClusterTime;
  /** Time of the last entry (T1): the time the restored data reflects. */
  readonly to: ClusterTime;
  /** Change events produced. */
  readonly events: number;
  /** Known limits of this window, for `consistency.warning`. */
  readonly warnings: readonly string[];
}

/** Databases whose entries are never replayed: they hold the server's own state. */
const INTERNAL_DATABASES: ReadonlySet<string> = new Set(["local", "config"]);

/** Commands that change no documents; collection options and index builds in progress come from the dump. */
const IGNORED_COMMANDS: ReadonlySet<string> = new Set([
  "collMod",
  "startIndexBuild",
  "abortIndexBuild",
  "dbCheck",
  "modifyCollectionShardingIndexCatalog",
]);

/** Commands that change data in a way no change event can replay. */
const REFUSED_COMMANDS: ReadonlySet<string> = new Set([
  "renameCollection",
  "emptycapped",
  "convertToCapped",
  "importCollection",
]);

/** A field name `$set` / `$unset` can address through a dotted path. */
function isAddressable(name: string): boolean {
  return name.length > 0 && !name.includes(".") && !name.startsWith("$");
}

/** Raw elements of a document, by name. */
type Fields = ReadonlyMap<string, RawElement>;

/** One oplog entry, taken apart. */
interface OplogEntry {
  readonly fields: Fields;
  readonly op: string;
  readonly ns: string;
  /** The raw timestamp (8 bytes), copied into events as `clusterTime`. */
  readonly ts: Buffer;
  readonly wall: RawElement | undefined;
}

/**
 * Converts oplog entries, one at a time and in oplog order, into raw change events.
 * Remembers the window and the open transactions in between.
 */
export class OplogConverter {
  readonly #filter: NamespaceFilter;
  readonly #where: string;
  #first: ClusterTime | undefined;
  #last: ClusterTime | undefined;
  #events = 0;
  readonly #warnings = new Set<string>();
  /** Entries of transactions waiting for their commit, by session and transaction number. */
  readonly #transactions = new Map<string, Buffer[]>();

  /**
   * @param filter the import's include/exclude patterns
   * @param where names the oplog in error messages
   */
  constructor(filter: NamespaceFilter, where: string) {
    this.#filter = filter;
    this.#where = where;
  }

  /**
   * The change events of one oplog entry (often one, none for skipped entries, many
   * for a committed transaction).
   *
   * @throws MS_FORMAT_UNSUPPORTED for entries that cannot be replayed (file header),
   *   MS_INTEGRITY_FAILED for malformed ones
   */
  convert(raw: Buffer): Buffer[] {
    const entry = this.#parse(raw, undefined);
    const time = clusterTimeOf(entry.ts);
    this.#first ??= time;
    this.#last = time;
    const events = this.#convertEntry(entry);
    this.#events += events.length;
    return events;
  }

  /** The window, once every entry was converted; undefined for an empty oplog. */
  finish(): OplogWindow | undefined {
    if (this.#first === undefined || this.#last === undefined) return undefined;
    return {
      from: this.#first,
      to: this.#last,
      events: this.#events,
      warnings: [...this.#warnings],
    };
  }

  /** Parses an entry; inner entries of `applyOps` take the time of their outer entry. */
  #parse(raw: Buffer, outer: OplogEntry | undefined): OplogEntry {
    const fields = new Map(
      readElements(raw, `an entry of ${this.#where}`).map((field) => [field.name, field]),
    );
    const op = stringField(fields, "op");
    const ns = stringField(fields, "ns") ?? "";
    const own = fields.get("ts");
    const ts = outer?.ts ?? (own?.type === BsonType.timestamp ? own.value : undefined);
    if (op === undefined || ts === undefined) throw this.#malformed("an entry has no op or ts");
    return { fields, op, ns, ts, wall: outer?.wall ?? fields.get("wall") };
  }

  #convertEntry(entry: OplogEntry): Buffer[] {
    switch (entry.op) {
      case "n":
        return [];
      case "i":
      case "u":
      case "d":
        return this.#documentEvent(entry);
      case "c":
        return this.#commandEvents(entry);
      default:
        throw this.#unsupported(`it holds an oplog entry of the unknown type "${entry.op}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Document writes
  // -------------------------------------------------------------------------

  #documentEvent(entry: OplogEntry): Buffer[] {
    const namespace = this.#selected(entry.ns);
    if (namespace === undefined) return [];
    const o = documentValue(entry.fields, "o");
    if (o === undefined) throw this.#malformed(`a "${entry.op}" entry of ${entry.ns} has no o`);
    const common = this.#header(entry, namespace);

    if (entry.op === "i") {
      const id = readElements(o, this.#where).find((field) => field.name === "_id");
      if (id === undefined) throw this.#malformed(`an insert into ${entry.ns} has no _id`);
      return [
        event("insert", common, [
          [BsonType.document, "documentKey", buildDocument([[id.type, "_id", id.value]])],
          [BsonType.document, "fullDocument", o],
        ]),
      ];
    }
    if (entry.op === "d") {
      return [event("delete", common, [[BsonType.document, "documentKey", o]])];
    }

    const o2 = documentValue(entry.fields, "o2");
    if (o2 === undefined) throw this.#malformed(`an update of ${entry.ns} has no o2`);
    const update = new Map(readElements(o, this.#where).map((field) => [field.name, field]));
    const documentKey: [number, string, Buffer] = [BsonType.document, "documentKey", o2];
    const diff = update.get("diff");
    const version = update.get("$v");
    if (diff !== undefined && version !== undefined && numberOf(version) === 2) {
      if (diff.type !== BsonType.document)
        throw this.#malformed(`an update diff of ${entry.ns} is not a document`);
      const description = new UpdateDescriptionBuilder(entry.ns, (problem) =>
        this.#unsupported(problem),
      );
      description.addDocumentDiff(diff.value, []);
      return [
        event("update", common, [
          documentKey,
          [BsonType.document, "updateDescription", description.build()],
        ]),
      ];
    }
    if (isModifierUpdate(update)) {
      // $v: 1 (and older) modifier updates: { $set: { path: value }, $unset: { path: … } }.
      const description = new UpdateDescriptionBuilder(entry.ns, (problem) =>
        this.#unsupported(problem),
      );
      description.addModifiers(update);
      return [
        event("update", common, [
          documentKey,
          [BsonType.document, "updateDescription", description.build()],
        ]),
      ];
    }
    return [event("replace", common, [documentKey, [BsonType.document, "fullDocument", o]])];
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  #commandEvents(entry: OplogEntry): Buffer[] {
    const o = documentValue(entry.fields, "o");
    if (o === undefined) throw this.#malformed(`a command entry of ${entry.ns} has no o`);
    const elements = readElements(o, this.#where);
    const command = elements[0]?.name ?? "";
    const database = entry.ns.slice(0, entry.ns.indexOf("."));

    if (command === "applyOps") return this.#applyOps(entry, elements);
    if (command === "commitTransaction" || command === "abortTransaction") {
      const key = transactionKey(entry.fields);
      const pending = key === undefined ? undefined : this.#transactions.get(key);
      if (key !== undefined) this.#transactions.delete(key);
      if (command === "abortTransaction" || pending === undefined) return [];
      return pending.flatMap((inner) => this.#convertEntry(this.#parse(inner, entry)));
    }
    if (IGNORED_COMMANDS.has(command)) return [];
    if (REFUSED_COMMANDS.has(command)) {
      throw this.#unsupported(
        `it records a ${command} on ${database}, which cannot be replayed from an oplog`,
      );
    }

    const target = elements[0];
    const collection = target?.type === BsonType.string ? stringValue(target.value) : undefined;
    switch (command) {
      case "dropDatabase": {
        if (INTERNAL_DATABASES.has(database) || database === "admin") return [];
        return [event("dropDatabase", this.#header(entry, { db: database, coll: undefined }), [])];
      }
      case "create":
      case "drop":
      case "createIndexes":
      case "commitIndexBuild":
      case "dropIndexes":
      case "deleteIndexes": {
        if (collection === undefined)
          throw this.#malformed(`a ${command} entry names no collection`);
        const namespace = this.#selected(`${database}.${collection}`);
        if (namespace === undefined) return [];
        return [this.#ddlEvent(command, entry, namespace, o)];
      }
      default:
        throw this.#unsupported(
          `it records the command "${command}", which MongoShield does not know how to replay`,
        );
    }
  }

  /** The DDL event of a selected namespace, in change stream form (showExpandedEvents). */
  #ddlEvent(command: string, entry: OplogEntry, namespace: EventNamespace, o: Buffer): Buffer {
    const header = this.#header(entry, namespace);
    const parsed = BSON.deserialize(o, LOSSLESS_DESERIALIZE_OPTIONS);
    const { [command]: _name, ...rest } = parsed;
    switch (command) {
      case "create":
        // The options of the new collection (and idIndex), as the change stream reports them.
        return event("create", header, [
          [BsonType.document, "operationDescription", serialize(rest)],
        ]);
      case "drop":
        return event("drop", header, []);
      case "createIndexes":
        return event("createIndexes", header, [
          [BsonType.document, "operationDescription", serialize({ indexes: [rest] })],
        ]);
      case "commitIndexBuild": {
        const indexes: unknown = rest.indexes;
        return event("createIndexes", header, [
          [
            BsonType.document,
            "operationDescription",
            serialize({ indexes: Array.isArray(indexes) ? indexes : [] }),
          ],
        ]);
      }
      default: {
        // dropIndexes: o = { dropIndexes: coll, index: name }, o2 = the dropped definition.
        const o2 = documentValue(entry.fields, "o2");
        const spec =
          o2 === undefined
            ? { name: rest.index }
            : BSON.deserialize(o2, LOSSLESS_DESERIALIZE_OPTIONS);
        return event("dropIndexes", header, [
          [BsonType.document, "operationDescription", serialize({ indexes: [spec] })],
        ]);
      }
    }
  }

  /**
   * `applyOps`: a transaction, a batched multi-document write, or one piece of a large
   * or prepared transaction (which waits for the rest).
   */
  #applyOps(entry: OplogEntry, elements: readonly RawElement[]): Buffer[] {
    const byName = new Map(elements.map((element) => [element.name, element]));
    const operations = byName.get("applyOps");
    if (operations?.type !== BsonType.array)
      throw this.#malformed("an applyOps entry has no operations");
    const inner = readElements(operations.value, this.#where).map((element) => element.value);

    const key = transactionKey(entry.fields);
    const partial = isTrue(byName.get("partialTxn"));
    const prepared = isTrue(byName.get("prepare"));
    if (key !== undefined && (partial || prepared)) {
      if (!this.#transactions.has(key) && hasPreviousEntry(entry.fields))
        throw this.#midTransaction();
      this.#transactions.set(key, [...(this.#transactions.get(key) ?? []), ...inner]);
      return [];
    }

    let all = inner;
    if (key !== undefined) {
      const earlier = this.#transactions.get(key);
      this.#transactions.delete(key);
      if (earlier === undefined && hasPreviousEntry(entry.fields)) throw this.#midTransaction();
      all = [...(earlier ?? []), ...inner];
    }
    return all.flatMap((raw) => this.#convertEntry(this.#parse(raw, entry)));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** The namespace of `ns` when its changes are replayed, undefined when they are not. */
  #selected(ns: string): EventNamespace | undefined {
    const dot = ns.indexOf(".");
    if (dot <= 0) return undefined;
    const db = ns.slice(0, dot);
    const coll = ns.slice(dot + 1);
    if (INTERNAL_DATABASES.has(db)) return undefined;
    if (coll.startsWith("system.buckets.")) {
      this.#warnings.add(
        "Time-series collections are restored as dumped: changes to them during the dump are not replayed.",
      );
      return undefined;
    }
    if (coll.startsWith("system.") && coll !== "system.js") {
      if (coll === "system.users" || coll === "system.roles") {
        this.#warnings.add(
          "Users and roles are restored as dumped: changes to them during the dump are not replayed.",
        );
      }
      return undefined;
    }
    return this.#filter(ns) ? { db, coll } : undefined;
  }

  /** The fields every event has: clusterTime, wallTime (when known) and ns. */
  #header(entry: OplogEntry, namespace: EventNamespace): [number, string, Buffer][] {
    const ns: [number, string, Buffer][] = [[BsonType.string, "db", encodeString(namespace.db)]];
    if (namespace.coll !== undefined)
      ns.push([BsonType.string, "coll", encodeString(namespace.coll)]);
    const header: [number, string, Buffer][] = [[BsonType.timestamp, "clusterTime", entry.ts]];
    if (entry.wall?.type === BsonType.date)
      header.push([BsonType.date, "wallTime", entry.wall.value]);
    header.push([BsonType.document, "ns", buildDocument(ns)]);
    return header;
  }

  #midTransaction(): MongoShieldError {
    return this.#unsupported(
      "it starts in the middle of a transaction, whose first writes are missing",
    );
  }

  #unsupported(problem: string): MongoShieldError {
    return new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `Cannot replay ${this.#where}: ${problem}.`,
      {
        hint: "Import the dump without its oplog (`ignoreOplog: true`, CLI --ignore-oplog): the collections are then imported as mongodump read them, with consistency `none`.",
      },
    );
  }

  #malformed(problem: string): MongoShieldError {
    return new MongoShieldError("MS_INTEGRITY_FAILED", `${this.#where} is malformed: ${problem}.`, {
      hint: "The dump is damaged; take it again with `mongodump --oplog`.",
    });
  }
}

/** An event's `ns`: a database, and a collection for collection events. */
interface EventNamespace {
  readonly db: string;
  readonly coll: string | undefined;
}

/**
 * Collects an update description from a `$v: 2` diff or `$v: 1` modifiers, with
 * the change stream's field names: updatedFields, removedFields, truncatedArrays,
 * disambiguatedPaths.
 */
class UpdateDescriptionBuilder {
  readonly #ns: string;
  readonly #refuse: (problem: string) => MongoShieldError;
  readonly #updated: [number, string, Buffer][] = [];
  readonly #removed: string[] = [];
  readonly #truncated: { field: string; newSize: number }[] = [];
  /** Paths whose dotted form does not say which parts are array indices. */
  readonly #disambiguated = new Map<string, (string | number)[]>();

  constructor(ns: string, refuse: (problem: string) => MongoShieldError) {
    this.#ns = ns;
    this.#refuse = refuse;
  }

  /** A document diff at `path`: sections d, u, i and sub-diffs s<field>. */
  addDocumentDiff(diff: Buffer, path: readonly (string | number)[]): void {
    for (const section of readElements(diff, `an update diff of ${this.#ns}`)) {
      if (section.name === "d") {
        for (const field of readElements(section.value, this.#ns))
          this.#remove([...path, field.name]);
      } else if (section.name === "u" || section.name === "i") {
        for (const field of readElements(section.value, this.#ns)) {
          this.#update([...path, field.name], field);
        }
      } else if (section.name.startsWith("s") && section.type === BsonType.document) {
        this.#addSubDiff(section.value, [...path, section.name.slice(1)]);
      } else {
        throw this.#refuse(
          `an update of ${this.#ns} has the unknown diff section "${section.name}"`,
        );
      }
    }
  }

  /** `$set` / `$unset` of a `$v: 1` update: paths are already dotted. */
  addModifiers(update: Fields): void {
    for (const [name, field] of update) {
      if (name === "$v") continue;
      if (field.type !== BsonType.document) {
        throw this.#refuse(`an update of ${this.#ns} has a malformed ${name}`);
      }
      for (const element of readElements(field.value, this.#ns)) {
        const components = element.name.split(".");
        if (name === "$set") this.#update(components, element);
        else this.#remove(components);
      }
    }
  }

  build(): Buffer {
    const disambiguated: [number, string, Buffer][] = [...this.#disambiguated].map(
      ([path, components]) => [
        BsonType.array,
        path,
        arrayOf(
          components.map((component) =>
            typeof component === "number"
              ? [BsonType.int32, int32(component)]
              : [BsonType.string, encodeString(component)],
          ),
        ),
      ],
    );
    return buildDocument([
      [BsonType.document, "updatedFields", buildDocument(this.#updated)],
      [
        BsonType.array,
        "removedFields",
        arrayOf(this.#removed.map((path) => [BsonType.string, encodeString(path)])),
      ],
      [
        BsonType.array,
        "truncatedArrays",
        arrayOf(
          this.#truncated.map((truncated) => [
            BsonType.document,
            buildDocument([
              [BsonType.string, "field", encodeString(truncated.field)],
              [BsonType.int32, "newSize", int32(truncated.newSize)],
            ]),
          ]),
        ),
      ],
      ...(disambiguated.length === 0
        ? []
        : [
            [BsonType.document, "disambiguatedPaths", buildDocument(disambiguated)] as [
              number,
              string,
              Buffer,
            ],
          ]),
    ]);
  }

  /**
   * A sub-diff: of an embedded document, or (with `a: true`) of an array, whose
   * entries are `l` (new length), `u<index>` (new element) and `s<index>` (element sub-diff).
   */
  #addSubDiff(diff: Buffer, path: readonly (string | number)[]): void {
    const entries = readElements(diff, `an update diff of ${this.#ns}`);
    if (!entries.some((entry) => entry.name === "a" && entry.type === BsonType.boolean)) {
      this.addDocumentDiff(diff, path);
      return;
    }
    for (const entry of entries) {
      if (entry.name === "a") continue;
      if (entry.name === "l") {
        this.#truncated.push({ field: this.#dotted(path), newSize: numberOf(entry) ?? 0 });
        continue;
      }
      const index = Number(entry.name.slice(1));
      if (!Number.isInteger(index) || index < 0) {
        throw this.#refuse(`an array update of ${this.#ns} has the unknown entry "${entry.name}"`);
      }
      if (entry.name.startsWith("u")) this.#update([...path, index], entry);
      else if (entry.name.startsWith("s") && entry.type === BsonType.document)
        this.#addSubDiff(entry.value, [...path, index]);
      else
        throw this.#refuse(`an array update of ${this.#ns} has the unknown entry "${entry.name}"`);
    }
  }

  #update(path: readonly (string | number)[], value: RawElement): void {
    this.#updated.push([value.type, this.#dotted(path), value.value]);
  }

  #remove(path: readonly (string | number)[]): void {
    this.#removed.push(this.#dotted(path));
  }

  /** The dotted form of a path, refusing names `$set` cannot address. */
  #dotted(path: readonly (string | number)[]): string {
    for (const component of path) {
      if (typeof component === "string" && !isAddressable(component)) {
        throw this.#refuse(
          `an update of ${this.#ns} changes the field "${component}", whose name cannot be written with $set (it contains a dot, starts with $ or is empty)`,
        );
      }
    }
    const dotted = path.join(".");
    // Array indices and numeric field names look alike in a dotted path.
    if (path.some((component) => typeof component === "number" || /^\d+$/.test(component))) {
      this.#disambiguated.set(dotted, [...path]);
    }
    return dotted;
  }
}

// ---------------------------------------------------------------------------
// Byte-level helpers
// ---------------------------------------------------------------------------

/** A change event: operationType, the header fields, then the event's own fields. */
function event(
  operationType: string,
  header: readonly [number, string, Buffer][],
  fields: readonly [number, string, Buffer][],
): Buffer {
  return buildDocument([
    [BsonType.string, "operationType", encodeString(operationType)],
    ...header,
    ...fields,
  ]);
}

/** A BSON array from `[type, value]` pairs. */
function arrayOf(values: readonly (readonly [number, Buffer])[]): Buffer {
  return buildDocument(values.map(([type, value], index) => [type, String(index), value]));
}

function encodeString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const value = Buffer.alloc(4 + bytes.length + 1);
  value.writeInt32LE(bytes.length + 1, 0);
  bytes.copy(value, 4);
  return value;
}

function stringValue(value: Buffer): string {
  return value.toString("utf8", 4, value.length - 1);
}

function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value, 0);
  return bytes;
}

function serialize(document: Document): Buffer {
  return Buffer.from(BSON.serialize(document, { checkKeys: false, ignoreUndefined: false }));
}

function stringField(fields: Fields, name: string): string | undefined {
  const field = fields.get(name);
  return field?.type === BsonType.string ? stringValue(field.value) : undefined;
}

function documentValue(fields: Fields, name: string): Buffer | undefined {
  const field = fields.get(name);
  return field?.type === BsonType.document ? field.value : undefined;
}

/** An int32, int64 or double element as a number. */
function numberOf(element: RawElement): number | undefined {
  if (element.type === BsonType.int32) return element.value.readInt32LE(0);
  if (element.type === BsonType.int64) return Number(element.value.readBigInt64LE(0));
  if (element.type === BsonType.double) return element.value.readDoubleLE(0);
  return undefined;
}

/**
 * True for a `$v: 1` style update (`$set` / `$unset`, possibly with `$v`). Anything else
 * without a diff is a replacement document, which since MongoDB 5.0 may itself have
 * field names starting with `$`.
 */
function isModifierUpdate(update: Fields): boolean {
  const names = [...update.keys()];
  return (
    names.some((name) => name === "$set" || name === "$unset") &&
    names.every((name) => name === "$set" || name === "$unset" || name === "$v")
  );
}

function isTrue(element: RawElement | undefined): boolean {
  return element?.type === BsonType.boolean && element.value[0] === 1;
}

/** A timestamp's 8 bytes as `{ t, i }`: increment in the low half, seconds in the high half. */
function clusterTimeOf(ts: Buffer): ClusterTime {
  return { t: ts.readUInt32LE(4), i: ts.readUInt32LE(0) };
}

/** Session + transaction number of a transaction's entry, as a map key; undefined outside transactions. */
function transactionKey(fields: Fields): string | undefined {
  const lsid = fields.get("lsid");
  const txnNumber = fields.get("txnNumber");
  if (lsid === undefined || txnNumber === undefined) return undefined;
  return `${lsid.value.toString("hex")}:${txnNumber.value.toString("hex")}`;
}

/** True when the entry links to an earlier entry of its transaction (`prevOpTime.ts` not 0). */
function hasPreviousEntry(fields: Fields): boolean {
  const previous = fields.get("prevOpTime");
  if (previous?.type !== BsonType.document) return false;
  const ts = readElements(previous.value, "prevOpTime").find((field) => field.name === "ts");
  return ts !== undefined && !ts.value.equals(Buffer.alloc(8));
}
