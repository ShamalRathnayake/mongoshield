/**
 * Importing a mongodump archive (`mongodump --archive[=file] [--gzip]`) into a
 * MongoShield backup, in one pass over the archive:
 *
 *   bytes → (gunzip) → createArchiveReader → events
 *     prelude         → decide what to import, write every metadata file
 *     document        → the namespace's writer: count → coalesce → compress → (encrypt) → storage
 *                       (time-series buckets are unpacked first; users and roles are
 *                       collected for their entries; oplog entries are converted to
 *                       change events, see import-oplog.ts)
 *     namespaceEnd    → end that writer
 *
 * mongodump interleaves the blocks of several collections, so several namespace
 * writers are open at once, each a `writeStoredFile` pipeline fed through an
 * object-mode PassThrough. Backpressure: when a writer's buffer is full, reading the
 * archive pauses until it drains, so memory stays flat however large the archive.
 * A failure in any writer aborts the others and stops reading.
 */

import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PassThrough, pipeline, Readable, type Transform } from "node:stream";
import { createDecompressor } from "../compression/index.ts";
import type { CapturedWindow } from "../engine/converge-capture.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { NamespaceEntry, StoredFile } from "../format/manifest.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { type ArchiveEvent, type ArchivePreludeEvent, dataCollectionOf } from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { parseDumpMetadata } from "./dump-metadata.ts";
import { AuthzCollector } from "./import-authz.ts";
import { IGNORED_OPLOG_REASON, importOplog } from "./import-oplog.ts";
import { importRole, ORPHAN_BUCKETS_REASON } from "./import-rules.ts";
import {
  caseSuffixesByNamespace,
  type ImportedData,
  type ImportNamespace,
  type ImportTarget,
  namespaceEntry,
  namespaceOf,
  type SkippedNamespace,
  writeImportedData,
  writeImportedMetadata,
} from "./import-target.ts";
import { createBucketUnpacker, timeSeriesSettings } from "./timeseries-buckets.ts";

/** Metadata files written at the same time (they are tiny; this hides storage latency). */
const METADATA_WRITE_CONCURRENCY = 8;

/**
 * Documents buffered per namespace writer before reading pauses. Small, because the
 * coalescer behind it already gathers documents into large chunks.
 */
const WRITER_BUFFER_DOCUMENTS = 64;

/** gzip streams start with the bytes 1F 8B (RFC 1952). */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/** An archive to read: a file path or a byte stream (e.g. stdin). */
export interface ArchiveInput {
  readonly archive: string | Readable;
  /** `true` for `mongodump --gzip` output. Detected from the first bytes when omitted. */
  readonly gzip?: boolean | undefined;
}

/** An opened archive, ready to be parsed. */
export interface OpenedArchive {
  readonly source: Readable;
  readonly transforms: readonly Transform[];
  /** The file's modification time (when mongodump finished), or now for streams. */
  readonly dumpedAt: Date;
}

/** What importing an archive produced. */
export interface ArchiveImportOutcome {
  readonly entries: NamespaceEntry[];
  readonly authzEntries: NamespaceEntry[];
  /** The converted oplog of `mongodump --oplog --archive`, when there was one. */
  readonly window: CapturedWindow | undefined;
  readonly skipped: SkippedNamespace[];
  readonly serverVersion: string | undefined;
  readonly toolVersion: string | undefined;
}

/**
 * Opens an archive file or stream and works out whether it is gzipped.
 *
 * @throws MS_CONFIG_INVALID when the file cannot be read.
 */
export async function openArchive(input: ArchiveInput): Promise<OpenedArchive> {
  let stream: Readable;
  let dumpedAt = new Date();
  if (typeof input.archive === "string") {
    const info = await stat(input.archive).catch((error: unknown) => {
      throw new MongoShieldError("MS_CONFIG_INVALID", `Cannot read the archive ${input.archive}.`, {
        cause: error,
        hint: "Check the path to the file written by `mongodump --archive=<file>`.",
      });
    });
    if (!info.isFile()) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `${input.archive} is not a file.`, {
        hint: "For a dump directory (`mongodump --out`), import it without --archive.",
      });
    }
    dumpedAt = info.mtime;
    stream = createReadStream(input.archive);
  } else {
    stream = input.archive;
  }

  if (input.gzip !== undefined) {
    return { source: stream, transforms: input.gzip ? [createDecompressor("gzip")] : [], dumpedAt };
  }
  const { head, rest } = await peekFirstChunk(stream);
  const isGzip = GZIP_MAGIC.every((value, index) => head[index] === value);
  return { source: rest, transforms: isGzip ? [createDecompressor("gzip")] : [], dumpedAt };
}

