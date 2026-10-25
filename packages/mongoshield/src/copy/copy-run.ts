/**
 * The state of one copy run, and copying one selection of documents with it.
 *
 * `copy.ts` drives the steps; `copy-roots.ts` (root documents, in parts) and the
 * reference following in `copy.ts` both end up in `copyDocuments` here, which reads a
 * selection from the source, notes its references, masks it and writes it.
 */

import type { Document, MongoClient, ReadPreferenceMode, WriteConcernSettings } from "mongodb";
import { BSON } from "mongodb";
import type { ProgressTracker } from "../engine/progress.ts";
import type { WriteMode } from "../engine/restore-documents.ts";
import type { NamespaceMapper } from "../engine/restore-rename.ts";
import { MongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { collectPathValues, type FieldPath, type Mask } from "../mask/index.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { CompiledSubset, ReferenceSets } from "../subset/index.ts";
import type { RestorePlanEntry, SearchIndexRef } from "../types.ts";
import type { CheckpointFile, NamespaceState } from "./copy-checkpoint.ts";
import { copySelection, type SelectionReading } from "./copy-namespace.ts";
import type { CopyEngineOptions, PlannedCopyNamespace } from "./copy-plan.ts";

/** Running totals of one target namespace (several passes may write to it). */
export interface NamespaceCounts {
  documents: number;
  bytes: number;
}

/** Shared state of one copy run. */
export interface CopyRun {
  readonly source: MongoClient;
  readonly target: MongoClient;
  readonly logger: Logger;
  readonly options: CopyEngineOptions;
  readonly insertWorkers: number;
  readonly parallelism: number;
  readonly readPreference: ReadPreferenceMode;
  readonly writeConcern: WriteConcernSettings | undefined;
  readonly bypassDocumentValidation: boolean;
  readonly mask: Mask | undefined;
  readonly subset: CompiledSubset | undefined;
  readonly references: ReferenceSets | undefined;
  readonly renameMapper: NamespaceMapper;
  readonly tracker: ProgressTracker;
  /** Where progress is recorded, when the copy is checkpointed. */
  readonly checkpoint: CheckpointFile | undefined;
  /** This run continues an interrupted copy. */
  readonly resuming: boolean;
  /** Options each target collection has, keyed by target namespace (for index collations). */
  readonly targetOptions: Map<string, Document>;
  readonly counts: Map<string, NamespaceCounts>;
  readonly completed: string[];
  readonly inProgress: Set<string>;
  readonly searchIndexes: {
    readonly created: SearchIndexRef[];
    readonly notCreated: SearchIndexRef[];
  };
  documentsCopied: number;
}

/** The checkpointed state of a namespace, created on first use; `undefined` without a checkpoint. */
export function namespaceState(
  run: CopyRun,
  item: PlannedCopyNamespace,
): NamespaceState | undefined {
  const { entry, spec } = item;
  return run.checkpoint?.namespace(spec.ns, () => ({
    from: spec.ns,
    to: entry.to,
    type: spec.type,
    action: entry.action === "conflict" ? "skip" : entry.action,
    sourceUuid: spec.uuid ?? null,
    targetUuid: null,
    prepared: false,
    ordered: false,
    parts: [],
    rootsDone: false,
    finished: false,
  }));
}

/** One selection of a namespace's source documents, and how to write it. */
export interface DocumentSelection {
  readonly filter: Document;
  readonly reading: SelectionReading;
  readonly mode: WriteMode;
  /** For checkpointed parts: called with each written chunk's last `_id`. */
  readonly onChunkWritten?: ((lastId: unknown) => void) | undefined;
  /**
   * For referenced time series: the followed field, which must hold one value per
   * measurement (see `assertSingleReference`).
   */
  readonly singleReference?: FieldPath | undefined;
}

/** Copies one selection of `item`'s source documents, masking them on the way. */
export async function copyDocuments(
  run: CopyRun,
  item: PlannedCopyNamespace,
  selection: DocumentSelection,
  signal: AbortSignal,
): Promise<void> {
  const { entry, spec } = item;
  const target = entry.to;
  const counts = countsOf(run, target);
  // Several parts of one namespace may run at once, so totals grow by what each
  // call reports since its previous report.
  let reported = { documents: 0, bytes: 0 };
  const addProgress = (documents: number, bytes: number) => {
    counts.documents += documents - reported.documents;
    counts.bytes += bytes - reported.bytes;
    run.documentsCopied += documents - reported.documents;
    reported = { documents, bytes };
    run.tracker.updateNamespace(target, counts.documents, counts.bytes);
  };
  const { database, collection } = splitNamespace(target);
  const result = await copySelection({
    source: run.source,
    spec,
    filter: selection.filter,
    reading: selection.reading,
    readPreference: run.readPreference,
    target: run.target.db(database).collection(collection),
    mode: selection.mode,
    workers: run.insertWorkers,
    bypassDocumentValidation: run.bypassDocumentValidation,
    writeConcern: run.writeConcern,
    signal,
    transformBatch: batchTransform(run, spec.ns, selection.singleReference),
    onProgress: addProgress,
    onChunkWritten: selection.onChunkWritten,
  });
  addProgress(result.documents, result.bytes);
}

/** The running totals of a target namespace. */
export function countsOf(run: CopyRun, target: string): NamespaceCounts {
  const existing = run.counts.get(target);
  if (existing !== undefined) return existing;
  const created = { documents: 0, bytes: 0 };
  run.counts.set(target, created);
  return created;
}

/**
 * How root documents are written. Existing collections (also empty ones kept in
 * fail-if-exists mode) may hold the same `_id` already; only there are duplicates
 * expected and skipped. A resumed namespace too: the interrupted run may have written
 * documents after its last checkpoint.
 */
export function rootWriteMode(entry: RestorePlanEntry, continuing: boolean): WriteMode {
  if (entry.action === "upsert") return "upsert";
  if (entry.action === "insert" || continuing) return "insert-skip-duplicates";
  return "insert-new";
}

/**
 * How referenced documents are written: the same document may be referenced again
 * (it was already copied as a root, or another rule points at it), so duplicates of
 * an `_id` already written are expected and skipped.
 */
export function followWriteMode(entry: RestorePlanEntry): WriteMode {
  return entry.action === "upsert" ? "upsert" : "insert-skip-duplicates";
}

/**
 * What happens to each parsed batch of `ns`: references are noted FIRST, from the
 * unmasked source values (they are used to query the source), then documents are
 * masked in place. `undefined` when there is nothing to do.
 */
function batchTransform(
  run: CopyRun,
  ns: string,
  singleReference: FieldPath | undefined,
): ((documents: Document[]) => Promise<Document[]>) | undefined {
  const namespaceMask = run.mask?.forNamespace(ns);
  const references = run.references;
  const hasReferences = (run.subset?.outgoing(ns).length ?? 0) > 0;
  if (namespaceMask === undefined && !hasReferences && singleReference === undefined) {
    return undefined;
  }
  return async (documents) => {
    if (singleReference !== undefined) {
      for (const document of documents) assertSingleReference(ns, document, singleReference);
    }
    if (hasReferences && references !== undefined) await references.collect(ns, documents);
    if (namespaceMask !== undefined) {
      for (const document of documents) namespaceMask.apply(document);
    }
    return documents;
  };
}

/**
 * A referenced time series measurement must hold ONE value at the followed field.
 * Referenced values are queried in batches and rounds, so a measurement holding two
 * of them could be selected twice, and a time series cannot refuse the second copy
 * (it has no unique `_id`). Stopping is better than a silently duplicated measurement.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID`.
 */
function assertSingleReference(ns: string, document: Document, path: FieldPath): void {
  const values = new Set<string>();
  for (const value of collectPathValues(document, path)) {
    values.add(BSON.EJSON.stringify({ value }, { relaxed: false }));
  }
  if (values.size <= 1) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `A measurement of the time series ${ns} holds ${values.size} values at the followed field ${path.join(".")}; it could be copied once per value.`,
    {
      hint: "Follow a field that holds one value per measurement (e.g. a metaField id), or copy the time series without following into it.",
    },
  );
}
