/**
 * Reading the journal back: the change events of a time range, in order, with every
 * segment of the range checked against the chain (docs/specs/JOURNAL.md).
 *
 *   storage.get → SHA-256 of the stored bytes → age decrypt? → decompress → BSON split
 *     → header (start, previous digest) → events … → trailer (end, event count)
 *
 * What is checked, so that a missing, reordered, truncated or altered segment is
 * always noticed:
 *
 * - each segment's header names its own start (as in its key) and the SHA-256 of the
 *   stored bytes of the segment before it (for the first segment of the range, that
 *   segment is downloaded and hashed);
 * - its trailer names the start of the next segment (or the start of a recorded gap,
 *   or the recovery point) and the number of events it holds;
 * - the last segment of the range is checked against the next segment's header, or,
 *   when it is the newest, against the digest `state.json` recorded.
 *
 * Integrity is only known at the end of a segment, after its events were yielded, so
 * a consumer must read to the end and treat the events as valid only if no error was
 * thrown. `replayJournal` therefore reads everything once before writing anything.
 */

import { createHash } from "node:crypto";
import { pipeline, type Readable, Transform, type TransformCallback } from "node:stream";
import { BSON } from "mongodb";
import { createDecompressor } from "../compression/index.ts";
import { parseChangeEvent, type StoredChangeEvent } from "../engine/converge-events.ts";
import { compareClusterTimes, formatClusterTime } from "../engine/converge-time.ts";
import { isMongoShieldError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { createBsonSplitter, LOSSLESS_DESERIALIZE_OPTIONS } from "../format/bson-stream.ts";
import type { ClusterTime } from "../format/manifest.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions } from "../types.ts";
import {
  type CoveredRange,
  type JournalCoverage,
  type JournalSegment,
  loadJournalCoverage,
  rangeCovering,
  segmentsBetween,
} from "./coverage.ts";
import {
  malformedSegment,
  parseSegmentHeader,
  parseSegmentTrailer,
  type SegmentHeader,
} from "./records.ts";
import { createSegmentDecryptor } from "./segment-crypto.ts";
import { isAfter } from "./time.ts";

/** Options for {@link readJournalSegments}. */
export interface ReadJournalOptions {
  /** Events strictly after this cluster time … */
  readonly from: ClusterTime;
  /** … up to and including this one. */
  readonly to: ClusterTime;
  /** Keys for an encrypted journal (identities; KMS segments also open through the KMS). */
  readonly decryption?: DecryptionOptions | undefined;
  readonly signal?: AbortSignal | undefined;
  /** An already loaded coverage (saves a listing); loaded when omitted. */
  readonly coverage?: JournalCoverage | undefined;
}

/**
 * Yields the journaled change events in `(from, to]`, in order, verifying the chain of
 * every segment involved.
 *
 * @throws MongoShieldError `MS_CHANGE_HISTORY_LOST` when the journal does not cover the
 *   whole range (a gap, or `to` beyond the recovery point); `MS_INTEGRITY_FAILED` for a
 *   missing, altered or truncated segment; `MS_NO_IDENTITY` / `MS_DECRYPTION_FAILED`
 *   when the keys do not open a segment; storage errors; `MS_ABORTED`.
 */
export async function* readJournalSegments(
  storage: StorageAdapter,
  options: ReadJournalOptions,
): AsyncGenerator<StoredChangeEvent> {
  const { from, to, signal } = options;
  const coverage = options.coverage ?? (await loadJournalCoverage(storage, signal));
  if (!isAfter(to, from)) return;
  assertCovered(coverage.ranges, from, to);

  const segments = segmentsBetween(coverage.segments, from, to);
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) return;

  // The digest the first segment's header must name: that of the segment before it.
  const before = neighbour(coverage, first, -1);
  let expectedPrevious =
    before === undefined ? undefined : await storedDigest(storage, before.key, signal);

  for (const segment of segments) {
    throwIfAborted(signal);
    const reader = new SegmentReader(storage, segment, options.decryption, signal);
    for await (const stored of reader.events(expectedPrevious)) {
      const time = stored.event.clusterTime;
      if (isAfter(time, from) && !isAfter(time, to)) yield stored;
    }
    expectedPrevious = reader.sha256;
  }

  await verifyTail(storage, coverage, last, expectedPrevious, options);
}

