/**
 * Applying a mask config to documents, and reporting what it did.
 *
 *   const mask = compileMask(config, { logger });   // validates everything up front
 *   const users = mask.forNamespace("app.users");   // undefined: no rule applies
 *   users?.apply(document);                         // masks in place
 *   mask.finish();                                  // warns about rules that never matched
 *   mask.report();                                  // per-rule counts, for the copy result
 *
 * Which rules apply to a namespace: every rule whose pattern matches it. When several
 * patterns have a rule for the SAME path, the most specific wins: an exact namespace
 * beats a pattern with `*`, then the first one declared wins. So
 * `"*.*": { email: { fake: "email" } }` plus `"app.admins": { email: "keep" }` masks
 * every email except the admins'.
 *
 * How operations treat values:
 * - `hash`, `fake`, `redact` work on leaf values and go into arrays element by element
 *   (`tags: "hash"` hashes every tag). `null` and missing values are left alone.
 * - `null`, `drop` and custom functions get the whole value at the path.
 * - A type an operation cannot handle follows `onUnsupported` (warn and keep by default).
 *
 * THE DETERMINISM GUARANTEE: with the same secret, `hash` and `fake` map equal input
 * values to equal outputs regardless of namespace, path, document or run. Masking both
 * sides of a reference with the same operation (`users._id: "hash"` and
 * `orders.userId: "hash"`) therefore keeps every reference pointing at the right document.
 */

import type { Document } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import {
  describeOperation,
  type MaskConfig,
  type MaskFunctionContext,
  type MaskOperation,
  needsSecret,
  type ParsedRule,
  parseMaskRules,
  selectRulesForNamespace,
  type UnsupportedValuePolicy,
} from "./config.ts";
import { type FakeKind, type FakeOptions, fakeValue } from "./fake.ts";
import { type HashOptions, hashValue, UNSUPPORTED } from "./hash.ts";
import { deriveMaskKeys, type MaskKeys } from "./keyed.ts";
import { REMOVE, visitPath } from "./paths.ts";
import { bsonTypeName, isEmbeddedDocument } from "./values.ts";

/** What one rule did during a run. */
export interface MaskRuleReport {
  /** The namespace pattern the rule was declared under. */
  readonly pattern: string;
  readonly path: string;
  /** `hash`, `hash[18..90]`, `fake:email`, `redact`, `null`, `drop`, `keep` or `custom`. */
  readonly operation: string;
  /** Namespaces the rule applied to (sorted). */
  readonly namespaces: readonly string[];
  /** Values the path selected (0 means the rule never matched anything). */
  readonly values: number;
  /** Values left as they were (or nulled) because of their type, by type name. */
  readonly unsupported: Readonly<Record<string, number>>;
}

/** What masking did during a run. */
export interface MaskReport {
  readonly rules: readonly MaskRuleReport[];
}

/** Options for `compileMask`. */
export interface CompileMaskOptions {
  /** Receives warnings (unsupported values, rules that never matched). */
  readonly logger?: Logger | undefined;
}

/** Masks the documents of one namespace. */
export interface NamespaceMask {
  /** The source namespace. */
  readonly ns: string;
  /** Short descriptions of the rules, `path: operation`, for plans. */
  readonly summary: readonly string[];
  /** Masks `document` in place and returns it. */
  apply(document: Document): Document;
}

/** A compiled mask config. */
export interface Mask {
  /** The masker for a namespace, or `undefined` when no rule applies to it. */
  forNamespace(ns: string): NamespaceMask | undefined;
  /** Logs a warning for every rule that never matched a value. Call once, at the end. */
  finish(): void;
  report(): MaskReport;
}

/** Running counts of one rule. */
interface RuleState {
  readonly rule: ParsedRule;
  readonly namespaces: Set<string>;
  values: number;
  readonly unsupported: Map<string, number>;
}

/**
 * Validates a mask config and prepares it for use.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for invalid rules, or a missing or
 *   too short secret when a rule needs one.
 */
export function compileMask(config: MaskConfig, options: CompileMaskOptions = {}): Mask {
  const rules = parseMaskRules(config);
  const logger = options.logger ?? silentLogger;
  const keys = needsSecret(rules) ? requireKeys(config.secret) : undefined;
  const policy: UnsupportedValuePolicy = config.onUnsupported ?? "warn";
  const states = rules.map(
    (rule): RuleState => ({
      rule,
      namespaces: new Set(),
      values: 0,
      unsupported: new Map(),
    }),
  );
  const cache = new Map<string, NamespaceMask | undefined>();

  return {
    forNamespace(ns) {
      if (!cache.has(ns)) {
        const applicable = rulesFor(states, ns);
        cache.set(
          ns,
          applicable.length === 0
            ? undefined
            : createNamespaceMask(ns, applicable, { keys, policy, logger }),
        );
      }
      return cache.get(ns);
    },
    finish() {
      for (const state of states) warnIfUnmatched(state, logger);
    },
    report() {
      return { rules: states.map(reportRule) };
    },
  };
}

/** The secret, turned into keys, or an error explaining where to put it. */
function requireKeys(secret: string | undefined): MaskKeys {
  if (secret === undefined || secret === "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The mask uses hash or fake rules, which need a secret, and none was given.",
      {
        hint: "Set `secret: process.env.MASK_SECRET` in the mask file, or the MONGOSHIELD_MASK_SECRET environment variable (generate one with `openssl rand -base64 32`).",
      },
    );
  }
  return deriveMaskKeys(secret);
}

/** The rules for one namespace (see `selectRulesForNamespace`), with their running counts. */
function rulesFor(states: readonly RuleState[], ns: string): RuleState[] {
  const chosen = selectRulesForNamespace(states, ns, (state) => state.rule);
  for (const state of chosen) state.namespaces.add(ns);
  return chosen;
}

