# Point-in-time recovery: the change journal

Status: implemented in phase P6 (`src/journal/`). This document is the contract for the
on-disk format and the behaviour; the operator's view is in
[docs/guides/point-in-time-recovery.md](../guides/point-in-time-recovery.md).

A backup captures the database at one moment. The **journal** records every change
after that moment, so a restore can stop at any second: just before the bad deploy,
the accidental `deleteMany`, or the ransomware.

It reuses the `converge` machinery (docs/specs/CONSISTENCY.md): the same change stream
(`allChangesForCluster`, `showExpandedEvents`, raw events), the same enrichment of
events replay could not express, and the same replay rules. Capture works the same way;
it just never stops.

## Concepts

| Term | Meaning |
|---|---|
| base backup | an ordinary complete backup whose manifest records a cluster time: `consistency.to` for converge, `consistency.from` for snapshot. Backups with consistency `none` cannot be a base. |
| journal | a chained sequence of segments of change events, with recorded gaps |
| segment | one stored object holding every journaled event with a cluster time in `(from, to]` |
| recovery point | the newest cluster time up to which the journal is complete (`state.json`) |
| RPO | how far behind "now" the recovery point is; normally under one segment interval |

Ranges are half-open on the left: a segment holds the events strictly after `from`, up
to and including `to`, and the next segment starts at `to`. A restore "to T" replays the
events with cluster time `<= T` that are after the base backup's time.

## Storage layout

```
journal/
  segments/2026-11-14/031500_1763090100-0000000003.bson.zst.age
           └ UTC day of `from` └ time of `from` └ `from` as t-i, zero-padded to 10 digits
  state.json                       the commit point (see below)
  gaps/1763090100-0000000003.json  a recorded gap, keyed by where it starts; never pruned
locks/journal/<generation>.json    the writer's lease (the scheduler's storage lock)
```

- **Segment keys** hold only the segment's start: segments are streamed to storage
  while they are written, so their end is not known when the upload begins. Zero
  padding makes key order equal time order. The extensions (`.bson`, `.zst`/`.gz`,
  `.age`) say how the segment is stored, so every segment is self-describing.
- **Encryption and compression** follow the configured backup settings. Segments are
  encrypted directly to the configured recipients and/or KMS keys (one KMS call per
  segment; no per-journal key file), so each segment is its own age file and never
  depends on another. **Passphrases are refused** (`MS_CONFIG_INVALID`): age runs scrypt
  for every file, and a journal writes a file every few minutes forever.

### Segment content

Concatenated BSON documents, compressed and encrypted as a whole:

```
{ op: "segment", formatVersion: 1, from: Timestamp, previous: <hex sha256> | null }
<change event> …                    raw, exactly as the server sent them (see below)
{ op: "segment-end", to: Timestamp, events: Int64 }
```

- `previous` is the SHA-256 of the previous segment's **stored** bytes (after
  compression and encryption), so the chain can be checked without a key for the
  hashing part. It is `null` for the first segment ever written. Across a gap it still
  names the last segment before the gap.
- Change events are stored verbatim, except the two cases converge also handles
  (CONSISTENCY.md and FORMAT.md): updates to field names containing `.` or starting with
  `$` get the document as of the event in `fullDocument` (snapshot read at the event's
  cluster time), and renames into a journaled namespace from a namespace the journal
  does not record (an excluded collection, or an `$out`/`$merge` scratch collection
  `tmp.*`, which the journal skips) are followed by synthesized `drop` + `create` +
  `insert` events (marked `synthesized: true`) that record the destination as of the
  rename.

### `state.json`: the commit point

```json
{
  "formatVersion": 1,
  "recoveryPoint": { "t": 1763090400, "i": 3 },
  "lastSegment": { "key": "journal/segments/…", "from": {…}, "to": {…}, "size": 1234,
                   "sha256": "…", "events": 812 },
  "totals": { "segments": 1500, "events": 9000000, "bytes": 812000000 },
  "updatedAt": "2026-11-14T03:20:01.123Z",
  "writer": { "host": "journal-7d9f", "pid": 1 }
}
```

