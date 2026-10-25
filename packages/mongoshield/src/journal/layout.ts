/**
 * Where the change journal lives in storage (docs/specs/JOURNAL.md, "Storage layout").
 *
 *   journal/
 *     segments/2026-11-14/031500_1763090100-0000000003.bson.zst.age
 *              └ day of `from` └ time of `from` └ `from` as t-i (zero-padded)
 *     state.json                 the commit point: last segment, recovery point, totals
 *     gaps/1763090100-0000000003.json   a recorded gap (history lost); never pruned
 *   locks/journal/…              the writer's lease (the scheduler's storage lock)
 *
 * A segment's key holds only its START (`from`): the segment is streamed to storage
 * while it is being written, so its end is not known yet when the upload begins. The
 * end is in the segment's trailer, equals the next segment's `from`, and for the newest
 * segment is recorded in `state.json`.
 *
 * Zero-padding makes key order equal time order, so a listing (which every adapter
 * returns in key order) is already chronological. The extensions say how the segment
 * was compressed and whether it is encrypted, so each segment is self-describing.
 */

import { MongoShieldError } from "../errors.ts";
import { COMPRESSION_EXTENSIONS, ENCRYPTED_EXTENSION } from "../format/layout.ts";
import type { ClusterTime, Compression } from "../format/manifest.ts";

/** Everything the journal stores lives under this prefix. */
export const JOURNAL_PREFIX = "journal/";

/** Segments, in one directory per UTC day. */
export const SEGMENTS_PREFIX = `${JOURNAL_PREFIX}segments/`;

/** Gap records. */
export const GAPS_PREFIX = `${JOURNAL_PREFIX}gaps/`;

/** The writer's commit point (see state.ts). */
export const STATE_KEY = `${JOURNAL_PREFIX}state.json`;

/** Name of the writer's storage lease: its objects live under `locks/journal/`. */
export const JOURNAL_LOCK_NAME = "journal";

/** 10 digits hold any 32-bit number (seconds until 2106, any increment). */
const TIME_DIGITS = 10;

/** `031500_1763090100-0000000003.bson.zst.age` (the file name of a segment). */
const SEGMENT_FILE_PATTERN = /^(\d{6})_(\d{10})-(\d{10})\.bson(\.zst|\.gz)?(\.age)?$/;

/** `1763090100-0000000003.json` (the file name of a gap record). */
const GAP_FILE_PATTERN = /^(\d{10})-(\d{10})\.json$/;

/** A segment as found in a listing: what its key says. */
export interface SegmentKeyInfo {
  /** The full storage key. */
  readonly key: string;
  /** The segment holds the events strictly after this cluster time. */
  readonly from: ClusterTime;
  readonly compression: Compression;
  readonly encrypted: boolean;
}

/** `1763090100-0000000003`: a cluster time that sorts as a string. */
export function encodeClusterTime(time: ClusterTime): string {
  return `${pad(time.t)}-${pad(time.i)}`;
}

/** The key of the segment starting after `from`. */
export function segmentKey(options: {
  readonly from: ClusterTime;
  readonly compression: Compression;
  readonly encrypted: boolean;
}): string {
  // The day and time come from `from`'s seconds, so a human browsing the bucket can
  // find "the segments of 3 a.m. on November 14" without decoding cluster times.
  const iso = new Date(options.from.t * 1000).toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(":", "");
  const extensions =
    ".bson" +
    COMPRESSION_EXTENSIONS[options.compression] +
    (options.encrypted ? ENCRYPTED_EXTENSION : "");
  return `${SEGMENTS_PREFIX}${day}/${time}_${encodeClusterTime(options.from)}${extensions}`;
}

/**
 * Decodes a segment key, or returns `undefined` for keys that are not segments (so
 * stray objects under `journal/segments/` are ignored rather than fatal).
 */
export function parseSegmentKey(key: string): SegmentKeyInfo | undefined {
  if (!key.startsWith(SEGMENTS_PREFIX)) return undefined;
  const name = key.slice(key.lastIndexOf("/") + 1);
  const match = SEGMENT_FILE_PATTERN.exec(name);
  if (match === null) return undefined;
  const [, , seconds, increment, compressionExtension, encryptedExtension] = match;
  return {
    key,
    from: { t: Number(seconds), i: Number(increment) },
    compression: compressionOfExtension(compressionExtension),
    encrypted: encryptedExtension !== undefined,
  };
}

/** The key of the gap record for a gap starting after `from`. */
export function gapKey(from: ClusterTime): string {
  return `${GAPS_PREFIX}${encodeClusterTime(from)}.json`;
}

/** True for keys that look like gap records. */
export function isGapKey(key: string): boolean {
  return key.startsWith(GAPS_PREFIX) && GAP_FILE_PATTERN.test(key.slice(GAPS_PREFIX.length));
}

function compressionOfExtension(extension: string | undefined): Compression {
  if (extension === ".zst") return "zstd";
  if (extension === ".gz") return "gzip";
  return "none";
}

function pad(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new MongoShieldError("MS_INTERNAL", `Invalid cluster time component ${value}.`);
  }
  return String(value).padStart(TIME_DIGITS, "0");
}
