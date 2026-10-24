/**
 * The mock backend's live data routes: in-memory "live databases" for every mock
 * connection, browsing, conditional edits, a journal with undo, and bulk edits that run
 * as mock jobs. backend.ts spreads these handlers into its route table.
 *
 * It mirrors the server rules the UI depends on (src/server/routes/live.ts):
 * - reading needs the operator role; writing also needs the `data:write` permission and
 *   live edits turned on for the connection (and confirmed for production ones),
 * - every write is conditional on the document's `version` (409 CONSOLE_LIVE_CONFLICT),
 * - every write is journaled first, so it can be undone from the Edit history (undo is
 *   conditional too, and itself journaled),
 * - bulk edits need a preview count and the exact confirmation text, and are capped.
 *
 * It is deliberately simple elsewhere: filters know equality, `$in`, `$ne`, `$exists` and
 * numeric comparisons; bulk updates know `$set`, `$unset` and `$inc`; versions are a
 * cheap deterministic hash (the UI treats them as opaque strings).
 */

import {
  type ConnectionView,
  type JobKind,
  type JobSummary,
  LIVE_BULK_DEFAULT_LIMIT,
  LIVE_BULK_HARD_LIMIT,
  type LiveCollectionInfo,
  type LiveDocument,
  type LiveEditEntryView,
  type LiveEditOp,
  type LiveEditSettingsView,
  type UserView,
} from "../../shared/api.ts";
import type { RequestOf, ResponseOf, RouteKey } from "../api.ts";
import { roleIncludes } from "../context.tsx";
import { generateDocument, type MockConnection, type MockData } from "./fixtures.ts";

/** The live routes this module answers. */
export type LiveRoute = Extract<
  RouteKey,
  | "PUT /api/connections/:id/live-edits"
  | `${string} /api/live/${string}`
  | `${string} /api/live-edits${string}`
>;

/** What a live handler receives (the same shape as backend.ts's handler input). */
interface LiveHandlerInput<Route extends RouteKey> {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: RequestOf<Route>;
  readonly user: UserView | undefined;
}

/** One handler per live route. */
export type LiveHandlers = {
  [Route in LiveRoute]: (input: LiveHandlerInput<Route>) => ResponseOf<Route>;
};

/** Minimum roles of the live routes (the handlers check `data:write` themselves). */
export const LIVE_ROUTE_ROLES: { readonly [Route in LiveRoute]: "operator" | "admin" } = {
  "PUT /api/connections/:id/live-edits": "admin",
  "GET /api/live/:id/collection": "operator",
  "GET /api/live/:id/documents": "operator",
  "POST /api/live/:id/documents": "operator",
  "PUT /api/live/:id/documents": "operator",
  "POST /api/live/:id/documents/delete": "operator",
  "POST /api/live/:id/bulk/preview": "operator",
  "POST /api/live/:id/bulk": "operator",
  "GET /api/live-edits": "operator",
  "GET /api/live-edits/:id": "operator",
  "POST /api/live-edits/:id/undo": "operator",
};

/** What the live mock needs from the backend around it. */
export interface LiveMockContext {
  readonly data: MockData;
  readonly now: number;
  /** Builds the error a handler throws (backend.ts turns it into an `ApiError` response). */
  readonly fail: (status: number, code: string, message: string, hint?: string) => Error;
  readonly findConnection: (id: string | undefined) => MockConnection;
  readonly audit: (
    action: string,
    outcome: "success" | "failure",
    target?: string,
    details?: Record<string, string | number | boolean>,
  ) => void;
  readonly newId: (prefix: string) => string;
  /** Starts a mock job; `onSuccess` runs when it finishes and returns its summary. */
  readonly startJob: (
    kind: JobKind,
    namespaces: readonly { ns: string; documents: number }[],
    extra: { onSuccess?: () => string },
  ) => JobSummary;
}

/** A live document: a relaxed Extended JSON object. */
type MockDocument = Record<string, unknown>;

/** One journaled document: its `_id` key and the states before and after. */
interface MockRecord {
  readonly id: string;
  readonly before?: MockDocument;
  readonly after?: MockDocument;
}

