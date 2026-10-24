/**
 * Reading a converge backup's documents as they were at the END of its window, for
 * `find`, single-document restore, tenant restore and document history.
 *
 * A converge backup holds each collection as dumped (somewhere inside the window)
 * plus every change made during the window; a full restore loads the dump and then
 * replays the changes. Reading the dump alone would show documents changed during
 * the window in an older version, miss documents inserted during it, and show
 * documents deleted during it. This module overlays the window on the dump instead,
 * with replay's rules (find-window-apply.ts), without a server:
 *
 *   pass 1  changes file → DDL events (drop, rename, dropDatabase) → the namespace's
 *           lineage: which namespace held its documents during which part of the
 *           window, and whether the dump is the starting point at all
 *   pass 2  changes file → document events of the lineage → per affected `_id`: the
 *           final document (insert / replace / delete fold into it) or, when the
 *           outcome depends on the dumped version, the updates to apply to it
 *   merge   dump → documents of affected `_id`s get the overlay, the others are
 *           yielded as dumped; then the affected `_id`s that were not in the dump
 *           (inserted during the window) are yielded
 *
 * Lineage, newest first: a drop of the namespace (or of its database) or a rename of
 * it away means the dump does not count, only what happened after; a rename of X into
 * the namespace means its documents came from X, so X's events before the rename
 * (and X's dump) belong to it. The capture records a rename's destination as of the
 * rename when X's dump cannot be trusted (synthesized drop + inserts right after the
 * rename), which this walk handles like any other drop.
 *
 * Memory: only the affected `_id`s are held, never the whole collection. When their
 * events exceed `memoryBytes`, the overlay is split by a hash of the `_id` into
 * several partitions, each read in its own pass over the changes file and the dump
 * (more reading, bounded memory). Documents are yielded in dump order, except that in
 * a split overlay each pass yields one partition, and documents inserted during the
 * window come after the dumped ones.
 */

import { BSON, type Document } from "mongodb";
import { throwIfAborted } from "../errors.ts";
import {
  type ChangesFile,
  collectionEntries,
  type DataFile,
  type Manifest,
} from "../format/manifest.ts";
import type { Logger } from "../logger.ts";
import { splitNamespace } from "../mongo/index.ts";
import {
  type ChangeEvent,
  collectionNamespaceOf,
  needsFullDocument,
  readChangeEvents,
  type StoredChangeEvent,
  type UpdateDescription,
} from "./converge-events.ts";
import { eventsUntil } from "./converge-targets.ts";
import type { MatchedDocument, OpenedNamespace } from "./find.ts";
import { parseBackedUpDocument } from "./find-parse.ts";
import {
  applyDocumentEvent,
  applyUpdateDescription,
  type DocumentState,
  isDocumentEvent,
  replacesDocument,
} from "./find-window-apply.ts";
import { openDocumentStream } from "./read-pipeline.ts";

/**
 * Raw bytes of the namespace's change events held in memory at once before the
 * overlay is split into partitions. Parsed documents take a few times their BSON
 * size, so this keeps the overlay in the low hundreds of megabytes at worst.
 */
export const DEFAULT_WINDOW_MEMORY_BYTES = 64 * 1024 * 1024;

/** Options of {@link documentsAtWindowEnd}. */
export interface WindowReadOptions {
  readonly signal: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  /** See {@link DEFAULT_WINDOW_MEMORY_BYTES}. Mainly for tests. */
  readonly memoryBytes?: number | undefined;
}

/** True when the backup recorded changes that `find` has to overlay. */
export function hasChangeWindow(manifest: Manifest): boolean {
  return (manifest.changes?.events ?? 0) > 0;
}

/**
 * Every document of the opened namespace as it was at the end of the backup window
 * (see the file header), unfiltered. Stopping the iteration closes the open files.
 */
