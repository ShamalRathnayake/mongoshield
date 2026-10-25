/**
 * Subsetting: copying a slice of a database that still hangs together.
 * Per-namespace filters pick the root documents; `follow` rules pull in exactly the
 * documents they reference, transitively.
 *
 *   config.ts          the subset file format (`defineSubset`) and its validation
 *   reference-set.ts   referenced values, spilled to temporary target collections
 */

export {
  type CompiledFollow,
  type CompiledSubset,
  compileSubset,
  DEFAULT_FOLLOW_BATCH_SIZE,
  defineSubset,
  type FollowEndpoint,
  type FollowRule,
  type SubsetConfig,
  type SubsetSelection,
} from "./config.ts";
export { type ReferenceSet, ReferenceSets, TEMP_COLLECTION_PREFIX } from "./reference-set.ts";
