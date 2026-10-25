/**
 * Copying ROOT documents (everything, or a subset filter's matches) in parts, and what
 * a resumed copy does with the parts an interrupted run left behind.
 *
 *   not checkpointed   one query per namespace, natural order (the cheapest read)
 *   checkpointed       parts by `_id`, like a backup's (`engine/backup-parts.ts`):
 *                        whole collection   split into ~256 MiB `_id` ranges, read in
 *                                           parallel through the `_id` index
 *                        filtered           one range, read in `_id` order (the planner
 *                                           may use an index on the filter)
 *                        no `_id` index     one unordered part (time series, clustered):
 *                                           an unfinished one is copied again whole
 *                      each part records the last `_id` of every written chunk
 *
 * Resuming a part continues at its last checkpointed `_id` (inclusive, through the
 * `_id` index), skipping duplicates: documents written after the last checkpoint are
 * already there. The part boundaries come from the checkpoint, never from a new
 * sample, so the ranges are exactly the first run's.
 */

import { ReadPreference } from "mongodb";
import {
  boundsFromBoundaries,
  canSplit,
  DEFAULT_PART_SIZE_BYTES,
  planCollectionParts,
} from "../engine/backup-parts.ts";
import { mapWithConcurrency } from "../engine/pool.ts";
import type { NamespaceState, PartState } from "./copy-checkpoint.ts";
import { partBound, storedBound } from "./copy-checkpoint.ts";
import { collectSelection, type SelectionReading, UNORDERED_READING } from "./copy-namespace.ts";
import type { PlannedCopyNamespace } from "./copy-plan.ts";
import { type CopyRun, copyDocuments, namespaceState, rootWriteMode } from "./copy-run.ts";

/** One part of one namespace's root documents. */
interface RootPart {
  readonly item: PlannedCopyNamespace;
  /** Its checkpointed state; `undefined` when the copy is not checkpointed. */
  readonly state: NamespaceState | undefined;
  readonly part: PartState | undefined;
}

/** Referenced values noted per `collect` call while re-reading copied documents. */
const COLLECT_BATCH = 1000;

/**
 * Copies the root documents of every namespace that has some (all but the purely
 * referenced ones), `parallelism` parts at a time.
 */
export async function copyRoots(
  run: CopyRun,
  roots: readonly PlannedCopyNamespace[],
): Promise<void> {
  const signal = run.options.signal;
  const planned = await mapWithConcurrency(roots, (item) => planRootParts(run, item), {
    concurrency: run.parallelism,
    signal,
  });
  await run.checkpoint?.flush();
  await mapWithConcurrency(
    planned.flat(),
    (part, _index, jobSignal) => copyRootPart(run, part, jobSignal),
    { concurrency: run.parallelism, signal },
  );
}

/**
 * The parts still to copy of one namespace, planning them on its first run.
 * Nothing for namespaces whose roots are all copied.
 */
async function planRootParts(run: CopyRun, item: PlannedCopyNamespace): Promise<RootPart[]> {
  const state = namespaceState(run, item);
  if (state === undefined) return [{ item, state, part: undefined }];
  if (state.rootsDone || item.entry.resume === "done") return [];
  if (state.parts.length === 0) {
    state.ordered = canSplit(item.spec);
    state.parts = await planParts(run, item, state.ordered);
    run.checkpoint?.save();
  }
  return state.parts.filter((part) => !part.done).map((part) => ({ item, state, part }));
}

/** See the file header. */
async function planParts(
  run: CopyRun,
  item: PlannedCopyNamespace,
  ordered: boolean,
): Promise<PartState[]> {
  const filtered = run.subset?.filters.has(item.spec.ns) === true;
  if (!ordered || filtered) return [{ lower: null, upper: null, last: null, done: false }];
  const partSize = run.options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
  const { boundaries } = await planCollectionParts(item.spec, partSize, {
    client: run.source,
    readPreference: new ReadPreference(run.readPreference),
    logger: run.logger,
    signal: run.options.signal,
  });
  return boundsFromBoundaries(boundaries).map((bounds) => ({
    lower: storedBound(bounds.lower),
    upper: storedBound(bounds.upper),
    last: null,
    done: false,
  }));
}

/** Copies one part, recording its progress chunk by chunk when checkpointed. */
async function copyRootPart(run: CopyRun, root: RootPart, signal: AbortSignal): Promise<void> {
  const { item, state, part } = root;
  const continuing = item.entry.resume === "partial";
  await copyDocuments(
    run,
    item,
    {
      filter: run.subset?.filters.get(item.spec.ns) ?? {},
      reading: readingOf(state, part),
      mode: rootWriteMode(item.entry, continuing),
      onChunkWritten:
        state?.ordered === true && part !== undefined
          ? (lastId) => {
              part.last = storedBound({ value: lastId });
              run.checkpoint?.save();
            }
          : undefined,
    },
    signal,
  );
  if (state === undefined || part === undefined) return;
  part.done = true;
  if (state.parts.every((candidate) => candidate.done)) state.rootsDone = true;
  run.checkpoint?.save();
}

/** How a part is read: from its last checkpointed `_id` when it has one. */
function readingOf(
  state: NamespaceState | undefined,
  part: PartState | undefined,
): SelectionReading {
  if (state === undefined || part === undefined || !state.ordered) return UNORDERED_READING;
  return { ordered: true, lower: partBound(part.last ?? part.lower), upper: partBound(part.upper) };
}

/**
 * Notes the references of the root documents the interrupted run already copied.
 *
 * Reference sets live in temporary collections that are dropped when a copy fails
 * (they hold unmasked source values), so a resumed copy rebuilds them: from the
 * documents copied before (re-read here from the source, not written again), and from
 * the documents it copies now (noted as usual). Unordered namespaces are copied again
 * whole and need nothing here.
 */
export async function collectCopiedReferences(
  run: CopyRun,
  roots: readonly PlannedCopyNamespace[],
): Promise<void> {
  const references = run.references;
  if (references === undefined) return;
  const ranges: { item: PlannedCopyNamespace; reading: SelectionReading }[] = [];
  for (const item of roots) {
    if ((run.subset?.outgoing(item.spec.ns).length ?? 0) === 0) continue;
    const state = namespaceState(run, item);
    if (state === undefined || !state.ordered || item.entry.resume === "restart") continue;
    for (const part of state.parts) {
      // A finished part up to its end; an unfinished one up to (not including) the
      // last checkpointed `_id`, where the resumed copy starts reading again.
      const upper = part.done ? part.upper : part.last;
      if (!part.done && part.last === null) continue;
      ranges.push({
        item,
        reading: { ordered: true, lower: partBound(part.lower), upper: partBound(upper) },
      });
    }
  }
  await mapWithConcurrency(
    ranges,
    ({ item, reading }, _index, signal) =>
      collectSelection({
        source: run.source,
        spec: item.spec,
        filter: run.subset?.filters.get(item.spec.ns) ?? {},
        reading,
        readPreference: run.readPreference,
        signal,
        batchSize: COLLECT_BATCH,
        onBatch: (documents) => references.collect(item.spec.ns, documents),
      }),
    { concurrency: run.parallelism, signal: run.options.signal },
  );
}
