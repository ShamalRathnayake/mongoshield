/**
 * The dump phase of a backup: planning each namespace (metadata file + parts) and
 * running every pending part, `parallelism` at a time, across all collections.
 *
 *   plan:  write metadata ─▶ $collStats / $sample ─▶ part keys and `_id` boundaries
 *   run:   pending parts ─▶ pool(parallelism) ─▶ dumpPart ─▶ record result in the plan
 *
 * Plans are plain data with one mutable field per part (`done`), so the same plan
 * serves a fresh run, a checkpoint (backup-checkpoint.ts) and a resumed run. A
 * resumed run rebuilds the plan from its checkpoint instead of planning again:
 * part boundaries must not move between invocations.
 */

import { MongoShieldError } from "../errors.ts";
import { dataFileKey } from "../format/layout.ts";
import type { NamespaceEntry, StoredFile } from "../format/manifest.ts";
import type { CollectionSpec } from "../mongo/index.ts";
import { withEngineSpan } from "../telemetry/engine-spans.ts";
import { ATTRIBUTES, ENGINE_SPANS } from "../telemetry/names.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { BackupOptions } from "../types.ts";
import type { TimeBudget } from "./backup-budget.ts";
import type { CheckpointNamespace, FinishedPart } from "./backup-checkpoint.ts";
import {
  dumpPart,
  type NamespaceDumpContext,
  type PartTarget,
  writeMetadataFile,
} from "./backup-namespace.ts";
import {
  boundsFromBoundaries,
  fromCanonical,
  type PlanReadOptions,
  planCollectionParts,
  toCanonical,
  toPartRange,
} from "./backup-parts.ts";
import { batchSizeFor } from "./backup-reads.ts";
import { mapWithConcurrency } from "./pool.ts";
import type { ProgressTracker } from "./progress.ts";

/** One part of a namespace plan. */
export interface PartState {
  /** Data file key, relative to the backup directory. */
  readonly key: string;
  /** Set once the part is stored (in this or an earlier invocation). */
  done: FinishedPart | undefined;
}

