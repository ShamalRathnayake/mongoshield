/**
 * Copy planning: which source namespaces are copied, where to, and what happens to
 * whatever already exists at each target. Read-only on both sides.
 *
 *   discover source namespaces (include/exclude) → rename → inspect targets
 *   → decide an action per namespace → annotate with subset selection and mask rules
 *
 * The actions follow exactly the same table as restore (see `decideAction` in
 * `engine/restore-plan.ts`): by default nothing existing is ever overwritten.
 *
 * One check restore does not need: the source and target may be the SAME deployment
 * (copying `app.*` to `app_staging.*` on one cluster is common). A target that is
 * itself one of the copied source namespaces is a conflict in every mode: `drop`
 * would destroy the data being copied, and inserting into it would read and write
 * the same collection at once.
 *
 * A RESUMED copy keeps the action the interrupted run chose for every target it
 * already created (they now hold its documents, which would otherwise be conflicts),
 * and each entry says what is left to do (`resume`, see `CopyResumeState`).
 */

import { Binary, type Document, type MongoClient, MongoServerError } from "mongodb";
import { decideAction, inspectTargets, type TargetState } from "../engine/restore-plan.ts";
import { assertValidTargetNamespace, compileRenameMap } from "../engine/restore-rename.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Mask } from "../mask/index.ts";
import { type CollectionSpec, discoverNamespaces, splitNamespace } from "../mongo/index.ts";
import { type CompiledSubset, compileSubset } from "../subset/index.ts";
import type {
  CopyOptions,
  CopyPlan,
  CopyPlanEntry,
  CopyResumeState,
  RestoreMode,
} from "../types.ts";
import type { CopyCheckpoint, NamespaceState } from "./copy-checkpoint.ts";

/** Connected clients for both sides. The engine never opens or closes them. */
export interface CopyContext {
  /** The deployment documents are read from. */
  readonly source: MongoClient;
  /** The deployment documents are written to (may be the same deployment). */
  readonly target: MongoClient;
  readonly logger: Logger;
}

/**
 * The engine's options: `CopyOptions` without the connection settings (the context has
 * the clients), plus tuning that is not part of the public options.
 */
export type CopyEngineOptions = Omit<CopyOptions, "from" | "to"> & {
  /**
   * Checkpointed copies split collections larger than this (raw BSON bytes) into
   * `_id` ranges. Defaults to `DEFAULT_PART_SIZE_BYTES` (256 MiB), like backups.
   */
  readonly partSizeBytes?: number;
};

/** One planned namespace with the source spec needed to copy it. */
export interface PlannedCopyNamespace {
  readonly spec: CollectionSpec;
  readonly entry: CopyPlanEntry;
}

/** A plan plus everything `runCopy` needs to carry it out. */
export interface DetailedCopyPlan {
  readonly plan: CopyPlan;
  /** The namespaces to copy (conflicts excluded; they are only in `plan`). */
  readonly namespaces: readonly PlannedCopyNamespace[];
  /** The compiled subset config, when one was given. */
  readonly subset: CompiledSubset | undefined;
  /** Source and target are the same deployment. */
  readonly sameDeployment: boolean;
}

/** The mode used when none is given: never overwrite anything. */
export const DEFAULT_COPY_MODE: RestoreMode = "fail-if-exists";

/**
 * Plans a copy without writing anything. Conflicting namespaces appear with
 * `action: "conflict"` and a `reason`; use `assertNoCopyConflicts` to refuse them.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for bad patterns, rename rules or
 *   subset config, or when nothing matches.
 */
