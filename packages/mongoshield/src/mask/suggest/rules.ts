/**
 * From findings to mask rules: which existing operation masks each kind of data, and
 * whether the user's current mask file already covers the field.
 *
 *   kind            values        suggested rule                     why
 *   email           strings       { fake: "email" }                  realistic, unique, joins keep working
 *   phone           strings       { fake: "phone" }                  digits replaced, format kept
 *   person-name     strings       { fake: "name" }
 *   address         strings       { fake: "address" }
 *   ip-address      strings       { fake: "ip" }                     private / documentation ranges
 *   postal-code     strings       "redact"                           no fake keeps every country's format
 *   credit-card     any           "redact"                           nothing downstream needs a real one
 *   iban            any           "redact"
 *   national-id     any           "hash"                             stays unique, so unique indexes build
 *   date-of-birth   dates         { fake: "date-shift", days: 365 }  ages stay roughly right
 *   secret          passwords     "drop"                             (and password hashes)
 *                   tokens, keys  "hash"                             unique and unusable against production
 *   geolocation     latitude      { hash: { range: [-90, 90] } }     still a valid coordinate
 *                   longitude     { hash: { range: [-180, 180] } }
 *                   point, pair   "null"
 *   free-text       strings       "redact"
 *
 * When the values are not the type an operation needs (a phone stored as a number, a
 * field holding mixed types), the rule falls back to `hash` for numbers and `redact`
 * otherwise: `fake` would leave non-strings unchanged with only a warning.
 *
 * Coverage follows the masker's own rule selection (`selectRulesForNamespace`), so
 * "covered" means the copy really masks the field: a rule on the same path (or one
 * that selects it: `addresses.zip` covers `addresses.*.zip`), or a rule that replaces a
 * containing value wholesale (`profile: "drop"` covers `profile.email`). A `keep` rule
 * marks the field as deliberately kept.
 */

import {
  describeOperation,
  type MaskConfig,
  type MaskFunction,
  type MaskRule,
  type ParsedRule,
  parseMaskRules,
  selectRulesForNamespace,
} from "../config.ts";
import { WILDCARD } from "../paths.ts";
import type { PiiFinding } from "./classify.ts";

/** A rule the suggester writes: any rule except a custom function. */
export type SuggestedMaskRule = Exclude<MaskRule, MaskFunction>;

/**
 * Whether a suggestion is needed:
 * - `new`: no rule masks the field yet;
 * - `covered`: a rule in the current mask config masks it;
 * - `kept`: a `keep` rule leaves it alone on purpose.
 */
export type SuggestionStatus = "new" | "covered" | "kept";

/** The rule of the current mask config that covers a field. */
export interface CoveringRule {
  /** The namespace pattern it was declared under. */
  readonly pattern: string;
  readonly path: string;
  /** `hash`, `fake:email`, `keep`, … (as in copy reports). */
  readonly operation: string;
}

/** A finding with the rule that would mask it, and whether one already does. */
export interface MaskSuggestion extends PiiFinding {
  readonly rule: SuggestedMaskRule;
  readonly status: SuggestionStatus;
  /** Present when `status` is `covered` or `kept`. */
  readonly coveredBy?: CoveringRule;
}

/** The rule for a finding (see the table in the file header). */
export function ruleForFinding(finding: PiiFinding): SuggestedMaskRule {
  const strings = finding.valueType === "string";
  const numbers = finding.valueType === "number";
  const fallback: SuggestedMaskRule = numbers ? "hash" : "redact";
  switch (finding.kind) {
    case "email":
      return strings ? { fake: "email" } : fallback;
    case "phone":
      return strings ? { fake: "phone" } : fallback;
    case "person-name":
      return strings ? { fake: "name" } : fallback;
    case "address":
      return strings ? { fake: "address" } : fallback;
    case "ip-address":
      return strings ? { fake: "ip" } : fallback;
    case "postal-code":
      return fallback;
    case "credit-card":
    case "iban":
      return numbers ? "null" : "redact";
    case "national-id":
      return "hash";
    case "date-of-birth":
      return birthDateRule(finding);
    case "secret":
      return finding.detail === "password" || finding.detail === "password-hash" ? "drop" : "hash";
    case "geolocation":
      return geolocationRule(finding);
    case "free-text":
      return "redact";
  }
}

/** Shift real dates; strings and numbers (years) cannot be shifted. */
function birthDateRule(finding: PiiFinding): SuggestedMaskRule {
  if (finding.valueType === "date") return { fake: "date-shift", days: 365 };
  return finding.valueType === "string" ? "redact" : "null";
}