A segment belongs to the journal once `state.json` names it or a later segment.
Segments with a later start are interrupted uploads: readers ignore them and the next
writer deletes them (it would overwrite the same key anyway, since it starts at the
recovery point). `totals` never decrease (pruning does not touch them); planning uses
them to estimate the number of events per stored byte.

### Gap records

```json
{ "formatVersion": 1, "from": { "t": …, "i": … }, "to": { "t": …, "i": … },
  "detectedAt": "…", "reason": "<server message>", "action": "backup" | "fail" }
```

Changes in `(from, to]` are lost. `from` is the recovery point when the gap was found;
`to` is where the journal starts again.

### Coverage from names

Without opening a segment: committed segments sorted by start; each ends where the next
starts, or where a gap that starts in between starts; the newest ends at the recovery
point. Consecutive segments form **covered ranges**. Names cannot prove that nothing is
missing or altered; the chain does (see "Reading").

## The writer: `mongoshield journal start` / `startJournal()`

A long-running process. It runs as a library call (`startJournal({ client, storage, … })`
returns a handle with `stop()`, `status()` and `done`) or as `mongoshield journal start`
(a container, a systemd service, a Kubernetes Deployment with one replica).

1. **Lease.** Take the storage lease `locks/journal/` (the scheduler's storage lock,
   src/schedule/lock-storage.ts, default 60 s, renewed every third of it). A second
   writer fails with `MS_STORAGE_PRECONDITION_FAILED`, or waits with `waitForLease`. A
   writer that loses its lease stops at once.
2. **Resume.** With a `state.json`: after its recovery point, skipping recorded gaps
   that start there. Without one (a new journal, and no segment in storage): at the
   newest base backup's cluster time, or at "now" with a warning that recovery is only
   possible from the next base backup. A journal with segments but no `state.json` is
   refused (`MS_CONFIG_INVALID`) rather than guessed at.
   The change stream is opened with `startAtOperationTime` = the cluster time right after
   the resume point, which returns exactly the later events because segments never end
   inside a cluster time (step 3).
3. **Segments.** Events stream into the current segment (getMore → compress → encrypt →
   SHA-256 → `storage.put`; memory stays flat). A segment closes once it is
   `segmentSeconds` old (default 300) or holds `segmentBytes` of events (default 64 MiB),
   and on `stop()`. It may only end at a cluster time T with every event up to T in it
   and none after:
   - an event with a later cluster time than the previous one arrives → T is the
     previous one (the events of a transaction share a cluster time and are never split);
   - an empty batch reports the stream's position P (`postBatchResumeToken`) → T is P.
   Closing means: write the trailer, finish the upload, then rewrite `state.json`.
4. **Heartbeat segments.** An idle database still produces a segment every interval:
   header and trailer only, ending at the stream's position, so the recovery point keeps
   moving (the oplog advances at least with the server's periodic no-op writes, every
   10 s).
5. **Gaps.** When the oplog no longer reaches the resume point (`ChangeStreamHistoryLost`,
   `ChangeStreamFatalError`, `CappedPositionLost`): write a gap record, alert (notify
   targets get a failure report; the heartbeat gets `/fail`), and then
   - `onGap: "backup"` (the default when a `takeBaseBackup` callback is given): keep
     journaling from "now" and take a new base backup in the background;
   - `onGap: "fail"` (the default otherwise): stop with `MS_CHANGE_HISTORY_LOST`. A
     restarted writer continues after the recorded gap.
   A brand-new journal that cannot start at an old base backup simply starts now (no gap).
6. **Transient failures** (connection drops, storage errors) abandon the open segment
   (its upload is discarded) and restart from the last commit after 1 s, 2 s, 4 s … up to
   60 s. Missing privileges, invalid settings, forbidden storage and a lost lease stop
   the writer.