/** Everything needed to dump (or finish dumping) one namespace. */
export interface NamespacePlan {
  readonly ns: string;
  readonly db: string;
  readonly collection: string;
  readonly type: CollectionSpec["type"];
  readonly estimatedDocuments: number;
  /** From `$collStats`, for cursor batch sizes; `undefined` when unknown. */
  readonly averageDocumentBytes: number | undefined;
  readonly metadata: StoredFile;
  /** Interior `_id` boundaries in exact BSON types; `undefined` when not split. */
  readonly boundaries: readonly unknown[] | undefined;
  /** In `_id` order. One for unsplit collections, none for views. */
  readonly parts: PartState[];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Settings for `planNamespace`. */
export interface PlanSettings {
  readonly partSizeBytes: number;
  /** From `caseCollisionSuffixes()` / `reservedNameSuffix()`. */
  readonly uniqueSuffix: string | undefined;
  readonly reads: PlanReadOptions;
  readonly signal: AbortSignal;
}

/**
 * Writes a namespace's metadata file and plans its parts.
 *
 * @throws MongoShieldError from the metadata write.
 */
export async function planNamespace(
  spec: CollectionSpec,
  context: NamespaceDumpContext,
  settings: PlanSettings,
): Promise<NamespacePlan> {
  const metadata = await writeMetadataFile(spec, context, {
    uniqueSuffix: settings.uniqueSuffix,
    signal: settings.signal,
  });
  const { boundaries, averageDocumentBytes } = await planCollectionParts(
    spec,
    settings.partSizeBytes,
    settings.reads,
  );
  const split = boundaries.length > 0;
  const partCount = spec.type === "view" ? 0 : boundaries.length + 1;

  const parts: PartState[] = [];
  for (let index = 0; index < partCount; index++) {
    const key = dataFileKey({
      db: spec.db,
      collection: spec.name,
      compression: context.compression,
      encrypted: context.encryption !== undefined,
      // Unsplit collections keep mongodump's plain `<collection>.bson` name.
      ...(split ? { part: index } : {}),
      ...(settings.uniqueSuffix === undefined ? {} : { uniqueSuffix: settings.uniqueSuffix }),
    });
    parts.push({ key, done: undefined });
  }

  return {
    ns: spec.ns,
    db: spec.db,
    collection: spec.name,
    type: spec.type,
    estimatedDocuments: spec.estimatedDocuments,
    averageDocumentBytes,
    metadata,
    boundaries: split ? boundaries : undefined,
    parts,
  };
}

/** A plan as stored in a checkpoint (boundaries as canonical Extended JSON). */
export function planToCheckpoint(plan: NamespacePlan): CheckpointNamespace {
  return {
    ns: plan.ns,
    db: plan.db,
    collection: plan.collection,
    type: plan.type,
    estimatedDocuments: plan.estimatedDocuments,
    ...(plan.averageDocumentBytes === undefined
      ? {}
      : { averageDocumentBytes: plan.averageDocumentBytes }),
    metadata: plan.metadata,
    ...(plan.boundaries === undefined
      ? {}
      : { boundaries: plan.boundaries.map((value) => toCanonical(value)) }),
    parts: plan.parts.map((part) => ({
      key: part.key,
      ...(part.done === undefined ? {} : { done: part.done }),
    })),
  };
}

/** The inverse of `planToCheckpoint`. */
export function planFromCheckpoint(namespace: CheckpointNamespace): NamespacePlan {
  return {
    ns: namespace.ns,
    db: namespace.db,
    collection: namespace.collection,
    type: namespace.type,
    estimatedDocuments: namespace.estimatedDocuments,
    averageDocumentBytes: namespace.averageDocumentBytes,
    metadata: namespace.metadata,
    boundaries: namespace.boundaries?.map((value) => fromCanonical(value)),
    parts: namespace.parts.map((part) => ({ key: part.key, done: part.done })),
  };
}

/**
 * The manifest entry of a fully dumped namespace. Split parts carry their `_id`
 * range; unsplit collections look exactly as before parts existed.
 */
export function namespaceEntry(plan: NamespacePlan): NamespaceEntry {
  const bounds = plan.boundaries === undefined ? undefined : boundsFromBoundaries(plan.boundaries);
  let documents = 0;
  let bytesRaw = 0;
  const files: NamespaceEntry["files"] = [];
  plan.parts.forEach((part, index) => {
    const done = part.done;
    if (done === undefined) {
      throw new MongoShieldError("MS_INTERNAL", `Part ${part.key} of ${plan.ns} is not finished.`);
    }
    documents += done.documents;
    bytesRaw += done.bytesRaw;
    const partBounds = bounds?.[index];
    files.push({
      key: part.key,
      size: done.size,
      sha256: done.sha256,
      ...(partBounds === undefined ? {} : { range: toPartRange(partBounds) }),
    });
  });
  return {
    ns: plan.ns,
    db: plan.db,
    collection: plan.collection,
    type: plan.type,
    documents,
    bytesRaw,
    files,
    metadata: plan.metadata,
  };
}

/** True when every part of every namespace is stored. */
export function allPartsDone(plans: readonly NamespacePlan[]): boolean {
  return plans.every((plan) => plan.parts.every((part) => part.done !== undefined));
}

/** Finished and total part counts, plus documents and bytes in finished parts. */
export function partTotals(plans: readonly NamespacePlan[]): {
  readonly partsDone: number;
  readonly partsTotal: number;
  readonly documents: number;
  readonly bytesRaw: number;
} {
  let partsDone = 0;
  let partsTotal = 0;
  let documents = 0;
  let bytesRaw = 0;
  for (const plan of plans) {
    for (const part of plan.parts) {
      partsTotal += 1;
      if (part.done === undefined) continue;
      partsDone += 1;
      documents += part.done.documents;
      bytesRaw += part.done.bytesRaw;
    }
  }
  return { partsDone, partsTotal, documents, bytesRaw };
}

// ---------------------------------------------------------------------------
// Running the parts
// ---------------------------------------------------------------------------

/** Options for `runPendingParts`. */
export interface RunPartsOptions {
  readonly parallelism: number;
  readonly query: BackupOptions["query"];
  readonly signal: AbortSignal | undefined;
  /** `undefined` without `maxDurationMs`: every pending part runs. */
  readonly budget: TimeBudget | undefined;
  readonly progress: ProgressTracker;
  /** After each finished part, e.g. to save the checkpoint. Must not throw. */
  readonly onPartDone: () => Promise<void>;
  /** After the last part of a namespace, e.g. converge's `markDumped`. */
  readonly onNamespaceDone: (ns: string) => Promise<void>;
  /** Opens a `mongoshield.backup.namespace` span per part; `undefined` records nothing. */
  readonly telemetry: Telemetry | undefined;
}

/** One pending part, with the bookkeeping of its namespace. */
interface PartJob {
  readonly plan: NamespacePlan;
  readonly index: number;
  readonly namespace: NamespaceRun;
}

/** Live totals of one namespace while its parts run. */
interface NamespaceRun {
  /** Totals of the parts finished so far (in any invocation). */
  documents: number;
  bytes: number;
  /** Running totals of the parts in flight, by part index. */
  readonly running: Map<number, { documents: number; bytes: number }>;
  pending: number;
  startedAt: number;
}

/**
 * Dumps every pending part of `plans`, `parallelism` at a time over all namespaces,
 * recording each result in its plan as soon as it is stored. With a budget, parts
 * that would not fit are left pending.
 *
 * @throws the first part failure (other parts are stopped; finished ones stay recorded).
 */
export async function runPendingParts(
  plans: readonly NamespacePlan[],
  context: NamespaceDumpContext,
  options: RunPartsOptions,
): Promise<void> {
  const jobs: PartJob[] = [];
  for (const plan of plans) {
    const namespace = startNamespace(plan, options.progress);
    plan.parts.forEach((part, index) => {
      if (part.done === undefined) jobs.push({ plan, index, namespace });
    });
    // Views, and namespaces finished by an earlier invocation, are done already.
    if (namespace.pending === 0) await finishNamespace(plan, namespace, context, options);
  }

  // Batch sizes adapt to what was actually read: after the first part of a
  // namespace, its observed average document size replaces the statistics.
  const observedAverage = new Map<string, number>();

  await mapWithConcurrency(
    jobs,
    async (job, _index, signal) => {
      if (options.budget !== undefined && !options.budget.tryStart()) return;
      const { plan, index, namespace } = job;
      const part = plan.parts[index];
      if (part === undefined) return;
      const startedAt = performance.now();
      const live = { documents: 0, bytes: 0 };
      namespace.running.set(index, live);

      // Parts are the unit of work, so the span is per part; for the usual unsplit
      // collection that is exactly one span per namespace.
      const result = await withEngineSpan(
        options.telemetry,
        ENGINE_SPANS.backupNamespace,
        (telemetry) => ({
          ...telemetry.namespaceAttributes(plan.ns),
          [ATTRIBUTES.part]: plan.parts.length > 1 ? index : undefined,
        }),
        async (span) => {
          const dumped = await dumpPart(partTarget(plan, index, observedAverage), context, {
            query: options.query?.[plan.ns],
            signal,
            onCounts: options.progress.enabled
              ? (documents, bytes) => {
                  live.documents = documents;
                  live.bytes = bytes;
                  reportNamespace(plan.ns, namespace, options.progress);
                }
              : undefined,
          });
          span.setAttributes({
            [ATTRIBUTES.documents]: dumped.documents,
            [ATTRIBUTES.bytesRaw]: dumped.bytesRaw,
            [ATTRIBUTES.bytesStored]: dumped.file.size,
          });
          return dumped;
        },
      );

      namespace.running.delete(index);
      part.done = {
        size: result.file.size,
        sha256: result.file.sha256,
        documents: result.documents,
        bytesRaw: result.bytesRaw,
      };
      namespace.documents += result.documents;
      namespace.bytes += result.bytesRaw;
      namespace.pending -= 1;
      if (result.documents > 0) observedAverage.set(plan.ns, result.bytesRaw / result.documents);
      options.budget?.partFinished(performance.now() - startedAt);

      await options.onPartDone();
      if (namespace.pending === 0) await finishNamespace(plan, namespace, context, options);
    },
    { concurrency: options.parallelism, signal: options.signal },
  );
}

/** What `dumpPart` needs to know about part `index` of `plan`. */
function partTarget(
  plan: NamespacePlan,
  index: number,
  observedAverage: ReadonlyMap<string, number>,
): PartTarget {
  const part = plan.parts[index];
  if (part === undefined)
    throw new MongoShieldError("MS_INTERNAL", `${plan.ns} has no part ${index}.`);
  const bounds =
    plan.boundaries === undefined ? undefined : boundsFromBoundaries(plan.boundaries)[index];
  return {
    ns: plan.ns,
    db: plan.db,
    collection: plan.collection,
    key: part.key,
    bounds,
    batchSize: batchSizeFor(observedAverage.get(plan.ns) ?? plan.averageDocumentBytes),
  };
}

/** Announces a namespace to the progress tracker and sets up its live totals. */
function startNamespace(plan: NamespacePlan, progress: ProgressTracker): NamespaceRun {
  const namespace: NamespaceRun = {
    documents: 0,
    bytes: 0,
    running: new Map(),
    pending: 0,
    startedAt: performance.now(),
  };
  for (const part of plan.parts) {
    if (part.done === undefined) {
      namespace.pending += 1;
    } else {
      namespace.documents += part.done.documents;
      namespace.bytes += part.done.bytesRaw;
    }
  }
  progress.startNamespace(plan.ns, plan.type === "view" ? 0 : plan.estimatedDocuments);
  return namespace;
}

/** Sums finished and in-flight parts into one progress update for the namespace. */
function reportNamespace(ns: string, namespace: NamespaceRun, progress: ProgressTracker): void {
  let documents = namespace.documents;
  let bytes = namespace.bytes;
  for (const live of namespace.running.values()) {
    documents += live.documents;
    bytes += live.bytes;
  }
  progress.updateNamespace(ns, documents, bytes);
}

/** Reports a namespace whose parts are all stored. */
async function finishNamespace(
  plan: NamespacePlan,
  namespace: NamespaceRun,
  context: NamespaceDumpContext,
  options: RunPartsOptions,
): Promise<void> {
  options.progress.finishNamespace(plan.ns, namespace.documents, namespace.bytes);
  await options.onNamespaceDone(plan.ns);
  context.logger.info("Backed up namespace", {
    ns: plan.ns,
    type: plan.type,
    parts: plan.parts.length,
    documents: namespace.documents,
    bytesRaw: namespace.bytes,
    bytesStored:
      plan.metadata.size + plan.parts.reduce((sum, part) => sum + (part.done?.size ?? 0), 0),
    durationMs: Math.round(performance.now() - namespace.startedAt),
  });
}
