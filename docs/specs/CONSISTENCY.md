# Consistency modes

A backup reads many collections, one after another, while the application keeps
writing. Without care, the restored database mixes moments: `orders` as of 03:00:04
and `users` as of 03:06:51, so an order can point at a user who "doesn't exist yet".
The `consistency` option controls how MongoShield deals with this.

| Mode | Restored state | Needs | Cost |
|---|---|---|---|
| `none` | each collection as of the moment it was read | nothing | none |
| `snapshot` | the whole backup as of one cluster time | replica set or sharded cluster; backup must finish within the snapshot window | none |
| `converge` | the whole backup as of the moment the backup finished (T1) | replica set or sharded cluster on MongoDB 6.0+; cluster-wide change stream privileges | a small extra file; replay time on restore |
| `auto` (default) | `converge` where possible, otherwise `none` | | |

`auto` picks `converge` when the deployment is a replica set or sharded cluster on
MongoDB 6.0+ **and** the user may open a deployment-wide change stream. The privilege
check is a probe: the backup opens the change stream (`batchSize: 0`, so it reads
nothing) and closes it again, which is exact whatever roles grant the privilege. When
any condition fails, `auto` uses `none` and records why in the manifest's
`consistency.warning` (shown by `mongoshield backup` and `inspect`); for example the
built-in `backup` role cannot open change streams, so a user with only that role gets
`none` and a warning naming the missing privileges. `auto` never picks `snapshot`,
which fails outright when a backup outlasts the snapshot window. An explicit
`consistency: "converge"` is not probed: it fails with `MS_UNSUPPORTED_TOPOLOGY` or
`MS_PERMISSION_DENIED` when it cannot run.

## `none`

Collections are read independently with ordinary cursors, exactly like `mongodump`
without `--oplog`. The manifest records `consistency.mode = "none"`.

## `snapshot`

All reads happen in one session opened with `{ snapshot: true }`, so every
collection is read at the same cluster time, recorded as `consistency.from`.
The server keeps old versions only for `minSnapshotHistoryWindowInSeconds`
(300 s by default), so a backup that takes longer fails with a clear error
(`SnapshotTooOld`) instead of producing a mixed result. Best for small databases.

## `converge`

This is MongoShield's equivalent of `mongodump --oplog`, built on change streams so it
works where the oplog is not readable (for example Atlas shared tiers).

Requirements: a replica set or sharded cluster running MongoDB 6.0+ (for
`showExpandedEvents`), and a user allowed to open a cluster-wide change stream
(`changeStream` and `find` on all databases, e.g. `readAnyDatabase`; the built-in
`backup` role alone is not enough). A standalone server fails with
`MS_UNSUPPORTED_TOPOLOGY`.

### Backup

Implemented in `src/engine/converge-capture.ts`.

1. Read the current cluster time **T0** (a `ping`'s `operationTime`: the last write
   the node applied). This happens **before** namespace discovery, so a collection
   created after discovery has its creation inside the window.
2. Open a deployment-wide change stream starting at T0 with the low-level `aggregate`
   command (`$changeStream: { allChangesForCluster: true, startAtOperationTime: T0,
   showExpandedEvents: true }`). The events kept are those of
   - the namespaces being backed up,
   - collections created during the window that the backup's include/exclude
     patterns select,
   - scratch collections (`tmp.*`) in the backed-up databases, which `$out` and
     `$merge` fill before renaming them over their target,
   - `dropDatabase` of those databases.
   A background task streams the kept events (raw BSON, as the server sent them)
   through the usual coalesce → compress → encrypt → digest → `storage.put` pipeline
   into `_changes/window.bson[.zst][.age]`. It only issues the next `getMore` when
   storage has taken the previous batch, so memory stays flat (backpressure).
3. Dump every collection as in mode `none`. After each dump the capture notes the
   cluster time (used for renames, below).
4. Read the current cluster time **T1**.
5. Keep reading the change stream until it has passed T1: until a reply's
   `postBatchResumeToken` (whose first bytes encode a cluster time) is after T1, or at
   T1 with an empty batch, or an event after T1 arrives. Change streams deliver events
   in cluster-time order, so at that point every event up to T1 has been captured.
   Events after T1 are dropped. (`operationTime` alone is not enough: a full batch is
   returned before the stream has read everything up to it. It is only used as a
   fallback when the token cannot be decoded.)
6. Record `consistency = { mode: "converge", from: T0, to: T1 }` and `changes` (with
   its event count) in the manifest, then commit the manifest as usual.

Any capture failure fails the backup and deletes its files: lost history
(`ChangeStreamHistoryLost` → `MS_CHANGE_HISTORY_LOST`), missing privileges, a dropped
connection, a drain that does not reach T1 within 5 minutes (`MS_TIMEOUT`). A converge
backup that may have missed events is never committed.

Two kinds of events are recorded in a replayable form instead of verbatim (both are
listed in FORMAT.md):

- An update to a field name containing `.` or starting with `$` cannot be written
  with `$set`/`$unset`. The capture reads the document at the event's cluster time
  (a snapshot read) and stores it as the event's `fullDocument`.
- A rename `A → B` replays as "B becomes A as it was at the rename". That is only
  right when the backup holds A as of the rename: A was created inside the window
  (all of its documents are events, which covers a `$out` started during the backup),
  or A's dump finished before the rename. Otherwise (a `$out` that started before T0,
  a collection renamed before it was dumped) the capture reads B at the rename's
  cluster time and stores it as `drop` + `create` + one `insert` per document right
  after the rename, so B is exact whatever A held.

