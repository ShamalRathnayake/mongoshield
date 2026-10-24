/**
 * The live data browser: reading the databases of a connection, and (opt-in) changing
 * documents with a journal and undo. See src/server/live/ for the safety machinery and
 * docs/specs/CONSOLE.md ("Live data") for the contract.
 *
 *   PUT  /api/connections/:id/live-edits     admin      turn live edits on/off (production: name + reason)
 *   GET  /api/live/:id/collection?ns=        operator   stats, indexes, whether the caller may write
 *   GET  /api/live/:id/documents?ns=…        operator   a page of documents (audited: live.browse)
 *   POST /api/live/:id/documents             data:write insert one
 *   PUT  /api/live/:id/documents             data:write replace one (conditional on its version)
 *   POST /api/live/:id/documents/delete      data:write delete one (conditional on its version)
 *   POST /api/live/:id/bulk/preview          data:write count what an update/delete many would touch
 *   POST /api/live/:id/bulk                  data:write run it as a job (typed confirmation)
 *   GET  /api/live-edits                     operator   the Edit history
 *   GET  /api/live-edits/:id                 operator   one entry with its journaled documents (audited)
 *   POST /api/live-edits/:id/undo            data:write undo an entry (conditional; journaled)
 *
 * "data:write" means: operator role or higher, the `data:write` permission, and live
 * edits turned on for the connection (access.ts). Every route checks it on the server.
 */

import type { Context, Hono } from "hono";
import { BSON, type Collection, type Document, MongoServerError, ObjectId } from "mongodb";
import { MongoShieldError } from "mongoshield";
import { connectionById, storageById } from "../../jobs/tasks.ts";
import {
  LIVE_BULK_DEFAULT_LIMIT,
  LIVE_BULK_HARD_LIMIT,
  type LiveCollectionInfo,
  type LiveCount,
  type LiveDocumentPage,
  type LiveEditEntryDetail,
  type LiveIndexView,
  type LiveUndoResult,
  type LiveWriteResult,
} from "../../shared/api.ts";
import { scrubText } from "../../state/redact.ts";
import { openConnectionUri } from "../../state/secrets.ts";
import type {
  ConnectionRecord,
  LiveEditRecord,
  LiveEditSettingsRecord,
} from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices, Principal } from "../context.ts";
import { ConsoleError, invalid, isKnownError } from "../errors.ts";
import { assertLiveWritable, liveWriteRefusal, requireLiveWriter } from "../live/access.ts";
import {
  applySingleEdit,
  bulkConfirmText,
  bulkEditJob,
  changeOf,
  collectionOf,
  conflictError,
  countMatching,
  type DocumentChange,
  inverseOf,
  type LiveDeps,
  matchesExpected,
  type Namespace,
  parseNamespace,
  readCurrent,
  undoJob,
  writableCollectionOf,
} from "../live/apply.ts";
import {
  FAITHFUL_READ,
  fromExtendedJson,
  idKeyOf,
  idLabelOf,
  liveDocumentView,
  mergeEdit,
  parseDocumentText,
  parseIdKey,
  parseQueryObject,
  parseSort,
  parseUpdate,
  parseVersion,
  versionOf,
} from "../live/documents.ts";
import { entryById, entryView, isUndoable, updateEntry } from "../live/history.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  type Fields,
  oneOf,
  optionalPositiveInt,
  optionalString,
  queryInt,
  requiredBoolean,
} from "../validate.ts";
import { connectionView } from "../views.ts";

/** Largest page of live documents. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
/** Deepest `skip` accepted: deeper pages are slow on the server; filter instead. */
const MAX_SKIP = 100_000;
/** A browse query may run for at most this long on the server. */
const QUERY_TIMEOUT_MS = 30_000;
/** Filtered counts stop here and report "at least". */
const COUNT_LIMIT = 10_000;
/** A filtered count may take at most this long before falling back to "at least". */
const COUNT_TIMEOUT_MS = 5_000;
/** Journaled documents shown on an entry's detail page. */
const DETAIL_RECORDS = 20;
/** Longest reason accepted when turning live edits on. */
const MAX_REASON_LENGTH = 500;

