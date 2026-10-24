/**
 * Exporting one collection of a backup as text: JSON Lines (one Extended JSON document
 * per line, like `mongoexport`) or CSV (chosen fields, a header row), for spreadsheets,
 * data warehouses and `mongoimport`.
 *
 *   select + open the backup → stream the namespace's documents → filter? →
 *   format each as a line → batch lines into ~64 KiB chunks → file or Writable
 *
 * Everything streams; memory does not depend on the collection size. A file output must
 * not exist yet (an export never overwrites) and is removed again if the export fails.
 * A Writable output is ended when the export finishes, like any pipeline destination.
 *
 * JSON Lines: `ejson: "relaxed"` (default) writes numbers as plain JSON numbers and dates
 * as ISO strings in `$date`, which most tools read; `"canonical"` keeps every BSON type
 * (`{"$numberInt":"1"}`), so the export can be read back with exactly the same types.
 * With `fields`, documents are projected to those fields (`_id` is kept, as by
 * mongoexport).
 *
 * CSV (RFC 4180 quoting, `\n` line ends): `fields` is required, dotted paths reach into
 * embedded documents (`address.city`) and array elements by index (`items.0.sku`).
 * Values are written as text: strings as is, numbers and booleans plainly, dates as ISO
 * 8601, ObjectIds as their hex string, missing values and null as an empty cell; every
 * other value (embedded documents, arrays, binary data, …) as Extended JSON. A cell is
 * quoted when it contains a comma, a double quote, a line break, or leading or trailing
 * spaces; double quotes inside are doubled. String values starting with `=`, `+`, `-`,
 * `@`, a tab or a carriage return get a leading `'` so spreadsheets never run them as
 * formulas (CSV injection).
 */

import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BSON, type Document, ObjectId } from "mongodb";
import type { EngineContext } from "../engine/context.ts";
import { compileFilter } from "../engine/filter.ts";
import { bsonTag, isDocument } from "../engine/filter-values.ts";
import { matchingDocuments, openNamespace } from "../engine/find.ts";
import { compileProjection, type Projector } from "../engine/find-projection.ts";
import { MongoShieldError } from "../errors.ts";
import type { BackupSelector, DecryptionOptions } from "../types.ts";
import { assertNamespace } from "./read-backup.ts";

/** The text formats `exportDocuments` writes. */
export type TextExportFormat = "jsonl" | "csv";

/** Extended JSON flavour: relaxed (readable) or canonical (type-preserving). */
export type EjsonMode = "relaxed" | "canonical";

/** Options for `exportDocuments`. */
export interface ExportDocumentsOptions {
  /** Which backup: an id, `"latest"`, or `{ before: date }`. */
  readonly backup: BackupSelector;
  /** The collection, `<database>.<collection>`. */
  readonly namespace: string;
  readonly format: TextExportFormat;
  /** Dotted paths. Required for CSV (its columns); for JSON Lines, a projection. */
  readonly fields?: readonly string[];
  /** Only documents matching this MongoDB filter (the subset of engine/filter.ts). */
  readonly filter?: Document;
  /** A file path (must not exist yet) or a stream (ended when done). */
  readonly output: string | Writable;
  /** Extended JSON flavour for JSON Lines and for complex CSV cells. Defaults to `"relaxed"`. */
  readonly ejson?: EjsonMode;
  readonly decryption?: DecryptionOptions;
  readonly signal?: AbortSignal;
}

/** What `exportDocuments` wrote. */
export interface ExportDocumentsResult {
  readonly backupId: string;
  readonly namespace: string;
  readonly format: TextExportFormat;
  /** Documents written (rows, for CSV; the header row is not counted). */
  readonly documents: number;
  /** Bytes written, including the CSV header. */
  readonly bytes: number;
  /** The output path, or `"stream"`. */
  readonly output: string;
  readonly durationMs: number;
}