export async function* documentsAtWindowEnd(
  opened: OpenedNamespace,
  options: WindowReadOptions,
): AsyncGenerator<MatchedDocument> {
  const file = opened.manifest.changes;
  if (file === undefined) {
    yield* dumpedDocuments(opened.entry.files, opened, options.signal);
    return;
  }
  const window = new ChangeWindow(opened, file, options.signal);
  const lineage = await window.lineage();
  const base = baseFiles(opened, lineage.base);
  const memoryBytes = options.memoryBytes ?? DEFAULT_WINDOW_MEMORY_BYTES;

  if (!lineage.touched) {
    // No document event reaches this namespace: the dump is the final state.
    yield* dumpedDocuments(base, opened, options.signal);
    return;
  }
  const first = await window.overlay(lineage, { partition: 0, partitions: 1, memoryBytes });
  const partitions =
    first.overflowBytes === undefined ? 1 : Math.ceil(first.overflowBytes / memoryBytes) + 1;
  options.logger?.info("find: applying the changes recorded during the backup window", {
    ns: opened.entry.ns,
    events: lineage.events,
    passes: partitions,
  });

  for (let partition = 0; partition < partitions; partition++) {
    const overlay =
      partitions === 1
        ? first.overlay
        : (
            await window.overlay(lineage, {
              partition,
              partitions,
              memoryBytes: Number.POSITIVE_INFINITY,
            })
          ).overlay;
    yield* mergeWithDump(base, overlay, { partition, partitions }, opened, options.signal);
  }
}

// ---------------------------------------------------------------------------
// Lineage (pass 1)
// ---------------------------------------------------------------------------

/** A part of the window during which `ns` held the documents: event indexes [from, to). */
interface Segment {
  readonly ns: string;
  readonly from: number;
  readonly to: number;
}

/** Where the namespace's documents were during the window. */
interface Lineage {
  readonly segments: readonly Segment[];
  /** The namespace whose dump is the starting point, or undefined: start empty. */
  readonly base: string | undefined;
  /** Events in the window (up to the manifest's end of it). */
  readonly events: number;
  /** True when some document event falls in a segment (else the dump is final). */
  readonly touched: boolean;
}

/** A DDL event that can move or remove a namespace's documents. */
type NamespaceChange =
  | { readonly kind: "drop"; readonly index: number; readonly ns: string }
  | { readonly kind: "dropDatabase"; readonly index: number; readonly db: string }
  | { readonly kind: "rename"; readonly index: number; readonly from: string; readonly to: string };

/** Walks the DDL events newest first (see the file header). */
export function lineageOf(
  namespace: string,
  changes: readonly NamespaceChange[],
  events: number,
): Pick<Lineage, "segments" | "base"> {
  const segments: Segment[] = [];
  let current = namespace;
  let end = events;
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index];
    if (change === undefined) continue;
    const startsFresh =
      (change.kind === "drop" && change.ns === current) ||
      (change.kind === "dropDatabase" && change.db === splitNamespace(current).database) ||
      (change.kind === "rename" && change.from === current && change.to !== current);
    if (startsFresh) {
      segments.push({ ns: current, from: change.index + 1, to: end });
      return { segments, base: undefined };
    }
    if (change.kind === "rename" && change.to === current && change.from !== current) {
      segments.push({ ns: current, from: change.index + 1, to: end });
      current = change.from;
      end = change.index;
    }
  }
  segments.push({ ns: current, from: 0, to: end });
  return { segments, base: current };
}

