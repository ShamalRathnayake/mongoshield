/**
 * Checkpoints of resumable copies (`checkpoint` + `resume`, CLI `--resume`).
 *
 * A checkpoint is a small JSON file ON THE MACHINE RUNNING THE COPY, rewritten as the
 * copy goes and deleted when it completes. It records, per namespace: whether its
 * target was created (and the target collection's UUID), the `_id` ranges ("parts")
 * its documents are read in, and for each part the last `_id` known to be written.
 * An interrupted copy continues every unfinished part from there.
 *
 * Why a local file and not a collection in the target: the recorded `_id`s are SOURCE
 * values (part boundaries are sampled from the source, and the progress `_id` is read
 * before masking). A masked copy exists to keep exactly such values out of the target
 * (an `_id` may be an email address), and a subset copy must not reveal `_id`s of
 * documents it left out. A local file also adds nothing that applications, backups or
 * the next copy of the target would see, and needs no extra privileges there. The cost:
 * the resuming run needs the file (the CLI keeps it under `.mongoshield/` in the
 * working directory; `--checkpoint <file>` puts it elsewhere, e.g. on a shared volume).
 *
 * Resuming must produce exactly what one uninterrupted run would have, so:
 * - the options that shape the copy (patterns, renames, mode, mask rules and secret,
 *   follow rules, skipIndexes) are fingerprinted and must not change; the mask secret
 *   only as an HMAC, never in clear;
 * - the subset FILTERS are stored and reused, so a filter computed from the clock
 *   (`new Date(Date.now() - 30 * DAY)`) selects the same slice on every run;
 * - every target and source collection must still be the one the checkpoint knew
 *   (UUIDs), or the recorded progress means nothing.
 *
 * The file holds `_id` values and filters, which may be customer data, so it is
 * written with owner-only permissions (0600).
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Binary, type Document, type MongoClient } from "mongodb";
import { z } from "zod";
import { fromCanonical, type PartBound, toCanonical } from "../engine/backup-parts.ts";
import { MongoShieldError } from "../errors.ts";
import { parseJsonInStoredOrder, stringifyJsonInStoredOrder } from "../format/ordered-json.ts";
import type { Logger } from "../logger.ts";
import type { MaskConfig } from "../mask/index.ts";
import { hmac } from "../mask/keyed.ts";
import { isEmbeddedDocument } from "../mask/values.ts";
import { splitNamespace } from "../mongo/index.ts";
import type { SubsetConfig } from "../subset/index.ts";
import type { CopyOptions } from "../types.ts";

/** Identifies the file format; a reader refuses anything else. */
export const COPY_CHECKPOINT_FORMAT = "mongoshield-copy-checkpoint";

/** Version of the checkpoint shape. */
export const COPY_CHECKPOINT_VERSION = 1;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** `{ value }` in canonical Extended JSON, or null for an open end / no progress yet. */
const BoundSchema = z.object({ value: z.unknown() }).nullable();

/** One `_id` range of a namespace's selected documents. */
const PartStateSchema = z.object({
  /** Inclusive lower bound. */
  lower: BoundSchema,
  /** Exclusive upper bound. */
  upper: BoundSchema,
  /** The last `_id` of the part known to be written (documents are read in `_id` order). */
  last: BoundSchema,
  done: z.boolean(),
});

const NamespaceStateSchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  type: z.enum(["collection", "view", "timeseries"]),
  /** The action the first run chose; a resumed run keeps it. */
  action: z.enum(["create", "drop-and-create", "insert", "upsert", "skip"]),
  /** UUIDs (32 hex characters) of the source and of the target the copy wrote. */
  sourceUuid: z.string().nullable(),
  targetUuid: z.string().nullable(),
  /** The target was dropped and/or created as `action` says. */
  prepared: z.boolean(),
  /**
   * Parts are read in `_id` order through the `_id` index, so a part can continue
   * after its `last` `_id`. Otherwise (no `_id` index, e.g. time series) an unfinished
   * namespace is copied again as a whole.
   */
  ordered: z.boolean(),
  /** The root documents (all, or the filter's) as `_id` ranges; empty until planned. */
  parts: z.array(PartStateSchema),
  rootsDone: z.boolean(),
  /** Indexes built (collections) or the view created. */
  finished: z.boolean(),
});

