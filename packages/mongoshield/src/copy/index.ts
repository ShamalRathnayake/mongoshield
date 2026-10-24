/**
 * Copying between deployments with masking and subsetting (`copy`, `pull`).
 *
 *   copy.ts             the engine: plan → pre-flight → targets → documents → references
 *                       → indexes → views
 *   copy-plan.ts        read-only planning, conflicts, same-deployment protection
 *   copy-namespace.ts   streaming one selection; creating targets and views
 *   local-target.ts     "is this URI on this machine?" (for `pull`)
 *   load-file.ts        loading mask and subset files with jiti
 */

export {
  DEFAULT_COPY_INSERT_WORKERS,
  DEFAULT_COPY_PARALLELISM,
  DEFAULT_COPY_READ_PREFERENCE,
  planCopy,
  runCopy,
} from "./copy.ts";
export {
  assertNoCopyConflicts,
  buildCopyPlan,
  type CopyContext,
  type CopyEngineOptions,
  DEFAULT_COPY_MODE,
} from "./copy-plan.ts";
export { loadMaskFile, loadSubsetFile } from "./load-file.ts";
export { isLocalMongoUri } from "./local-target.ts";
