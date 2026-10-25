/**
 * The GDPR erasure ledger: "right to be forgotten" requests that keep holding after a
 * restore.
 *
 * Backups are immutable (and often object-locked), so a person's data erased from the
 * live database is still inside every backup taken before. Rewriting backups is not an
 * option; instead every erasure is recorded once, next to the backups:
 *
 *   erasures/<time>-<random>.json     one record per request, append-only
 *
 * and replayed after anything that brings old data back: `shield.restore`,
 * `restoreTenant`, `copy` and `rollback` (through `withErasures`, below). A restored
 * database therefore never resurrects someone who asked to be forgotten, for as long as
 * the backups that hold them exist.
 *
 *   await recordErasure(storage, {
 *     namespace: "app.users", filter: { email: "ada@example.com" },
 *     reason: "GDPR art. 17 request #4471", requestedBy: "dpo@example.com",
 *   });
 *   // … any time later, after a restore:
 *   await applyErasures(client, storage, { namespaces: ["app.users"] });
 *
 * How filters are stored (hashed when they would otherwise keep the personal data in
 * the ledger) is explained in erasure-match.ts. Records are written with a conditional
 * put where the storage supports it, so an existing record is never overwritten.
 *
 * A record that cannot be read is an error, not something to skip: skipping it would
 * silently bring the erased data back.
 */

import { randomBytes } from "node:crypto";
import { BSON, type Collection, type Document, type MongoClient } from "mongodb";
import { z } from "zod";
import { compileRenameMap } from "../engine/restore-rename.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import {
  compileNamespaceFilter,
  discoverNamespaces,
  type NamespaceFilter,
  splitNamespace,
} from "../mongo/index.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { version } from "../version.ts";
import {
  deriveErasureKey,
  type ErasureKey,
  type HashedField,
  MATCH_VERSION,
  matchesHashed,
  storeFilter,
} from "./erasure-match.ts";

/** Every ledger record lives under this prefix, outside `backups/`. */
export const ERASURES_PREFIX = "erasures/";

/** Ledger records are small JSON files. */
const MAX_RECORD_BYTES = 1024 * 1024;

/** Plain filters combined into one `deleteMany({ $or: [...] })`. */
const FILTERS_PER_DELETE = 100;

/** Documents deleted per `deleteMany({ _id: { $in: [...] } })` while scanning. */
const IDS_PER_DELETE = 1000;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const StoredMatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("filter"), filter: z.record(z.string(), z.unknown()) }),
  z.object({
    kind: z.literal("hashed"),
    // Records without it were written with version 1 (see erasure-match.ts). A version
    // this reader does not know fails the record rather than being applied wrongly.
    matchVersion: z.literal(MATCH_VERSION).default(MATCH_VERSION),
    keyed: z.boolean(),
    keyId: z.string().optional(),
    fields: z.array(z.object({ path: z.string().min(1), digest: sha256Hex })).min(1),
  }),
]);

export const ErasureRecordSchema = z.object({
  formatVersion: z.literal(1),
  /** `<time>-<random>`, also the file name. */
  id: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }),
  /** A namespace or pattern (`app.users`, `app.*`, `*`), matched against SOURCE names. */
  namespace: z.string().min(1),
  match: StoredMatchSchema,
  /** Why, e.g. "GDPR art. 17 request #4471". Must not contain the personal data itself. */
  reason: z.string().min(1),
  requestedBy: z.string().optional(),
  tool: z.string(),
});

/** One stored erasure. */
export type ErasureRecord = z.infer<typeof ErasureRecordSchema>;

/** Options for {@link recordErasure}. */
export interface RecordErasureOptions {
  /** The namespace holding the person's documents, a pattern like `app.*`, or `"*"`. */
  readonly namespace: string;
  /** Which documents, e.g. `{ _id: id }` or `{ email: "ada@example.com" }`. */
  readonly filter: Document;
  readonly reason: string;
  readonly requestedBy?: string;
  /** The erasure secret; makes hashed filters guess-resistant (see erasure-match.ts). */
  readonly secret?: string;
  readonly signal?: AbortSignal;
  /** The record time. For tests. */
  readonly now?: Date;
}