/** A journal entry: the API view plus the journaled documents. */
interface MockEntry {
  view: LiveEditEntryView;
  records: MockRecord[];
}

/** Controls for tests: simulate someone else changing a document meanwhile. */
export interface LiveMockControls {
  /**
   * Changes a field of a live document behind the UI's back (as another user or an app
   * would), so its version changes and the next edit conflicts. `id` is the `_id` as
   * JSON, e.g. `{"$oid":"65…"}`.
   */
  touch(connectionId: string, ns: string, id: string): void;
  /** The documents of a live namespace (generated on first use). */
  documents(connectionId: string, ns: string): MockDocument[];
  /** Journal entries, newest first. */
  entries(): readonly LiveEditEntryView[];
}

/** Generated documents per live collection (enough for a few pages). */
const DOCUMENTS_PER_COLLECTION = 45;

/** Settings of a connection, with the server's defaults when it never had any. */
export function liveSettingsOf(connection: MockConnection): LiveEditSettingsView {
  return (
    connection.liveEdits ?? {
      enabled: false,
      productionConfirmed: false,
      maxBulkDocuments: LIVE_BULK_DEFAULT_LIMIT,
    }
  );
}

/** The confirmation text, exactly like the server's `bulkConfirmText`. */
export function bulkConfirmText(op: "update" | "delete", count: number, ns: string): string {
  return `${op} ${count} ${count === 1 ? "document" : "documents"} in ${ns}`;
}