/** What applying operations needs besides the rule. */
interface ApplyContext {
  readonly keys: MaskKeys | undefined;
  readonly policy: UnsupportedValuePolicy;
  readonly logger: Logger;
}

function createNamespaceMask(
  ns: string,
  states: readonly RuleState[],
  context: ApplyContext,
): NamespaceMask {
  return {
    ns,
    summary: states.map(
      (state) => `${state.rule.path}: ${describeOperation(state.rule.operation)}`,
    ),
    apply(document) {
      for (const state of states) {
        state.values += visitPath(document, state.rule.segments, (value, location) =>
          applyOperation(value, { ns, location, document, state, context }),
        );
      }
      return document;
    },
  };
}

/** Where a value is being masked. */
interface ValueSite {
  readonly ns: string;
  readonly location: string;
  readonly document: Document;
  readonly state: RuleState;
  readonly context: ApplyContext;
}

/** Applies a rule's operation to the value at one location. Returns the replacement. */
function applyOperation(value: unknown, site: ValueSite): unknown {
  const operation = site.state.rule.operation;
  switch (operation.kind) {
    case "keep":
      return value;
    case "null":
      return null;
    case "drop":
      return REMOVE;
    case "custom":
      return applyCustom(operation.mask, value, site);
    case "redact":
    case "hash":
    case "fake":
      return applyToLeaves(value, operation, site);
  }
}

/** Leaf operations go into arrays element by element; `null`s stay `null`. */
function applyToLeaves(value: unknown, operation: LeafOperation, site: ValueSite): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((element) => applyToLeaves(element, operation, site));
  if (operation.kind === "redact") return operation.text;

  const masked = isEmbeddedDocument(value) ? UNSUPPORTED : maskLeaf(value, operation, site.context);
  return masked === UNSUPPORTED ? handleUnsupported(value, site) : masked;
}

type LeafOperation = Extract<MaskOperation, { kind: "redact" | "hash" | "fake" }>;

function maskLeaf(
  value: unknown,
  operation: Extract<MaskOperation, { kind: "hash" | "fake" }>,
  context: ApplyContext,
): unknown {
  const keys = context.keys;
  // compileMask derives keys whenever a hash or fake rule exists.
  if (keys === undefined) throw new MongoShieldError("MS_INTERNAL", "Mask keys are missing.");
  return operation.kind === "hash"
    ? hashValue(value, keys, operation.options)
    : fakeValue(value, operation.fake, keys, operation.options);
}

/** Follows the `onUnsupported` policy for a value of a type the rule cannot mask. */
function handleUnsupported(value: unknown, site: ValueSite): unknown {
  const type = bsonTypeName(value);
  const { state, context } = site;
  const operation = describeOperation(state.rule.operation);
  if (context.policy === "fail") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Mask rule "${state.rule.pattern} → ${state.rule.path}" (${operation}) cannot mask a ${type} value in ${site.ns} at ${site.location}.`,
      {
        hint: "Change the rule (e.g. use redact, null or a custom function) or set onUnsupported.",
      },
    );
  }
  const seen = state.unsupported.get(type) ?? 0;
  state.unsupported.set(type, seen + 1);
  if (seen === 0) {
    context.logger.warn(
      context.policy === "null"
        ? "A mask rule met a value type it cannot mask; replaced with null"
        : "A mask rule met a value type it cannot mask; left unchanged",
      { ns: site.ns, rule: `${state.rule.pattern} → ${state.rule.path}`, operation, type },
    );
  }
  return context.policy === "null" ? null : value;
}

/** Runs a custom function with its helpers. Errors stop the copy (fail closed). */
function applyCustom(
  mask: (value: unknown, context: MaskFunctionContext) => unknown,
  value: unknown,
  site: ValueSite,
): unknown {
  const helpers: MaskFunctionContext = {
    ns: site.ns,
    path: site.location,
    document: site.document,
    hash: (input: unknown, options: HashOptions = {}) =>
      strictly(maskLeaf(input, { kind: "hash", options }, site.context), "hash", input),
    fake: (kind: FakeKind, input: unknown, options: FakeOptions = {}) =>
      strictly(maskLeaf(input, { kind: "fake", fake: kind, options }, site.context), kind, input),
  };
  let result: unknown;
  try {
    result = mask(value, helpers);
  } catch (error) {
    const rule = site.state.rule;
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The custom mask "${rule.pattern} → ${rule.path}" failed on ${site.ns} at ${site.location}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, hint: "Fix the function in the mask file; nothing unmasked was written." },
    );
  }
  return result === undefined ? REMOVE : result;
}

/** Inside custom functions, an unsupported value is an error: the author must decide. */
function strictly(result: unknown, operation: string, input: unknown): unknown {
  if (result !== UNSUPPORTED) return result;
  throw new Error(`${operation} cannot mask a ${bsonTypeName(input)} value`);
}

function warnIfUnmatched(state: RuleState, logger: Logger): void {
  if (state.values > 0) return;
  const rule = `${state.rule.pattern} → ${state.rule.path}`;
  if (state.namespaces.size === 0) {
    logger.warn("A mask rule's pattern matched no copied namespace", { rule });
  } else {
    logger.warn("A mask rule never matched any document; check the field path", {
      rule,
      namespaces: [...state.namespaces].sort(),
    });
  }
}

function reportRule(state: RuleState): MaskRuleReport {
  return {
    pattern: state.rule.pattern,
    path: state.rule.path,
    operation: describeOperation(state.rule.operation),
    namespaces: [...state.namespaces].sort(),
    values: state.values,
    unsupported: Object.fromEntries(state.unsupported),
  };
}
