/**
 * Turning documents into the text of an export file (JSON, JSON Lines or CSV), for
 * `GET /api/live/:id/export` and `GET /api/storage/:id/backups/:backupId/export`.
 *
 * Everything here is pure: no MongoDB, no storage, no HTTP. The routes
 * (routes/browse-extras.ts) read the documents and feed them to an {@link ExportWriter}
 * through {@link collectExport}, which stops at the document limit and at the byte cap.
 *
 * The formats:
 *
 *   json   `[\n` + one document per line, joined by `,\n` + `\n]` (an empty export is `[]`)
 *   jsonl  one document per line, each line ending in `\n`
 *          (both relaxed Extended JSON, or canonical with `ejson=canonical`)
 *   csv    RFC 4180: a header row of field paths, then one row per document, CRLF line
 *          endings, cells quoted when they contain a comma, a quote, CR or LF (quotes
 *          doubled). Columns are the union of every document's field paths, in the order
 *          they first appear. Nested plain objects are flattened (`address.city`); BSON
 *          values stay one cell (see {@link csvValue}); arrays are one cell of JSON text.
 *
 * CSV formula injection: spreadsheets run a cell that starts with `=`, `+`, `-` or `@`
 * (and some also after a leading TAB or CR) as a formula, so a document field like
 * `=HYPERLINK("http://evil", "click")` would become a live link, or worse, when the
 * file is opened. Such text cells get a leading `'`, which spreadsheets show as "this is
 * text" (OWASP's recommendation). Numbers are not text and are left alone, so `-5` stays
 * a number the spreadsheet can add up.
 */

import { BSON, type Document } from "mongodb";
import type { ExportFormat } from "../shared/api.ts";
import { relaxedText } from "./ejson-text.ts";
import { invalid } from "./errors.ts";

/** Which Extended JSON flavour a document is written in. */
export type EjsonMode = "relaxed" | "canonical";

/** The file extension and media type of each export format. */
export const EXPORT_FORMATS: Readonly<
  Record<ExportFormat, { readonly extension: string; readonly contentType: string }>
> = {
  json: { extension: "json", contentType: "application/json;charset=utf-8" },
  jsonl: { extension: "jsonl", contentType: "application/x-ndjson;charset=utf-8" },
  csv: { extension: "csv", contentType: "text/csv;charset=utf-8" },
};

/** Longest file name suggested to the browser (well below every file system's 255). */
const MAX_FILENAME_LENGTH = 200;

