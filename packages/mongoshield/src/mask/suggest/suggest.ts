/**
 * `suggestMasks`: sample a deployment's collections, detect personal data, and suggest
 * mask rules for `copy` / `pull`. The only part of the suggester that touches MongoDB.
 *
 *   discover namespaces (include/exclude) → for each collection, one at a time:
 *     $sample N documents (secondaryPreferred, maxTimeMS) → profile → classify
 *     → suggest rules, marking fields the current mask config already covers
 *
 * Gentle on production by design, since that is where it usually runs:
 * - READ ONLY: one `$sample` aggregation per collection; nothing is written anywhere.
 * - Bounded: at most `sampleSize` documents per collection (default 1000, at most
 *   10 000), and each sample is limited by `maxTimeMS` on the server.
 * - One collection at a time, so the load is one cursor, never a burst.
 * - Reads go to a secondary when there is one (`secondaryPreferred`).
 * - Views are skipped (their data is their source collection's); so are collections
 *   that are empty.
 *
 * `$sample` picks documents with a random cursor when the sample is under 5% of the
 * collection and otherwise scans and sorts randomly, so small collections are read in
 * full (that is cheap) and large ones are sampled without a collection scan.
 */

import { type Document, type MongoClient, MongoServerError, ReadPreference } from "mongodb";
import { MongoShieldError, throwIfAborted } from "../../errors.ts";
import { type Logger, silentLogger } from "../../logger.ts";
import { type CollectionSpec, discoverNamespaces } from "../../mongo/index.ts";
import type { NamespacePattern, ReadPreferenceModeName } from "../../types.ts";
import type { MaskConfig } from "../config.ts";
import { classifyProfiles, DEFAULT_MIN_CONFIDENCE } from "./classify.ts";
import { CollectionProfiler } from "./profile.ts";
import { newRules } from "./render.ts";
import {
  currentRules,
  type MaskSuggestion,
  type SuggestedMaskRule,
  suggestRules,
} from "./rules.ts";

/** Options of `suggestMasks`. */
export interface SuggestMasksOptions {
  readonly include?: readonly NamespacePattern[];
  readonly exclude?: readonly NamespacePattern[];
  /** Documents sampled per collection. Defaults to 1000; at most 10 000. */
  readonly sampleSize?: number;
  /**
   * The current mask config: fields its rules already mask are reported as `covered`
   * (or `kept` for `keep` rules) instead of `new`.
   */
  readonly mask?: MaskConfig;
  /** Findings below this confidence (0–1) are left out. Defaults to 0.5. */
  readonly minConfidence?: number;
  /** Where documents are read. Defaults to `"secondaryPreferred"`. */
  readonly readPreference?: ReadPreferenceModeName;
  /** Server-side time limit of each collection's sample, in milliseconds. Defaults to 30 000. */
  readonly maxTimeMS?: number;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
  /** Called before each collection is sampled, for progress output. */
  readonly onCollection?: (ns: string, index: number, total: number) => void;
}

/** What was found in one collection. */
export interface CollectionSuggestions {
  readonly ns: string;
  /** Documents sampled. */
  readonly documents: number;
  /** True when the collection had more distinct field paths than are profiled (1000). */
  readonly truncated: boolean;
  /** One per field with personal data, highest confidence first. */
  readonly suggestions: readonly MaskSuggestion[];
}

/** A namespace that was not sampled, and why. */
export interface SkippedNamespace {
  readonly ns: string;
  readonly reason: "view" | "empty";
}

/** The result of `suggestMasks`. */
export interface MaskSuggestionReport {
  /** Documents sampled per collection (at most). */
  readonly sampleSize: number;
  readonly minConfidence: number;
  /** Every sampled collection, also those where nothing was found (in namespace order). */
  readonly collections: readonly CollectionSuggestions[];
  readonly skipped: readonly SkippedNamespace[];
  /**
   * The `new` suggestions in the mask file format (namespace → path → rule), ready to
   * paste into a mask file's `rules` or pass to `defineMask`.
   */
  readonly rules: Readonly<Record<string, Readonly<Record<string, SuggestedMaskRule>>>>;
}

/** Default and limit of `SuggestMasksOptions.sampleSize`. */
export const DEFAULT_SAMPLE_SIZE = 1000;
export const MAX_SAMPLE_SIZE = 10_000;

/** Default of `SuggestMasksOptions.maxTimeMS`. */
export const DEFAULT_SAMPLE_TIME_MS = 30_000;

/** Documents fetched per round trip: small, so a slow network never holds much in memory. */
const SAMPLE_BATCH_SIZE = 200;

/** Server error codes: not authorized, and a query over its time limit. */
const UNAUTHORIZED_CODE = 13;
const MAX_TIME_EXPIRED_CODE = 50;