/** A latitude or longitude stays a valid coordinate; points and pairs are removed. */
function geolocationRule(finding: PiiFinding): SuggestedMaskRule {
  if (finding.valueType === "number" && finding.detail === "latitude") {
    return { hash: { range: [-90, 90] } };
  }
  if (finding.valueType === "number" && finding.detail === "longitude") {
    return { hash: { range: [-180, 180] } };
  }
  return "null";
}

/**
 * Suggestions for one namespace's findings, marking the ones the current mask config
 * already covers. Sorted by confidence, highest first (the findings' order).
 *
 * @param rules the current config's rules (`parseMaskRules`), or `[]` without one.
 */
export function suggestRules(
  ns: string,
  findings: readonly PiiFinding[],
  rules: readonly ParsedRule[],
): MaskSuggestion[] {
  const applicable = selectRulesForNamespace(rules, ns, (rule) => rule);
  return findings.map((finding) => {
    const covering = coveringRule(applicable, finding.path);
    const suggestion: MaskSuggestion = {
      ...finding,
      rule: ruleForFinding(finding),
      status: covering === undefined ? "new" : covering.status,
    };
    return covering === undefined ? suggestion : { ...suggestion, coveredBy: covering.rule };
  });
}

/** Validates the current mask config for coverage checks (`[]` when there is none). */
export function currentRules(mask: MaskConfig | undefined): ParsedRule[] {
  return mask === undefined ? [] : parseMaskRules(mask);
}

/**
 * The rule (of those applying to the namespace) that covers a field path: a masking
 * rule first, else a `keep` rule.
 */
function coveringRule(
  rules: readonly ParsedRule[],
  path: string,
): { status: "covered" | "kept"; rule: CoveringRule } | undefined {
  const fieldSegments = path.split(".");
  let kept: ParsedRule | undefined;
  for (const rule of rules) {
    const selection = selects(rule.segments, fieldSegments);
    if (selection === "none") continue;
    const kind = rule.operation.kind;
    if (kind === "keep") {
      kept ??= rule;
      continue;
    }
    // hash and fake cannot mask a whole sub-document: they leave it unchanged.
    if (selection === "ancestor" && (kind === "hash" || kind === "fake")) continue;
    return { status: "covered", rule: describe(rule) };
  }
  return kept === undefined ? undefined : { status: "kept", rule: describe(kept) };
}

function describe(rule: ParsedRule): CoveringRule {
  return { pattern: rule.pattern, path: rule.path, operation: describeOperation(rule.operation) };
}

/**
 * How a rule path relates to a field path (`*` in the field path = array elements):
 * - `field`: the rule selects the field's values (or every element of them);
 * - `ancestor`: it selects a value that contains the field;
 * - `none`: it selects neither (another field, or only part of the array).
 *
 * Mirrors `visitPath` in paths.ts: `*` in a rule matches any key or every element, a
 * number selects one element only, and a named segment meeting an array goes into
 * every element (implicit traversal). A `*` in the field path can also stand for the
 * keys of a document used as a map (see `isDataKey` in profile.ts); a named rule
 * segment is then assumed to go into it like into an array, which is only wrong for
 * such maps, where a rule would need `*` itself.
 */
export function selects(
  rule: readonly string[],
  field: readonly string[],
): "field" | "ancestor" | "none" {
  return match(rule, 0, field, 0);
}

function match(
  rule: readonly string[],
  ruleIndex: number,
  field: readonly string[],
  fieldIndex: number,
): "field" | "ancestor" | "none" {
  if (ruleIndex === rule.length) {
    // Only array levels left: leaf operations go into arrays anyway.
    return field.slice(fieldIndex).every((segment) => segment === WILDCARD) ? "field" : "ancestor";
  }
  if (fieldIndex === field.length) {
    // The rule goes deeper. `tags.*` against `tags` still selects every tag.
    return rule.slice(ruleIndex).every((segment) => segment === WILDCARD) ? "field" : "none";
  }
  const ruleSegment = rule[ruleIndex];
  const fieldSegment = field[fieldIndex];
  if (fieldSegment === WILDCARD) {
    if (ruleSegment === WILDCARD) return match(rule, ruleIndex + 1, field, fieldIndex + 1);
    // A number selects one element, so it does not cover the field.
    if (/^[0-9]+$/.test(ruleSegment ?? "")) return "none";
    return match(rule, ruleIndex, field, fieldIndex + 1);
  }
  if (ruleSegment === WILDCARD || ruleSegment === fieldSegment) {
    return match(rule, ruleIndex + 1, field, fieldIndex + 1);
  }
  return "none";
}
