/**
 * Backups in a storage location, read through the mongoshield catalog.
 *
 *   GET    /api/storage/:id/backups                         viewer
 *   GET    /api/storage/:id/backups/:backupId               viewer
 *   POST   /api/storage/:id/backups/:backupId/verify        operator → job
 *   POST   /api/storage/:id/backups/:backupId/drill         operator → job (admin for production targets)
 *   POST   /api/storage/:id/backups/:backupId/hold          operator
 *   DELETE /api/storage/:id/backups/:backupId/hold          admin (releasing makes the backup prunable)
 *   GET    /api/storage/:id/backups/:backupId/documents     operator (read-only document browser)
 *   (samples and exports of a backup's documents: browse-extras.ts)
 *
 * The document browser shows customer data, not console metadata, so it needs
 * the operator role (the people who may restore that data anyway) rather than viewer.
 * The restore preview's document lists and diffs need the same role
 * (`DOCUMENT_BROWSE_ROLE`, see restore-preview.ts).
 */

import type { Hono } from "hono";
import { BSON, type Document } from "mongodb";
import { type CatalogEntry, readDrills } from "mongoshield";
import {
  connectionById,
  decryptionFor,
  drillJob,
  shieldFor,
  storageById,
  verifyJob,
} from "../../jobs/tasks.ts";
import type { BackupDetail, BackupSummary, DocumentPage, Role } from "../../shared/api.ts";
import { recordAudit } from "../audit.ts";
import { hasRole, requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { relaxedText } from "../ejson-text.ts";
import { ConsoleError, forbidden, invalid } from "../errors.ts";
import { type EjsonMode, parseEjsonMode } from "../export-format.ts";
import { parseExtendedJsonFilter } from "../filter.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  backupIdParam,
  oneOf,
  optionalPositiveInt,
  queryInt,
  requiredString,
} from "../validate.ts";

/** Who may read documents: the document browser, and the restore preview's drill-down. */
export const DOCUMENT_BROWSE_ROLE: Role = "operator";

/** Largest page of the document browser. */
const MAX_PAGE_SIZE = 100;
/** Default page size. */
const DEFAULT_PAGE_SIZE = 20;
/** Longest accepted page cursor. */
const MAX_CURSOR_LENGTH = 2048;
/** A single browse request may scan a backup for at most this long. */
const BROWSE_TIMEOUT_MS = 60_000;
/** Largest drill sample (the library's own limit). */
const MAX_DRILL_SAMPLE = 10_000;

/** Registers the backup routes. */
export function backupRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store, tasks } = services;

  app.get("/api/storage/:id/backups", async (c) => {
    requireRole(c, "viewer");
    const storage = storageById(store, c.req.param("id"));
    const shield = await shieldFor(tasks, storage);
    const entries = await shield.list({ signal: c.req.raw.signal });
    return c.json(entries.map(backupSummary));
  });

  app.get("/api/storage/:id/backups/:backupId", async (c) => {
    requireRole(c, "viewer");
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const shield = await shieldFor(tasks, storage);
    const entry = (await shield.list({ signal: c.req.raw.signal })).find(
      (candidate) => candidate.id === backupId,
    );
    if (entry === undefined) {
      throw new ConsoleError(404, "MS_BACKUP_NOT_FOUND", `There is no backup "${backupId}".`);
    }
    const drills = await readDrills(shield.storage, backupId);
    const detail: BackupDetail = {
      ...backupSummary(entry),
      ...(entry.manifest === undefined ? {} : { manifest: entry.manifest }),
      drills: drills.map((drill) => ({
        drilledAt: drill.drilledAt,
        ok: drill.ok,
        rtoMs: drill.restoreDurationMs,
        // Upgrade rehearsals (`mongoshield rehearse-upgrade`): the version they proved.
        ...(drill.targetVersion === undefined ? {} : { targetVersion: drill.targetVersion }),
      })),
    };
    return c.json(detail);
  });

  app.post("/api/storage/:id/backups/:backupId/verify", async (c) => {
    const principal = requireRole(c, "operator");
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const body = asObject(await readJson(c));
    const mode = oneOf(body, "mode", ["fast", "deep"]);
    const job = await services.runner.start(
      verifyJob(tasks, storage, backupId, mode, principal.user.username),
    );
    await recordAudit(services, {
      actor: principal,
      action: "backup.verify",
      target: backupId,
      outcome: "success",
      details: { storage: storage.name, mode, job: job.id },
    });
    return c.json(job);
  });

  app.post("/api/storage/:id/backups/:backupId/drill", async (c) => {
    const principal = requireRole(c, "operator");
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const body = asObject(await readJson(c));
    const target = connectionById(store, requiredString(body, "targetConnectionId", 64));
    const sample = optionalPositiveInt(body, "sample", MAX_DRILL_SAMPLE);
    // A drill restores a full copy: on a production deployment that is real load and disk use.
    if (target.production && !hasRole(principal.user.role, "admin")) {
      throw forbidden("Only admins may run drills against a production connection.");
    }
    const job = await services.runner.start(
      drillJob(tasks, storage, backupId, target, sample, principal.user.username),
    );
    await recordAudit(services, {
      actor: principal,
      action: "backup.drill",
      target: backupId,
      outcome: "success",
      details: { storage: storage.name, connection: target.name, job: job.id },
    });
    return c.json(job);
  });

  app.post("/api/storage/:id/backups/:backupId/hold", async (c) => {
    const principal = requireRole(c, "operator");
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const body = asObject(await readJson(c));
    const reason = requiredString(body, "reason", 500);
    const shield = await shieldFor(tasks, storage);
    await shield.hold(backupId, { reason, by: principal.user.username });
    await recordAudit(services, {
      actor: principal,
      action: "backup.hold",
      target: backupId,
      outcome: "success",
      details: { storage: storage.name, reason },
    });
    return c.json({ ok: true as const });
  });

  app.delete("/api/storage/:id/backups/:backupId/hold", async (c) => {
    const principal = requireRole(c, "admin");
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const shield = await shieldFor(tasks, storage);
    await shield.release(backupId);
    await recordAudit(services, {
      actor: principal,
      action: "backup.release",
      target: backupId,
      outcome: "success",
      details: { storage: storage.name },
    });
    return c.json({ ok: true as const });
  });

  app.get("/api/storage/:id/backups/:backupId/documents", async (c) => {
    const principal = requireRole(c, DOCUMENT_BROWSE_ROLE);
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const namespace = c.req.query("ns");
    if (namespace === undefined || namespace === "" || namespace.length > 255) {
      throw invalid('"ns" (the namespace, e.g. app.users) is required.');
    }
    const limit = queryInt(c.req.query("limit"), "limit", {
      min: 1,
      max: MAX_PAGE_SIZE,
      fallback: DEFAULT_PAGE_SIZE,
    });
    const filter = parseExtendedJsonFilter(c.req.query("filter"), "The filter") ?? {};
    const after = parseCursor(c.req.query("after"));
    const ejson = parseEjsonMode(c.req.query("ejson"));
    const shield = await shieldFor(tasks, storage);
    const decryption = decryptionFor(store, storage.id);
    const page = await readPage(
      shield.find({
        backup: backupId,
        namespace,
        filter,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(BROWSE_TIMEOUT_MS)]),
        ...(decryption === undefined ? {} : { decryption }),
      }),
      limit,
      after,
      ejson,
    );
    // Reading backup contents is sensitive: record who looked at what (not the documents).
    await recordAudit(services, {
      actor: principal,
      action: "backup.browse",
      target: `${backupId}/${namespace}`,
      outcome: "success",
      details: { storage: storage.name, documents: page.documents.length },
    });
    return c.json(page);
  });
}

