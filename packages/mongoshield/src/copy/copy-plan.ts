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
 */

import { Binary, type Document, type MongoClient } from "mongodb";
import { decideAction, inspectTargets, type TargetState } from "../engine/restore-plan.ts";
import { assertValidTargetNamespace, compileRenameMap } from "../engine/restore-rename.ts";
import { MongoShieldError, throwIfAborted } from "../errors.ts";
import type { Logger } from "../logger.ts";
import type { Mask } from "../mask/index.ts";
import { type CollectionSpec, discoverNamespaces, splitNamespace } from "../mongo/index.ts";
import { type CompiledSubset, compileSubset } from "../subset/index.ts";
import type { CopyOptions, CopyPlan, CopyPlanEntry, RestoreMode } from "../types.ts";

/** Connected clients for both sides. The engine never opens or closes them. */
export interface CopyContext {
  /** The deployment documents are read from. */
  readonly source: MongoClient;
  /** The deployment documents are written to (may be the same deployment). */
  readonly target: MongoClient;
  readonly logger: Logger;
}

/** The engine's options: `CopyOptions` without the connection settings (the context has the clients). */
export type CopyEngineOptions = Omit<CopyOptions, "from" | "to">;

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
): Promise<DetailedCopyPlan> {
  const mode = options.mode ?? DEFAULT_COPY_MODE;
  const specs = await discoverSource(context, options);
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
    const decision = selfConflict
      ? {
          conflict:
            to === spec.ns
              ? "it is the source itself (same deployment); use --rename to copy elsewhere"
              : "it is also a source namespace of this copy (same deployment)",
        }
      : decideAction(mode, spec.type, state);

    const entry: CopyPlanEntry = {
      from: spec.ns,
      to,
      type: spec.type,
      documents: spec.estimatedDocuments,
      existingDocuments: state.exists ? state.documents : 0,
      subset: subset?.selectionOf(spec.ns) ?? "all",
      masked: spec.type === "view" ? [] : (mask?.forNamespace(spec.ns)?.summary ?? []),
      ...("conflict" in decision
        ? { action: "conflict" as const, reason: decision.conflict }
        : { action: decision.action }),
    };
    entries.push(entry);
    if (entry.action !== "conflict") namespaces.push({ spec, entry });
  }

  return { plan: { mode, entries }, namespaces, subset, sameDeployment };
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
    const infos = await context.target
      .db(database)
      .listCollections({}, { nameOnly: false, authorizedCollections: true })
      .toArray();
    if (infos.some((info) => sourceUuids.has(uuidOf(info)))) return true;
  }
  return false;
}

/** The collection UUID of a `listCollections` entry as 32 lowercase hex characters, or "". */
function uuidOf(info: Document): string {
  const uuid: unknown = info.info?.uuid;
  return uuid instanceof Binary ? uuid.toString("hex").toLowerCase() : "";
}