/**
 * Samples collections and suggests mask rules for the personal data found in them.
 * Read-only (see the file header). Never logs or returns raw values: examples are
 * masked shapes.
 *
 *   const report = await suggestMasks(client, { include: ["app.*"], mask: currentMask });
 *   const mask = defineMask({ secret, rules: { ...currentMask.rules, ...report.rules } });
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for invalid options, an invalid `mask`
 *   or patterns that match nothing; `MS_PERMISSION_DENIED` when the user may not read a
 *   collection; `MS_TIMEOUT` when a sample exceeds `maxTimeMS`; `MS_ABORTED`.
 */
export async function suggestMasks(
  client: MongoClient,
  options: SuggestMasksOptions = {},
): Promise<MaskSuggestionReport> {
  const sampleSize = validSampleSize(options.sampleSize);
  const minConfidence = validMinConfidence(options.minConfidence);
  // Validate the mask first: a typo in it should fail before any database work.
  const rules = currentRules(options.mask);
  const logger = options.logger ?? silentLogger;
  const specs = await discoverNamespaces(client, {
    include: options.include,
    exclude: options.exclude,
    signal: options.signal,
    logger,
  });
  if (specs.length === 0) throw nothingToSample(options);

  const collections: CollectionSuggestions[] = [];
  const skipped: SkippedNamespace[] = [];
  for (const [index, spec] of specs.entries()) {
    throwIfAborted(options.signal);
    if (spec.type === "view") {
      skipped.push({ ns: spec.ns, reason: "view" });
      continue;
    }
    options.onCollection?.(spec.ns, index, specs.length);
    const profiler = await sampleCollection(client, spec, { ...options, sampleSize });
    if (profiler.documents === 0) {
      skipped.push({ ns: spec.ns, reason: "empty" });
      continue;
    }
    const findings = classifyProfiles(profiler.profiles(), { minConfidence });
    collections.push({
      ns: spec.ns,
      documents: profiler.documents,
      truncated: profiler.truncated,
      suggestions: suggestRules(spec.ns, findings, rules),
    });
    logger.debug("Sampled a collection for personal data", {
      ns: spec.ns,
      documents: profiler.documents,
      findings: findings.length,
    });
  }
  return {
    sampleSize,
    minConfidence,
    collections,
    skipped,
    rules: newRules(collections),
  };
}

/** Samples one collection into a profiler. */
async function sampleCollection(
  client: MongoClient,
  spec: CollectionSpec,
  options: SuggestMasksOptions & { readonly sampleSize: number },
): Promise<CollectionProfiler> {
  const profiler = new CollectionProfiler(spec.name);
  const cursor = client
    .db(spec.db)
    .collection<Document>(spec.name)
    .aggregate([{ $sample: { size: options.sampleSize } }], {
      readPreference: new ReadPreference(options.readPreference ?? "secondaryPreferred"),
      maxTimeMS: options.maxTimeMS ?? DEFAULT_SAMPLE_TIME_MS,
      batchSize: Math.min(options.sampleSize, SAMPLE_BATCH_SIZE),
    });
  try {
    for await (const document of cursor) {
      throwIfAborted(options.signal);
      profiler.add(document);
    }
  } catch (error) {
    throw toSampleError(spec.ns, error);
  } finally {
    // Releases the server-side cursor when sampling stopped early; a no-op otherwise.
    await cursor.close().catch(() => undefined);
  }
  return profiler;
}

/** A driver error while sampling, as a MongoShieldError (aborts pass through). */
function toSampleError(ns: string, error: unknown): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof MongoServerError && error.code === UNAUTHORIZED_CODE) {
    return new MongoShieldError("MS_PERMISSION_DENIED", `Sampling ${ns} was refused: ${reason}`, {
      cause: error,
      hint: "The user needs `find` on the collections (the built-in `read` or `backup` role).",
    });
  }
  if (error instanceof MongoServerError && error.code === MAX_TIME_EXPIRED_CODE) {
    return new MongoShieldError("MS_TIMEOUT", `Sampling ${ns} took longer than allowed.`, {
      cause: error,
      hint: "Sample fewer documents (--sample), or allow more time (maxTimeMS in the API).",
    });
  }
  return new MongoShieldError("MS_CONNECTION_FAILED", `Sampling ${ns} failed: ${reason}`, {
    cause: error,
  });
}

function nothingToSample(options: SuggestMasksOptions): MongoShieldError {
  const hasPatterns = (options.include?.length ?? 0) + (options.exclude?.length ?? 0) > 0;
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    hasPatterns
      ? "No namespace matches the include/exclude patterns."
      : "The deployment has no namespaces to sample.",
    {
      hint: hasPatterns
        ? 'Check the patterns: they look like "app.*" or "app.users".'
        : "Check the connection string (database names are case-sensitive).",
    },
  );
}

function validSampleSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SAMPLE_SIZE;
  if (Number.isInteger(value) && value >= 1 && value <= MAX_SAMPLE_SIZE) return value;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The sample size must be a whole number from 1 to ${MAX_SAMPLE_SIZE}, got ${value}.`,
  );
}

function validMinConfidence(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MIN_CONFIDENCE;
  if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The minimum confidence must be a number from 0 to 1, got ${value}.`,
  );
}