/**
 * Reads the archive and writes every selected namespace into `target`.
 *
 * @throws MongoShieldError: `MS_INTEGRITY_FAILED` / `MS_FORMAT_UNSUPPORTED` for a damaged
 *   or foreign archive, storage errors, `MS_ABORTED`.
 */
export async function importArchive(
  archive: OpenedArchive,
  target: ImportTarget,
  filter: NamespaceFilter,
  options: { readonly ignoreOplog: boolean; readonly signal: AbortSignal },
): Promise<ArchiveImportOutcome> {
  const run = new ArchiveImportRun(target, filter, options);
  return run.execute(archive);
}

/** One namespace being imported from the archive. */
interface PlannedNamespace {
  readonly namespace: ImportNamespace;
  readonly metadataFile: StoredFile;
  /** Views have no data file. */
  readonly hasData: boolean;
}

/** An open data writer: documents go into `input`; `done` settles when the file is stored. */
interface NamespaceWriter {
  readonly input: PassThrough;
  readonly done: Promise<ImportedData>;
}

/** The writer of the converted oplog (`mongodump --oplog`): documents are oplog entries. */
interface OplogWriter {
  readonly input: PassThrough;
  readonly done: Promise<CapturedWindow | undefined>;
}

/** State of one archive import; `execute` runs it from start to end. */
class ArchiveImportRun {
  readonly #target: ImportTarget;
  readonly #filter: NamespaceFilter;
  /** Fires on the caller's abort and on the first failure of any writer. */
  readonly #controller = new AbortController();
  readonly #skipped: SkippedNamespace[] = [];
  /** Planned namespaces by data namespace (`db.collection` of their documents). */
  readonly #planned = new Map<string, PlannedNamespace>();
  readonly #writers = new Map<string, NamespaceWriter>();
  /** Data namespaces holding users or roles (`admin.system.users`, `app.$admin.system.roles`, …). */
  readonly #authzNamespaces = new Map<string, "users" | "roles">();
  readonly #authz: AuthzCollector;
  /** The data namespace of the oplog (db "", see archive-format.ts), when it is imported. */
  #oplogKey: string | undefined;
  #oplog: OplogWriter | undefined;
  #prelude: ArchivePreludeEvent | undefined;
  #failure: { readonly error: unknown } | undefined;

  readonly #signal: AbortSignal;
  readonly #ignoreOplog: boolean;

  constructor(
    target: ImportTarget,
    filter: NamespaceFilter,
    options: { readonly ignoreOplog: boolean; readonly signal: AbortSignal },
  ) {
    this.#target = target;
    this.#filter = filter;
    this.#signal = options.signal;
    this.#ignoreOplog = options.ignoreOplog;
    this.#authz = new AuthzCollector(filter);
  }

