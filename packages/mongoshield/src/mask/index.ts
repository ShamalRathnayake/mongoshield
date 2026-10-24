/**
 * Masking: deterministic, type-preserving anonymisation of documents in flight.
 * Used by `copy` / `pull`; independent of MongoDB, so it is unit-tested in isolation.
 *
 *   config.ts    the mask file format (`defineMask`) and its validation
 *   masker.ts    applying rules to documents, with per-rule reporting
 *   hash.ts      the `hash` operation          fake.ts   the `fake` operation
 *   keyed.ts     HMAC-based keyed randomness   paths.ts  field paths with `*`
 */

export {
  defineMask,
  type MaskConfig,
  type MaskFunction,
  type MaskFunctionContext,
  type MaskRule,
  type UnsupportedValuePolicy,
} from "./config.ts";
export { FAKE_KINDS, type FakeKind, type FakeOptions } from "./fake.ts";
export type { HashOptions } from "./hash.ts";
export { MIN_SECRET_LENGTH } from "./keyed.ts";
export {
  type CompileMaskOptions,
  compileMask,
  type Mask,
  type MaskReport,
  type MaskRuleReport,
  type NamespaceMask,
} from "./masker.ts";
export { collectPathValues, type FieldPath, parseFieldPath } from "./paths.ts";
