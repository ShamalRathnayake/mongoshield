/**
 * Field name suggestions while typing a filter, sort or projection.
 *
 * When the caret is where a key goes (right after `{` or `,`, optionally after an opening
 * quote) and the user has started typing, the box suggests matching field paths from the
 * sampled documents (`address.city`), or query operators when the word starts with `$`
 * (`$gte`, `$in`, …). Accepting one writes the key properly quoted with its colon:
 *
 *   {"addr|                 →  {"address.city": |
 *   {"total": {"$g|         →  {"total": {"$gte": |
 *
 * Pure functions over the text and the caret position, so they are easy to test; the
 * listbox itself is in components/query-bar.tsx.
 */

/** Operators suggested after `$` (the same set the filter check accepts). */
export const OPERATOR_SUGGESTIONS: readonly string[] = [
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$exists",
  "$type",
  "$regex",
  "$options",
  "$size",
  "$all",
  "$elemMatch",
  "$and",
  "$or",
  "$nor",
  "$not",
  "$mod",
];

/** Most suggestions shown at once. */
export const MAX_SUGGESTIONS = 8;

/** Where the word being completed is, and what it is. */
export interface CompletionContext {
  /** Start of the text to replace (the opening quote, when there is one). */
  readonly start: number;
  /** End of the text to replace (after the rest of the word and its closing quote). */
  readonly end: number;
  /** What the user typed so far (without the quote). */
  readonly prefix: string;
  readonly kind: "field" | "operator";
}

/** Characters of a field path or operator. */
const WORD_CHAR = /[A-Za-z0-9_.$-]/;

/**
 * The word at the caret when it is in a key position, else undefined. A key position is
 * one whose previous non-blank character (before the word and its quote) is `{` or `,`
 * (a `,` inside an array, `["a", "b|`, is a value: those are rare in filters and still
 * offer suggestions, which the user can ignore).
 */
export function completionContext(text: string, caret: number): CompletionContext | undefined {
  let start = caret;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) start -= 1;
  const prefix = text.slice(start, caret);
  const quoted = text.charAt(start - 1) === '"';
  const keyStart = quoted ? start - 1 : start;
  let before = keyStart - 1;
  while (before >= 0 && /\s/.test(text.charAt(before))) before -= 1;
  const previous = text.charAt(before);
  if (previous !== "{" && previous !== ",") return undefined;
  if (prefix === "" && !quoted) return undefined;
  // Replace the rest of the word after the caret too, and a closing quote.
  let end = caret;
  while (end < text.length && WORD_CHAR.test(text.charAt(end))) end += 1;
  if (quoted && text.charAt(end) === '"') end += 1;
  return { start: keyStart, end, prefix, kind: prefix.startsWith("$") ? "operator" : "field" };
}

/**
 * Suggestions for a context: fields (or operators) starting with the prefix first, then
 * those containing it, case-insensitive; never the exact word already typed.
 */
export function suggestionsFor(context: CompletionContext, fields: readonly string[]): string[] {
  const candidates = context.kind === "operator" ? OPERATOR_SUGGESTIONS : fields;
  const needle = context.prefix.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower === needle) continue;
    if (lower.startsWith(needle)) starts.push(candidate);
    else if (needle !== "" && lower.includes(needle)) contains.push(candidate);
  }
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

/** Writes the chosen suggestion as a quoted key with its colon; returns the new caret too. */
export function applyCompletion(
  text: string,
  context: CompletionContext,
  suggestion: string,
): { text: string; caret: number } {
  let after = text.slice(context.end);
  // Do not double an existing colon (`{"sta|": 1}` keeps its `: 1`).
  const hasColon = /^\s*:/.test(after);
  const key = `"${suggestion}"${hasColon ? "" : ": "}`;
  if (hasColon) after = after.replace(/^\s*:\s?/, ": ");
  const next = text.slice(0, context.start) + key + after;
  const caret = context.start + key.length + (hasColon ? 2 : 0);
  return { text: next, caret };
}
