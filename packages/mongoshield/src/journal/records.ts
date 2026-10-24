/**
 * The small records of the change journal (docs/specs/JOURNAL.md):
 *
 * - `journal/state.json`: the writer's commit point. A segment counts as part of the
 *   journal once `state.json` names it (or a later segment). Rewritten after every
 *   segment.
 * - `journal/gaps/<from>.json`: a recorded gap, where change history was lost. Written
 *   once, never pruned automatically.
 * - The header and trailer documents that open and close every segment (BSON, inside
 *   the segment, so they are compressed and encrypted with it).
 *
 *   segment = header { op: "segment", formatVersion, from, previous }
 *             event … event                     (raw change events, as the server sent them)
 *             trailer { op: "segment-end", to, events }
 *
 * `previous` is the SHA-256 of the previous segment's stored bytes (null for the first
 * segment ever written). That chains the segments: a missing, reordered or altered
 * segment breaks the chain, which every reader checks.
 */

import { BSON, type Document, Int32, Long, Timestamp } from "mongodb";
import { z } from "zod";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { type ClusterTime, ClusterTimeSchema } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { readStreamToBuffer } from "../util/streams.ts";
import { gapKey, STATE_KEY } from "./layout.ts";

/** Version of `state.json`, gap records and segment headers. */
export const JOURNAL_FORMAT_VERSION = 1;

/** State files and gap records are tiny; anything bigger is not one of ours. */
const MAX_RECORD_BYTES = 1024 * 1024;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 digest");
const isoDate = z.iso.datetime({ offset: true });

/** A committed segment, as `state.json` records the newest one. */
export const CommittedSegmentSchema = z.object({
  key: z.string().min(1),
  from: ClusterTimeSchema,
  to: ClusterTimeSchema,
  /** Size in bytes of the stored object. */
  size: z.number().int().nonnegative(),
  /** SHA-256 of the stored bytes: the next segment's `previous`. */
  sha256: sha256Hex,
  /** Change events in the segment (header and trailer not counted). */
  events: z.number().int().nonnegative(),
});

/** `journal/state.json`. */
export const JournalStateSchema = z.object({
  formatVersion: z.literal(JOURNAL_FORMAT_VERSION),
  /** Every change up to and including this cluster time is in a committed segment. */
  recoveryPoint: ClusterTimeSchema,
  lastSegment: CommittedSegmentSchema,
  /** Running totals over every segment ever committed (pruning does not lower them). */
  totals: z.object({
    segments: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  }),
  updatedAt: isoDate,
  /** The writer that committed last. Never secrets. */
  writer: z.object({ host: z.string(), pid: z.number().int() }),
});

/** `journal/gaps/<from>.json`. */
export const GapRecordSchema = z.object({
  formatVersion: z.literal(JOURNAL_FORMAT_VERSION),
  /** The last cluster time the journal covered before the gap (its recovery point). */
  from: ClusterTimeSchema,
  /** Where the journal starts again: events in `(from, to]` are lost. */
  to: ClusterTimeSchema,
  detectedAt: isoDate,
  /** What the server said, for the operator. */
  reason: z.string(),
  /** What the writer did about it (`onGap`). */
  action: z.enum(["backup", "fail"]),
});

/** A committed segment (see {@link CommittedSegmentSchema}). */
export type CommittedSegment = z.infer<typeof CommittedSegmentSchema>;
/** The content of `journal/state.json` (see {@link JournalStateSchema}). */
export type JournalState = z.infer<typeof JournalStateSchema>;
/** A recorded gap (see {@link GapRecordSchema}). */
export type GapRecord = z.infer<typeof GapRecordSchema>;

// ---------------------------------------------------------------------------
// state.json and gap records
// ---------------------------------------------------------------------------

/**
 * Reads `journal/state.json`; `undefined` when there is none yet (no segment was ever
 * committed).
 *
 * @throws MongoShieldError `MS_MANIFEST_INVALID` when it exists but is malformed.
 */
export async function readJournalState(
  storage: StorageAdapter,
  signal?: AbortSignal,
): Promise<JournalState | undefined> {
  const text = await readSmallObject(storage, STATE_KEY, signal);
  if (text === undefined) return undefined;
  return parseRecord(JournalStateSchema, text, STATE_KEY);
}

/** Writes `journal/state.json` (an atomic overwrite: readers see the old or the new one). */
export async function writeJournalState(
  storage: StorageAdapter,
  state: JournalState,
  signal?: AbortSignal,
): Promise<void> {
  await putJson(storage, STATE_KEY, state, signal);
}