/** The options that must not change between the runs of one copy. */
const FingerprintSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  rename: z.record(z.string(), z.string()),
  mode: z.string(),
  /** SHA-256 of the mask rules, policy and an HMAC of the secret; null without a mask. */
  mask: z.string().nullable(),
  /** SHA-256 of the follow rules; null without any. */
  follow: z.string().nullable(),
  skipIndexes: z.boolean(),
});

const CopyCheckpointSchema = z.object({
  format: z.literal(COPY_CHECKPOINT_FORMAT),
  version: z.literal(COPY_CHECKPOINT_VERSION),
  startedAt: z.string(),
  updatedAt: z.string(),
  fingerprint: FingerprintSchema,
  /** The subset filters of the first run, per source namespace, canonical Extended JSON. */
  filters: z.record(z.string(), z.unknown()),
  namespaces: z.array(NamespaceStateSchema),
  /** Every referenced document has been followed and copied. */
  referencesDone: z.boolean(),
});

/** The content of a checkpoint file. */
export type CopyCheckpoint = z.infer<typeof CopyCheckpointSchema>;
/** One namespace of a checkpoint. */
export type NamespaceState = z.infer<typeof NamespaceStateSchema>;
/** One part of a namespace. */
export type PartState = z.infer<typeof PartStateSchema>;
/** The options a resumed copy must share with the interrupted one. */
export type CopyFingerprint = z.infer<typeof FingerprintSchema>;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** The fingerprint of the options that shape a copy. */
export function copyFingerprint(
  options: Pick<
    CopyOptions,
    "include" | "exclude" | "rename" | "mode" | "mask" | "subset" | "skipIndexes"
  >,
): CopyFingerprint {
  return {
    include: sortedUnique(options.include ?? []),
    exclude: sortedUnique(options.exclude ?? []),
    rename: { ...options.rename },
    mode: options.mode ?? "fail-if-exists",
    mask: maskDigest(options.mask),
    follow: followDigest(options.subset),
    skipIndexes: options.skipIndexes === true,
  };
}

/** Readable names of the fingerprint fields that differ, e.g. `["mask rules or secret"]`. */
export function fingerprintDifferences(
  expected: CopyFingerprint,
  actual: CopyFingerprint,
): string[] {
  const fields: readonly (readonly [keyof CopyFingerprint, string])[] = [
    ["include", "--include"],
    ["exclude", "--exclude"],
    ["rename", "--rename"],
    ["mode", "--mode"],
    ["mask", "the mask rules or secret"],
    ["follow", "the subset's follow rules"],
    ["skipIndexes", "--skip-indexes"],
  ];
  const differences: string[] = [];
  for (const [field, label] of fields) {
    if (JSON.stringify(expected[field]) !== JSON.stringify(actual[field])) differences.push(label);
  }
  return differences;
}

/**
 * Mask rules in declaration order (it decides precedence), custom functions by their
 * source text, and an HMAC of the secret: a different secret gives different masked
 * values, and the secret itself must never be written down.
 */
function maskDigest(mask: MaskConfig | undefined): string | null {
  if (mask === undefined) return null;
  const rules = Object.entries(mask.rules).map(([pattern, fields]) => [
    pattern,
    Object.entries(fields).map(([path, rule]) => [
      path,
      typeof rule === "function" ? `function:${String(rule)}` : rule,
    ]),
  ]);
  const secret =
    mask.secret === undefined || mask.secret === ""
      ? null
      : hmac(mask.secret, "mongoshield/copy-checkpoint/v1/secret").toString("hex");
  return sha256(JSON.stringify({ rules, onUnsupported: mask.onUnsupported ?? "warn", secret }));
}

/** The follow rules decide which documents are copied; `batchSize` only how. */
function followDigest(subset: SubsetConfig | undefined): string | null {
  const follow = subset?.follow ?? [];
  return follow.length === 0 ? null : sha256(JSON.stringify(follow));
}

