/**
 * Samples and exports for the document viewer, of live collections and of backups.
 *
 *   GET /api/live/:id/sample?ns=&filter=&size=                         operator  live.browse (sample)
 *   GET /api/live/:id/export?ns=&filter=&projection=&sort=&format=&limit=&ejson=
 *                                                                      operator  live.export
 *   GET /api/storage/:id/backups/:backupId/sample?ns=&filter=&size=    operator  backup.browse (sample)
 *   GET /api/storage/:id/backups/:backupId/export?ns=&filter=&format=&limit=&ejson=
 *                                                                      operator  backup.export
 *
 * A sample feeds the schema and chart views and the filter's field suggestions:
 * `$sample` on a live collection (random), the first documents of a backup (backups are
 * read as a stream, so there is no random access). An export is the viewer's current
 * result as a file (export-format.ts), returned as JSON (`ExportResult`) like the config
 * export, so the browser saves it without a second request.
 *
 * Limits (shared/api.ts): samples read LIVE_SAMPLE_DEFAULT_SIZE documents unless asked,
 * at most LIVE_SAMPLE_MAX_SIZE (LIVE_SAMPLE_SHARED_TIER_MAX_SIZE on Atlas Free/Flex);
 * exports EXPORT_DEFAULT_LIMIT documents, at most EXPORT_MAX_LIMIT and EXPORT_MAX_BYTES.
 * On a live connection one sample or export runs at a time on an Atlas shared tier and a
 * few otherwise (pacing.ts). Every request passes the browser's abort signal on, so
 * leaving the page stops the query on the server or the backup download.
 *
 * The same rules as the document browsers apply: the operator role (customer data),
 * no internal namespaces, no server-side JavaScript in filters, and an audit entry
 * with counts, never contents.
 */

import type { Context, Hono } from "hono";
import type { Document } from "mongodb";
import { connectionById, decryptionFor, shieldFor, storageById } from "../../jobs/tasks.ts";
import {
  type DocumentSample,
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_BYTES,
  EXPORT_MAX_LIMIT,
  type ExportFormat,
  type ExportResult,
  LIVE_SAMPLE_DEFAULT_SIZE,
  LIVE_SAMPLE_MAX_SIZE,
  LIVE_SAMPLE_SHARED_TIER_MAX_SIZE,
} from "../../shared/api.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { invalid } from "../errors.ts";
import {
  collectExport,
  createExportWriter,
  documentText,
  type EjsonMode,
  EXPORT_FORMATS,
  exportFilename,
  parseEjsonMode,
  parseExportFormat,
} from "../export-format.ts";
import { parseExtendedJsonFilter } from "../filter.ts";
import { parseNamespace } from "../live/apply.ts";
import { isSharedTier } from "../live/atlas-tier.ts";
import { FAITHFUL_READ, parseQueryObject, parseSort } from "../live/documents.ts";
import { ConnectionPacer, type PacerOptions } from "../live/pacing.ts";
import { backupIdParam, queryInt } from "../validate.ts";
import { DOCUMENT_BROWSE_ROLE } from "./backups.ts";
import { withDriverErrors } from "./live.ts";

/** A sample may run on the server for at most 10 s (it is a convenience, not a query). */
const SAMPLE_TIMEOUT_MS = 10_000;
/** An export query may run on the server for at most 30 s (the browse query's bound). */
const EXPORT_TIMEOUT_MS = 30_000;
/** Reading a backup for a sample or export stops after 60 s (the backup browser's bound). */
const BACKUP_READ_TIMEOUT_MS = 60_000;
/**
 * Largest number accepted for `size` before capping. Bigger values are refused as
 * nonsense; values between the cap and this are quietly capped (the reply says the size).
 */
const MAX_SIZE_PARAMETER = 1_000_000;
/** Longest backup namespace accepted (MongoDB's own namespace limit). */
const MAX_NAMESPACE_LENGTH = 255;

/** Options of {@link browseExtrasRoutes} (tests shorten the pacing wait). */
export interface BrowseExtrasOptions {
  readonly pacing?: PacerOptions;
}