/** Every gap record, oldest first. Malformed ones fail: a gap must never be overlooked. */
export async function readGapRecords(
  storage: StorageAdapter,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<GapRecord[]> {
  const gaps: GapRecord[] = [];
  for (const key of keys) {
    const text = await readSmallObject(storage, key, signal);
    if (text !== undefined) gaps.push(parseRecord(GapRecordSchema, text, key));
  }
  return gaps;
}

/** Writes a gap record (keyed by where the gap starts). */
export async function writeGapRecord(
  storage: StorageAdapter,
  gap: GapRecord,
  signal?: AbortSignal,
): Promise<void> {
  await putJson(storage, gapKey(gap.from), gap, signal);
}

async function putJson(
  storage: StorageAdapter,
  key: string,
  value: unknown,
  signal: AbortSignal | undefined,
): Promise<void> {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await storage.put(key, body, {
    contentType: "application/json",
    sizeHint: body.length,
    ...(signal === undefined ? {} : { signal }),
  });
}

async function readSmallObject(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const body = await storage.get(key, signal === undefined ? {} : { signal });
    const bytes = await readStreamToBuffer(body, { maxBytes: MAX_RECORD_BYTES });
    return bytes.toString("utf8");
  } catch (error) {
    if (isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")) return undefined;
    throw error;
  }
}

function parseRecord<Schema extends z.ZodType>(
  schema: Schema,
  text: string,
  key: string,
): z.infer<Schema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw invalidRecord(key, "it is not valid JSON", error);
  }
  const result = schema.safeParse(json);
  if (!result.success) throw invalidRecord(key, z.prettifyError(result.error));
  return result.data;
}

function invalidRecord(key: string, problem: string, cause?: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_MANIFEST_INVALID",
    `The journal record ${key} is malformed: ${problem}`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint: "Do not edit journal records by hand. Restore the object from a copy, or ask for help.",
    },
  );
}

// ---------------------------------------------------------------------------
// Segment header and trailer
// ---------------------------------------------------------------------------

/** The first document of every segment. */
export interface SegmentHeader {
  readonly from: ClusterTime;
  /** SHA-256 (hex) of the previous segment's stored bytes; null for the very first. */
  readonly previous: string | null;
}

/** The last document of every segment. */
export interface SegmentTrailer {
  /** The segment holds every journaled event in `(from, to]`. */
  readonly to: ClusterTime;
  readonly events: number;
}

/** The BSON bytes of a segment header. */
export function encodeSegmentHeader(header: SegmentHeader): Buffer {
  return Buffer.from(
    BSON.serialize({
      op: "segment",
      formatVersion: JOURNAL_FORMAT_VERSION,
      from: new Timestamp(header.from),
      previous: header.previous,
    }),
  );
}

/** The BSON bytes of a segment trailer. */
export function encodeSegmentTrailer(trailer: SegmentTrailer): Buffer {
  return Buffer.from(
    BSON.serialize({
      op: "segment-end",
      to: new Timestamp(trailer.to),
      // A Long, so a huge count never silently becomes a double.
      events: Long.fromNumber(trailer.events),
    }),
  );
}

/**
 * Parses a segment's first document.
 *
 * @throws MongoShieldError `MS_INTEGRITY_FAILED` when it is not a segment header,
 *   `MS_FORMAT_UNSUPPORTED` for a newer format version.
 */
export function parseSegmentHeader(raw: Uint8Array, key: string): SegmentHeader {
  const document = deserialize(raw, key);
  if (document.op !== "segment")
    throw malformedSegment(key, "it does not start with a segment header");
  const version = numberOf(document.formatVersion);
  if (version !== JOURNAL_FORMAT_VERSION) {
    throw new MongoShieldError(
      "MS_FORMAT_UNSUPPORTED",
      `Journal segment ${key} uses format version ${String(version)}; this release reads version ${JOURNAL_FORMAT_VERSION}.`,
      { hint: "Upgrade MongoShield to read this journal." },
    );
  }
  const from = clusterTimeOf(document.from);
  const previous: unknown = document.previous;
  if (from === undefined) throw malformedSegment(key, "its header has no start time");
  if (previous !== null && (typeof previous !== "string" || !/^[0-9a-f]{64}$/.test(previous))) {
    throw malformedSegment(key, "its header has an invalid previous-segment digest");
  }
  return { from, previous };
}

/**
 * Parses a document that may be a segment trailer: returns it, or `undefined` for any
 * other document (a change event).
 *
 * @throws MongoShieldError `MS_INTEGRITY_FAILED` for a malformed trailer.
 */
export function parseSegmentTrailer(document: Document, key: string): SegmentTrailer | undefined {
  if (document.op !== "segment-end") return undefined;
  const to = clusterTimeOf(document.to);
  const events = numberOf(document.events);
  if (to === undefined || events === undefined)
    throw malformedSegment(key, "its trailer is malformed");
  return { to, events };
}

/** Malformed segment content. Exported for the reader. */
export function malformedSegment(key: string, problem: string, cause?: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_INTEGRITY_FAILED",
    `Journal segment ${key} is damaged: ${problem}.`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint: "Run `mongoshield journal status` to see the journal's covered ranges; restore to a time before this segment, or from a newer base backup.",
    },
  );
}

function deserialize(raw: Uint8Array, key: string): Document {
  try {
    return BSON.deserialize(raw);
  } catch (error) {
    throw malformedSegment(key, "a document is not valid BSON", error);
  }
}

function clusterTimeOf(value: unknown): ClusterTime | undefined {
  return value instanceof Timestamp ? { t: value.t, i: value.i } : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value instanceof Int32) return value.valueOf();
  if (value instanceof Long) return value.toNumber();
  return undefined;
}