/** The namespace change an event makes, if any. */
function namespaceChangeOf(event: ChangeEvent, index: number): NamespaceChange | undefined {
  const ns = collectionNamespaceOf(event.ns);
  switch (event.operationType) {
    case "drop":
      return ns === undefined ? undefined : { kind: "drop", index, ns };
    case "dropDatabase":
      return event.ns === undefined ? undefined : { kind: "dropDatabase", index, db: event.ns.db };
    case "rename": {
      const to = collectionNamespaceOf(event.to);
      return ns === undefined || to === undefined
        ? undefined
        : { kind: "rename", index, from: ns, to };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The overlay (pass 2)
// ---------------------------------------------------------------------------

/** What the window did to one `_id`. */
type OverlayEntry =
  /** Its final state no longer depends on the dump (`undefined`: deleted). */
  | { kind: "known"; document: DocumentState }
  /** Updates to apply, in order, to the dumped version. */
  | { kind: "pending"; readonly updates: UpdateDescription[] };

/** Overlay entries by `_id` key (see `idKey`). */
type Overlay = Map<string, OverlayEntry>;

/** Which `_id`s one pass handles. */
interface PartitionPass {
  readonly partition: number;
  readonly partitions: number;
  /** Stop collecting past this many event bytes, and report the total instead. */
  readonly memoryBytes: number;
}

/** One namespace's view of a changes file. */
class ChangeWindow {
  readonly #opened: OpenedNamespace;
  readonly #file: ChangesFile;
  readonly #signal: AbortSignal | undefined;

  constructor(opened: OpenedNamespace, file: ChangesFile, signal: AbortSignal | undefined) {
    this.#opened = opened;
    this.#file = file;
    this.#signal = signal;
  }

  /** The window's events up to the manifest's end of it, numbered. */
  async *#events(): AsyncGenerator<{ readonly index: number; readonly stored: StoredChangeEvent }> {
    const events = readChangeEvents(this.#opened.source, this.#file, this.#signal);
    let index = 0;
    for await (const stored of eventsUntil(events, this.#opened.manifest.consistency.to)) {
      throwIfAborted(this.#signal);
      yield { index, stored };
      index += 1;
    }
  }

  /** Pass 1: the lineage of the opened namespace. */
  async lineage(): Promise<Lineage> {
    const changes: NamespaceChange[] = [];
    const written = new Set<string>();
    let events = 0;
    for await (const { index, stored } of this.#events()) {
      events = index + 1;
      const change = namespaceChangeOf(stored.event, index);
      if (change !== undefined) changes.push(change);
      const ns = collectionNamespaceOf(stored.event.ns);
      if (ns !== undefined && isDocumentEvent(stored.event)) written.add(ns);
    }
    const { segments, base } = lineageOf(this.#opened.entry.ns, changes, events);
    const movedIn = base !== this.#opened.entry.ns;
    const touched = movedIn || segments.some((segment) => written.has(segment.ns));
    return { segments, base, events, touched };
  }

  /**
   * Pass 2: the overlay of one partition. When the collected events pass
   * `memoryBytes`, collecting stops and `overflowBytes` reports the total instead.
   */
  async overlay(
    lineage: Lineage,
    pass: PartitionPass,
  ): Promise<{ overlay: Overlay; overflowBytes: number | undefined }> {
    let overlay: Overlay = new Map();
    let bytes = 0;
    let overflowing = false;
    for await (const { index, stored } of this.#events()) {
      const { event } = stored;
      if (!isDocumentEvent(event) || !inLineage(lineage, event, index)) continue;
      // Replay skips the updates the capture could not record (converge-replay.ts).
      if (needsFullDocument(event)) continue;
      const id: unknown = event.documentKey?._id;
      if (id === undefined) continue;
      const key = idKey(id);
      if (pass.partitions > 1 && partitionOf(key, pass.partitions) !== pass.partition) continue;

      bytes += stored.raw.length;
      if (overflowing) continue;
      if (bytes > pass.memoryBytes) {
        // Too much for one pass: drop what was collected, keep counting for the split.
        overflowing = true;
        overlay = new Map();
        continue;
      }
      addToOverlay(overlay, key, event);
    }
    return { overlay, overflowBytes: overflowing ? bytes : undefined };
  }
}

/** True when the event writes to the namespace that held the documents at its time. */
function inLineage(lineage: Lineage, event: ChangeEvent, index: number): boolean {
  const ns = collectionNamespaceOf(event.ns);
  return lineage.segments.some(
    (segment) => segment.ns === ns && index >= segment.from && index < segment.to,
  );
}

/** Folds one document event into the overlay entry of its `_id`. */
function addToOverlay(overlay: Overlay, key: string, event: ChangeEvent): void {
  const entry = overlay.get(key);
  if (replacesDocument(event)) {
    overlay.set(key, { kind: "known", document: applyDocumentEvent(undefined, event) });
  } else if (entry?.kind === "known") {
    entry.document = applyDocumentEvent(entry.document, event);
  } else if (event.updateDescription !== undefined) {
    if (entry === undefined)
      overlay.set(key, { kind: "pending", updates: [event.updateDescription] });
    else entry.updates.push(event.updateDescription);
  }
}

/** The final state of an `_id`, given its dumped version (`undefined`: not dumped). */
function resolve(entry: OverlayEntry, dumped: DocumentState): DocumentState {
  if (entry.kind === "known") return entry.document;
  let document = dumped;
  for (const update of entry.updates) document = applyUpdateDescription(document, update);
  return document;
}

// ---------------------------------------------------------------------------
// Merging with the dump
// ---------------------------------------------------------------------------

/** The data files of the lineage's base namespace (none when it starts empty). */
function baseFiles(opened: OpenedNamespace, base: string | undefined): readonly DataFile[] {
  if (base === undefined) return [];
  // The opened entry may list fewer parts than the manifest (document history reads
  // only the parts that can hold an `_id`), so it wins for its own namespace.
  if (base === opened.entry.ns) return opened.entry.files;
  const entry = collectionEntries(opened.manifest.namespaces).find(
    (candidate) => candidate.ns === base,
  );
  if (entry === undefined || entry.type === "view") return [];
  return entry.files;
}

/** The dumped documents of some data files, as they are. */
async function* dumpedDocuments(
  files: readonly DataFile[],
  opened: OpenedNamespace,
  signal: AbortSignal | undefined,
): AsyncGenerator<MatchedDocument> {
  for (const file of files) {
    for await (const raw of openDocumentStream(opened.source, file, { signal })) {
      throwIfAborted(signal);
      const bytes = raw as Buffer;
      yield { document: parseBackedUpDocument(bytes), bytes: bytes.length, raw: bytes };
    }
  }
}

/** The dump of one partition with its overlay applied, then the window's new documents. */
async function* mergeWithDump(
  files: readonly DataFile[],
  overlay: Overlay,
  pass: Pick<PartitionPass, "partition" | "partitions">,
  opened: OpenedNamespace,
  signal: AbortSignal | undefined,
): AsyncGenerator<MatchedDocument> {
  for await (const dumped of dumpedDocuments(files, opened, signal)) {
    const id: unknown = dumped.document._id;
    if (id === undefined) {
      if (pass.partition === 0) yield dumped;
      continue;
    }
    if (overlay.size === 0 && pass.partitions === 1) {
      yield dumped;
      continue;
    }
    const key = idKey(id);
    if (pass.partitions > 1 && partitionOf(key, pass.partitions) !== pass.partition) continue;
    const entry = overlay.get(key);
    if (entry === undefined) {
      yield dumped;
      continue;
    }
    // Handled: what is left in the overlay afterwards was not in the dump.
    overlay.delete(key);
    const document = resolve(entry, dumped.document);
    if (document !== undefined) yield sized(document);
  }
  for (const entry of overlay.values()) {
    const document = resolve(entry, undefined);
    if (document !== undefined) yield sized(document);
  }
}

function sized(document: Document): MatchedDocument {
  return { document, bytes: BSON.calculateObjectSize(document) };
}

// ---------------------------------------------------------------------------
// `_id` keys and partitions
// ---------------------------------------------------------------------------

/**
 * A string that is equal for two `_id`s exactly when their BSON encodings are. Events
 * carry the `_id` exactly as the document stores it (same BSON type), so this matches
 * an event to its dumped document.
 */
export function idKey(id: unknown): string {
  return Buffer.from(BSON.serialize({ _id: id })).toString("base64");
}

/** The partition of an `_id` key: a 32-bit FNV-1a hash of it, modulo `partitions`. */
export function partitionOf(key: string, partitions: number): number {
  // FNV-1a: offset basis 2166136261, prime 16777619 (32-bit).
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash % partitions;
}
