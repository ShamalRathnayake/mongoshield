import { createHash } from "node:crypto";
import { BSON, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import type { ClusterTime } from "../format/manifest.ts";
import { memoryStorage } from "../storage/memory.ts";
import { STATE_KEY, segmentKey } from "./layout.ts";
import { readJournalSegments, verifyJournal } from "./reader.ts";
import {
  encodeSegmentHeader,
  encodeSegmentTrailer,
  JOURNAL_FORMAT_VERSION,
  type JournalState,
} from "./records.ts";

/** A segment's documents: header, events and trailer (each overridable to damage it). */
interface SegmentParts {
  readonly from: ClusterTime;
  readonly to: ClusterTime;
  readonly previous?: string | null;
  readonly documents?: readonly Buffer[];
}

const insert = (t: number, i: number): Buffer =>
  Buffer.from(
    BSON.serialize({
      operationType: "insert",
      clusterTime: new Timestamp({ t, i }),
      ns: { db: "app", coll: "items" },
      documentKey: { _id: i },
      fullDocument: { _id: i },
    }),
  );

const header = (from: ClusterTime, previous: string | null = null) =>
  encodeSegmentHeader({ from, previous });
const trailer = (to: ClusterTime, events: number) => encodeSegmentTrailer({ to, events });

/**
 * Stores uncompressed, unencrypted segments and a state.json naming the last one, so
 * the reader sees a committed journal whose content the test controls byte for byte.
 */
async function journalOf(segments: readonly SegmentParts[]) {
  const storage = memoryStorage();
  let previous: string | null = null;
  let last: JournalState["lastSegment"] | undefined;
  for (const segment of segments) {
    const documents = segment.documents ?? [
      header(segment.from, segment.previous ?? previous),
      trailer(segment.to, 0),
    ];
    const bytes = Buffer.concat(documents);
    const key = segmentKey({ from: segment.from, compression: "none", encrypted: false });
    await storage.put(key, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    last = { key, from: segment.from, to: segment.to, size: bytes.length, sha256, events: 0 };
    previous = sha256;
  }
  if (last === undefined) throw new Error("no segments");
  const state: JournalState = {
    formatVersion: JOURNAL_FORMAT_VERSION,
    recoveryPoint: last.to,
    lastSegment: last,
    totals: { segments: segments.length, events: 0, bytes: 0 },
    updatedAt: new Date(0).toISOString(),
    writer: { host: "test", pid: 1 },
  };
  await storage.put(STATE_KEY, Buffer.from(JSON.stringify(state)));
  return storage;
}

async function readAll(
  storage: ReturnType<typeof memoryStorage>,
  from: ClusterTime,
  to: ClusterTime,
) {
  const times: ClusterTime[] = [];
  for await (const { event } of readJournalSegments(storage, { from, to }))
    times.push(event.clusterTime);
  return times;
}

const T0 = { t: 100, i: 0 };
const T1 = { t: 200, i: 0 };
const T2 = { t: 300, i: 0 };

describe("readJournalSegments", () => {
  it("yields the events inside the range, in order, across segments", async () => {
    const storage = await journalOf([
      { from: T0, to: T1, documents: [header(T0), insert(150, 1), insert(150, 2), trailer(T1, 2)] },
      { from: T1, to: T2 },
    ]);
    expect(await readAll(storage, T0, T2)).toEqual([
      { t: 150, i: 1 },
      { t: 150, i: 2 },
    ]);
    expect(await readAll(storage, { t: 150, i: 1 }, T2)).toEqual([{ t: 150, i: 2 }]);
    expect(await readAll(storage, T2, T2)).toEqual([]);
    expect(await verifyJournal(storage)).toEqual({ segments: 2, events: 2 });
  });

  it("refuses a range the journal does not cover", async () => {
    const storage = await journalOf([{ from: T0, to: T1 }]);
    await expect(readAll(storage, T0, T2)).rejects.toMatchObject({
      code: "MS_CHANGE_HISTORY_LOST",
    });
    await expect(readAll(memoryStorage(), T0, T1)).rejects.toMatchObject({
      code: "MS_CHANGE_HISTORY_LOST",
      message: expect.stringContaining("Covered: nothing"),
    });
  });

  const damaged: [string, readonly Buffer[], RegExp][] = [
    ["an empty segment", [], /it is empty/],
    ["a segment without a trailer", [header(T0)], /truncated/],
    ["data after the trailer", [header(T0), trailer(T1, 0), insert(150, 1)], /after its trailer/],
    ["a header naming another start", [header(T1), trailer(T1, 0)], /different start/],
    [
      "a trailer ending elsewhere",
      [header(T0), trailer({ t: 150, i: 0 }, 0)],
      /a segment is missing/,
    ],
    ["a wrong event count", [header(T0), insert(150, 1), trailer(T1, 5)], /counts 5 events/],
    [
      "events out of order",
      [header(T0), insert(150, 2), insert(150, 1), trailer(T1, 2)],
      /out of order/,
    ],
    ["an event before the segment", [header(T0), insert(50, 1), trailer(T1, 1)], /out of order/],
    ["bytes that are not BSON", [Buffer.from([9, 0, 0, 0, 1, 2, 3, 4, 0])], /damaged/],
  ];
  for (const [what, documents, message] of damaged) {
    it(`detects ${what}`, async () => {
      const storage = await journalOf([{ from: T0, to: T1, documents }]);
      await expect(readAll(storage, T0, T1)).rejects.toMatchObject({
        code: "MS_INTEGRITY_FAILED",
        message: expect.stringMatching(message),
      });
    });
  }

  it("detects a segment whose header does not name the previous segment", async () => {
    const storage = await journalOf([
      { from: T0, to: T1 },
      { from: T1, to: T2, previous: "a".repeat(64) },
    ]);
    await expect(readAll(storage, T0, T2)).rejects.toMatchObject({
      message: expect.stringContaining("the segment chain is broken"),
    });
    // Reading only the second segment hashes the first to check its header.
    await expect(readAll(storage, T1, T2)).rejects.toMatchObject({
      message: expect.stringContaining("the segment chain is broken"),
    });
  });

  it("detects a last segment that differs from what state.json recorded", async () => {
    const storage = await journalOf([{ from: T0, to: T1 }]);
    const key = segmentKey({ from: T0, compression: "none", encrypted: false });
    // Same documents, recorded with another digest: rewrite state.json.
    const state = JSON.parse((await readText(storage, STATE_KEY)) ?? "{}");
    state.lastSegment.sha256 = "b".repeat(64);
    await storage.put(STATE_KEY, Buffer.from(JSON.stringify(state)));
    expect(storage.keys()).toContain(key);
    await expect(readAll(storage, T0, T1)).rejects.toMatchObject({
      message: expect.stringContaining("differs from what the journal recorded"),
    });
  });

  it("stops when aborted", async () => {
    const storage = await journalOf([{ from: T0, to: T1 }]);
    const signal = AbortSignal.abort();
    const reading = (async () => {
      for await (const _event of readJournalSegments(storage, { from: T0, to: T1, signal })) {
        // nothing
      }
    })();
    await expect(reading).rejects.toMatchObject({ code: "MS_ABORTED" });
  });
});

async function readText(
  storage: ReturnType<typeof memoryStorage>,
  key: string,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of await storage.get(key)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