/**
 * Reads every committed segment in full and checks the whole chain. Returns how many
 * segments and events were checked.
 *
 * @throws as {@link readJournalSegments}.
 */
export async function verifyJournal(
  storage: StorageAdapter,
  options: {
    readonly decryption?: DecryptionOptions | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<{ readonly segments: number; readonly events: number }> {
  const coverage = await loadJournalCoverage(storage, options.signal);
  let segments = 0;
  let events = 0;
  for (const range of coverage.ranges) {
    for await (const _event of readJournalSegments(storage, {
      ...options,
      coverage,
      from: range.from,
      to: range.to,
    })) {
      events += 1;
    }
    segments += range.segments;
  }
  return { segments, events };
}

/** Fails unless one covered range holds the whole of `(from, to]`. */
function assertCovered(ranges: readonly CoveredRange[], from: ClusterTime, to: ClusterTime): void {
  if (rangeCovering(ranges, from, to) !== undefined) return;
  const covered = ranges.map(
    (range) => `${formatClusterTime(range.from)} → ${formatClusterTime(range.to)}`,
  );
  throw new MongoShieldError(
    "MS_CHANGE_HISTORY_LOST",
    `The journal does not cover every change from ${formatClusterTime(from)} to ${formatClusterTime(to)}. Covered: ${covered.length === 0 ? "nothing" : covered.join(", ")}.`,
    {
      hint: "Pick a time inside a covered range (`mongoshield journal status`).",
      details: { coveredRanges: ranges },
    },
  );
}

/** The committed segment just before (-1) or after (+1) `segment`. */
function neighbour(
  coverage: JournalCoverage,
  segment: JournalSegment,
  direction: -1 | 1,
): JournalSegment | undefined {
  const index = coverage.segments.findIndex((candidate) => candidate.key === segment.key);
  return index === -1 ? undefined : coverage.segments[index + direction];
}

/**
 * Checks the last segment read: the next segment's header must name its digest; with no
 * next segment, `state.json` must.
 */
async function verifyTail(
  storage: StorageAdapter,
  coverage: JournalCoverage,
  last: JournalSegment,
  lastDigest: string | undefined,
  options: ReadJournalOptions,
): Promise<void> {
  const next = neighbour(coverage, last, 1);
  let recorded: string | null | undefined;
  if (next !== undefined) {
    const reader = new SegmentReader(storage, next, options.decryption, options.signal);
    recorded = (await reader.header()).previous;
  } else if (coverage.state?.lastSegment.key === last.key) {
    recorded = coverage.state.lastSegment.sha256;
  }
  if (recorded !== undefined && recorded !== lastDigest) {
    throw malformedSegment(
      last.key,
      "its content differs from what the journal recorded when it was written (the segment chain is broken)",
    );
  }
}

/** Downloads a stored object only to hash it (no key needed). */
async function storedDigest(
  storage: StorageAdapter,
  key: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const body = await storage.get(key, signal === undefined ? {} : { signal });
  for await (const chunk of body) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Reads one segment: its header, its events and its trailer, checking all three. */
class SegmentReader {
  readonly #storage: StorageAdapter;
  readonly #segment: JournalSegment;
  readonly #decryption: DecryptionOptions | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #hash = createHash("sha256");
  /** The SHA-256 of the stored bytes, once the whole segment was read. */
  sha256: string | undefined;

  constructor(
    storage: StorageAdapter,
    segment: JournalSegment,
    decryption: DecryptionOptions | undefined,
    signal: AbortSignal | undefined,
  ) {
    this.#storage = storage;
    this.#segment = segment;
    this.#decryption = decryption;
    this.#signal = signal;
  }

  /** Reads only the header (decrypting just the start of the segment). */
  async header(): Promise<SegmentHeader> {
    const documents = await this.#open();
    try {
      for await (const raw of documents) return this.#parseHeader(raw as Buffer);
    } catch (error) {
      throw this.#explain(error);
    } finally {
      documents.destroy();
    }
    throw malformedSegment(this.#segment.key, "it is empty");
  }

  /**
   * Every event of the segment, after checking the header (`expectedPrevious`, when
   * known, is the digest the header must name). The trailer is checked at the end.
   */
  async *events(expectedPrevious: string | undefined): AsyncGenerator<StoredChangeEvent> {
    const { key } = this.#segment;
    const documents = await this.#open();
    let header: SegmentHeader | undefined;
    let trailerSeen = false;
    let events = 0;
    let lastTime = this.#segment.from;
    try {
      for await (const chunk of documents) {
        const raw = chunk as Buffer;
        if (header === undefined) {
          header = this.#parseHeader(raw);
          if (expectedPrevious !== undefined && header.previous !== expectedPrevious) {
            throw malformedSegment(
              key,
              "the segment before it is missing or was altered (the segment chain is broken)",
            );
          }
          continue;
        }
        if (trailerSeen) throw malformedSegment(key, "it has data after its trailer");
        const trailer = parseSegmentTrailer(
          BSON.deserialize(raw, LOSSLESS_DESERIALIZE_OPTIONS),
          key,
        );
        if (trailer !== undefined) {
          this.#checkTrailer(trailer.to, trailer.events, events);
          trailerSeen = true;
          continue;
        }
        const event = parseChangeEvent(raw);
        // Events are in cluster-time order and inside the segment's range.
        if (
          !isAfter(event.clusterTime, this.#segment.from) ||
          compareClusterTimes(event.clusterTime, lastTime) < 0
        ) {
          throw malformedSegment(
            key,
            `an event at ${formatClusterTime(event.clusterTime)} is out of order`,
          );
        }
        lastTime = event.clusterTime;
        events += 1;
        yield { raw, event };
      }
    } catch (error) {
      throw this.#explain(error);
    } finally {
      documents.destroy();
    }
    if (header === undefined) throw malformedSegment(key, "it is empty");
    if (!trailerSeen) throw malformedSegment(key, "it is truncated (no trailer)");
    this.sha256 = this.#hash.digest("hex");
  }

  #parseHeader(raw: Buffer): SegmentHeader {
    const header = parseSegmentHeader(raw, this.#segment.key);
    if (compareClusterTimes(header.from, this.#segment.from) !== 0) {
      throw malformedSegment(this.#segment.key, "its header names a different start than its key");
    }
    return header;
  }

  /** The trailer must end the segment where the journal says it ends. */
  #checkTrailer(to: ClusterTime, recordedEvents: number, events: number): void {
    const { key } = this.#segment;
    if (compareClusterTimes(to, this.#segment.to) !== 0) {
      throw malformedSegment(
        key,
        `it ends at ${formatClusterTime(to)}, but the next segment starts at ${formatClusterTime(this.#segment.to)} (a segment is missing)`,
      );
    }
    if (recordedEvents !== events) {
      throw malformedSegment(
        key,
        `its trailer counts ${recordedEvents} events, but it holds ${events}`,
      );
    }
  }

  /** storage → hash → decrypt? → decompress → split, as one readable of raw documents. */
  async #open(): Promise<Readable> {
    const { key, encrypted, compression } = this.#segment;
    const stages: Transform[] = [this.#hasher()];
    if (encrypted) stages.push(createSegmentDecryptor(this.#decryption));
    stages.push(createDecompressor(compression));
    const splitter = createBsonSplitter();
    const stored = await this.#storage.get(
      key,
      this.#signal === undefined ? {} : { signal: this.#signal },
    );
    // Errors in any stage destroy the splitter, so they surface where it is read.
    pipeline([stored, ...stages, splitter], () => {});
    return splitter;
  }

  #hasher(): Transform {
    const hash = this.#hash;
    return new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
  }

  /** A failure to decrypt or decompress a segment means it was altered. */
  #explain(error: unknown): unknown {
    if (this.#signal?.aborted) return error;
    if (isMongoShieldError(error, "MS_DECRYPTION_FAILED")) {
      return malformedSegment(
        this.#segment.key,
        "it does not decrypt (it was altered or truncated)",
        error,
      );
    }
    if (
      isMongoShieldError(error, "MS_INTEGRITY_FAILED") &&
      !error.message.startsWith("Journal segment")
    ) {
      return malformedSegment(this.#segment.key, error.message, error);
    }
    return error;
  }
}