export async function buildCopyPlan(
  context: CopyContext,
  options: CopyEngineOptions,
  mask: Mask | undefined,
  checkpoint?: CopyCheckpoint,
): Promise<DetailedCopyPlan> {
  const mode = options.mode ?? DEFAULT_COPY_MODE;
  const specs = await discoverSource(context, options);
  if (checkpoint !== undefined) assertSameSourceCollections(specs, checkpoint);
  const subset =
    options.subset === undefined
      ? undefined
      : compileSubset(
          options.subset,
          specs.map((spec) => ({ ns: spec.ns, type: spec.type })),
        );
  const targets = mapTargets(specs, options.rename);

  const states = await inspectTargets(context.target, [...targets.values()], options.signal);
  const sameDeployment = await isSameDeployment(context, specs, targets, options.signal);
  const sourceNamespaces = new Set(specs.map((spec) => spec.ns));

  const namespaces: PlannedCopyNamespace[] = [];
  const entries: CopyPlanEntry[] = [];
  for (const spec of specs) {
    const to = targets.get(spec.ns) ?? spec.ns;
    const state: TargetState = states.get(to) ?? { exists: false };
    const selfConflict = sameDeployment && sourceNamespaces.has(to);
    const resumed = checkpoint?.namespaces.find((candidate) => candidate.from === spec.ns);
    const decision = selfConflict
      ? {
          conflict:
            to === spec.ns
              ? "it is the source itself (same deployment); use --rename to copy elsewhere"
              : "it is also a source namespace of this copy (same deployment)",
        }
      : resumed?.prepared === true || resumed?.finished === true
        ? { action: resumed.action }
        : decideAction(mode, spec.type, state);
    const selection = subset?.selectionOf(spec.ns) ?? "all";

    const entry: CopyPlanEntry = {
      from: spec.ns,
      to,
      type: spec.type,
      documents: spec.estimatedDocuments,
      existingDocuments: state.exists ? state.documents : 0,
      subset: selection,
      masked: spec.type === "view" ? [] : (mask?.forNamespace(spec.ns)?.summary ?? []),
      ...("conflict" in decision
        ? { action: "conflict" as const, reason: decision.conflict }
        : { action: decision.action }),
      ...(checkpoint === undefined
        ? {}
        : { resume: resumeStateOf(resumed, selection, checkpoint.referencesDone) }),
    };
    entries.push(entry);
    if (entry.action !== "conflict") namespaces.push({ spec, entry });
  }

  return { plan: { mode, entries }, namespaces, subset, sameDeployment };
}

/**
 * What a resumed copy does with one namespace, from its checkpointed state.
 *
 * Unordered namespaces (no `_id` index, e.g. time series) cannot continue mid-way, so
 * unfinished ones start over: their roots when not all copied, and also when they are
 * followed into and following did not finish (references are followed again from the
 * start, and a time series could not skip the measurements it already holds).
 */
export function resumeStateOf(
  state: NamespaceState | undefined,
  selection: CopyPlanEntry["subset"],
  referencesDone: boolean,
): CopyResumeState {
  if (state === undefined || (!state.prepared && !state.finished)) return "not-started";
  if (state.finished) return "done";
  if (!state.ordered) {
    const hasRoots = selection !== "referenced";
    const isFollowed = selection === "referenced" || selection === "filtered+referenced";
    if ((hasRoots && !state.rootsDone) || (isFollowed && !referencesDone)) return "restart";
  }
  return "partial";
}

/**
 * A resumed copy reads the source in the `_id` ranges the interrupted run planned:
 * they only describe the same documents if every source collection is still the
 * same one, and none of the checkpointed collections has gone.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` naming the collections that changed.
 */