  async execute(archive: OpenedArchive): Promise<ArchiveImportOutcome> {
    // The caller's abort stops this run like a writer failure does.
    const forwardAbort = () => this.#controller.abort(this.#signal.reason);
    if (this.#signal.aborted) forwardAbort();
    this.#signal.addEventListener("abort", forwardAbort, { once: true });

    const reader = createArchiveReader();
    // Errors anywhere in the chain destroy the reader, so they surface in the loop below.
    pipeline([archive.source, ...archive.transforms, reader], () => {});
    try {
      for await (const event of reader) {
        this.#throwIfFailed();
        await this.#handle(event as ArchiveEvent);
      }
      this.#throwIfFailed();
      const entries = await this.#finishWriters();
      const authzEntries = await this.#authz.write(this.#target, this.#controller.signal);
      const window = await this.#oplog?.done;
      return {
        entries,
        authzEntries,
        window,
        skipped: this.#skipped,
        serverVersion: this.#prelude?.header.serverVersion || undefined,
        toolVersion: this.#prelude?.header.toolVersion || undefined,
      };
    } catch (error) {
      // The first writer failure explains more than its consequences (aborted drains, …).
      const cause = this.#failure?.error ?? error;
      this.#fail(cause);
      reader.destroy();
      // Wait until every writer has stopped, so nothing runs on after we return.
      await Promise.allSettled([
        ...[...this.#writers.values()].map((writer) => writer.done),
        ...(this.#oplog === undefined ? [] : [this.#oplog.done]),
      ]);
      throw cause;
    } finally {
      this.#signal.removeEventListener("abort", forwardAbort);
    }
  }

  async #handle(event: ArchiveEvent): Promise<void> {
    switch (event.kind) {
      case "prelude":
        this.#prelude = event;
        await this.#planFromPrelude(event);
        return;
      case "namespaceStart":
        this.#writerFor(`${event.db}.${event.collection}`);
        return;
      case "document": {
        const key = `${event.db}.${event.collection}`;
        if (key === this.#oplogKey) {
          await this.#write(this.#oplogWriter(), event.document);
          return;
        }
        const authzKind = this.#authzNamespaces.get(key);
        if (authzKind !== undefined) {
          this.#authz.add(authzKind, event.document, `the archive namespace ${key}`);
          return;
        }
        const writer = this.#writerFor(key);
        if (writer !== undefined) await this.#write(writer, event.document);
        return;
      }
      case "namespaceEnd": {
        const key = `${event.db}.${event.collection}`;
        if (key === this.#oplogKey) this.#oplogWriter().input.end();
        else this.#writers.get(key)?.input.end();
        return;
      }
    }
  }

  /** Decides what to import from the prelude and writes the metadata files. */
  async #planFromPrelude(prelude: ArchivePreludeEvent): Promise<void> {
    const selected: Omit<ImportNamespace, "uniqueSuffix">[] = [];
    for (const entry of prelude.collections) {
      if (entry.db === "") {
        // The oplog of `mongodump --oplog` (db "", collection "oplog").
        if (this.#ignoreOplog)
          this.#skipped.push({ ns: entry.collection, reason: IGNORED_OPLOG_REASON });
        else this.#oplogKey = `.${entry.collection}`;
        continue;
      }
      const ns = `${entry.db}.${entry.collection}`;
      const role = importRole(entry.db, entry.collection);
      if (role.kind === "users" || role.kind === "roles") {
        // Filtered per user and role, by their database (import-authz.ts).
        this.#authzNamespaces.set(ns, role.kind);
        continue;
      }
      if (!this.#filter(role.kind === "buckets" ? `${entry.db}.${role.collection}` : ns)) continue;
      if (role.kind !== "namespace") {
        // mongodump never announces bucket data on its own: its collection is missing.
        this.#skipped.push({
          ns,
          reason: role.kind === "skip" ? role.reason : ORPHAN_BUCKETS_REASON,
        });
        continue;
      }
      // An entry without metadata (rare) takes its type from the prelude entry.
      const text =
        entry.metadata === "" && entry.type !== ""
          ? JSON.stringify({ type: entry.type })
          : entry.metadata;
      const metadata = parseDumpMetadata(text, entry.collection, `the archive metadata of ${ns}`);
      selected.push({ db: entry.db, collection: entry.collection, metadata });
    }

    const suffixes = caseSuffixesByNamespace(selected);
    const namespaces: ImportNamespace[] = selected.map((item) => ({
      ...item,
      uniqueSuffix: suffixes.get(namespaceOf(item)),
    }));
    const metadataFiles = await mapWithConcurrency(
      namespaces,
      (namespace, _index, jobSignal) => writeImportedMetadata(this.#target, namespace, jobSignal),
      { concurrency: METADATA_WRITE_CONCURRENCY, signal: this.#controller.signal },
    );
    namespaces.forEach((namespace, index) => {
      const metadataFile = metadataFiles[index];
      if (metadataFile === undefined) return;
      const dataKey = `${namespace.db}.${dataCollectionOf({ collection: namespace.collection, type: namespace.metadata.type })}`;
      this.#planned.set(dataKey, {
        namespace,
        metadataFile,
        hasData: namespace.metadata.type !== "view",
      });
    });
  }

  /** The writer for a data namespace, opened on first use; undefined when it is not imported. */
  #writerFor(dataKey: string): NamespaceWriter | undefined {
    const existing = this.#writers.get(dataKey);
    if (existing !== undefined) return existing;
    const planned = this.#planned.get(dataKey);
    if (planned === undefined || !planned.hasData) return undefined;
    const writer = this.#openWriter(
      planned.namespace,
      new PassThrough({
        objectMode: true,
        highWaterMark: WRITER_BUFFER_DOCUMENTS,
      }),
    );
    this.#writers.set(dataKey, writer);
    return writer;
  }

