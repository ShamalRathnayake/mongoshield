/**
 * The shape of a mask file and its validation.
 *
 *   // mask.ts
 *   import { defineMask } from "mongoshield";
 *
 *   export default defineMask({
 *     secret: process.env.MASK_SECRET,          // or MONGOSHIELD_MASK_SECRET
 *     rules: {
 *       "app.users": {
 *         _id: "hash",                          // keyed pseudonym, same type
 *         email: { fake: "email" },
 *         "addresses.*.street": { fake: "address" },
 *         age: { hash: { range: [18, 90] } },
 *         notes: { redact: "[removed]" },
 *         passwordHash: "drop",
 *       },
 *       "app.orders": { userId: "hash" },       // same input → same output: joins still work
 *       "*.*": { ssn: "null" },                 // patterns work like --include
 *     },
 *   });
 *
 * Rules are validated here (operations, kinds, ranges, patterns, path syntax) so a
 * typo fails before anything is read or written. Applying them lives in `masker.ts`.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { compileNamespaceFilter, type NamespaceFilter } from "../mongo/index.ts";
import type { NamespacePattern } from "../types.ts";
import { FAKE_KINDS, type FakeKind, type FakeOptions } from "./fake.ts";
import type { HashOptions } from "./hash.ts";
import { type FieldPath, parseFieldPath } from "./paths.ts";

/**
 * A custom mask: receives the value at the path and returns its replacement.
 * Return `undefined` to remove the field. Throwing stops the copy (masking fails
 * closed: an unmasked value is never written because a function broke).
 */
export type MaskFunction = (value: unknown, context: MaskFunctionContext) => unknown;

/** What a custom mask function knows besides the value. */
export interface MaskFunctionContext {
  /** Source namespace of the document, e.g. `app.users`. */
  readonly ns: string;
  /** Concrete path of the value, e.g. `addresses.1.street`. */
  readonly path: string;
  /** The whole document, with the rules before this one already applied. Do not modify it. */
  readonly document: Readonly<Document>;
  /** The `hash` operation, for deterministic custom masks. Throws for unsupported types. */
  hash(value: unknown, options?: HashOptions): unknown;
  /** The `fake` operation. Throws when the kind does not apply to the value. */
  fake(kind: FakeKind, value: unknown, options?: FakeOptions): unknown;
}

/**
 * One rule. The strings are shorthands:
 * - `"hash"`: keyed pseudonym of the same type (see `hash.ts`)
 * - `"redact"`: the text `[redacted]`
 * - `"null"`: `null`; `"drop"`: remove the field; `"keep"`: leave it alone (overrides
 *   a broader pattern's rule for the same path)
 */
export type MaskRule =
  | "hash"
  | "keep"
  | "null"
  | "drop"
  | "redact"
  | { readonly hash: HashOptions | true }
  | ({ readonly fake: FakeKind } & FakeOptions)
  | { readonly redact: string }
  | MaskFunction;

/**
 * What happens when a rule meets a value it cannot handle (`hash` on a boolean,
 * `fake: "email"` on a number):
 * - `"warn"` (default): leave the value unchanged and log a warning (once per rule and type)
 * - `"null"`: replace it with `null`
 * - `"fail"`: stop the copy
 */
export type UnsupportedValuePolicy = "warn" | "null" | "fail";

/** A mask file's default export. */
export interface MaskConfig {
  /**
   * Secret key for `hash` and `fake` (at least 16 characters). Keep it out of the file:
   * `secret: process.env.MASK_SECRET`. The CLI falls back to MONGOSHIELD_MASK_SECRET.
   * Using the same secret for every copy keeps masked values stable between copies.
   */
  readonly secret?: string | undefined;
  /** Namespace pattern → field path → rule. */
  readonly rules: Readonly<Record<NamespacePattern, Readonly<Record<string, MaskRule>>>>;
  /** Defaults to `"warn"`. */
  readonly onUnsupported?: UnsupportedValuePolicy;
}

/**
 * Identity function that gives mask files type checking and editor completion.
 *
 *   export default defineMask({ rules: { "app.users": { email: { fake: "email" } } } });
 */
export function defineMask(config: MaskConfig): MaskConfig {
  return config;
}

/** A validated operation. */
export type MaskOperation =
  | { readonly kind: "keep" }
  | { readonly kind: "null" }
  | { readonly kind: "drop" }
  | { readonly kind: "redact"; readonly text: string }
  | { readonly kind: "hash"; readonly options: HashOptions }
  | { readonly kind: "fake"; readonly fake: FakeKind; readonly options: FakeOptions }
  | { readonly kind: "custom"; readonly mask: MaskFunction };

/** A validated rule, ready to apply. */
export interface ParsedRule {
  /** The namespace pattern it was declared under. */
  readonly pattern: string;
  readonly matchesNamespace: NamespaceFilter;
  /** Exact namespaces (no `*`) beat patterns when both have a rule for the same path. */
  readonly exact: boolean;
  /** Declaration order, the tie-breaker among patterns of equal specificity. */
  readonly order: number;
  readonly path: string;
  readonly segments: FieldPath;
  readonly operation: MaskOperation;
}

/** Default text of `"redact"`. */
export const DEFAULT_REDACTION = "[redacted]";

/**
 * Validates a mask config and returns its rules.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` naming the pattern, path and problem.
 */
