/**
 * Importing a mongodump archive (`mongodump --archive[=file] [--gzip]`) into a
 * MongoShield backup, in one pass over the archive:
 *
 *   bytes → (gunzip) → createArchiveReader → events
 *     prelude         → decide what to import, write every metadata file
 *     document        → the namespace's writer: count → coalesce → compress → (encrypt) → storage
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
import { mapWithConcurrency } from "../engine/pool.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { NamespaceEntry, StoredFile } from "../format/manifest.ts";
import type { NamespaceFilter } from "../mongo/index.ts";
import { type ArchiveEvent, type ArchivePreludeEvent, dataCollectionOf } from "./archive-format.ts";
import { createArchiveReader } from "./archive-reader.ts";
import { parseDumpMetadata } from "./dump-metadata.ts";
import { skipReason } from "./import-rules.ts";
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
  signal: AbortSignal,
): Promise<ArchiveImportOutcome> {
  const run = new ArchiveImportRun(target, filter, signal);
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
  #prelude: ArchivePreludeEvent | undefined;
  #failure: { readonly error: unknown } | undefined;

  readonly #signal: AbortSignal;

  constructor(target: ImportTarget, filter: NamespaceFilter, signal: AbortSignal) {
    this.#target = target;
    this.#filter = filter;
    this.#signal = signal;
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
      return {
        entries,
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
      await Promise.allSettled([...this.#writers.values()].map((writer) => writer.done));
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
        const writer = this.#writerFor(`${event.db}.${event.collection}`);
        if (writer !== undefined) await this.#write(writer, event.document);
        return;
      }
      case "namespaceEnd":
        this.#writers.get(`${event.db}.${event.collection}`)?.input.end();
        return;
    }
  }

  /** Decides what to import from the prelude and writes the metadata files. */
  async #planFromPrelude(prelude: ArchivePreludeEvent): Promise<void> {
    const selected: Omit<ImportNamespace, "uniqueSuffix">[] = [];
    for (const entry of prelude.collections) {
      if (entry.db === "") {
        this.#skipped.push({
          ns: entry.collection,
          reason: "oplog from `mongodump --oplog`; replaying it is not supported",
        });
        continue;
      }
      const ns = `${entry.db}.${entry.collection}`;
      if (!this.#filter(ns)) continue;
      // An entry without metadata (rare) takes its type from the prelude entry.
      const text =
        entry.metadata === "" && entry.type !== ""
          ? JSON.stringify({ type: entry.type })
          : entry.metadata;
      const metadata = parseDumpMetadata(text, entry.collection, `the archive metadata of ${ns}`);
      const reason = skipReason(entry.collection, metadata.type);
      if (reason !== undefined) {
        this.#skipped.push({ ns, reason });
        continue;
      }
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
    this.#target.progress.startNamespace(namespaceOf(namespace), 0);
    const done = writeImportedData(this.#target, namespace, input, [], this.#controller.signal);
    // Record the first failure and stop everything else; the loop rethrows it.
    done.catch((error: unknown) => this.#fail(error));
    return { input, done };
  }

  /** Hands one document to a writer, waiting while its buffer is full. */
  async #write(writer: NamespaceWriter, document: Buffer): Promise<void> {
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
