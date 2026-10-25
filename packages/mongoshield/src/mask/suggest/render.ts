/**
 * Writing suggestions in the mask file format: as a snippet to paste, as a new mask
 * module, or merged into an existing JSON mask file.
 *
 *   "app.users": {
 *     email: { fake: "email" }, // email · 100% of 1,000 values · confidence 1
 *     "addresses.*.zip": "redact", // postal code · 98% of 2,140 values · confidence 0.86
 *   },
 *
 * Only `new` suggestions are written: covered and kept fields already have a rule, and
 * a suggestion never overwrites one. Rules are keyed by the exact namespace that was
 * sampled (`app.users`), which beats any pattern rule for the same path in the user's
 * file, so a merged suggestion takes effect exactly where the data was found.
 *
 * Why existing TypeScript/JavaScript mask files are never rewritten: they are programs.
 * They can compute keys, read `process.env`, hold custom functions and comments, and
 * reformatting or re-serialising them could silently change what gets masked. JSON has
 * none of that, so a JSON file can be merged safely; for modules the CLI prints the
 * snippet instead.
 */

import { KIND_LABELS } from "./kinds.ts";
import type { MaskSuggestion, SuggestedMaskRule } from "./rules.ts";

/** The suggestions of one namespace, as passed to the renderers. */
export interface NamespaceSuggestions {
  readonly ns: string;
  readonly suggestions: readonly MaskSuggestion[];
}

/** The `rules` object of the new suggestions: namespace → path → rule. */
export function newRules(
  groups: readonly NamespaceSuggestions[],
): Record<string, Record<string, SuggestedMaskRule>> {
  const rules: Record<string, Record<string, SuggestedMaskRule>> = {};
  for (const group of groups) {
    const fresh = group.suggestions.filter((suggestion) => suggestion.status === "new");
    if (fresh.length === 0) continue;
    rules[group.ns] = Object.fromEntries(
      fresh.map((suggestion) => [suggestion.path, suggestion.rule]),
    );
  }
  return rules;
}

/** How many rules `newRules` holds. */
export function countRules(
  rules: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): number {
  return Object.values(rules).reduce((sum, fields) => sum + Object.keys(fields).length, 0);
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

/**
 * The new rules as entries of a `rules` object, indented by `indent` spaces, each with
 * a comment saying what was found. Empty when there is nothing new.
 */
export function renderRulesSnippet(groups: readonly NamespaceSuggestions[], indent = 0): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const group of groups) {
    const fresh = group.suggestions.filter((suggestion) => suggestion.status === "new");
    if (fresh.length === 0) continue;
    lines.push(`${pad}${literalKey(group.ns)}: {`);
    for (const suggestion of fresh) {
      lines.push(
        `${pad}  ${literalKey(suggestion.path)}: ${toLiteral(suggestion.rule)}, // ${describeSuggestion(suggestion)}`,
      );
    }
    lines.push(`${pad}},`);
  }
  return lines.join("\n");
}

/** A complete mask module (`mask.ts`) holding the new rules. */
export function renderMaskModule(groups: readonly NamespaceSuggestions[]): string {
  return [
    "// Mask rules drafted by `mongoshield mask suggest` from a sample of the data.",
    "// Review every rule before copying: detection is based on samples and patterns, so it",
    "// can miss fields (rare values, unusual formats) and flag harmless ones.",
    'import { defineMask } from "mongoshield";',
    "",
    "export default defineMask({",
    "  // At least 16 characters; keep it out of the file (openssl rand -base64 32).",
    "  secret: process.env.MONGOSHIELD_MASK_SECRET,",
    "  rules: {",
    renderRulesSnippet(groups, 4),
    "  },",
    "});",
    "",
  ].join("\n");
}

/** "email · 100% of 1,000 values · confidence 0.98". */
function describeSuggestion(suggestion: MaskSuggestion): string {
  const share = `${Math.floor(suggestion.share * 100)}% of ${suggestion.sampled.toLocaleString("en-US")} values`;
  return `${KIND_LABELS[suggestion.kind]} · ${share} · confidence ${suggestion.confidence}`;
}

/** A key as written in an object literal: bare when it is an identifier, quoted otherwise. */
function literalKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** A rule (JSON-like data) as a one-line TypeScript literal: `{ hash: { range: [18, 90] } }`. */
export function toLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toLiteral).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(
      ([key, inner]) => `${literalKey(key)}: ${toLiteral(inner)}`,
    );
    return `{ ${entries.join(", ")} }`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** What merging into a JSON mask file did. */
export interface JsonMergeResult {
  /** The new file content. */
  readonly text: string;
  /** Rules added. */
  readonly added: number;
  /** Suggested rules skipped because the file already has a rule for that namespace and path. */
  readonly skipped: number;
}

/**
 * Merges the new rules into a JSON mask file's content (`undefined`: a new file).
 * Existing rules and other keys are kept as they are; a namespace + path that already
 * has a rule is never overwritten.
 *
 * @throws Error with a readable message when the content is not a JSON object whose
 *   `rules` (if present) is an object. The caller turns it into a config error.
 */
export function mergeIntoJsonMask(
  existing: string | undefined,
  rules: Readonly<Record<string, Readonly<Record<string, SuggestedMaskRule>>>>,
): JsonMergeResult {
  const config = parseJsonMask(existing);
  const merged: Record<string, Record<string, unknown>> = { ...config.rules };
  let added = 0;
  let skipped = 0;
  for (const [ns, fields] of Object.entries(rules)) {
    const target: Record<string, unknown> = { ...merged[ns] };
    for (const [path, rule] of Object.entries(fields)) {
      if (Object.hasOwn(target, path)) {
        skipped += 1;
        continue;
      }
      target[path] = rule;
      added += 1;
    }
    merged[ns] = target;
  }
  // Same key order as before (`rules` stays where it was), so the diff shows only additions.
  const document = { ...config.document, rules: merged };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return { text, added, skipped };
}

/** A JSON mask file: the whole object (kept as is) and its validated rules. */
interface JsonMask {
  readonly document: Record<string, unknown>;
  readonly rules: Record<string, Record<string, unknown>>;
}

function parseJsonMask(existing: string | undefined): JsonMask {
  if (existing === undefined || existing.trim() === "") return { document: {}, rules: {} };
  const parsed: unknown = JSON.parse(existing);
  if (!isPlainObject(parsed)) throw new Error("the file is not a JSON object");
  const rules = parsed.rules ?? {};
  if (!isPlainObject(rules)) throw new Error("its `rules` is not an object");
  const checked: Record<string, Record<string, unknown>> = {};
  for (const [ns, fields] of Object.entries(rules)) {
    if (!isPlainObject(fields)) throw new Error(`its rules for "${ns}" are not an object`);
    checked[ns] = fields;
  }
  return { document: parsed, rules: checked };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