/** Registers the sample and export routes. */
export function browseExtrasRoutes(
  app: Hono<AppEnv>,
  services: ConsoleServices,
  options: BrowseExtrasOptions = {},
): void {
  const { store, tasks } = services;
  // One pacer for the whole console: it limits samples/exports per connection.
  const pacer = new ConnectionPacer(options.pacing);

  // ---- live collections -------------------------------------------------

  app.get("/api/live/:id/sample", async (c) => {
    const principal = requireRole(c, "operator");
    const connection = connectionById(store, c.req.param("id"));
    const namespace = parseNamespace(c.req.query("ns"));
    const filter = parseQueryObject(c.req.query("filter"), "The filter") ?? {};
    const requested = parseSize(c.req.query("size"));
    const signal = c.req.raw.signal;
    return withDriverErrors(services, connection, async () => {
      const client = await services.live.clients.clientFor(connection);
      const sharedTier = await isSharedTier(client);
      const size = Math.min(
        requested,
        sharedTier ? LIVE_SAMPLE_SHARED_TIER_MAX_SIZE : LIVE_SAMPLE_MAX_SIZE,
      );
      // `$sample` after `$match` samples the matching documents only.
      const pipeline: Document[] = [
        ...(Object.keys(filter).length === 0 ? [] : [{ $match: filter }]),
        { $sample: { size } },
      ];
      const documents = await pacer.run(
        connection.id,
        sharedTier,
        () =>
          client
            .db(namespace.db)
            .collection(namespace.collection)
            .aggregate(pipeline, { maxTimeMS: SAMPLE_TIMEOUT_MS, signal, ...FAITHFUL_READ })
            .toArray(),
        signal,
      );
      const sample: DocumentSample = {
        documents: documents.map((document) => documentText(document, "relaxed")),
        size,
        method: "random",
      };
      // A sample is customer data like a page of documents: audited the same way.
      await recordAudit(services, {
        actor: principal,
        action: "live.browse",
        target: `${connection.name}/${namespace.ns}`,
        outcome: "success",
        details: {
          connection: connection.id,
          documents: documents.length,
          filtered: Object.keys(filter).length > 0,
          sample: true,
        },
      });
      return c.json(sample);
    });
  });

  app.get("/api/live/:id/export", async (c) => {
    const principal = requireRole(c, "operator");
    const connection = connectionById(store, c.req.param("id"));
    const namespace = parseNamespace(c.req.query("ns"));
    const filter = parseQueryObject(c.req.query("filter"), "The filter") ?? {};
    const projection = parseQueryObject(c.req.query("projection"), "The projection");
    const sort = parseSort(c.req.query("sort"));
    const request = exportRequestOf(c);
    const signal = c.req.raw.signal;
    return withDriverErrors(services, connection, async () => {
      const client = await services.live.clients.clientFor(connection);
      const sharedTier = await isSharedTier(client);
      const writer = createExportWriter(request.format, request.ejson, EXPORT_MAX_BYTES);
      const { truncated } = await pacer.run(
        connection.id,
        sharedTier,
        () =>
          collectExport(
            client
              .db(namespace.db)
              .collection(namespace.collection)
              .find(filter, {
                ...(projection === undefined || Object.keys(projection).length === 0
                  ? {}
                  : { projection }),
                ...(sort === undefined ? {} : { sort }),
                // One more than the limit tells whether the export is complete.
                limit: request.limit + 1,
                maxTimeMS: EXPORT_TIMEOUT_MS,
                signal,
                // Exact BSON types, so a canonical export says Double/Long/Int32 correctly.
                ...FAITHFUL_READ,
              }),
            writer,
            request.limit,
          ),
        signal,
      );
      const result = exportResultOf(
        [namespace.ns],
        request.format,
        writer.finish(),
        writer.documents,
        truncated,
      );
      await recordAudit(services, {
        actor: principal,
        action: "live.export",
        target: `${connection.name}/${namespace.ns}`,
        outcome: "success",
        details: {
          connection: connection.id,
          documents: result.documents,
          format: request.format,
          filtered: Object.keys(filter).length > 0,
          truncated,
        },
      });
      return c.json(result);
    });
  });

  // ---- backups --------------------------------------------------------------

  app.get("/api/storage/:id/backups/:backupId/sample", async (c) => {
    const principal = requireRole(c, DOCUMENT_BROWSE_ROLE);
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const namespace = backupNamespace(c.req.query("ns"));
    const filter = parseExtendedJsonFilter(c.req.query("filter"), "The filter") ?? {};
    // No shared-tier rule here: reading a backup does not touch the cluster.
    const size = Math.min(parseSize(c.req.query("size")), LIVE_SAMPLE_MAX_SIZE);
    const shield = await shieldFor(tasks, storage);
    const decryption = decryptionFor(store, storage.id);
    const documents: string[] = [];
    for await (const document of shield.find({
      backup: backupId,
      namespace,
      filter,
      signal: backupSignal(c),
      ...(decryption === undefined ? {} : { decryption }),
    })) {
      documents.push(documentText(document, "relaxed"));
      // Leaving the loop closes the download: nothing past the sample is read.
      if (documents.length >= size) break;
    }
    const sample: DocumentSample = { documents, size, method: "first" };
    await recordAudit(services, {
      actor: principal,
      action: "backup.browse",
      target: `${backupId}/${namespace}`,
      outcome: "success",
      details: {
        storage: storage.name,
        documents: documents.length,
        filtered: Object.keys(filter).length > 0,
        sample: true,
      },
    });
    return c.json(sample);
  });

  app.get("/api/storage/:id/backups/:backupId/export", async (c) => {
    const principal = requireRole(c, DOCUMENT_BROWSE_ROLE);
    const storage = storageById(store, c.req.param("id"));
    const backupId = backupIdParam(c.req.param("backupId"));
    const namespace = backupNamespace(c.req.query("ns"));
    const filter = parseExtendedJsonFilter(c.req.query("filter"), "The filter") ?? {};
    const request = exportRequestOf(c);
    const shield = await shieldFor(tasks, storage);
    const decryption = decryptionFor(store, storage.id);
    const writer = createExportWriter(request.format, request.ejson, EXPORT_MAX_BYTES);
    const { truncated } = await collectExport(
      shield.find({
        backup: backupId,
        namespace,
        filter,
        signal: backupSignal(c),
        ...(decryption === undefined ? {} : { decryption }),
      }),
      writer,
      request.limit,
    );
    const result = exportResultOf(
      [namespace, backupId],
      request.format,
      writer.finish(),
      writer.documents,
      truncated,
    );
    await recordAudit(services, {
      actor: principal,
      action: "backup.export",
      target: `${backupId}/${namespace}`,
      outcome: "success",
      details: {
        storage: storage.name,
        documents: result.documents,
        format: request.format,
        filtered: Object.keys(filter).length > 0,
        truncated,
      },
    });
    return c.json(result);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The `size` of a sample: LIVE_SAMPLE_DEFAULT_SIZE when absent, else a whole number of
 * at least 1 (the caller caps it, and the reply says the size actually used).
 */
function parseSize(raw: string | undefined): number {
  return queryInt(raw, "size", {
    min: 1,
    max: MAX_SIZE_PARAMETER,
    fallback: LIVE_SAMPLE_DEFAULT_SIZE,
  });
}

/** The format, Extended JSON flavour and limit of an export request. */
function exportRequestOf(c: Context<AppEnv>): {
  readonly format: ExportFormat;
  readonly ejson: EjsonMode;
  readonly limit: number;
} {
  return {
    format: parseExportFormat(c.req.query("format")),
    ejson: parseEjsonMode(c.req.query("ejson")),
    limit: queryInt(c.req.query("limit"), "limit", {
      min: 1,
      max: EXPORT_MAX_LIMIT,
      fallback: EXPORT_DEFAULT_LIMIT,
    }),
  };
}

/** The reply of an export. */
function exportResultOf(
  nameParts: readonly string[],
  format: ExportFormat,
  content: string,
  documents: number,
  truncated: boolean,
): ExportResult {
  return {
    filename: exportFilename(nameParts, format),
    contentType: EXPORT_FORMATS[format].contentType,
    content,
    documents,
    truncated,
  };
}

/**
 * A backup namespace from the query, checked like the backup document browser does
 * (the library refuses namespaces the backup does not contain).
 */
function backupNamespace(raw: string | undefined): string {
  if (raw === undefined || raw === "" || raw.length > MAX_NAMESPACE_LENGTH) {
    throw invalid('"ns" (the namespace, e.g. app.users) is required.');
  }
  return raw;
}

/** Stops reading a backup when the browser goes away, or after the read timeout. */
function backupSignal(c: Context<AppEnv>): AbortSignal {
  return AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(BACKUP_READ_TIMEOUT_MS)]);
}