/** Creates the live routes over the mock's data. */
export function createLiveMock(context: LiveMockContext): {
  readonly handlers: LiveHandlers;
  readonly controls: LiveMockControls;
} {
  const { data, fail } = context;
  /** connection id → namespace → documents. */
  const databases = new Map<string, Map<string, MockDocument[]>>();
  /** Journal entries, newest first. */
  const journal: MockEntry[] = [];

  // ---- data ---------------------------------------------------------------

  const collectionNode = (connection: MockConnection, ns: string) => {
    const dot = ns.indexOf(".");
    const db = connection.namespaces.find((node) => node.name === ns.slice(0, dot));
    const node = db?.collections.find((candidate) => candidate.name === ns.slice(dot + 1));
    if (dot === -1 || node === undefined) {
      throw fail(404, "CONSOLE_NOT_FOUND", `There is no collection "${ns}".`);
    }
    return node;
  };

  const documentsOf = (connectionId: string, ns: string): MockDocument[] => {
    const connection = context.findConnection(connectionId);
    const node = collectionNode(connection, ns);
    let byNamespace = databases.get(connectionId);
    if (byNamespace === undefined) {
      byNamespace = new Map();
      databases.set(connectionId, byNamespace);
    }
    let documents = byNamespace.get(ns);
    if (documents === undefined) {
      const count =
        node.type === "view" ? 0 : Math.min(node.estimatedDocuments, DOCUMENTS_PER_COLLECTION);
      documents = Array.from({ length: count }, (_, index) =>
        generateDocument(ns, index, context.now),
      );
      byNamespace.set(ns, documents);
    }
    return documents;
  };

  const findById = (documents: MockDocument[], id: string) =>
    documents.findIndex((document) => idKey(document) === id);

  // ---- access ---------------------------------------------------------------

  /** Who may write here, mirroring the server's access.ts; throws the same errors. */
  const assertWriter = (user: UserView | undefined, connection: MockConnection) => {
    if (user === undefined || !canWrite(user)) {
      throw fail(
        403,
        "CONSOLE_FORBIDDEN",
        "Changing live data needs the data:write permission, which an admin grants.",
      );
    }
    const refusal = settingsRefusal(connection);
    if (refusal !== undefined) throw fail(403, "CONSOLE_LIVE_EDITS_DISABLED", refusal);
  };

  const settingsRefusal = (connection: MockConnection): string | undefined => {
    const settings = liveSettingsOf(connection);
    if (!settings.enabled)
      return `Live edits are turned off for the connection "${connection.name}".`;
    if (connection.production && !settings.productionConfirmed) {
      return `"${connection.name}" is marked production and live edits were not confirmed for production.`;
    }
    return undefined;
  };

  // ---- journal --------------------------------------------------------------

  const addEntry = (
    connection: MockConnection,
    ns: string,
    op: LiveEditOp,
    by: string,
    records: MockRecord[],
    extra: { undoOf?: string; jobId?: string } = {},
  ): MockEntry => {
    const single = records.length === 1 ? records[0] : undefined;
    const journalStorageId = liveSettingsOf(connection).journalStorageId;
    const entry: MockEntry = {
      records,
      view: {
        id: context.newId("edit"),
        connectionId: connection.id,
        connectionName: connection.name,
        ns,
        op,
        by,
        at: new Date().toISOString(),
        // The mock applies writes at once, so its entries are never pending.
        status: "applied",
        documents: records.length,
        applied: records.length,
        conflicts: 0,
        ...(single === undefined ? {} : { documentId: single.id }),
        ...(single?.before === undefined ? {} : { beforeHash: versionOf(single.before) }),
        ...(single?.after === undefined ? {} : { afterHash: versionOf(single.after) }),
        ...(extra.undoOf === undefined ? {} : { undoOf: extra.undoOf }),
        ...(extra.jobId === undefined ? {} : { jobId: extra.jobId }),
        journal:
          journalStorageId === undefined
            ? { kind: "console" }
            : { kind: "storage", storageId: journalStorageId },
        undoable: records.length > 0,
      },
    };
    journal.unshift(entry);
    return entry;
  };

  const findEntry = (id: string | undefined): MockEntry => {
    const entry = journal.find((candidate) => candidate.view.id === id);
    if (entry === undefined)
      throw fail(404, "CONSOLE_NOT_FOUND", "The edit history entry was not found.");
    return entry;
  };

  /** Applies one record's change if the document is still in its `before` state. */
  const applyConditionally = (documents: MockDocument[], record: MockRecord): boolean => {
    const index = findById(documents, record.id);
    const current = index === -1 ? undefined : documents[index];
    const matches =
      record.before === undefined
        ? current === undefined
        : current !== undefined && versionOf(current) === versionOf(record.before);
    if (!matches) return false;
    if (record.after === undefined) documents.splice(index, 1);
    else if (index === -1) documents.push(record.after);
    else documents[index] = record.after;
    return true;
  };

  const conflict = (what: "edit" | "undo") =>
    what === "edit"
      ? fail(
          409,
          "CONSOLE_LIVE_CONFLICT",
          "The document changed after you loaded it (or was deleted), so your change was not saved.",
          "Reload the document, check what changed, and make your edit again.",
        )
      : fail(
          409,
          "CONSOLE_LIVE_CONFLICT",
          "The document changed after this edit, so undoing it would overwrite newer changes. Nothing was changed.",
          "Open the document in the data browser to see its current state.",
        );

  // ---- request parsing --------------------------------------------------------

  const parseObject = (
    text: string | null | undefined,
    label: string,
  ): MockDocument | undefined => {
    if (text === null || text === undefined || text.trim() === "") return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw fail(400, "CONSOLE_VALIDATION", `${label} is not valid Extended JSON.`);
    }
    if (!isRecord(value)) throw fail(400, "CONSOLE_VALIDATION", `${label} must be a JSON object.`);
    if (JSON.stringify(value).includes('"$where"')) {
      throw fail(
        400,
        "CONSOLE_VALIDATION",
        `${label} uses $where, which runs JavaScript on the server.`,
      );
    }
    return value;
  };

  const requireNamespace = (ns: string | null | undefined): string => {
    if (ns === null || ns === undefined || !ns.includes(".")) {
      throw fail(400, "CONSOLE_VALIDATION", '"ns" (the namespace, e.g. app.users) is required.');
    }
    return ns;
  };

  // ---- handlers -----------------------------------------------------------------

  const handlers: LiveHandlers = {
    "PUT /api/connections/:id/live-edits": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      const reason = body.reason?.trim();
      const productionConfirmed = body.enabled && connection.production;
      if (productionConfirmed) {
        if (body.confirmName !== connection.name) {
          throw fail(
            400,
            "MS_CONFIRMATION_REQUIRED",
            `"${connection.name}" is marked production: type its name to allow live edits.`,
          );
        }
        if (reason === undefined || reason === "") {
          throw fail(
            400,
            "CONSOLE_VALIDATION",
            "Give a reason for allowing live edits on a production connection.",
          );
        }
      }
      const max = body.maxBulkDocuments ?? liveSettingsOf(connection).maxBulkDocuments;
      if (!Number.isInteger(max) || max < 1 || max > LIVE_BULK_HARD_LIMIT) {
        throw fail(
          400,
          "CONSOLE_VALIDATION",
          `"maxBulkDocuments" must be a whole number between 1 and ${LIVE_BULK_HARD_LIMIT}.`,
        );
      }
      if (
        body.journalStorageId !== undefined &&
        !data.storage.some((storage) => storage.id === body.journalStorageId)
      ) {
        throw fail(404, "CONSOLE_NOT_FOUND", "The storage location was not found.");
      }
      connection.liveEdits = {
        enabled: body.enabled,
        productionConfirmed,
        changedBy: user?.username ?? "admin",
        changedAt: new Date().toISOString(),
        ...(reason === undefined || reason === "" ? {} : { reason }),
        ...(body.journalStorageId === undefined ? {} : { journalStorageId: body.journalStorageId }),
        maxBulkDocuments: max,
      };
      context.audit("connection.live_edits", "success", connection.name, {
        enabled: body.enabled,
        production: connection.production,
      });
      return connectionView(connection);
    },

    "GET /api/live/:id/collection": ({ params, query, user }) => {
      const connection = context.findConnection(params.id);
      const ns = requireNamespace(query.get("ns"));
      const node = collectionNode(connection, ns);
      const documents = documentsOf(connection.id, ns);
      const refusal =
        node.type === "view"
          ? "Views are read-only."
          : node.type === "timeseries"
            ? "Time series collections are read-only in the data browser."
            : user === undefined || !canWrite(user)
              ? "Changing live data needs the data:write permission, which an admin grants."
              : settingsRefusal(connection);
      const averageDocumentBytes = 412;
      const info: LiveCollectionInfo = {
        ns,
        type: node.type,
        estimatedDocuments: documents.length,
        capped: false,
        ...(node.type === "view"
          ? {}
          : {
              sizeBytes: documents.length * averageDocumentBytes,
              storageSizeBytes: Math.round(documents.length * averageDocumentBytes * 0.4),
              averageDocumentBytes,
              totalIndexBytes: 4096 * Math.max(node.indexes, 1),
            }),
        indexes:
          node.type === "view"
            ? []
            : [
                {
                  name: "_id_",
                  key: '{"_id":1}',
                  unique: false,
                  sparse: false,
                  hidden: false,
                  sizeBytes: 4096,
                },
                ...(ns.endsWith(".users")
                  ? [
                      {
                        name: "email_1",
                        key: '{"email":1}',
                        unique: true,
                        sparse: false,
                        hidden: false,
                        sizeBytes: 8192,
                      },
                    ]
                  : []),
                ...(ns.endsWith(".sessions")
                  ? [
                      {
                        name: "createdAt_1",
                        key: '{"createdAt":1}',
                        unique: false,
                        sparse: false,
                        hidden: false,
                        expireAfterSeconds: 86_400,
                      },
                    ]
                  : []),
              ],
        writable: refusal === undefined,
        ...(refusal === undefined ? {} : { readOnlyReason: refusal }),
      };
      return info;
    },

    "GET /api/live/:id/documents": ({ params, query }) => {
      const connection = context.findConnection(params.id);
      const ns = requireNamespace(query.get("ns"));
      const filter = parseObject(query.get("filter"), "The filter");
      const projection = parseObject(query.get("projection"), "The projection");
      const sort = parseObject(query.get("sort"), "The sort");
      const skip = Number(query.get("skip") ?? "0");
      const limit = Number(query.get("limit") ?? "20");
      let documents = documentsOf(connection.id, ns).filter(
        (document) => filter === undefined || matches(document, filter),
      );
      if (sort !== undefined) documents = sortDocuments(documents, sort);
      const page = documents.slice(skip, skip + limit);
      const projected = projection !== undefined && Object.keys(projection).length > 0;
      context.audit("live.browse", "success", `${connection.name}/${ns}`, {
        documents: page.length,
      });
      return {
        documents: page.map((document) =>
          liveView(projected ? project(document, projection) : document, !projected),
        ),
        skip,
        limit,
        count:
          filter === undefined
            ? { value: documents.length, kind: "estimated" }
            : { value: documents.length, kind: "exact" },
        hasMore: skip + limit < documents.length,
        projected,
      };
    },

    "POST /api/live/:id/documents": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      assertWriter(user, connection);
      const ns = requireNamespace(body.ns);
      const parsed = parseObject(body.document, "The document");
      if (parsed === undefined) throw fail(400, "CONSOLE_VALIDATION", '"document" is required.');
      const document: MockDocument =
        "_id" in parsed ? parsed : { _id: { $oid: newObjectId(context.newId("oid")) }, ...parsed };
      const documents = documentsOf(connection.id, ns);
      if (findById(documents, idKey(document)) !== -1) {
        throw fail(
          409,
          "CONSOLE_LIVE_CONFLICT",
          "A document with this _id already exists, so nothing was inserted.",
          "Remove _id to get a new ObjectId, or choose another value.",
        );
      }
      const record: MockRecord = { id: idKey(document), after: document };
      applyConditionally(documents, record);
      const entry = addEntry(connection, ns, "insert", usernameOf(user), [record]);
      context.audit("live.insert", "success", ns, { id: record.id });
      return { entry: entry.view, document: liveView(document, true) };
    },

    "PUT /api/live/:id/documents": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      assertWriter(user, connection);
      const ns = requireNamespace(body.ns);
      const edited = parseObject(body.document, "The document");
      if (edited === undefined) throw fail(400, "CONSOLE_VALIDATION", '"document" is required.');
      const documents = documentsOf(connection.id, ns);
      const index = findById(documents, body.id);
      const current = documents[index];
      if (current === undefined || versionOf(current) !== body.version) {
        context.audit("live.update", "failure", ns, { id: body.id, conflict: true });
        throw conflict("edit");
      }
      if (idKey(edited) !== body.id) {
        throw fail(400, "CONSOLE_VALIDATION", "An edit cannot change or remove _id.");
      }
      const changedFields = changedPaths(current, edited);
      if (changedFields.length === 0) {
        throw fail(
          400,
          "CONSOLE_VALIDATION",
          "The edited document is the same as the stored one; nothing to save.",
        );
      }
      const record: MockRecord = { id: body.id, before: current, after: edited };
      applyConditionally(documents, record);
      const entry = addEntry(connection, ns, "update", usernameOf(user), [record]);
      context.audit("live.update", "success", ns, { id: body.id, fields: changedFields.length });
      return { entry: entry.view, document: liveView(edited, true), changedFields };
    },

    "POST /api/live/:id/documents/delete": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      assertWriter(user, connection);
      const ns = requireNamespace(body.ns);
      const documents = documentsOf(connection.id, ns);
      const current = documents[findById(documents, body.id)];
      if (current === undefined || versionOf(current) !== body.version) {
        context.audit("live.delete", "failure", ns, { id: body.id, conflict: true });
        throw conflict("edit");
      }
      const record: MockRecord = { id: body.id, before: current };
      applyConditionally(documents, record);
      const entry = addEntry(connection, ns, "delete", usernameOf(user), [record]);
      context.audit("live.delete", "success", ns, { id: body.id });
      return { entry: entry.view };
    },

    "POST /api/live/:id/bulk/preview": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      assertWriter(user, connection);
      const ns = requireNamespace(body.ns);
      if (body.op === "update") parseUpdate(body.update);
      const filter = parseObject(body.filter, "The filter") ?? {};
      const matched = documentsOf(connection.id, ns).filter((document) =>
        matches(document, filter),
      ).length;
      const max = liveSettingsOf(connection).maxBulkDocuments;
      return {
        ns,
        op: body.op,
        matched,
        max,
        allowed: matched > 0 && matched <= max,
        confirmText: bulkConfirmText(body.op, matched, ns),
      };
    },

    "POST /api/live/:id/bulk": ({ params, body, user }) => {
      const connection = context.findConnection(params.id);
      assertWriter(user, connection);
      const ns = requireNamespace(body.ns);
      const update = body.op === "update" ? parseUpdate(body.update) : undefined;
      const filter = parseObject(body.filter, "The filter") ?? {};
      const max = liveSettingsOf(connection).maxBulkDocuments;
      if (body.expectedCount > max) {
        throw fail(
          422,
          "CONSOLE_LIVE_BULK_TOO_LARGE",
          `This connection allows at most ${max} documents per bulk edit.`,
        );
      }
      const expected = bulkConfirmText(body.op, body.expectedCount, ns);
      if (body.confirm !== expected) {
        throw fail(400, "MS_CONFIRMATION_REQUIRED", `Type "${expected}" to confirm.`);
      }
      const documents = documentsOf(connection.id, ns);
      const matching = documents.filter((document) => matches(document, filter));
      if (matching.length !== body.expectedCount) {
        throw fail(
          409,
          "CONSOLE_LIVE_COUNT_CHANGED",
          `The filter now matches ${matching.length} documents instead of the ${body.expectedCount} you confirmed. Nothing was changed.`,
        );
      }
      const by = usernameOf(user);
      const job = context.startJob("live-edit", [{ ns, documents: matching.length }], {
        // The change happens when the mock job finishes, like a real job working through batches.
        onSuccess: () => {
          const records: MockRecord[] = matching.map((before) => ({
            id: idKey(before),
            before,
            ...(update === undefined ? {} : { after: applyUpdate(before, update) }),
          }));
          const applied = records.filter((record) => applyConditionally(documents, record));
          addEntry(
            connection,
            ns,
            body.op === "update" ? "bulk-update" : "bulk-delete",
            by,
            applied,
            {
              jobId: job.id,
            },
          );
          return `${body.op === "update" ? "updated" : "deleted"} ${applied.length} of ${records.length} documents in ${ns}`;
        },
      });
      context.audit(`live.bulk_${body.op}.start`, "success", ns, { job: job.id });
      return job;
    },

    "GET /api/live-edits": ({ query }) => {
      const connectionId = query.get("connectionId");
      return journal
        .filter(
          (entry) =>
            connectionId === null ||
            connectionId === "" ||
            entry.view.connectionId === connectionId,
        )
        .map((entry) => entry.view);
    },

    "GET /api/live-edits/:id": ({ params }) => {
      const entry = findEntry(params.id);
      context.audit("live.history_read", "success", entry.view.ns, { entry: entry.view.id });
      return {
        ...entry.view,
        records: entry.records.slice(0, 20).map((record) => ({
          id: record.id,
          ...(record.before === undefined ? {} : { before: JSON.stringify(record.before) }),
          ...(record.after === undefined ? {} : { after: JSON.stringify(record.after) }),
        })),
        truncated: entry.records.length > 20,
      };
    },

    "POST /api/live-edits/:id/undo": ({ params, user }) => {
      const original = findEntry(params.id);
      const connection = context.findConnection(original.view.connectionId);
      assertWriter(user, connection);
      if (!original.view.undoable) {
        throw fail(
          409,
          "CONSOLE_LIVE_NOT_UNDOABLE",
          original.view.undoneBy === undefined
            ? "This entry changed nothing, so there is nothing to undo."
            : "This edit has already been undone.",
        );
      }
      const documents = documentsOf(connection.id, original.view.ns);
      const inverses: MockRecord[] = original.records.map((record) => ({
        id: record.id,
        ...(record.after === undefined ? {} : { before: record.after }),
        ...(record.before === undefined ? {} : { after: record.before }),
      }));
      const by = usernameOf(user);
      const markUndone = (entry: MockEntry) => {
        original.view = { ...original.view, undoneBy: entry.view.id, undoable: false };
      };
      if (inverses.length === 1) {
        const [inverse] = inverses;
        if (inverse === undefined || !applyConditionally(documents, inverse)) {
          context.audit("live.undo", "failure", original.view.ns, { conflict: true });
          throw conflict("undo");
        }
        const entry = addEntry(connection, original.view.ns, "undo", by, [inverse], {
          undoOf: original.view.id,
        });
        markUndone(entry);
        context.audit("live.undo", "success", original.view.ns, { undoOf: original.view.id });
        return { kind: "applied", entry: entry.view };
      }
      const job = context.startJob(
        "live-edit",
        [{ ns: original.view.ns, documents: inverses.length }],
        {
          onSuccess: () => {
            const applied = inverses.filter((inverse) => applyConditionally(documents, inverse));
            const entry = addEntry(connection, original.view.ns, "undo", by, applied, {
              undoOf: original.view.id,
              jobId: job.id,
            });
            entry.view = { ...entry.view, conflicts: inverses.length - applied.length };
            if (applied.length > 0) markUndone(entry);
            return `undid the edit of ${applied.length} documents in ${original.view.ns}`;
          },
        },
      );
      return { kind: "job", job };
    },
  };

  /** Validates an update for bulk edits ($set, $unset, $inc only in the mock). */
  function parseUpdate(text: string | undefined): MockDocument {
    const update = parseObject(text, "The update");
    if (update === undefined || Object.keys(update).length === 0) {
      throw fail(
        400,
        "CONSOLE_VALIDATION",
        'The update must contain at least one operator, e.g. {"$set": {…}}.',
      );
    }
    for (const [operator, fields] of Object.entries(update)) {
      if (!["$set", "$unset", "$inc"].includes(operator) || !isRecord(fields)) {
        throw fail(400, "CONSOLE_VALIDATION", `"${operator}" is not an allowed update operator.`);
      }
    }
    return update;
  }

  const controls: LiveMockControls = {
    touch(connectionId, ns, id) {
      const documents = documentsOf(connectionId, ns);
      const index = findById(documents, id);
      const current = documents[index];
      if (current === undefined) throw new Error(`No document ${id} in ${ns}.`);
      documents[index] = {
        ...current,
        touchedBy: "someone else",
        touchedAt: new Date().toISOString(),
      };
    },
    documents: documentsOf,
    entries: () => journal.map((entry) => entry.view),
  };

  return { handlers, controls };

  /** The API view of a connection (needed by the settings route's response). */
  function connectionView(connection: MockConnection): ConnectionView {
    return {
      id: connection.id,
      name: connection.name,
      uri: {
        configured: true,
        preview: connection.uri.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@").split("?")[0] ?? "",
      },
      production: connection.production,
      createdAt: connection.createdAt,
      liveEdits: liveSettingsOf(connection),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The signed-in user's name for journal entries (routes behind a role always have one). */
function usernameOf(user: UserView | undefined): string {
  return user?.username ?? "";
}

/** True when the user holds `data:write` with a role that may use it (operator or admin). */
function canWrite(user: UserView): boolean {
  return roleIncludes(user.role, "operator") && user.permissions.includes("data:write");
}

function isRecord(value: unknown): value is MockDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `_id` as JSON: the mock's stand-in for canonical Extended JSON. */
function idKey(document: MockDocument): string {
  return JSON.stringify(document._id);
}

/**
 * A 64-hex-character version of a document: four 32-bit FNV-1a hashes of its JSON with
 * different seeds. Not cryptographic; the real server uses SHA-256 of the BSON.
 */
export function versionOf(document: MockDocument): string {
  const text = JSON.stringify(document);
  let version = "";
  for (const seed of [0x811c9dc5, 0x01000193, 0x2f2f2f2f, 0x5bd1e995]) {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    version += hash.toString(16).padStart(8, "0").repeat(2);
  }
  return version;
}

/** A document as the browser receives it. */
function liveView(document: MockDocument, editable: boolean): LiveDocument {
  return {
    json: JSON.stringify(document),
    ...("_id" in document ? { id: idKey(document) } : {}),
    ...(editable && "_id" in document ? { version: versionOf(document) } : {}),
  };
}

/** A fresh 24-hex-character ObjectId-like string from a mock id. */
function newObjectId(seed: string): string {
  const digits = seed.replace(/\D/g, "");
  return `6a${digits.padStart(22, "0").slice(-22)}`;
}

/** The value at a dotted path. */
function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

/** A number from a JSON number or a `{"$numberDecimal": "…"}`-style wrapper. */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (isRecord(value)) {
    const inner = Object.values(value)[0];
    if (typeof inner === "string" && inner.trim() !== "" && !Number.isNaN(Number(inner)))
      return Number(inner);
  }
  return undefined;
}

/** The mock's filter matcher; see the file header for what it knows. */
function matches(document: MockDocument, filter: MockDocument): boolean {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === "$and" && Array.isArray(condition)) {
      return condition.every((part) => isRecord(part) && matches(document, part));
    }
    if (field === "$or" && Array.isArray(condition)) {
      return condition.some((part) => isRecord(part) && matches(document, part));
    }
    const value = valueAt(document, field);
    if (
      isRecord(condition) &&
      Object.keys(condition).some((key) => key.startsWith("$") && OPERATORS.has(key))
    ) {
      return Object.entries(condition).every(([operator, operand]) =>
        compare(value, operator, operand),
      );
    }
    return JSON.stringify(value) === JSON.stringify(condition);
  });
}