  #openWriter(namespace: ImportNamespace, input: PassThrough): NamespaceWriter {
    const ns = namespaceOf(namespace);
    this.#target.progress.startNamespace(ns, 0);
    // Time-series data arrives as bucket documents; the backup stores measurements.
    const unpack =
      namespace.metadata.type === "timeseries"
        ? [createBucketUnpacker(timeSeriesSettings(namespace.metadata, ns), ns)]
        : [];
    const done = writeImportedData(this.#target, namespace, input, unpack, this.#controller.signal);
    // Record the first failure and stop everything else; the loop rethrows it.
    done.catch((error: unknown) => this.#fail(error));
    return { input, done };
  }

  /** The oplog's writer, opened on first use. */
  #oplogWriter(): OplogWriter {
    if (this.#oplog !== undefined) return this.#oplog;
    const input = new PassThrough({ objectMode: true, highWaterMark: WRITER_BUFFER_DOCUMENTS });
    const done = importOplog(this.#target, input, [], {
      filter: this.#filter,
      where: "the oplog of the archive",
      signal: this.#controller.signal,
    });
    done.catch((error: unknown) => this.#fail(error));
    this.#oplog = { input, done };
    return this.#oplog;
  }

  /** Hands one document to a writer, waiting while its buffer is full. */
  async #write(writer: { readonly input: PassThrough }, document: Buffer): Promise<void> {
    this.#throwIfFailed();
    if (writer.input.write(document)) return;
    try {
      await once(writer.input, "drain", { signal: this.#controller.signal });
    } catch (error) {
      this.#throwIfFailed();
      throw error;
    }
  }

  /** Waits for every writer and returns the manifest entries, in prelude order. */
  async #finishWriters(): Promise<NamespaceEntry[]> {
    const entries: NamespaceEntry[] = [];
    for (const [dataKey, planned] of this.#planned) {
      let data: ImportedData | undefined;
      if (planned.hasData) {
        // The reader guarantees every announced namespace was seen, so a writer
        // normally exists; an empty file keeps the backup consistent otherwise.
        const writer =
          this.#writers.get(dataKey) ?? this.#openWriter(planned.namespace, endedInput());
        data = await writer.done;
      }
      const entry = namespaceEntry(planned.namespace, planned.metadataFile, data);
      this.#target.progress.finishNamespace(entry.ns, entry.documents, entry.bytesRaw);
      this.#target.logger.info("Imported namespace", {
        ns: entry.ns,
        type: entry.type,
        documents: entry.documents,
        bytesRaw: entry.bytesRaw,
      });
      entries.push(entry);
    }
    return entries;
  }

  #fail(error: unknown): void {
    this.#failure ??= { error };
    if (!this.#controller.signal.aborted) this.#controller.abort(error);
  }

  #throwIfFailed(): void {
    if (this.#failure !== undefined) throw this.#failure.error;
    throwIfAborted(this.#controller.signal);
  }
}

/** An already-ended document stream, for a namespace without documents. */
function endedInput(): PassThrough {
  const input = new PassThrough({ objectMode: true });
  input.end();
  return input;
}

/**
 * Reads the first chunk of a stream (to sniff its format) and returns it with a
 * stream that yields the whole content again, first chunk included.
 */
async function peekFirstChunk(stream: Readable): Promise<{ head: Buffer; rest: Readable }> {
  const iterator: AsyncIterator<unknown> = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  const head = first.done === true ? Buffer.alloc(0) : toBuffer(first.value);
  async function* replay(): AsyncGenerator<Buffer> {
    try {
      if (head.length > 0) yield head;
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        yield toBuffer(next.value);
      }
    } finally {
      // Stopping early (an error downstream) must also close the original stream.
      await iterator.return?.();
    }
  }
  return { head, rest: Readable.from(replay(), { objectMode: false }) };
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk), "utf8");
}