/**
 * Appends one erasure to the ledger and returns the stored record.
 *
 * @throws MS_CONFIG_INVALID for an empty filter or reason, a malformed namespace
 *   pattern, or a secret that is too short; storage errors.
 */
export async function recordErasure(
  storage: StorageAdapter,
  options: RecordErasureOptions,
): Promise<ErasureRecord> {
  compileNamespaceFilter({ include: [options.namespace] });
  const reason = options.reason.trim();
  if (reason === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "An erasure needs a reason.", {
      hint: 'Reference the request, e.g. --reason "GDPR request #4471" (not the personal data).',
    });
  }
  const key = deriveErasureKey(options.secret);
  const stored = storeFilter(options.filter, key);
  const match: ErasureRecord["match"] =
    stored.kind === "filter"
      ? { kind: "filter", filter: BSON.EJSON.serialize(stored.filter, { relaxed: false }) }
      : { ...stored, fields: [...stored.fields] };

  const recordedAt = (options.now ?? new Date()).toISOString();
  // "2026-11-14T03:00:04.123Z" → "2026-11-14T03-00-04-123Z": sortable and key-safe; the
  // random suffix keeps two erasures in the same millisecond apart.
  const id = `${recordedAt.replaceAll(":", "-").replace(".", "-")}-${randomBytes(4).toString("hex")}`;
  const record: ErasureRecord = {
    formatVersion: 1,
    id,
    recordedAt,
    namespace: options.namespace,
    match,
    reason,
    ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
    tool: `mongoshield@${version}`,
  };
  const body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  await storage.put(`${ERASURES_PREFIX}${id}.json`, body, {
    contentType: "application/json",
    sizeHint: body.length,
    ...(storage.capabilities.conditionalWrites ? { ifNoneMatch: "*" as const } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return record;
}

/**
 * Reads the ledger, oldest first. `since` keeps only records made at or after it.
 *
 * @throws MS_INTEGRITY_FAILED for a record that cannot be read (see the file header).
 */
export async function listErasures(
  storage: StorageAdapter,
  options: { readonly since?: Date; readonly signal?: AbortSignal } = {},
): Promise<ErasureRecord[]> {
  const records: ErasureRecord[] = [];
  const signalOption = options.signal ? { signal: options.signal } : {};
  for await (const object of storage.list(ERASURES_PREFIX, signalOption)) {
    if (!object.key.endsWith(".json")) continue;
    const record = await readRecord(storage, object.key, options.signal);
    if (options.since !== undefined && Date.parse(record.recordedAt) < options.since.getTime()) {
      continue;
    }
    records.push(record);
  }
  return records.sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
}

async function readRecord(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal | undefined,
): Promise<ErasureRecord> {
  const bytes = await readStreamToBuffer(await storage.get(key, signal ? { signal } : {}), {
    maxBytes: MAX_RECORD_BYTES,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw unreadableRecord(key, error);
  }
  const result = ErasureRecordSchema.safeParse(parsed);
  if (!result.success) throw unreadableRecord(key, result.error);
  return result.data;
}

function unreadableRecord(key: string, cause: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `The erasure ledger record ${key} cannot be read.`,
    {
      cause,
      hint: "Restoring without it could bring erased data back. Repair the record from a replica (mongoshield replicate copies the ledger), then retry.",
    },
  );
}

// ---------------------------------------------------------------------------
// Applying erasures
// ---------------------------------------------------------------------------

/** A restored namespace: its name in the backup (what erasures name) and where it is now. */
export interface ErasureTarget {
  readonly from: string;
  readonly to: string;
  /** Views hold no documents and are skipped. */
  readonly type?: "collection" | "view" | "timeseries";
}

/** Options for {@link applyErasures}. */
export interface ApplyErasuresOptions {
  /**
   * The namespaces that were restored: their names in the backup, or `{ from, to }`
   * pairs. Plain names are mapped through `rename`.
   */
  readonly namespaces: readonly (string | ErasureTarget)[];
  /** The rename rules of the restore, as for `restore({ rename })`. */
  readonly rename?: Readonly<Record<string, string>>;
  /** Only erasures recorded at or after this time (e.g. the backup's completion time). */
  readonly since?: Date;
  /** The erasure secret; required when the ledger holds keyed records. */
  readonly secret?: string;
  /** Count what would be deleted, delete nothing. */
  readonly dryRun?: boolean;
  /** Records already read (by `withErasures`), to avoid reading the ledger twice. */
  readonly records?: readonly ErasureRecord[];
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
}

/** What one namespace lost. */
export interface ErasureNamespaceResult {
  readonly ns: string;
  /** Ledger records that apply to it. */
  readonly erasures: number;
  /** Documents deleted (or, in a dry run, that would be). */
  readonly deleted: number;
}

/** What {@link applyErasures} did. */
export interface ApplyErasuresResult {
  readonly dryRun: boolean;
  /** Ledger records that applied to at least one namespace. */
  readonly erasures: number;
  readonly documentsDeleted: number;
  /** Only namespaces with at least one applicable record. */
  readonly namespaces: readonly ErasureNamespaceResult[];
}

/**
 * Deletes, from freshly restored namespaces, every document the ledger says was erased.
 * Plain filters run as `deleteMany`; hashed ones need a scan of the collection
 * (projected to the hashed fields), see erasure-match.ts.
 *
 * @throws MS_CONFIG_INVALID when keyed records exist but no or the wrong secret was
 *   given (checked before anything is deleted); MS_INTEGRITY_FAILED for unreadable
 *   records; MS_RESTORE_FAILED when the target refuses the deletes; MS_ABORTED.
 */
export async function applyErasures(
  client: MongoClient,
  storage: StorageAdapter,
  options: ApplyErasuresOptions,
): Promise<ApplyErasuresResult> {
  const logger = options.logger ?? silentLogger;
  const all =
    options.records ??
    (await listErasures(storage, {
      ...(options.since ? { since: options.since } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }));
  const since = options.since;
  const records =
    since === undefined
      ? all
      : all.filter((record) => Date.parse(record.recordedAt) >= since.getTime());
  const key = keyForRecords(records, options.secret);
  const targets = resolveTargets(options.namespaces, options.rename);
  const matchers = records.map((record) => ({
    record,
    applies: compileNamespaceFilter({ include: [record.namespace] }),
  }));

  const applied = new Set<string>();
  const results: ErasureNamespaceResult[] = [];
  for (const target of targets) {
    throwIfAborted(options.signal);
    if (target.type === "view") continue;
    const relevant = matchers.filter((matcher) => matcher.applies(target.from));
    if (relevant.length === 0) continue;
    for (const matcher of relevant) applied.add(matcher.record.id);
    const deleted = await eraseFromNamespace(
      client,
      target.to,
      relevant.map((matcher) => matcher.record),
      key,
      options,
    );
    if (deleted > 0) logger.info("Applied erasures", { ns: target.to, deleted });
    results.push({ ns: target.to, erasures: relevant.length, deleted });
  }
  return {
    dryRun: options.dryRun === true,
    erasures: applied.size,
    documentsDeleted: results.reduce((sum, result) => sum + result.deleted, 0),
    namespaces: results,
  };
}

/**
 * The hashing key, after checking that it can open every keyed record: all keyed
 * records must carry the id of the given secret. Unkeyed records need no secret.
 */
function keyForRecords(records: readonly ErasureRecord[], secret: string | undefined): ErasureKey {
  const keyIds = new Set<string>();
  for (const record of records) {
    if (record.match.kind === "hashed" && record.match.keyed) {
      keyIds.add(record.match.keyId ?? "");
    }
  }
  const key = deriveErasureKey(secret);
  if (keyIds.size === 0) return key;
  if (secret === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The erasure ledger holds records hashed with an erasure secret, but none was given.",
      {
        hint: "Set MONGOSHIELD_ERASURE_SECRET (or `erasures.secret`). Without it, erased documents could come back.",
      },
    );
  }
  const unknown = [...keyIds].filter((keyId) => keyId !== key.keyId);
  if (unknown.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Some erasure records were hashed with a different erasure secret than the one given.",
      { hint: "Use the secret those erasures were recorded with (key ids differ)." },
    );
  }
  return key;
}

/** Turns names (with rename rules) and pairs into pairs, without duplicates. */
function resolveTargets(
  namespaces: readonly (string | ErasureTarget)[],
  rename: Readonly<Record<string, string>> | undefined,
): ErasureTarget[] {
  const mapName = compileRenameMap(rename);
  const seen = new Set<string>();
  const targets: ErasureTarget[] = [];
  for (const item of namespaces) {
    const target = typeof item === "string" ? { from: item, to: mapName(item) } : item;
    if (seen.has(target.to)) continue;
    seen.add(target.to);
    targets.push(target);
  }
  return targets;
}

/** Applies the records that concern one namespace; returns the documents deleted. */
async function eraseFromNamespace(
  client: MongoClient,
  ns: string,
  records: readonly ErasureRecord[],
  key: ErasureKey,
  options: ApplyErasuresOptions,
): Promise<number> {
  const { database, collection: name } = splitNamespace(ns);
  const collection = client.db(database).collection(name);
  const dryRun = options.dryRun === true;

  const filters: Document[] = [];
  const hashed: (readonly HashedField[])[] = [];
  for (const record of records) {
    if (record.match.kind === "filter") {
      filters.push(BSON.EJSON.deserialize(record.match.filter, { relaxed: false }));
    } else {
      hashed.push(record.match.fields);
    }
  }

  try {
    let deleted = 0;
    for (let start = 0; start < filters.length; start += FILTERS_PER_DELETE) {
      const chunk = { $or: filters.slice(start, start + FILTERS_PER_DELETE) };
      deleted += dryRun
        ? await collection.countDocuments(chunk)
        : (await collection.deleteMany(chunk)).deletedCount;
    }
    if (hashed.length > 0) {
      deleted += await eraseHashed(collection, hashed, key, dryRun, options.signal);
    }
    return deleted;
  } catch (error) {
    if (isMongoShieldError(error)) throw error;
    throw new MongoShieldError("MS_RESTORE_FAILED", `Applying erasures to ${ns} failed.`, {
      cause: error,
      hint: "The data was restored, but erased documents may still be in it. Fix the cause and run `mongoshield erasures apply` (or the restore) again.",
    });
  }
}

/**
 * Hashed erasures: one scan of the collection, projected to the hashed paths, deleting
 * matching documents by `_id` in batches. Memory holds at most one batch of ids.
 */
async function eraseHashed(
  collection: Collection,
  hashed: readonly (readonly HashedField[])[],
  key: ErasureKey,
  dryRun: boolean,
  signal: AbortSignal | undefined,
): Promise<number> {
  const projection: Document = { _id: 1 };
  for (const fields of hashed) for (const field of fields) projection[field.path] = 1;

  let deleted = 0;
  let batch: Document["_id"][] = [];
  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    deleted += dryRun
      ? batch.length
      : (await collection.deleteMany({ _id: { $in: batch } })).deletedCount;
    batch = [];
  }

  const cursor = collection.find({}, { projection });
  try {
    for await (const document of cursor) {
      throwIfAborted(signal);
      if (hashed.some((fields) => matchesHashed(document, fields, key))) {
        batch.push(document._id);
        if (batch.length >= IDS_PER_DELETE) await flush();
      }
    }
    await flush();
  } finally {
    await cursor.close();
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Wiring into restore / copy / rollback
// ---------------------------------------------------------------------------

/** What `withErasures` needs from the shield. */
export interface ErasureContext {
  /** Connected to the deployment the operation writes to. */
  readonly client: MongoClient;
  /** Where the ledger lives (the shield's backup storage). */
  readonly storage: StorageAdapter;
  readonly secret?: string | undefined;
  readonly logger?: Logger | undefined;
}

/** The part of a restore / copy result that `withErasures` reads. */
export interface ErasableResult {
  readonly dryRun: boolean;
  readonly plan: {
    readonly entries: readonly {
      readonly from: string;
      readonly to: string;
      readonly type?: "collection" | "view" | "timeseries";
      readonly action?: string;
    }[];
  };
}

/**
 * Runs a restore-like `operation` and then applies the erasure ledger to every
 * namespace it wrote. Drop-in for `MongoShield.restore` / `copy` / `restoreTenant`:
 *
 *   return withErasures(
 *     { client: connection.client, storage: this.storage, secret, logger: this.#logger },
 *     options,
 *     () => runRestore(this.#restoreContext(connection), options),
 *   );
 *
 * The ledger is read and the secret checked BEFORE the operation runs, so a missing
 * secret refuses the restore instead of restoring data that then cannot be erased.
 * Dry runs and `skipErasures: true` run the operation alone.
 */
export async function withErasures<Result extends ErasableResult>(
  context: ErasureContext,
  options: {
    readonly skipErasures?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly dryRun?: boolean | undefined;
  },
  operation: () => Promise<Result>,
): Promise<Result & { readonly erasures?: ApplyErasuresResult }> {
  if (options.skipErasures === true || options.dryRun === true) return operation();

  const records = await listErasures(
    context.storage,
    options.signal ? { signal: options.signal } : {},
  );
  if (records.length > 0) keyForRecords(records, context.secret);

  const result = await operation();
  if (result.dryRun || records.length === 0) return result;
  const namespaces = result.plan.entries
    .filter((entry) => entry.action !== "skip" && entry.action !== "conflict")
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      ...(entry.type ? { type: entry.type } : {}),
    }));
  const erasures = await applyErasures(context.client, context.storage, {
    namespaces,
    records,
    ...(context.secret !== undefined ? { secret: context.secret } : {}),
    ...(context.logger ? { logger: context.logger } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { ...result, erasures };
}

// ---------------------------------------------------------------------------
// Erasing live data now (`mongoshield erase --now`)
// ---------------------------------------------------------------------------

/**
 * Deletes the matching documents from the live deployment right away, in every
 * existing namespace the pattern names. Uses the plain filter (it is at hand here,
 * unlike when replaying hashed records).
 */
export async function eraseLiveDocuments(
  client: MongoClient,
  options: {
    readonly namespace: string;
    readonly filter: Document;
    readonly dryRun?: boolean;
    readonly signal?: AbortSignal;
  },
): Promise<ErasureNamespaceResult[]> {
  const names = await liveNamespaces(client, options.namespace, options.signal);
  const results: ErasureNamespaceResult[] = [];
  for (const ns of names) {
    throwIfAborted(options.signal);
    const { database, collection } = splitNamespace(ns);
    const target = client.db(database).collection(collection);
    const deleted =
      options.dryRun === true
        ? await target.countDocuments(options.filter)
        : (await target.deleteMany(options.filter)).deletedCount;
    results.push({ ns, erasures: 1, deleted });
  }
  return results;
}

/** Exact namespaces are used as they are; patterns are resolved against the deployment. */
async function liveNamespaces(
  client: MongoClient,
  pattern: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const matches: NamespaceFilter = compileNamespaceFilter({ include: [pattern] });
  if (!pattern.includes("*")) return [pattern];
  const specs = await discoverNamespaces(client, { include: [pattern], signal });
  return specs.filter((spec) => spec.type !== "view" && matches(spec.ns)).map((spec) => spec.ns);
}