/** Lines are gathered into chunks of about this size before they are written. */
const CHUNK_BYTES = 64 * 1024;

/**
 * Exports the documents of one backed-up collection as JSON Lines or CSV.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a bad format, fields, filter or
 *   namespace, or an output file that exists; `MS_BACKUP_NOT_FOUND`; key and integrity
 *   errors from reading the backup; `MS_ABORTED`.
 */
export async function exportDocuments(
  context: EngineContext,
  options: ExportDocumentsOptions,
): Promise<ExportDocumentsResult> {
  const startedAt = performance.now();
  assertNamespace(options.namespace);
  const formatter = createFormatter(options);
  const matcher = compileFilter(options.filter ?? {});
  await assertNewFile(options.output);

  const opened = await openNamespace(context, options);
  const totals = { documents: 0, bytes: 0 };
  async function* chunks(): AsyncGenerator<Buffer> {
    let pending: string[] = [];
    let pendingBytes = 0;
    const header = formatter.header();
    if (header !== undefined) {
      pending.push(header);
      pendingBytes += Buffer.byteLength(header);
    }
    for await (const match of matchingDocuments(opened, matcher, options.signal)) {
      const line = formatter.line(match.document);
      pending.push(line);
      pendingBytes += Buffer.byteLength(line);
      totals.documents += 1;
      if (pendingBytes >= CHUNK_BYTES) {
        totals.bytes += pendingBytes;
        yield Buffer.from(pending.join(""));
        pending = [];
        pendingBytes = 0;
      }
    }
    if (pending.length > 0) {
      totals.bytes += pendingBytes;
      yield Buffer.from(pending.join(""));
    }
  }

  await writeOutput(Readable.from(chunks()), options, context);
  const result: ExportDocumentsResult = {
    backupId: opened.manifest.id,
    namespace: options.namespace,
    format: options.format,
    documents: totals.documents,
    bytes: totals.bytes,
    output: typeof options.output === "string" ? options.output : "stream",
    durationMs: Math.round(performance.now() - startedAt),
  };
  context.logger.info("Exported documents", {
    ns: options.namespace,
    format: options.format,
    documents: result.documents,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** A file output must not exist: an export never overwrites. */
async function assertNewFile(output: string | Writable): Promise<void> {
  if (typeof output !== "string") return;
  if (output === "") throw new MongoShieldError("MS_CONFIG_INVALID", "The output path is empty.");
  const existing = await stat(output).catch(() => undefined);
  if (existing !== undefined) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `${output} already exists.`, {
      hint: "Choose a new file name, or delete the old export first.",
    });
  }
}

/** Pipes the chunks into the output; a partly written file is removed on failure. */
async function writeOutput(
  chunks: Readable,
  options: ExportDocumentsOptions,
  context: EngineContext,
): Promise<void> {
  const { output } = options;
  const destination =
    typeof output === "string" ? createWriteStream(output, { flags: "wx" }) : output;
  try {
    await pipeline(chunks, destination, options.signal ? { signal: options.signal } : {});
  } catch (error) {
    if (typeof output === "string") {
      await rm(output, { force: true }).catch((removeError: unknown) => {
        context.logger.warn("Could not remove the partial export", {
          path: output,
          error: String(removeError),
        });
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Turns documents into lines (each ending in `\n`). */
interface LineFormatter {
  /** The CSV header row; `undefined` for JSON Lines. */
  header(): string | undefined;
  line(document: Document): string;
}

function createFormatter(options: ExportDocumentsOptions): LineFormatter {
  const relaxed = validateEjsonMode(options.ejson) === "relaxed";
  const fields = validateFields(options.fields);
  if (options.format === "jsonl") return jsonLinesFormatter(fields, relaxed);
  if (options.format === "csv") {
    if (fields === undefined) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "A CSV export needs the fields to write.", {
        hint: 'Pass fields, e.g. ["_id", "name", "address.city"] (CLI: --fields _id,name,address.city).',
      });
    }
    return csvFormatter(fields, relaxed);
  }
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Unknown text export format "${String(options.format)}".`,
    {
      hint: 'Use "jsonl" or "csv".',
    },
  );
}

function validateEjsonMode(mode: string | undefined): EjsonMode {
  if (mode === undefined || mode === "relaxed" || mode === "canonical") return mode ?? "relaxed";
  throw new MongoShieldError("MS_CONFIG_INVALID", `Unknown Extended JSON mode "${mode}".`, {
    hint: 'Use "relaxed" (readable) or "canonical" (keeps every BSON type).',
  });
}

/** Fields must be non-empty, distinct dotted paths without empty segments or `$`. */
function validateFields(fields: readonly string[] | undefined): readonly string[] | undefined {
  if (fields === undefined) return undefined;
  if (fields.length === 0) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The list of fields is empty.");
  }
  const seen = new Set<string>();
  for (const field of fields) {
    if (field.split(".").some((segment) => segment === "" || segment.startsWith("$"))) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `"${field}" is not a field path.`, {
        hint: "Use dotted paths such as address.city or items.0.sku.",
      });
    }
    if (seen.has(field)) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `The field "${field}" is listed twice.`);
    }
    seen.add(field);
  }
  return fields;
}

function jsonLinesFormatter(
  fields: readonly string[] | undefined,
  relaxed: boolean,
): LineFormatter {
  const project: Projector =
    fields === undefined ? (document) => document : compileProjection(inclusionOf(fields));
  return {
    header: () => undefined,
    line: (document) => `${BSON.EJSON.stringify(project(document), { relaxed })}\n`,
  };
}

/** `["a", "b.c"]` → `{ a: 1, "b.c": 1 }`. */
function inclusionOf(fields: readonly string[]): Document {
  const projection: Document = {};
  for (const field of fields) projection[field] = 1;
  return projection;
}

function csvFormatter(fields: readonly string[], relaxed: boolean): LineFormatter {
  return {
    header: () => `${fields.map(csvCell).join(",")}\n`,
    line: (document) =>
      `${fields.map((field) => csvCell(csvCellText(valueAtPath(document, field), relaxed))).join(",")}\n`,
  };
}

/**
 * The value at a dotted path, or `undefined`. Numeric segments index into arrays;
 * other segments do not descend into arrays (a CSV cell holds one value).
 */
export function valueAtPath(document: Document, path: string): unknown {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isDocument(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

/** A value as the text of one CSV cell (see the file header for the rules). */
export function csvText(value: unknown, relaxed: boolean): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (value instanceof ObjectId) return value.toHexString();
  const tag = bsonTag(value);
  // Numeric wrappers from lossless parsing print their plain value.
  if (tag === "Int32" || tag === "Double" || tag === "Long" || tag === "Decimal128") {
    return String(value);
  }
  return BSON.EJSON.stringify(value, { relaxed });
}

/**
 * Characters that make Excel, LibreOffice and Google Sheets treat a cell as a formula.
 * A string field such as `=HYPERLINK("http://evil", "click")` in exported customer data
 * would otherwise run when someone opens the CSV ("CSV injection", OWASP).
 */
const FORMULA_TRIGGERS = /^[=+\-@\t\r]/;

/**
 * The text of one CSV cell. String values that would start a formula get a leading `'`,
 * which spreadsheets show as plain text. Only strings are protected: a negative number
 * such as -5 is a number, not a formula, and must stay as it is.
 */
export function csvCellText(value: unknown, relaxed: boolean): string {
  const text = csvText(value, relaxed);
  return typeof value === "string" && FORMULA_TRIGGERS.test(text) ? `'${text}` : text;
}

/** Quotes a cell when RFC 4180 (or a spreadsheet trimming spaces) requires it. */
export function csvCell(text: string): string {
  const needsQuotes = /[",\r\n]/.test(text) || text !== text.trim();
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}
