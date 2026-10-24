/**
 * The masking suggester: find personal data in sampled documents and suggest mask
 * rules for it, in the mask file format.
 *
 *   kinds.ts         what is detected               field-names.ts  what names suggest
 *   values.ts        what values look like          national-ids.ts checkable national ids
 *   checksums.ts     Luhn and IBAN mod-97           example.ts      masked examples
 *   profile.ts       walking documents, counting    classify.ts     profiles → findings
 *   rules.ts         findings → rules, coverage     render.ts       snippets, JSON merge
 *   suggest.ts       sampling a deployment (the only file that touches MongoDB)
 */

export {
  DEFAULT_MIN_CONFIDENCE,
  type DetectOptions,
  detectPii,
  type PiiFinding,
} from "./classify.ts";
export { KIND_LABELS, PII_KINDS, type PiiKind } from "./kinds.ts";
export type { ProfileLimits } from "./profile.ts";
export {
  countRules,
  mergeIntoJsonMask,
  type NamespaceSuggestions,
  newRules,
  renderMaskModule,
  renderRulesSnippet,
  toLiteral,
} from "./render.ts";
export {
  type CoveringRule,
  type MaskSuggestion,
  ruleForFinding,
  type SuggestedMaskRule,
  type SuggestionStatus,
} from "./rules.ts";
export {
  type CollectionSuggestions,
  DEFAULT_SAMPLE_SIZE,
  MAX_SAMPLE_SIZE,
  type MaskSuggestionReport,
  type SkippedNamespace,
  type SuggestMasksOptions,
  suggestMasks,
} from "./suggest.ts";
