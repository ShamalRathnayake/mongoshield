/**
 * Everything a copy checks and prepares before its first write: the checkpoint to
 * resume (and the options it pins), the reference sets of a subset with `follow`
 * rules, and the privileges of both users.
 */

import { randomBytes } from "node:crypto";
import type { NamespaceMapper } from "../engine/restore-rename.ts";
import { MongoShieldError } from "../errors.ts";
import { assertPrivileges, checkPrivileges, splitNamespace } from "../mongo/index.ts";
import { ReferenceSets } from "../subset/index.ts";
import {
  type CopyCheckpoint,
  copyFingerprint,
  fingerprintDifferences,
  readCopyCheckpoint,
  subsetForResume,
} from "./copy-checkpoint.ts";
import type { CopyContext, CopyEngineOptions, DetailedCopyPlan } from "./copy-plan.ts";

/** The checkpoint a resumed copy continues, and the options it runs with. */
export interface ResumeSetup {
  /** `undefined` unless `resume` is set. */
  readonly checkpoint: CopyCheckpoint | undefined;
  /** The caller's options, with the first run's subset filters when resuming. */
  readonly options: CopyEngineOptions;
}

/**
 * Reads the checkpoint to resume and checks that it may be continued with these
 * options. Without `resume`, nothing is read: a new copy replaces any old checkpoint.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for `resume` without `checkpoint`, a
 *   missing or unreadable checkpoint, or options that differ from the first run's.
 */
export async function resolveResume(
  context: CopyContext,
  options: CopyEngineOptions,
): Promise<ResumeSetup> {
  if (options.resume !== true) return { checkpoint: undefined, options };
  const path = options.checkpoint;
  if (path === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "resume needs the checkpoint file of the interrupted copy.",
      {
        hint: "Pass `checkpoint` (the path the interrupted copy was given) together with `resume`.",
      },
    );
  }
  const checkpoint = await readCopyCheckpoint(path);
  if (checkpoint === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `There is no interrupted copy to resume: ${path} does not exist.`,
      {
        hint: "The copy may have completed (its checkpoint is deleted then), or it ran in another directory (pass --checkpoint). Copy again without --resume.",
      },
    );
  }
  const differences = fingerprintDifferences(checkpoint.fingerprint, copyFingerprint(options));
  if (differences.length > 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The interrupted copy was started with different options (${differences.join(", ")}); resuming would mix two different copies.`,
      {
        hint: "Resume with the options of the interrupted copy, or copy again without --resume (with --drop).",
        details: { differences },
      },
    );
  }
  const subset = subsetForResume(options.subset, checkpoint, context.logger);
  const { subset: _ignored, ...rest } = options;
  return { checkpoint, options: subset === undefined ? rest : { ...rest, subset } };
}

/** The reference sets of a subset with `follow` rules, or `undefined`. */
export function createReferenceSets(
  context: CopyContext,
  options: CopyEngineOptions,
  detailed: DetailedCopyPlan,
  renameMapper: NamespaceMapper,
): ReferenceSets | undefined {
  const follows = detailed.subset?.follows ?? [];
  if (follows.length === 0) return undefined;
  return new ReferenceSets({
    client: context.target,
    follows,
    databaseFor: (sourceNs) => splitNamespace(renameMapper(sourceNs)).database,
    runId: randomBytes(4).toString("hex"),
    writeConcern: options.writeConcern,
    logger: context.logger,
  });
}

/**
 * Checks both users' privileges before anything is written: the source user must be
 * able to read (the `backup` role's actions), the target user to restore (the
 * `restore` role's actions), plus `update` for upserts and `find` on the temporary
 * reference collections when following references.
 *
 * @returns true when inserts may bypass document validation.
 * @throws MongoShieldError `MS_PERMISSION_DENIED` listing every missing privilege.
 */
export async function checkCopyPrivileges(
  context: CopyContext,
  options: CopyEngineOptions,
  detailed: DetailedCopyPlan,
  references: ReferenceSets | undefined,
): Promise<boolean> {
  const sourceNamespaces = detailed.namespaces.map((item) => item.spec.ns);
  if (sourceNamespaces.length === 0) return true;
  await assertPrivileges(context.source, {
    operation: "backup",
    databases: [...new Set(detailed.namespaces.map((item) => item.spec.db))],
    namespaces: sourceNamespaces,
  });

  const temporary = (references?.sets ?? []).map((set) => `${set.database}.${set.collection}`);
  const namespaces = [...detailed.namespaces.map((item) => item.entry.to), ...temporary];
  const databases = [...new Set(namespaces.map((ns) => splitNamespace(ns).database))];
  const extraActions = [
    ...(options.mode === "upsert" ? ["update"] : []),
    ...(references === undefined ? [] : ["find"]),
  ];
  await assertPrivileges(context.target, {
    operation: "restore",
    databases,
    namespaces,
    extraActions,
  });
  const bypass = await checkPrivileges(context.target, {
    operation: "restore",
    databases,
    namespaces,
    extraActions: [...extraActions, "bypassDocumentValidation"],
  });
  if (!bypass.ok) {
    context.logger.warn(
      "The target user lacks bypassDocumentValidation; documents are checked against validators while copying",
      { missing: bypass.missing },
    );
  }
  return bypass.ok;
}