// ---------------------------------------------------------------------------
// Subset filters
// ---------------------------------------------------------------------------

/** The subset filters as stored in a checkpoint. */
export function canonicalFilters(subset: SubsetConfig | undefined): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const [ns, filter] of Object.entries(subset?.filters ?? {})) {
    stored[ns] = toCanonical(filter);
  }
  return stored;
}

/**
 * The subset to use when resuming: the given one with the FIRST run's filters, so the
 * same documents are selected (see the file header). Logs when the filters differ.
 */
export function subsetForResume(
  subset: SubsetConfig | undefined,
  checkpoint: CopyCheckpoint,
  logger: Logger,
): SubsetConfig | undefined {
  const stored = checkpoint.filters;
  if (JSON.stringify(canonicalFilters(subset)) !== JSON.stringify(stored)) {
    logger.warn(
      "The subset filters differ from those of the interrupted copy (computed from the clock?); the interrupted copy's filters are used, so the slice stays consistent",
    );
  }
  const filters: Record<string, Document> = {};
  for (const [ns, filter] of Object.entries(stored)) {
    const value = fromCanonical(filter);
    if (isEmbeddedDocument(value)) filters[ns] = value;
  }
  if (subset === undefined && Object.keys(filters).length === 0) return undefined;
  return { ...subset, filters };
}

// ---------------------------------------------------------------------------
// Parts and bounds
// ---------------------------------------------------------------------------

/**
 * A part bound for the checkpoint: canonical Extended JSON, exact types kept, and the
 * stored field order of an embedded-document `_id` recorded. The file is written and
 * read with the order-keeping JSON functions (src/format/ordered-json.ts), so a resumed
 * copy continues exactly where the interrupted one stopped: in JavaScript order such
 * an `_id` is another value, elsewhere in the `_id` order.
 */
export function storedBound(bound: PartBound): PartState["lower"] {
  return bound === undefined ? null : { value: toCanonical(bound.value) };
}

/** The inverse of `storedBound`. */
export function partBound(stored: PartState["lower"]): PartBound {
  return stored === null ? undefined : { value: fromCanonical(stored.value) };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * Reads a checkpoint, or `undefined` when the file does not exist.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the file is not a copy checkpoint
 *   of a version this release understands.
 */
export async function readCopyCheckpoint(path: string): Promise<CopyCheckpoint | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new MongoShieldError("MS_CONFIG_INVALID", `Cannot read the copy checkpoint ${path}.`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    // Records the stored order of `_id` bounds and filters (see `storedBound`).
    parsed = parseJsonInStoredOrder(text);
  } catch (error) {
    throw invalidCheckpoint(path, error);
  }
  const result = CopyCheckpointSchema.safeParse(parsed);
  if (!result.success) throw invalidCheckpoint(path, result.error);
  return result.data;
}

/** A new, empty checkpoint for a copy that starts now. */
export function newCopyCheckpoint(
  fingerprint: CopyFingerprint,
  filters: Record<string, unknown>,
  now: Date = new Date(),
): CopyCheckpoint {
  return {
    format: COPY_CHECKPOINT_FORMAT,
    version: COPY_CHECKPOINT_VERSION,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    fingerprint,
    filters,
    namespaces: [],
    referencesDone: false,
  };
}

/**
 * Keeps a checkpoint file up to date while a copy runs.
 *
 * `save()` never waits and never piles up writes: a write in flight is followed by at
 * most one more, with whatever the state is by then. That is safe because the state
 * only ever records what is already written to the target, so any snapshot of it is
 * a valid place to resume from. `flush()` waits until the latest state is on disk.
 * Each write goes to a temporary file that is then renamed over the checkpoint, so a
 * crash mid-write leaves the previous checkpoint intact.
 */
export class CheckpointFile {
  readonly path: string;
  readonly state: CopyCheckpoint;
  readonly #logger: Logger;
  #writing: Promise<void> | undefined;
  #dirty = false;
  #failure: unknown;

  constructor(path: string, state: CopyCheckpoint, logger: Logger) {
    this.path = path;
    this.state = state;
    this.#logger = logger;
  }

