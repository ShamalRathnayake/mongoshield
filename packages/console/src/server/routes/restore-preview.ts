/**
 * Restore preview: what a restore would change in its target (see src/jobs/preview.ts).
 *
 *   POST /api/restore/preview                  operator (admin for production targets) → job
 *   GET  /api/restore/preview/:id              operator (admin for production targets)
 *   GET  /api/restore/preview/:id/documents    document browser role, same target rule
 *   POST /api/restore/preview/:id/document     document browser role, same target rule
 *
 * Who sees what:
 * - Counts, index and option differences: whoever may plan the restore (the same
 *   rules as `POST /api/restore/plan`, in restore.ts).
 * - `_id` lists and document contents: additionally the document browser's role
 *   (`DOCUMENT_BROWSE_ROLE`), because they are customer data. `documentsVisible` in
 *   the view tells the UI.
 * - A preview into a production target stays admin-only for its whole life; the
 *   connection is looked up again on every request, so marking it production later
 *   also locks its preview.
 *
 * Every start and every read of documents is audited (`restore.preview`,
 * `restore.preview_documents`, `restore.preview_document`) with ids and counts only:
 * never document ids or contents, which may be personal data.
 */

import type { Hono } from "hono";
import {
  DEFAULT_PREVIEW_LIMITS,
  PREVIEW_CATEGORIES,
  type PreviewRecord,
  PreviewStore,
  previewDocument,
  previewJob,
  previewPage,
  resultOf,
} from "../../jobs/preview.ts";
import type { PreviewLimits, RestorePreviewView } from "../../shared/api.ts";
import { recordAudit } from "../audit.ts";
import { hasRole, requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices, Principal } from "../context.ts";
import { forbidden, invalid, notFound } from "../errors.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  oneOf,
  optionalString,
  optionalStringArray,
  queryInt,
  requiredString,
} from "../validate.ts";
import { DOCUMENT_BROWSE_ROLE } from "./backups.ts";
import { authorizeTarget, parseRequest } from "./restore.ts";

/** Largest page of listed `_id`s (as the document browser). */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
/** Longest accepted `_id` (canonical Extended JSON). */
const MAX_ID_LENGTH = 2048;