7. **Metrics.** `status()`: recovery point, RPO, segments/events/bytes written, events
   per second, last segment latency (closing → committed), gaps, last transient error.
   Every committed segment pings the configured heartbeat URL and calls `onSegment`.

## Reading: `readJournalSegments(storage, { from, to, decryption })`

Yields the events in `(from, to]` in order and checks, for every segment involved:

- the header names its own start (as in its key) and the SHA-256 of the previous
  segment's stored bytes (for the first segment of the range, the previous segment is
  downloaded and hashed);
- events are in cluster-time order, inside the segment's range;
- the trailer names the segment's end as derived from the names (the next segment's
  start, a gap's start, or the recovery point) and its event count;
- the last segment's digest matches the next segment's `previous`, or, for the newest
  segment, `state.json`'s `lastSegment.sha256`.

A missing, reordered, truncated or altered segment fails with `MS_INTEGRITY_FAILED`; a
range the journal does not cover (a gap, or past the recovery point) fails with
`MS_CHANGE_HISTORY_LOST`. Segments encrypted to KMS keys open through the KMS when no
given identity matches. `verifyJournal(storage)` reads every covered range.

## Restore to a point in time

`at` is a `Date` or a cluster time. **A `Date` is rounded down to its second, and that
second's writes are not replayed** (cluster time `{ t: <second>, i: 0 }`): when someone
names the second the bad `deleteMany` ran, replaying that second might replay it. Pass a
cluster time for exact control.

1. `planPointInTimeRestore(storage, at)`: the newest complete base backup whose cluster
   time is at or before `at`, a covered range from that time through `at`, and the
   segments holding `(base time, at]` (with their stored size and an estimate of the
   number of events). Only names, manifests and small records are read. Otherwise
   `MS_CHANGE_HISTORY_LOST`, listing the recoverable ranges (also in
   `details.recoverableRanges`): within each covered range, from its oldest base backup
   to its end, plus every base backup on its own.
2. Restore the base backup as usual (including its own converge replay and index builds).
3. `replayJournal({ client, storage, from: base time, to: at, baseNamespaces, include,
   exclude, rename, mode, decryption, … })`: reads the whole range once (chain,
   decryption, parsing) before writing anything, maps namespaces with the restore's
   rules (src/engine/converge-targets.ts; collections created after the base backup are
   conflict-checked with `mode`), then replays with the converge rules
   (src/engine/converge-replay.ts).
4. Report the exact cluster time restored to (`restoredTo`) and the number of events.

`mongoshield journal status` shows the recovery point, the RPO, the covered ranges and
any gaps (`--json` for scripts, `--max-rpo 10m` exits 1 when the journal is further
behind). `mongoshield restore --at` (with `--dry-run` showing the plan) wires steps 1 to 3.

## Retention

Journal segments that end at or before the oldest kept base backup are useless, because
nothing can be replayed onto them. `pruneJournal(storage, { olderThan })` deletes them;
run it after pruning backups with the oldest remaining base backup's cluster time
(`listBaseBackups`). The newest segment and gap records are never pruned.

## Limits

- The same as `converge` (CONSISTENCY.md): DDL other than create, drop and rename is not
  replayed; time series collections are not journaled (change streams do not report
  their writes).
- Collections created after the base backup are restored without secondary indexes
  (the replay runs after the base restore built its indexes).
- Base backups must include every namespace the journal records (same include/exclude).
- The two enrichments (dotted field names, rename destinations) are snapshot reads at the
  event's cluster time: a writer catching up from further behind than the server's
  snapshot window (`minSnapshotHistoryWindowInSeconds`, 300 s) cannot record them
  exactly and logs an error for each.
- Lost history is detected by the server. A replica set whose oplog never rolled over
  accepts any start time, because its first entry marks the beginning of history.