function assertSameSourceCollections(
  specs: readonly CollectionSpec[],
  checkpoint: CopyCheckpoint,
): void {
  const byNs = new Map(specs.map((spec) => [spec.ns, spec]));
  const changed: string[] = [];
  for (const state of checkpoint.namespaces) {
    const spec = byNs.get(state.from);
    const uuid = spec?.uuid ?? null;
    if (spec === undefined || (state.sourceUuid !== null && uuid !== state.sourceUuid)) {
      changed.push(state.from);
    }
  }
  if (changed.length === 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The interrupted copy cannot be resumed: the source collection(s) ${changed.join(", ")} were dropped or replaced since.`,
    { hint: "Copy again without --resume (with --drop to replace the partial targets)." },
  );
}

/**
 * Throws `MS_RESTORE_CONFLICT` listing every conflicting namespace, if the plan has any.
 */
export function assertNoCopyConflicts(plan: CopyPlan): void {
  const conflicts = plan.entries.filter((entry) => entry.action === "conflict");
  if (conflicts.length === 0) return;
  const lines = conflicts.map((entry) => `  ${entry.to}: ${entry.reason ?? "conflict"}`).join("\n");
  throw new MongoShieldError(
    "MS_RESTORE_CONFLICT",
    `The copy would overwrite existing data in ${conflicts.length} namespace(s):\n${lines}`,
    {
      hint:
        plan.mode === "fail-if-exists"
          ? "Copy with --drop to replace the targets, --mode insert to keep existing documents, or --rename to copy elsewhere."
          : "Copy with --drop to replace the targets, or --rename to copy elsewhere.",
      details: { mode: plan.mode, conflicts: conflicts.map((entry) => entry.to) },
    },
  );
}

/**
 * The source namespaces to copy. Patterns that match nothing are almost certainly a
 * typo, and an empty source is almost certainly the wrong URI: both are errors rather
 * than a copy that silently does nothing.
 */
async function discoverSource(
  context: CopyContext,
  options: CopyEngineOptions,
): Promise<CollectionSpec[]> {
  const specs = await discoverNamespaces(context.source, {
    include: options.include,
    exclude: options.exclude,
    signal: options.signal,
    logger: context.logger,
  });
  if (specs.length > 0) return specs;
  const hasPatterns = (options.include?.length ?? 0) + (options.exclude?.length ?? 0) > 0;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    hasPatterns
      ? "No source namespace matches the include/exclude patterns."
      : "The source has no namespaces to copy.",
    {
      hint: hasPatterns
        ? 'Check the patterns: they look like "app.*" or "app.users".'
        : "Check the source connection string (database names are case-sensitive).",
    },
  );
}

/**
 * Source namespace → target namespace. Two namespaces copied to the same target
 * would mix their documents, so that is rejected.
 */
function mapTargets(
  specs: readonly CollectionSpec[],
  rename: CopyEngineOptions["rename"],
): Map<string, string> {
  const mapper = compileRenameMap(rename);
  const targets = new Map<string, string>();
  const sourceByTarget = new Map<string, string>();
  for (const spec of specs) {
    const target = mapper(spec.ns);
    if (target !== spec.ns) assertValidTargetNamespace(target);
    const other = sourceByTarget.get(target);
    if (other !== undefined) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Both ${other} and ${spec.ns} would be copied to ${target}.`,
        { hint: "Change the rename rules so every namespace has its own target." },
      );
    }
    sourceByTarget.set(target, spec.ns);
    targets.set(spec.ns, target);
  }
  return targets;
}

/**
 * True when source and target are the same deployment: the same client object, or
 * a target database holding a collection with the UUID of a source collection.
 * Collection UUIDs are random and unique, so a match means "the same collection".
 */
async function isSameDeployment(
  context: CopyContext,
  specs: readonly CollectionSpec[],
  targets: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (context.source === context.target) return true;
  const sourceUuids = new Set(
    specs.flatMap((spec) => (spec.uuid === undefined ? [] : [spec.uuid])),
  );
  if (sourceUuids.size === 0) return false;

  // The source databases too: copying app.* → app_copy.* on one cluster creates new
  // target databases whose collections share nothing with the source yet.
  const databases = new Set<string>();
  for (const spec of specs) databases.add(spec.db);
  for (const target of targets.values()) databases.add(splitNamespace(target).database);

  for (const database of databases) {
    throwIfAborted(signal);
    const infos = await listCollectionInfos(context.target, database);
    if (infos.some((info) => sourceUuids.has(uuidOf(info)))) return true;
  }
  return false;
}

/** Server error code for "not authorized". */
const UNAUTHORIZED_CODE = 13;

/**
 * `listCollections` of one target database, or nothing when the target user may not
 * list it. A least-privilege target user (`readWrite` on the target databases only)
 * cannot list the SOURCE database names on the target; it cannot write there either,
 * so they cannot be the copy's target and only its own databases matter for the check.
 */
async function listCollectionInfos(client: MongoClient, database: string): Promise<Document[]> {
  try {
    return await client
      .db(database)
      .listCollections({}, { nameOnly: false, authorizedCollections: true })
      .toArray();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) return [];
    throw error;
  }
}

/** The collection UUID of a `listCollections` entry as 32 lowercase hex characters, or "". */
function uuidOf(info: Document): string {
  const uuid: unknown = info.info?.uuid;
  return uuid instanceof Binary ? uuid.toString("hex").toLowerCase() : "";
}