/** Registers the restore preview routes. `limits` is for tests; the console uses the defaults. */
export function restorePreviewRoutes(
  app: Hono<AppEnv>,
  services: ConsoleServices,
  limits: PreviewLimits = DEFAULT_PREVIEW_LIMITS,
): void {
  const previews = new PreviewStore(services.now);

  app.post("/api/restore/preview", async (c) => {
    const principal = requireRole(c, "operator");
    const { input } = await parseRequest(c, services);
    authorizeTarget(principal, input);
    if (input.filter !== undefined) {
      throw invalid(
        "A preview compares whole collections, not selected documents.",
        "The dry-run plan of a selected-documents restore already counts the documents it would replace.",
      );
    }
    const { spec, outcome } = previewJob(services.tasks, input, principal.user.username, limits);
    const job = await services.runner.start(spec);
    previews.add({
      jobId: job.id,
      storageId: input.storage.id,
      backupId: input.backupId,
      targetConnectionId: input.target.id,
      mode: input.mode,
      createdAt: services.now(),
      outcome,
    });
    await recordAudit(services, {
      actor: principal,
      action: "restore.preview",
      target: input.target.name,
      outcome: "success",
      details: {
        backup: input.backupId,
        storage: input.storage.name,
        mode: input.mode,
        production: input.target.production,
        job: job.id,
      },
    });
    return c.json(job);
  });

  app.get("/api/restore/preview/:id", (c) => {
    const principal = requireRole(c, "operator");
    const record = previews.get(c.req.param("id"));
    authorizeRecord(services, principal, record);
    return c.json(previewView(services, previews, principal, record, limits));
  });

  app.get("/api/restore/preview/:id/documents", async (c) => {
    const principal = requireRole(c, DOCUMENT_BROWSE_ROLE);
    const record = previews.get(c.req.param("id"));
    const target = authorizeRecord(services, principal, record);
    const ns = namespaceQuery(c.req.query("ns"));
    const category = oneOf({ category: c.req.query("category") }, "category", PREVIEW_CATEGORIES);
    const limit = queryInt(c.req.query("limit"), "limit", {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
    const after = queryInt(c.req.query("after"), "after", {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: 0,
    });
    const page = previewPage(resultOf(record), ns, category, limit, after);
    await recordAudit(services, {
      actor: principal,
      action: "restore.preview_documents",
      target: `${record.backupId}/${ns}`,
      outcome: "success",
      details: { connection: target.name, category, documents: page.documents.length },
    });
    return c.json(page);
  });

  app.post("/api/restore/preview/:id/document", async (c) => {
    const principal = requireRole(c, DOCUMENT_BROWSE_ROLE);
    const record = previews.get(c.req.param("id"));
    const target = authorizeRecord(services, principal, record);
    const body = asObject(await readJson(c));
    const ns = namespaceQuery(requiredString(body, "ns", 255));
    const id = requiredString(body, "id", MAX_ID_LENGTH);
    const passphrase = optionalString(body, "passphrase", 1024);
    const identities = optionalStringArray(body, "identities", { maxItems: 20, maxLength: 200 });
    const diff = await previewDocument(
      services.tasks,
      record,
      {
        ns,
        id,
        keys: {
          ...(passphrase === undefined ? {} : { passphrase }),
          ...(identities === undefined ? {} : { identities }),
        },
      },
      c.req.raw.signal,
    );
    // Reading documents of the backup AND of the target: record who looked (not what).
    await recordAudit(services, {
      actor: principal,
      action: "restore.preview_document",
      target: `${record.backupId}/${ns}`,
      outcome: "success",
      details: { connection: target.name, fields: diff.fields.length },
    });
    return c.json(diff);
  });
}

/** `ns` must be given and look like a namespace. */
function namespaceQuery(ns: string | undefined): string {
  if (ns === undefined || ns === "" || ns.length > 255 || !ns.includes(".")) {
    throw invalid('"ns" (the backed-up namespace, e.g. app.users) is required.');
  }
  return ns;
}

/**
 * Applies the restore target rule to a kept preview: production targets need an admin.
 * Returns the target connection; a deleted one makes the preview unreadable (404).
 */
function authorizeRecord(
  services: ConsoleServices,
  principal: Principal,
  record: PreviewRecord,
): { readonly name: string; readonly production: boolean } {
  const target = services.store.current.connections.find(
    (connection) => connection.id === record.targetConnectionId,
  );
  if (target === undefined) throw notFound("The preview's target connection");
  if (target.production && !hasRole(principal.user.role, "admin")) {
    throw forbidden("Only admins may preview restores into a production connection.");
  }
  return target;
}

/** The API view of a kept preview, with its job's current status. */
function previewView(
  services: ConsoleServices,
  previews: PreviewStore,
  principal: Principal,
  record: PreviewRecord,
  limits: PreviewLimits,
): RestorePreviewView {
  const job = services.runner.get(record.jobId);
  const result = record.outcome.result;
  return {
    jobId: record.jobId,
    // The job history is long (500 jobs); a preview outlives it only in odd cases.
    status: job?.status ?? (result === undefined ? "failed" : "succeeded"),
    storageId: record.storageId,
    backupId: record.backupId,
    targetConnectionId: record.targetConnectionId,
    mode: record.mode,
    ...(result === undefined ? {} : { namespaces: result.namespaces }),
    ...(job?.error === undefined ? {} : { error: job.error }),
    documentsVisible: hasRole(principal.user.role, DOCUMENT_BROWSE_ROLE),
    limits,
    expiresAt: previews.expiresAt(record).toISOString(),
  };
}