const OPERATORS = new Set(["$in", "$nin", "$ne", "$eq", "$exists", "$gt", "$gte", "$lt", "$lte"]);

function compare(value: unknown, operator: string, operand: unknown): boolean {
  const same = (candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(value);
  switch (operator) {
    case "$in":
      return Array.isArray(operand) && operand.some(same);
    case "$nin":
      return Array.isArray(operand) && !operand.some(same);
    case "$eq":
      return same(operand);
    case "$ne":
      return !same(operand);
    case "$exists":
      return (value !== undefined) === (operand === true);
    default: {
      const left = numeric(value);
      const right = numeric(operand);
      if (left === undefined || right === undefined) return false;
      if (operator === "$gt") return left > right;
      if (operator === "$gte") return left >= right;
      if (operator === "$lt") return left < right;
      return left <= right;
    }
  }
}

/** Sorts by the given fields (1 ascending, -1 descending), comparing numbers or JSON text. */
function sortDocuments(documents: MockDocument[], sort: MockDocument): MockDocument[] {
  const keys = Object.entries(sort);
  return [...documents].sort((left, right) => {
    for (const [field, direction] of keys) {
      const a = valueAt(left, field);
      const b = valueAt(right, field);
      const na = numeric(a);
      const nb = numeric(b);
      const order =
        na !== undefined && nb !== undefined
          ? na - nb
          : JSON.stringify(a ?? null).localeCompare(JSON.stringify(b ?? null));
      if (order !== 0) return direction === -1 ? -order : order;
    }
    return 0;
  });
}

/** Applies an inclusion (`{"name": 1}`) or exclusion (`{"tags": 0}`) projection. */
function project(document: MockDocument, projection: MockDocument | undefined): MockDocument {
  if (projection === undefined) return document;
  const including = Object.entries(projection).some(([key, value]) => key !== "_id" && value !== 0);
  const result: MockDocument = {};
  for (const [key, value] of Object.entries(document)) {
    const rule = projection[key];
    const keep =
      key === "_id" ? rule !== 0 : including ? rule !== undefined && rule !== 0 : rule !== 0;
    if (keep) result[key] = value;
  }
  return result;
}

/** Applies `$set`, `$unset` and `$inc` (top-level fields) to a copy. */
function applyUpdate(document: MockDocument, update: MockDocument): MockDocument {
  const result: MockDocument = { ...document };
  for (const [operator, fields] of Object.entries(update)) {
    if (!isRecord(fields)) continue;
    for (const [field, value] of Object.entries(fields)) {
      if (operator === "$set") result[field] = value;
      if (operator === "$unset") delete result[field];
      if (operator === "$inc")
        result[field] = (numeric(result[field]) ?? 0) + (numeric(value) ?? 0);
    }
  }
  return result;
}

/** Top-level fields that differ between two documents (the mock's changedFields). */
function changedPaths(before: MockDocument, after: MockDocument): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