/** A catalog entry as the API's summary. */
function backupSummary(entry: CatalogEntry): BackupSummary {
  const manifest = entry.manifest;
  return {
    id: entry.id,
    status: entry.status,
    startedAt: manifest?.startedAt ?? entry.startedAt.toISOString(),
    ...(manifest === undefined
      ? {}
      : {
          completedAt: manifest.completedAt,
          namespaces: manifest.totals.namespaces,
          documents: manifest.totals.documents,
          bytesStored: manifest.totals.bytesStored,
          encrypted: manifest.encryption !== undefined,
          consistency: manifest.consistency.mode,
          ...(manifest.chain === undefined
            ? {}
            : { kind: "incremental" as const, chainLength: manifest.chain.length }),
          ...(manifest.immutableUntil === undefined
            ? {}
            : { immutableUntil: manifest.immutableUntil }),
        }),
    ...(entry.verification === undefined
      ? {}
      : {
          verification: {
            mode: entry.verification.mode,
            ok: entry.verification.ok,
            verifiedAt: entry.verification.verifiedAt,
          },
        }),
    ...(entry.hold === undefined
      ? {}
      : { hold: { reason: entry.hold.reason, heldAt: entry.hold.heldAt } }),
  };
}

/**
 * Cursors encode the last `_id` of the previous page as canonical Extended JSON,
 * base64url. They are opaque to clients and carry no secret, only a document id
 * the client has already seen.
 */
function encodeCursor(idKey: string): string {
  return Buffer.from(idKey, "utf8").toString("base64url");
}

function parseCursor(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > MAX_CURSOR_LENGTH) throw invalid("The page cursor is too long.");
  return Buffer.from(raw, "base64url").toString("utf8");
}

/** The canonical Extended JSON of a document's `_id`, used to recognise it again. */
function idKeyOf(document: Document): string {
  return BSON.EJSON.stringify(document._id, { relaxed: false });
}

/**
 * Reads one page. Documents come in backup order, which never changes for a
 * backup, so "everything after the document with this `_id`" is a stable cursor
 * whatever type the `_id` has. Iteration stops as soon as the page is full, which
 * closes the storage download. With `ejson: "canonical"` the page also carries every
 * document as canonical Extended JSON (`DocumentPage.canonical`, the JSON view).
 */
async function readPage(
  documents: AsyncIterable<Document>,
  limit: number,
  after: string | undefined,
  ejson: EjsonMode = "relaxed",
): Promise<DocumentPage> {
  let skipping = after !== undefined;
  const page: string[] = [];
  const canonical: string[] = [];
  let lastIdKey: string | undefined;
  let hasMore = false;
  for await (const document of documents) {
    const idKey = idKeyOf(document);
    if (skipping) {
      if (idKey === after) skipping = false;
      continue;
    }
    if (page.length === limit) {
      hasMore = true;
      break;
    }
    // Relaxed, with Int64 values beyond 2^53 kept exact (ejson-text.ts).
    page.push(relaxedText(document));
    if (ejson === "canonical") canonical.push(BSON.EJSON.stringify(document, { relaxed: false }));
    lastIdKey = idKey;
  }
  if (skipping) {
    throw invalid(
      "The page cursor does not match any document.",
      "Start again from the first page.",
    );
  }
  return {
    documents: page,
    ...(ejson === "canonical" ? { canonical } : {}),
    ...(hasMore && lastIdKey !== undefined ? { next: encodeCursor(lastIdKey) } : {}),
  };
}