**The manifest's T1 is the authority.** The capture keeps reading the change stream
in the background and only learns T1 when its closing `ping` returns, so the changes
file can hold a few events from just after T1. Readers must ignore every event whose
cluster time is after `consistency.to`, and the restore does so for both its planning
scan and the replay. T1 itself is read from the server's logical clock (`$clusterTime`),
which is never behind a write the server has applied; T0 is read from `operationTime`,
which can lag, and that is the safe direction for a start time.

### Restore

Implemented in `src/engine/converge-targets.ts` (planning) and
`src/engine/converge-replay.ts` (replay).

1. Pre-flight: the whole changes file is read once (integrity, decryption, every event
   parses) before anything is written. Events are mapped to targets with the restore's
   include/exclude and rename rules: backed-up namespaces go to their planned target;
   collections created during the window are restored when the patterns select them
   (and get the same conflict checks as other targets: `fail-if-exists` refuses a
   non-empty target, `drop` replaces it); scratch collections are replayed next to the
   restored namespace they are renamed over, and skipped otherwise.
2. Restore every collection's documents as usual, without secondary indexes.
3. Replay the captured events in order, each as an operation that sets absolute values:

   | Event | Replayed as |
   |---|---|
   | `insert` | `replaceOne({ _id }, fullDocument, { upsert: true })` |
   | `replace` | `replaceOne({ _id }, fullDocument, { upsert: true })` |
   | `update` | `updateOne({ _id }, { $push: { <array>: { $each: [], $slice: n } } })` per truncated array, then `updateOne({ _id }, { $set: updatedFields, $unset: removedFields })` |
   | `update` with `fullDocument` | `replaceOne({ _id }, fullDocument, { upsert: true })` |
   | `delete` | `deleteOne({ _id })` |
   | `create` | `create` with the recorded options (ignored when the target exists, and for views) |
   | `drop` | delete every document; drop the collection at the end of the replay unless it was created again |
   | `dropDatabase` | as `drop` for every target from that database |
   | `rename` | `renameCollection` to the mapped target with `dropTarget`; a rename out of the restored namespaces is a `drop` |
   | index and collection-option events | ignored; metadata comes from the dump |

   Writes match `_id` with the simple collation. They are queued per target namespace
   and sent as ordered `bulkWrite`s (1000 operations or 8 MiB), so the events of each
   document keep their order; a DDL event first flushes the queues it affects.
   An update that fails because its path no longer fits the document (e.g. `$set`
   of `a.5.x` where `a` is now a string; codes 2, 14, 28) is skipped: the event that
   changed `a` comes later and sets it absolutely. Every other error fails the restore.
   Progress is reported as the pseudo-namespace `(changes during the backup)`.
4. Build indexes (except on targets the replay dropped or renamed away), then create
   views.

### Why replay converges to T1

Every document was read at some moment between T0 and T1. Replaying all events from T0
to T1 in order reapplies every change that happened in that window. Each replayed
operation writes absolute values (`$set` the new value, replace with the full document,
delete by `_id`), not relative changes like `$inc` (a change event records the
resulting value, not the increment). So applying an event to a document that already
reflects it is harmless, and the last event touching each field wins. After the
replay, every document is as it was at T1. This is the same idempotency argument
`mongorestore --oplogReplay` relies on.

Known limits:

- Time series collections are not converged: change streams do not report their
  writes. They are restored as read, and the manifest's `consistency.warning` says so.
- On MongoDB 6.0 (no `disambiguatedPaths`, added in 6.1), an update to a field name
  containing a dot looks like an update to a nested field (manifest warning).
- Collections created during the window are restored from their events with the
  options of their `create` event, but without secondary indexes.
- Collection option changes (`collMod`), view changes and index changes during the
  window are not replayed; the dumped metadata is used.
- A change event larger than 16 MiB fails the backup (no `$changeStreamSplitLargeEvent`
  yet), as does a transient network error during the capture (no resume yet).
- In restore modes `insert` and `upsert`, replay can overwrite documents of the
  target that share an `_id` with a document changed during the window.
- A change stream whose history falls off the oplog (`ChangeStreamHistoryLost`) fails
  the backup; it is never committed as consistent.

### Test harness

`converge` became the `auto` default after this randomized harness passed
repeatedly. The harness (`test/integration/converge-harness.test.ts`) runs three
concurrent writers making inserts, `$set`/`$unset`/`$inc`/`$rename` updates, array
pushes, element sets and truncations (pipeline updates), updates to numeric field
names, replacements, deletes, multi-document updates and `$out` rebuilds across five
collections, during a backup slowed down by a storage that waits before each data
file. Writers keep running after T1. The backup is restored into another database and
every collection is compared, byte for byte, with the source read at T1 (a snapshot
read `atClusterTime: T1`). Each iteration has its own seed (`CONVERGE_HARNESS_SEED`,
`CONVERGE_HARNESS_ITERATIONS`, `CONVERGE_HARNESS_REPORT=1` prints timings).

Results so far (MongoDB 7.0, single-node replica set, 2026-10-21): 120 of 120
iterations passed across four runs with different seeds; about 1,100 change events
per window (820 to 1,800), backup about 0.8 s, restore about 0.85 s per iteration.