/** Registers the live data routes. */
export function liveRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store } = services;
  const deps: LiveDeps = {
    store,
    journal: services.live.journal,
    clients: services.live.clients,
    now: services.now,
    audit: (input) => recordAudit(services, input),
  };

  // ---- settings ---------------------------------------------------------

  app.put("/api/connections/:id/live-edits", async (c) => {
    const principal = requireRole(c, "admin");
    const connection = connectionById(store, c.req.param("id"));
    const body = asObject(await readJson(c));
    const settings = liveSettingsFrom(services, principal, connection, body);
    const updated = await store.update((state) => {
      const current = state.connections.find((candidate) => candidate.id === connection.id);
      if (current === undefined)
        throw new ConsoleError(404, "CONSOLE_NOT_FOUND", "The connection was not found.");
      const next: ConnectionRecord = { ...current, liveEdits: settings };
      state.connections = state.connections.map((candidate) =>
        candidate.id === connection.id ? next : candidate,
      );
      return next;
    });
    await recordAudit(services, {
      actor: principal,
      action: "connection.live_edits",
      target: connection.name,
      outcome: "success",
      details: {
        id: connection.id,
        enabled: settings.enabled,
        production: connection.production,
        productionConfirmed: settings.productionConfirmed,
        journal:
          settings.journalStorageId === undefined
            ? "console"
            : storageById(store, settings.journalStorageId).name,
        maxBulkDocuments: settings.maxBulkDocuments,
        ...(settings.reason === undefined ? {} : { reason: settings.reason }),
      },
    });
    return c.json(connectionView(updated));
  });

  // ---- reading ----------------------------------------------------------

  app.get("/api/live/:id/collection", async (c) => {
    const principal = requireRole(c, "operator");
    const connection = connectionById(store, c.req.param("id"));
    const namespace = parseNamespace(c.req.query("ns"));
    return withDriverErrors(services, connection, async () => {
      const client = await services.live.clients.clientFor(connection);
      const db = client.db(namespace.db);
      const [info] = await db
        .listCollections({ name: namespace.collection }, { nameOnly: false })
        .toArray();
      if (info === undefined) {
        throw new ConsoleError(
          404,
          "CONSOLE_NOT_FOUND",
          `There is no collection "${namespace.ns}".`,
        );
      }
      const type =
        info.type === "view" ? "view" : info.type === "timeseries" ? "timeseries" : "collection";
      const collection = db.collection(namespace.collection);
      const refusal = readOnlyReason(principal, connection, type);
      const result: LiveCollectionInfo = {
        ns: namespace.ns,
        type,
        estimatedDocuments:
          type === "view" ? 0 : await collection.estimatedDocumentCount().catch(() => 0),
        capped: Reflect.get(Object(info.options), "capped") === true,
        ...(type === "view" ? {} : await storageStatsOf(collection)),
        indexes: type === "view" ? [] : await indexesOf(collection),
        writable: refusal === undefined,
        ...(refusal === undefined ? {} : { readOnlyReason: refusal }),
      };
      return c.json(result);
    });
  });

  app.get("/api/live/:id/documents", async (c) => {
    const principal = requireRole(c, "operator");
    const connection = connectionById(store, c.req.param("id"));
    const namespace = parseNamespace(c.req.query("ns"));
    const filter = parseQueryObject(c.req.query("filter"), "The filter") ?? {};
    const projection = parseQueryObject(c.req.query("projection"), "The projection");
    const sort = parseSort(c.req.query("sort"));
    const skip = queryInt(c.req.query("skip"), "skip", { min: 0, max: MAX_SKIP, fallback: 0 });
    const limit = queryInt(c.req.query("limit"), "limit", {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
    const projected = projection !== undefined && Object.keys(projection).length > 0;
    return withDriverErrors(services, connection, async () => {
      const collection = await collectionOf(deps, connection, namespace);
      // One extra document tells whether another page follows.
      const read = await collection
        .find(filter, {
          ...(projected ? { projection } : {}),
          ...(sort === undefined ? {} : { sort }),
          skip,
          limit: limit + 1,
          maxTimeMS: QUERY_TIMEOUT_MS,
          ...FAITHFUL_READ,
        })
        .toArray();
      const documents = read.slice(0, limit);
      const page: LiveDocumentPage = {
        documents: documents.map((document) => liveDocumentView(document, !projected)),
        skip,
        limit,
        count: await countOf(collection, filter, skip + read.length),
        hasMore: read.length > limit,
        projected,
      };
      // Reading live documents is reading customer data: record who looked at what.
      await recordAudit(services, {
        actor: principal,
        action: "live.browse",
        target: `${connection.name}/${namespace.ns}`,
        outcome: "success",
        details: {
          connection: connection.id,
          documents: documents.length,
          filtered: Object.keys(filter).length > 0,
          skip,
        },
      });
      return c.json(page);
    });
  });

  // ---- single-document writes ---------------------------------------------

  app.post("/api/live/:id/documents", async (c) => {
    const principal = requireLiveWriter(c);
    const connection = connectionById(store, c.req.param("id"));
    assertLiveWritable(principal, connection);
    const body = asObject(await readJson(c));
    const namespace = parseNamespace(body.ns);
    const parsed = parseDocumentText(body.document);
    // The console assigns the ObjectId itself, so the journal knows the _id before the insert.
    const document = withIdFirst("_id" in parsed ? parsed : { _id: new ObjectId(), ...parsed });
    return withDriverErrors(services, connection, async () => {
      const collection = await writableCollectionOf(deps, connection, namespace);
      if ((await readCurrent(collection, document._id)) !== undefined) {
        await auditConflict(
          services,
          principal,
          "live.insert",
          connection,
          namespace,
          document._id,
        );
        throw new ConsoleError(
          409,
          "CONSOLE_LIVE_CONFLICT",
          "A document with this _id already exists, so nothing was inserted.",
          "Remove _id to get a new ObjectId, or choose another value.",
        );
      }
      const entry = await applySingleEdit(deps, {
        connection,
        namespace,
        op: "insert",
        by: principal.user.username,
        change: { after: document },
      });
      return finishSingleWrite(
        c,
        services,
        principal,
        "live.insert",
        connection,
        namespace,
        entry,
        collection,
        document._id,
      );
    });
  });

  app.put("/api/live/:id/documents", async (c) => {
    const principal = requireLiveWriter(c);
    const connection = connectionById(store, c.req.param("id"));
    assertLiveWritable(principal, connection);
    const body = asObject(await readJson(c));
    const namespace = parseNamespace(body.ns);
    const id = parseIdKey(body.id);
    const version = parseVersion(body.version);
    const edited = parseDocumentText(body.document);
    return withDriverErrors(services, connection, async () => {
      const collection = await writableCollectionOf(deps, connection, namespace);
      const current = await readCurrent(collection, id);
      if (current === undefined || versionOf(current) !== version) {
        await auditConflict(services, principal, "live.update", connection, namespace, id);
        throw conflictError("edit");
      }
      const merged = mergeEdit(current, edited);
      if (!("_id" in merged.document) || idKeyOf(merged.document) !== idKeyOf(current)) {
        throw invalid(
          "An edit cannot change or remove _id.",
          "Insert a copy with “Duplicate” instead.",
        );
      }
      if (merged.changedFields.length === 0) {
        throw invalid("The edited document is the same as the stored one; nothing to save.");
      }
      const entry = await applySingleEdit(deps, {
        connection,
        namespace,
        op: "update",
        by: principal.user.username,
        change: { before: current, after: withIdFirst(merged.document) },
      });
      return finishSingleWrite(
        c,
        services,
        principal,
        "live.update",
        connection,
        namespace,
        entry,
        collection,
        id,
        merged.changedFields,
      );
    });
  });

  app.post("/api/live/:id/documents/delete", async (c) => {
    const principal = requireLiveWriter(c);
    const connection = connectionById(store, c.req.param("id"));
    assertLiveWritable(principal, connection);
    const body = asObject(await readJson(c));
    const namespace = parseNamespace(body.ns);
    const id = parseIdKey(body.id);
    const version = parseVersion(body.version);
    return withDriverErrors(services, connection, async () => {
      const collection = await writableCollectionOf(deps, connection, namespace);
      const current = await readCurrent(collection, id);
      if (current === undefined || versionOf(current) !== version) {
        await auditConflict(services, principal, "live.delete", connection, namespace, id);
        throw conflictError("edit");
      }
      const entry = await applySingleEdit(deps, {
        connection,
        namespace,
        op: "delete",
        by: principal.user.username,
        change: { before: current },
      });
      return finishSingleWrite(
        c,
        services,
        principal,
        "live.delete",
        connection,
        namespace,
        entry,
        collection,
        id,
      );
    });
  });

  // ---- bulk writes ------------------------------------------------------------

  app.post("/api/live/:id/bulk/preview", async (c) => {
    const principal = requireLiveWriter(c);
    const connection = connectionById(store, c.req.param("id"));
    assertLiveWritable(principal, connection);
    const request = bulkRequestFrom(asObject(await readJson(c)));
    const max = maxBulkOf(connection);
    return withDriverErrors(services, connection, async () => {
      const collection = await writableCollectionOf(deps, connection, request.namespace);
      const matched = await countMatching(collection, request.filter);
      return c.json({
        ns: request.namespace.ns,
        op: request.op,
        matched,
        max,
        allowed: matched > 0 && matched <= max,
        confirmText: bulkConfirmText(request.op, matched, request.namespace.ns),
      });
    });
  });

  app.post("/api/live/:id/bulk", async (c) => {
    const principal = requireLiveWriter(c);
    const connection = connectionById(store, c.req.param("id"));
    assertLiveWritable(principal, connection);
    const body = asObject(await readJson(c));
    const request = bulkRequestFrom(body);
    const expectedCount = optionalPositiveInt(body, "expectedCount", LIVE_BULK_HARD_LIMIT);
    if (expectedCount === undefined || expectedCount === 0) {
      throw invalid('"expectedCount" (the count from the preview) is required.');
    }
    const max = maxBulkOf(connection);
    if (expectedCount > max) {
      throw new ConsoleError(
        422,
        "CONSOLE_LIVE_BULK_TOO_LARGE",
        `This connection allows at most ${max} documents per bulk edit.`,
        "Narrow the filter, or ask an admin to raise the connection's limit.",
      );
    }
    const expectedText = bulkConfirmText(request.op, expectedCount, request.namespace.ns);
    if (optionalString(body, "confirm", 400) !== expectedText) {
      throw new ConsoleError(
        400,
        "MS_CONFIRMATION_REQUIRED",
        `Type "${expectedText}" to confirm.`,
        "The confirmation must match the preview exactly.",
      );
    }
    let resolveJobId: (id: string) => void = () => {};
    const jobId = new Promise<string>((resolve) => {
      resolveJobId = resolve;
    });
    const job = await services.runner.start(
      bulkEditJob(deps, {
        connection,
        namespace: request.namespace,
        op: request.op,
        filter: request.filter,
        ...(request.update === undefined ? {} : { update: request.update }),
        expectedCount,
        max,
        by: principal.user.username,
        jobId,
        secrets: [openConnectionUri(store, connection)],
      }),
    );
    resolveJobId(job.id);
    await recordAudit(services, {
      actor: principal,
      action: request.op === "update" ? "live.bulk_update.start" : "live.bulk_delete.start",
      target: request.namespace.ns,
      outcome: "success",
      details: { connection: connection.name, job: job.id, expected: expectedCount },
    });
    return c.json(job);
  });

  // ---- history and undo ---------------------------------------------------

  app.get("/api/live-edits", (c) => {
    requireRole(c, "operator");
    const connectionId = c.req.query("connectionId");
    const limit = queryInt(c.req.query("limit"), "limit", { min: 1, max: 200, fallback: 50 });
    const before = c.req.query("before");
    let entries = (store.current.liveEdits ?? []).filter(
      (entry) =>
        connectionId === undefined || connectionId === "" || entry.connectionId === connectionId,
    );
    if (before !== undefined && before !== "") {
      const index = entries.findIndex((entry) => entry.id === before);
      entries = index === -1 ? [] : entries.slice(index + 1);
    }
    return c.json(entries.slice(0, limit).map((entry) => entryView(store, entry)));
  });

  app.get("/api/live-edits/:id", async (c) => {
    const principal = requireRole(c, "operator");
    const entry = entryById(store, c.req.param("id"));
    const { records, truncated } = await detailRecords(services, entry);
    const detail: LiveEditEntryDetail = { ...entryView(store, entry), records, truncated };
    // The journal holds customer documents: reading them is audited like browsing.
    await recordAudit(services, {
      actor: principal,
      action: "live.history_read",
      target: entry.ns,
      outcome: "success",
      details: { entry: entry.id, documents: records.length },
    });
    return c.json(detail);
  });

  app.post("/api/live-edits/:id/undo", async (c) => {
    const principal = requireLiveWriter(c);
    const original = entryById(store, c.req.param("id"));
    const connection = connectionById(store, original.connectionId);
    assertLiveWritable(principal, connection);
    if (!isUndoable(original)) {
      throw new ConsoleError(
        409,
        "CONSOLE_LIVE_NOT_UNDOABLE",
        original.undoneBy === undefined
          ? "This entry changed nothing, so there is nothing to undo."
          : "This edit has already been undone.",
        original.undoneBy === undefined ? undefined : "Undo the undo entry to redo the edit.",
      );
    }
    const runningJob =
      original.jobId === undefined ? undefined : services.runner.get(original.jobId);
    if (
      runningJob !== undefined &&
      (runningJob.status === "queued" || runningJob.status === "running")
    ) {
      throw new ConsoleError(
        409,
        "CONSOLE_LIVE_NOT_UNDOABLE",
        "This edit is still running.",
        "Wait for its job to finish.",
      );
    }
    const namespace = parseNamespace(original.ns);
    return withDriverErrors(services, connection, async () => {
      if (original.parts === 1 && original.documents === 1) {
        const result = await undoSingle(services, deps, principal, connection, namespace, original);
        return c.json(result);
      }
      let resolveJobId: (id: string) => void = () => {};
      const jobId = new Promise<string>((resolve) => {
        resolveJobId = resolve;
      });
      const job = await services.runner.start(
        undoJob(deps, {
          connection,
          namespace,
          original,
          by: principal.user.username,
          jobId,
          secrets: [openConnectionUri(store, connection)],
        }),
      );
      resolveJobId(job.id);
      await recordAudit(services, {
        actor: principal,
        action: "live.undo.start",
        target: original.ns,
        outcome: "success",
        details: { connection: connection.name, undoOf: original.id, job: job.id },
      });
      const result: LiveUndoResult = { kind: "job", job };
      return c.json(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Validates a settings change. Turning edits on for a production connection needs the
 * connection's name typed again and a reason; both are recorded (the reason in the audit
 * log and on the connection).
 */
function liveSettingsFrom(
  services: ConsoleServices,
  principal: Principal,
  connection: ConnectionRecord,
  body: Fields,
): LiveEditSettingsRecord {
  const enabled = requiredBoolean(body, "enabled");
  const journalStorageId = optionalString(body, "journalStorageId", 64);
  if (journalStorageId !== undefined && journalStorageId !== "") {
    storageById(services.store, journalStorageId); // 404 for a storage location that does not exist
  }
  const maxBulkDocuments =
    optionalPositiveInt(body, "maxBulkDocuments", LIVE_BULK_HARD_LIMIT) ??
    connection.liveEdits?.maxBulkDocuments ??
    LIVE_BULK_DEFAULT_LIMIT;
  if (maxBulkDocuments < 1) throw invalid('"maxBulkDocuments" must be at least 1.');
  const reason = optionalString(body, "reason", MAX_REASON_LENGTH)?.trim();
  if (reason !== undefined && hasControlCharacter(reason)) {
    throw invalid('"reason" must not contain control characters.');
  }
  const productionConfirmed = enabled && connection.production;
  if (productionConfirmed) {
    if (body.confirmName !== connection.name) {
      throw new ConsoleError(
        400,
        "MS_CONFIRMATION_REQUIRED",
        `"${connection.name}" is marked production: type its name to allow live edits.`,
        "Live edits on production change customer data directly; every write is journaled and audited.",
      );
    }
    if (reason === undefined || reason === "") {
      throw invalid(
        "Give a reason for allowing live edits on a production connection.",
        "It is recorded with the setting and in the audit log.",
      );
    }
  }
  return {
    enabled,
    changedBy: principal.user.username,
    changedAt: services.now().toISOString(),
    ...(reason === undefined || reason === "" ? {} : { reason }),
    productionConfirmed,
    ...(journalStorageId === undefined || journalStorageId === "" ? {} : { journalStorageId }),
    maxBulkDocuments,
  };
}

/** True when text contains a C0 control character or DEL (newlines could forge log lines). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The connection's bulk cap (never above the hard limit). */
function maxBulkOf(connection: ConnectionRecord): number {
  return Math.min(
    connection.liveEdits?.maxBulkDocuments ?? LIVE_BULK_DEFAULT_LIMIT,
    LIVE_BULK_HARD_LIMIT,
  );
}

/** Why the caller may not write to a collection, in words, or `undefined`. */
function readOnlyReason(
  principal: Principal,
  connection: ConnectionRecord,
  type: LiveCollectionInfo["type"],
): string | undefined {
  if (type === "view") return "Views are read-only.";
  if (type === "timeseries") return "Time series collections are read-only in the data browser.";
  return liveWriteRefusal(principal.user, connection)?.message;
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

/** How many documents match: the metadata estimate without a filter, else a bounded count. */
async function countOf(
  collection: Collection<Document>,
  filter: Document,
  seen: number,
): Promise<LiveCount> {
  if (Object.keys(filter).length === 0) {
    const value = await collection.estimatedDocumentCount();
    return { value: Math.max(value, seen), kind: "estimated" };
  }
  try {
    const value = await collection.countDocuments(filter, {
      limit: COUNT_LIMIT + 1,
      maxTimeMS: COUNT_TIMEOUT_MS,
    });
    return value > COUNT_LIMIT
      ? { value: COUNT_LIMIT, kind: "at-least" }
      : { value, kind: "exact" };
  } catch {
    // A count that takes too long is not worth failing the page for.
    return { value: seen, kind: "at-least" };
  }
}

/** Sizes from `$collStats` (summed over shards); absent when the user may not read them. */
async function storageStatsOf(
  collection: Collection<Document>,
): Promise<
  Pick<
    LiveCollectionInfo,
    "sizeBytes" | "storageSizeBytes" | "averageDocumentBytes" | "totalIndexBytes"
  >
> {
  try {
    const stats = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    let sizeBytes = 0;
    let storageSizeBytes = 0;
    let totalIndexBytes = 0;
    let count = 0;
    for (const shard of stats) {
      const storageStats: unknown = shard.storageStats;
      sizeBytes += numberField(storageStats, "size");
      storageSizeBytes += numberField(storageStats, "storageSize");
      totalIndexBytes += numberField(storageStats, "totalIndexSize");
      count += numberField(storageStats, "count");
    }
    return {
      sizeBytes,
      storageSizeBytes,
      totalIndexBytes,
      averageDocumentBytes: count === 0 ? 0 : Math.round(sizeBytes / count),
    };
  } catch {
    return {};
  }
}

/** The indexes of a collection, with their sizes when `$collStats` has them. */
async function indexesOf(collection: Collection<Document>): Promise<LiveIndexView[]> {
  const sizes = new Map<string, number>();
  try {
    const stats = await collection.aggregate([{ $collStats: { storageStats: {} } }]).toArray();
    for (const shard of stats) {
      const indexSizes: unknown = Reflect.get(Object(shard.storageStats), "indexSizes");
      for (const [name, size] of Object.entries(Object(indexSizes))) {
        if (typeof size === "number") sizes.set(name, (sizes.get(name) ?? 0) + size);
      }
    }
  } catch {
    // Sizes are optional.
  }
  const indexes = await collection.listIndexes().toArray();
  return indexes.map((index): LiveIndexView => {
    const name = String(index.name);
    const size = sizes.get(name);
    return {
      name,
      key: BSON.EJSON.stringify(index.key, { relaxed: true }),
      unique: index.unique === true,
      sparse: index.sparse === true,
      hidden: index.hidden === true,
      ...(typeof index.expireAfterSeconds === "number"
        ? { expireAfterSeconds: index.expireAfterSeconds }
        : {}),
      ...(index.partialFilterExpression === undefined
        ? {}
        : {
            partialFilter: BSON.EJSON.stringify(index.partialFilterExpression, { relaxed: true }),
          }),
      ...(size === undefined ? {} : { sizeBytes: size }),
    };
  });
}

/** A numeric field of an unknown object, or 0. */
function numberField(value: unknown, name: string): number {
  const field: unknown = Reflect.get(Object(value), name);
  return typeof field === "number" ? field : 0;
}

/** The first journaled documents of an entry, as relaxed Extended JSON. */
async function detailRecords(
  services: ConsoleServices,
  entry: LiveEditRecord,
): Promise<{ records: LiveEditEntryDetail["records"]; truncated: boolean }> {
  if (entry.parts === 0) return { records: [], truncated: false };
  const records = await services.live.journal.readPart(entry, 0);
  const relaxed = (text: string | undefined) =>
    text === undefined
      ? undefined
      : BSON.EJSON.stringify(fromExtendedJson(text), { relaxed: true });
  return {
    records: records.slice(0, DETAIL_RECORDS).map((record) => {
      const before = relaxed(record.before);
      const after = relaxed(record.after);
      return {
        id: BSON.EJSON.stringify(fromExtendedJson(record.id), { relaxed: true }),
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
      };
    }),
    truncated: records.length > DETAIL_RECORDS || entry.parts > 1,
  };
}

// ---------------------------------------------------------------------------
// Writing helpers
// ---------------------------------------------------------------------------

/** MongoDB keeps `_id` as the first field; the journal's images must match that order. */
function withIdFirst(document: Document): Document {
  const { _id, ...rest } = document;
  return { _id, ...rest };
}

/** The request of a bulk preview or bulk edit. */
function bulkRequestFrom(body: Fields): {
  namespace: Namespace;
  op: "update" | "delete";
  filter: Document;
  update?: Document;
} {
  const namespace = parseNamespace(body.ns);
  const op = oneOf(body, "op", ["update", "delete"] as const);
  const rawFilter = body.filter;
  if (rawFilter !== undefined && typeof rawFilter !== "string") {
    throw invalid('"filter" must be Extended JSON text.');
  }
  const filter = parseQueryObject(rawFilter, "The filter") ?? {};
  if (op === "update") return { namespace, op, filter, update: parseUpdate(body.update) };
  return { namespace, op, filter };
}

/**
 * After a single write: answer 409 when the compare-and-swap lost a race, else audit and
 * return the entry with the document as it is stored now (read back, so its version is
 * exactly what the next edit has to present).
 */
async function finishSingleWrite(
  c: Context<AppEnv>,
  services: ConsoleServices,
  principal: Principal,
  action: "live.insert" | "live.update" | "live.delete",
  connection: ConnectionRecord,
  namespace: Namespace,
  entry: LiveEditRecord,
  collection: Collection<Document>,
  id: unknown,
  changedFields?: readonly string[],
): Promise<Response> {
  const applied = entry.status === "applied";
  await recordAudit(services, {
    actor: principal,
    action,
    target: namespace.ns,
    outcome: applied ? "success" : "failure",
    details: auditDetails(connection, entry, applied ? {} : { conflict: true }, changedFields),
  });
  if (!applied) throw conflictError("edit");
  const stored = action === "live.delete" ? undefined : await readCurrent(collection, id);
  const result: LiveWriteResult = {
    entry: entryView(services.store, entry),
    ...(stored === undefined ? {} : { document: liveDocumentView(stored, true) }),
    ...(changedFields === undefined ? {} : { changedFields }),
  };
  return c.json(result);
}

/** Audit details of a single-document write: ids and hashes, never document contents. */
function auditDetails(
  connection: ConnectionRecord,
  entry: LiveEditRecord,
  extra: Readonly<Record<string, string | number | boolean>>,
  changedFields?: readonly string[],
): Record<string, string | number | boolean> {
  return {
    connection: connection.name,
    entry: entry.id,
    ...(entry.documentId === undefined ? {} : { id: entry.documentId }),
    ...(entry.beforeHash === undefined ? {} : { before: entry.beforeHash }),
    ...(entry.afterHash === undefined ? {} : { after: entry.afterHash }),
    ...(changedFields === undefined ? {} : { fields: changedFields.length }),
    ...extra,
  };
}

/** Audits a write refused because the document changed since it was loaded. */
async function auditConflict(
  services: ConsoleServices,
  principal: Principal,
  action: string,
  connection: ConnectionRecord,
  namespace: Namespace,
  id: unknown,
): Promise<void> {
  await recordAudit(services, {
    actor: principal,
    action,
    target: namespace.ns,
    outcome: "failure",
    details: { connection: connection.name, id: idLabelOf(id), conflict: true },
  });
}

/** Undoes a single-document entry right away (see apply.ts for the rules). */
async function undoSingle(
  services: ConsoleServices,
  deps: LiveDeps,
  principal: Principal,
  connection: ConnectionRecord,
  namespace: Namespace,
  original: LiveEditRecord,
): Promise<LiveUndoResult> {
  const [record] = await services.live.journal.readPart(original, 0);
  const inverse = record === undefined ? undefined : inverseOf(original.op, record);
  if (inverse === undefined) {
    throw new ConsoleError(
      409,
      "CONSOLE_LIVE_NOT_UNDOABLE",
      "The journal has no state to return this document to.",
    );
  }
  const change: DocumentChange = changeOf(inverse);
  const id = (change.before ?? change.after)?._id;
  const collection = await collectionOf(deps, connection, namespace);
  const current = await readCurrent(collection, id);
  if (!matchesExpected(current, change.before)) {
    await auditConflict(services, principal, "live.undo", connection, namespace, id);
    throw conflictError("undo");
  }
  const entry = await applySingleEdit(deps, {
    connection,
    namespace,
    op: "undo",
    by: principal.user.username,
    change,
    undoOf: original.id,
  });
  const applied = entry.status === "applied";
  await recordAudit(services, {
    actor: principal,
    action: "live.undo",
    target: namespace.ns,
    outcome: applied ? "success" : "failure",
    details: auditDetails(connection, entry, {
      undoOf: original.id,
      ...(applied ? {} : { conflict: true }),
    }),
  });
  if (!applied) throw conflictError("undo");
  await updateEntry(services.store, original.id, { undoneBy: entry.id });
  return { kind: "applied", entry: entryView(services.store, entry) };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Runs a handler and describes driver errors safely: errors the server reported about
 * the request (a bad operator, a validation rule) become `400 CONSOLE_LIVE_QUERY` with
 * the server's message; anything else (network, authentication) becomes
 * `502 MS_CONNECTION_FAILED`. The connection URI is scrubbed from every message.
 */
async function withDriverErrors(
  services: ConsoleServices,
  connection: ConnectionRecord,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (isKnownError(error)) throw error;
    const uri = openConnectionUri(services.store, connection);
    const message = scrubText(error instanceof Error ? error.message : String(error), [uri]);
    if (error instanceof MongoServerError) {
      throw new ConsoleError(400, "CONSOLE_LIVE_QUERY", `MongoDB refused the request: ${message}`);
    }
    throw new MongoShieldError("MS_CONNECTION_FAILED", message, {
      hint: "Test the connection for details.",
    });
  }
}