/** Characters a spreadsheet may treat as the start of a formula (see the file header). */
const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Cells that need RFC 4180 quoting: a comma, a double quote, CR or LF anywhere. */
const NEEDS_QUOTES = /[",\r\n]/;

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

/**
 * Parses the `ejson` query parameter: `relaxed` (the default when absent) or
 * `canonical`. Anything else is a `400`.
 */
export function parseEjsonMode(raw: string | undefined): EjsonMode {
  if (raw === undefined || raw === "" || raw === "relaxed") return "relaxed";
  if (raw === "canonical") return "canonical";
  throw invalid('"ejson" must be "relaxed" or "canonical".');
}

/** Parses the `format` query parameter (`json` when absent); anything else is a `400`. */
export function parseExportFormat(raw: string | undefined): ExportFormat {
  if (raw === undefined || raw === "") return "json";
  if (raw === "json" || raw === "jsonl" || raw === "csv") return raw;
  throw invalid('"format" must be "json", "jsonl" or "csv".');
}

/**
 * A safe file name for an export: the parts joined with dots, plus the format's
 * extension. Anything other than letters, digits, `.`, `_` and `-` becomes `_`, so a
 * collection name can never smuggle a path (`../`) or a header-breaking character
 * into the browser's "save as" dialog.
 *
 *   exportFilename(["shop", "orders"], "csv") → "shop.orders.csv"
 */
export function exportFilename(parts: readonly string[], format: ExportFormat): string {
  const base = parts
    .join(".")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // A leading dot would make a hidden file on Unix.
    .replace(/^\.+/, "_")
    .slice(0, MAX_FILENAME_LENGTH);
  return `${base === "" ? "export" : base}.${EXPORT_FORMATS[format].extension}`;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

/** Builds the text of one export, refusing documents that would go over the byte cap. */
export interface ExportWriter {
  /**
   * Adds a document. Returns `false`, and adds nothing, when the export would then be
   * larger than its byte cap: the caller stops there and reports `truncated`.
   */
  add(document: Document): boolean;
  /** How many documents were added. */
  readonly documents: number;
  /** The file's text. */
  finish(): string;
}

/**
 * A writer for one format.
 *
 * @param format json, jsonl or csv.
 * @param ejson the Extended JSON flavour of json/jsonl documents and of CSV cells that
 *   hold JSON text (arrays and uncommon BSON types).
 * @param maxBytes the most UTF-8 bytes the finished text may have.
 */
export function createExportWriter(
  format: ExportFormat,
  ejson: EjsonMode,
  maxBytes: number,
): ExportWriter {
  return format === "csv" ? csvWriter(ejson, maxBytes) : jsonWriter(format, ejson, maxBytes);
}

/**
 * Feeds documents to a writer until the source ends, `limit` documents were added, or
 * the writer refuses one (byte cap). Breaking out of the loop closes the source (a
 * MongoDB cursor or a backup download), so nothing more is read than needed.
 *
 * @returns `truncated: true` when documents were left out (the source had more).
 */
export async function collectExport(
  source: AsyncIterable<Document>,
  writer: ExportWriter,
  limit: number,
): Promise<{ readonly truncated: boolean }> {
  for await (const document of source) {
    // One document past the limit proves there were more: that is a truncated export.
    if (writer.documents >= limit || !writer.add(document)) return { truncated: true };
  }
  return { truncated: false };
}

/** A document as one line of Extended JSON. */
export function documentText(document: unknown, ejson: EjsonMode): string {
  // Relaxed text keeps Int64 values beyond 2^53 exact (ejson-text.ts).
  return ejson === "relaxed"
    ? relaxedText(document)
    : BSON.EJSON.stringify(document, { relaxed: false });
}

/** The writer of `json` and `jsonl` (see the file header for the layout). */
function jsonWriter(format: "json" | "jsonl", ejson: EjsonMode, maxBytes: number): ExportWriter {
  const lines: string[] = [];
  // Bytes of the finished text so far, framing included (computed as lines are added).
  let bytes = 0;
  return {
    get documents() {
      return lines.length;
    },
    add(document) {
      const line = documentText(document, ejson);
      const lineBytes = Buffer.byteLength(line, "utf8");
      // json: the first line adds "[\n" and "\n]" (4 bytes), every later one ",\n" (2).
      // jsonl: every line adds its "\n" (1).
      const framing = format === "jsonl" ? 1 : lines.length === 0 ? 4 : 2;
      if (bytes + lineBytes + framing > maxBytes) return false;
      lines.push(line);
      bytes += lineBytes + framing;
      return true;
    },
    finish() {
      if (format === "jsonl") return lines.map((line) => `${line}\n`).join("");
      return lines.length === 0 ? "[]" : `[\n${lines.join(",\n")}\n]`;
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * The CSV writer. Rows are kept as already-escaped cells per column path; the header
 * (the union of all paths) is only known at the end, so the size check accounts for the
 * empty cells that new columns add to earlier rows:
 *
 *   total = header + Σ cell bytes + rows × (columns − 1 commas + 2 bytes of CRLF)
 */
function csvWriter(ejson: EjsonMode, maxBytes: number): ExportWriter {
  /** Column path → its index, in order of first appearance. */
  const columns = new Map<string, number>();
  /** Each row: escaped cell text by column index. */
  const rows: Map<number, string>[] = [];
  let headerBytes = 0;
  let cellBytes = 0;
  return {
    get documents() {
      return rows.length;
    },
    add(document) {
      const cells = flattenDocument(document, ejson);
      // What the totals would be with this row: new columns, their header cells.
      let newColumns = 0;
      let newHeaderBytes = 0;
      let rowBytes = 0;
      for (const [path, cell] of cells) {
        if (!columns.has(path)) {
          newColumns += 1;
          newHeaderBytes += Buffer.byteLength(csvEscape(path, true), "utf8");
        }
        rowBytes += Buffer.byteLength(cell, "utf8");
      }
      const columnCount = columns.size + newColumns;
      const separators = Math.max(columnCount - 1, 0) + 2;
      // The header row has its own commas and CRLF.
      const total =
        headerBytes +
        newHeaderBytes +
        separators +
        cellBytes +
        rowBytes +
        (rows.length + 1) * separators;
      if (total > maxBytes) return false;

      const row = new Map<number, string>();
      for (const [path, cell] of cells) {
        let index = columns.get(path);
        if (index === undefined) {
          index = columns.size;
          columns.set(path, index);
        }
        row.set(index, cell);
      }
      rows.push(row);
      headerBytes += newHeaderBytes;
      cellBytes += rowBytes;
      return true;
    },
    finish() {
      if (rows.length === 0) return "";
      const width = columns.size;
      const header = [...columns.keys()].map((path) => csvEscape(path, true)).join(",");
      const lines = [header];
      for (const row of rows) {
        lines.push(Array.from({ length: width }, (_, index) => row.get(index) ?? "").join(","));
      }
      return lines.map((line) => `${line}\r\n`).join("");
    },
  };
}

/**
 * A document's cells: dotted field path → escaped cell text, in field order. Plain
 * objects are walked into; an empty one is a cell `{}` (otherwise the field would
 * vanish from the file).
 */
export function flattenDocument(document: Document, ejson: EjsonMode): Map<string, string> {
  const cells = new Map<string, string>();
  const walk = (value: unknown, path: string): void => {
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0 && path !== "") {
        cells.set(path, csvEscape("{}", false));
        return;
      }
      for (const [key, child] of entries) walk(child, path === "" ? key : `${path}.${key}`);
      return;
    }
    const cell = csvValue(value, ejson);
    cells.set(path, csvEscape(cell.text, cell.text !== "" && !cell.numeric));
  };
  walk(document, "");
  return cells;
}

/**
 * One value as the text of a CSV cell, and whether it is a number (numbers skip the
 * formula guard). Missing and `null` values are empty cells.
 *
 *   ObjectId → hex             Date → ISO 8601        Decimal128, Long → their digits
 *   Int32, Double, numbers → their value             Binary (and UUID) → base64
 *   arrays → JSON text         booleans, strings → as they are
 *   anything else (Timestamp, regular expressions, MinKey, …) → its Extended JSON text
 */
export function csvValue(
  value: unknown,
  ejson: EjsonMode,
): { readonly text: string; readonly numeric: boolean } {
  if (value === undefined || value === null) return { text: "", numeric: false };
  if (typeof value === "string") return { text: value, numeric: false };
  if (typeof value === "boolean") return { text: String(value), numeric: false };
  if (typeof value === "number" || typeof value === "bigint") {
    return { text: String(value), numeric: true };
  }
  if (value instanceof Date) {
    // An invalid date has no ISO form; its Extended JSON text says what it is.
    return Number.isNaN(value.getTime())
      ? { text: documentText(value, ejson), numeric: false }
      : { text: value.toISOString(), numeric: false };
  }
  if (value instanceof Uint8Array) {
    // A Node.js Buffer: binary data read without the driver's Binary wrapper.
    return { text: Buffer.from(value).toString("base64"), numeric: false };
  }
  // BSON classes are recognised by their `_bsontype` tag rather than `instanceof`, so
  // values built by another copy of the bson package (the library's) are still recognised.
  switch (bsonTypeOf(value)) {
    case "ObjectId":
      return { text: (value as BSON.ObjectId).toHexString(), numeric: false };
    case "Int32":
    case "Double":
    case "Long":
    case "Decimal128":
      return { text: String(value), numeric: true };
    case "Binary":
      return { text: (value as BSON.Binary).toString("base64"), numeric: false };
    default:
      return { text: documentText(value, ejson), numeric: false };
  }
}

/** The `_bsontype` tag of a BSON class instance (`"ObjectId"`, `"Long"`, …), if any. */
function bsonTypeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const tag: unknown = Reflect.get(value, "_bsontype");
  return typeof tag === "string" ? tag : undefined;
}

/**
 * Escapes one cell: the formula guard first (when `guard`), then RFC 4180 quoting.
 *
 *   csvEscape('say "hi", ok', true) → '"say ""hi"", ok"'
 *   csvEscape("=SUM(A1)", true)     → "'=SUM(A1)"
 */
export function csvEscape(text: string, guard: boolean): string {
  const safe = guard && FORMULA_START.has(text.charAt(0)) ? `'${text}` : text;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** True for objects built by JSON/EJSON parsing or the driver (not arrays, not BSON classes). */
function isPlainObject(value: unknown): value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