export function parseMaskRules(config: MaskConfig): ParsedRule[] {
  if (!isObject(config) || !isObject(config.rules)) {
    throw maskError("the mask config must be an object with a `rules` object");
  }
  const policy: unknown = config.onUnsupported;
  if (policy !== undefined && policy !== "warn" && policy !== "null" && policy !== "fail") {
    throw maskError(
      `onUnsupported must be "warn", "null" or "fail", got ${JSON.stringify(policy)}`,
    );
  }

  const rules: ParsedRule[] = [];
  for (const [pattern, fields] of Object.entries(config.rules)) {
    const matchesNamespace = compileNamespaceFilter({ include: [pattern] });
    if (!isObject(fields)) throw maskError(`the rules for "${pattern}" must be an object`);
    for (const [path, rule] of Object.entries(fields)) {
      rules.push({
        pattern,
        matchesNamespace,
        exact: !pattern.includes("*"),
        order: rules.length,
        path,
        segments: parseFieldPath(path),
        operation: parseOperation(rule, `${pattern} → ${path}`),
      });
    }
  }
  return rules;
}

/**
 * The rules that apply to one namespace: every rule whose pattern matches it, but only
 * one per path, the most specific (an exact namespace beats a pattern with `*`, then
 * the first declared wins). Returned in declaration order, which is the order they are
 * applied in. Shared by the masker and the mask suggester, so both agree on which rule
 * masks a field.
 *
 * Works on anything that carries a rule (`ruleOf`), so the masker can select its
 * per-rule counters directly.
 */
export function selectRulesForNamespace<T>(
  items: readonly T[],
  ns: string,
  ruleOf: (item: T) => ParsedRule,
): T[] {
  const matching = items.filter((item) => ruleOf(item).matchesNamespace(ns));
  matching.sort((left, right) => {
    const [a, b] = [ruleOf(left), ruleOf(right)];
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return a.order - b.order;
  });
  const byPath = new Map<string, T>();
  for (const item of matching) {
    const path = ruleOf(item).path;
    if (!byPath.has(path)) byPath.set(path, item);
  }
  // Declaration order, so a rule on `profile` and one on `profile.email` run in the
  // order the user wrote them.
  return [...byPath.values()].sort((left, right) => ruleOf(left).order - ruleOf(right).order);
}

/** True when any rule needs the secret (custom functions may call `hash`/`fake`). */
export function needsSecret(rules: readonly ParsedRule[]): boolean {
  return rules.some((rule) => ["hash", "fake", "custom"].includes(rule.operation.kind));
}

/** A short description for plans and reports: `hash`, `hash[18..90]`, `fake:email`, … */
export function describeOperation(operation: MaskOperation): string {
  switch (operation.kind) {
    case "hash":
      return operation.options.range === undefined
        ? "hash"
        : `hash[${operation.options.range[0]}..${operation.options.range[1]}]`;
    case "fake":
      return `fake:${operation.fake}`;
    default:
      return operation.kind;
  }
}

/** Turns one rule value into an operation. */
function parseOperation(rule: unknown, where: string): MaskOperation {
  if (typeof rule === "function") {
    return {
      kind: "custom",
      mask: (value, context) => Reflect.apply(rule, undefined, [value, context]),
    };
  }
  if (typeof rule === "string") return parseShorthand(rule, where);
  if (!isObject(rule))
    throw maskError(`${where}: a rule must be a string, an object or a function`);

  const keys = Object.keys(rule);
  if ("hash" in rule && keys.length === 1)
    return { kind: "hash", options: parseHashOptions(rule.hash, where) };
  if ("redact" in rule && keys.length === 1) {
    if (typeof rule.redact !== "string") throw maskError(`${where}: redact needs a string`);
    return { kind: "redact", text: rule.redact };
  }
  if ("fake" in rule && keys.every((key) => key === "fake" || key === "days")) {
    return parseFake(rule.fake, rule.days, where);
  }
  throw maskError(
    `${where}: unknown rule ${JSON.stringify(rule)}; use { hash }, { fake, days? } or { redact }`,
  );
}

function parseShorthand(rule: string, where: string): MaskOperation {
  switch (rule) {
    case "hash":
      return { kind: "hash", options: {} };
    case "redact":
      return { kind: "redact", text: DEFAULT_REDACTION };
    case "keep":
    case "null":
    case "drop":
      return { kind: rule };
    default:
      throw maskError(
        `${where}: unknown operation "${rule}"; use hash, redact, null, drop, keep, { fake: … } or a function`,
      );
  }
}

function parseHashOptions(options: unknown, where: string): HashOptions {
  if (options === true) return {};
  if (!isObject(options)) throw maskError(`${where}: hash takes true or { range: [min, max] }`);
  const range: unknown = options.range;
  if (range === undefined) return {};
  if (Array.isArray(range) && range.length === 2) {
    const [min, max]: unknown[] = range;
    if (isWholeNumber(min) && isWholeNumber(max) && min <= max) return { range: [min, max] };
  }
  throw maskError(`${where}: range must be [min, max] with whole numbers and min <= max`);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseFake(kind: unknown, days: unknown, where: string): MaskOperation {
  const known = FAKE_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw maskError(
      `${where}: unknown fake kind ${JSON.stringify(kind)}; use ${FAKE_KINDS.join(", ")}`,
    );
  }
  if (days === undefined) return { kind: "fake", fake: known, options: {} };
  if (known !== "date-shift" || typeof days !== "number" || !Number.isInteger(days) || days < 1) {
    throw maskError(
      `${where}: days applies to date-shift only and must be a whole number of at least 1`,
    );
  }
  return { kind: "fake", fake: known, options: { days } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maskError(problem: string): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", `Invalid mask config: ${problem}.`, {
    hint: "See docs/guides/staging-data.md for the mask file format.",
  });
}