  /** The state of namespace `from`, created (not prepared, nothing copied) if new. */
  namespace(from: string, create: () => NamespaceState): NamespaceState {
    const existing = this.state.namespaces.find((candidate) => candidate.from === from);
    if (existing !== undefined) return existing;
    const created = create();
    this.state.namespaces.push(created);
    return created;
  }

  /** Schedules a write of the current state (see the class comment). */
  save(): void {
    this.#dirty = true;
    if (this.#writing === undefined) this.#writing = this.#writeWhileDirty();
  }

  /**
   * Waits until the current state is on disk.
   *
   * @throws MongoShieldError `MS_CONFIG_INVALID` when the file cannot be written.
   */
  async flush(): Promise<void> {
    this.save();
    await this.#writing;
    if (this.#failure !== undefined) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Cannot write the copy checkpoint ${this.path}.`,
        {
          cause: this.#failure,
          hint: "Check that the directory is writable, or choose another file with --checkpoint.",
        },
      );
    }
  }

  /** Deletes the file once the copy is complete. Never throws: failures are logged. */
  async remove(): Promise<void> {
    await this.#writing;
    try {
      await rm(this.path, { force: true });
    } catch (error) {
      this.#logger.warn("Could not delete the copy checkpoint; delete it by hand", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #writeWhileDirty(): Promise<void> {
    try {
      while (this.#dirty) {
        this.#dirty = false;
        this.state.updatedAt = new Date().toISOString();
        // Order-keeping JSON for the `_id` bounds and filters (see `storedBound`).
        await writeAtomically(this.path, `${stringifyJsonInStoredOrder(this.state, 2)}\n`);
      }
    } catch (error) {
      // Remembered for flush(): a copy must not report success with a stale checkpoint,
      // but a failed background write must not crash the process either.
      this.#failure = error;
    } finally {
      this.#writing = undefined;
    }
  }
}

/** Writes a temporary file next to `path`, then renames it over `path`. */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Checking that the deployments are still the ones the checkpoint knew
// ---------------------------------------------------------------------------

/**
 * The UUID of a collection as 32 lowercase hex characters, or `undefined` when it does
 * not exist. A time series reports its UUID on the backing `system.buckets.<name>`.
 */
export async function collectionUuid(client: MongoClient, ns: string): Promise<string | undefined> {
  const { database, collection } = splitNamespace(ns);
  const buckets = `system.buckets.${collection}`;
  const infos = await client
    .db(database)
    .listCollections({ name: { $in: [collection, buckets] } }, { nameOnly: false })
    .toArray();
  const own = infos.find((info) => info.name === collection);
  if (own === undefined) return undefined;
  const bucket = infos.find((info) => info.name === buckets);
  return uuidHex(own.info?.uuid) ?? uuidHex(bucket?.info?.uuid);
}

/**
 * Checks that every target the checkpoint created or wrote is still the same
 * collection, so the recorded progress describes what is really there.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` naming the targets that changed.
 */
export async function assertTargetsUnchanged(
  client: MongoClient,
  checkpoint: CopyCheckpoint,
): Promise<void> {
  const changed: string[] = [];
  for (const state of checkpoint.namespaces) {
    if (!state.prepared || state.targetUuid === null) continue;
    const uuid = await collectionUuid(client, state.to);
    if (uuid !== state.targetUuid) changed.push(state.to);
  }
  if (changed.length === 0) return;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The interrupted copy cannot be resumed: ${changed.join(", ")} was dropped or replaced since.`,
    { hint: "Copy again without --resume (with --drop to replace the partial targets)." },
  );
}

/** The `info.uuid` of a `listCollections` entry as lowercase hex. */
function uuidHex(uuid: unknown): string | undefined {
  return uuid instanceof Binary ? uuid.toString("hex").toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function invalidCheckpoint(path: string, cause: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_CONFIG_INVALID",
    `${path} is not a copy checkpoint this version of MongoShield can resume.`,
    { cause, hint: "Copy again without --resume; the checkpoint is replaced." },
  );
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
