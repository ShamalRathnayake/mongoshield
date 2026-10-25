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
without `--oplog`. The manifest records `consistency.mode = "none"`. A collection
dropped or replaced (`$out`) while it is read is read again from the start, once; one
that no longer exists is left out of the manifest, and `consistency.warning` names it.

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

**Least-privilege role.** `readAnyDatabase` works, but a backup needs less. This
custom role is enough for `auto` to pick `converge` (tested with access control on in
`test/topology/access-control.test.ts`):

```js
db.getSiblingDB("admin").createRole({
  role: "mongoshieldBackup",
  privileges: [
    { resource: { db: "", collection: "" },
      actions: ["find", "changeStream", "listCollections", "listIndexes", "collStats"] },
    { resource: { cluster: true }, actions: ["listDatabases"] },
  ],
  roles: [],
});
```

`includeUsersAndRoles` also needs `viewUser` and `viewRole` (on
`{ db: "", collection: "" }`, or per database); the built-in `backup` role has neither.

### Backup

Implemented in `src/engine/converge-capture.ts`.

1. Read the current cluster time **T0** (a `ping`'s `operationTime`: the last write
   the node applied). This happens **before** namespace discovery, so a collection
   created after discovery has its creation inside the window.
2. Open a deployment-wide change stream starting at T0 with the low-level `aggregate`
   command (`$changeStream: { allChangesForCluster: true, startAtOperationTime: T0,
   showExpandedEvents: true }`, then a `$match` on the databases, then
   `$changeStreamSplitLargeEvent` where the server has it; see "Large events" and
   "Interruptions" below). The cursor carries the comment
   `mongoshield backup <id> (converge)`, so it can be found in `currentOp`. The server
   filters by database: when every include pattern names its database literally
   (`app.*`, `shop.orders`), only events whose `ns.db` or rename `to.db` is one of
   them (or of the backed-up namespaces) leave the server; otherwise every database
   except `admin`, `config` and `local` (unless backed up). The events kept are those of
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
   cluster time (used for renames, below). A collection dropped, renamed or replaced
   (`$out`) while its dump reads it kills the cursor (QueryPlanKilled, "collection
   dropped"); the dump then keeps what it read and is recorded as usual. The window
   holds the drop or rename (it came after the dump started, so after T0), and
   replaying it empties or replaces the target, so the partial dump is overwritten and
   the restore is exact. (In mode `none` such a collection is read again from the
   start, once, and left out with a manifest warning when it no longer exists; in mode
   `snapshot` the snapshot still holds it, and a failure fails the backup.)
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
(`ChangeStreamHistoryLost` → `MS_CHANGE_HISTORY_LOST`), missing privileges, a
connection that stays down (below), an event over the size limit (below), a drain that
does not reach T1 within 5 minutes (`MS_TIMEOUT`). A converge backup that may have
missed events is never committed.

**Interruptions.** A transient error on the stream's `getMore` (a network error, a
server selection timeout, an error labelled `ResumableChangeStreamError`, or the codes
an operator's `killSessions` / `killCursors` / `killOp` or a step-down produce, such as
`CursorNotFound`, `CursorKilled`, `Interrupted`, `PrimarySteppedDown`) reopens the
stream in a new session with `resumeAfter` the last batch's `postBatchResumeToken`.
The capture stores a whole batch before it asks for the next one, so resuming after
that token neither loses nor repeats an event. Up to 5 attempts are made, 100 ms,
200 ms, 400 ms, 800 ms and 1.6 s apart; then the backup fails with the last error
(`MS_CONNECTION_FAILED` for a network error). A failed first `aggregate` is retried the
same way. Lost history (`ChangeStreamHistoryLost`, `ChangeStreamFatalError`,
`CappedPositionLost`) and missing privileges are never retried. Implemented in
`src/engine/converge-stream.ts`, shared with the journal writer.

**Large events.** The server cannot return a change event larger than its internal
limit (16 MiB + 16 KiB) and fails the cursor (`BSONObjectTooLarge`, code 10334).
MongoDB 7.0 (and 6.0.9) can split such an event into fragments with
`$changeStreamSplitLargeEvent`; the capture adds that stage when the server knows it (an
older server rejects it as an unknown stage, code 40324, and the stream is reopened
without it) and puts the fragments (`splitEvent: { fragment, of }`) back together before
storing, so the changes file only ever holds whole events. The stage splits at
top-level fields, and every fragment repeats the resume token, which embeds the
document key. Without pre- and post-images (MongoShield uses neither), an event only
exceeds the limit when a document close to 16 MiB also has a large `_id`, which the
event holds three times (token, `documentKey`, `fullDocument`): that event cannot be
split either (code 7182500). Both cases fail the backup with `MS_UNSUPPORTED_TOPOLOGY`
and a message naming the change's cluster time when the server's error quotes it.
Events up to the limit itself, slightly over 16 MiB, are captured and replayed
normally.

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
  On a sharded cluster a shard cannot read B as of a time before its current catalog
  entry: the rename commits there after the event's cluster time, B may have been
  replaced again since (a `$out` loop), and through mongos the capture often sees the
  rename only after T1. When the read is refused (SnapshotUnavailable, "has undergone a
  catalog change"), the capture first does an ordinary read of B (mongos refreshes its
  routing) and reads again at the newest cluster time it knows, up to 10 attempts about
  1 s in all; then the backup fails with `MS_UNSUPPORTED_TOPOLOGY`. The records keep the
  rename's cluster time; the events between it and the read follow in the file and
  replay onto the newer state, which converges like a dump does. When the read's time is
  after T1, **T1 moves to it**: T1 only has to be after every dump, and the drain then
  records every event up to the new T1 (`consistency.to`).

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
   | `createIndexes`, `dropIndexes` | recorded per target and applied after the indexes are built (step 4) |
   | collection-option events (`modify`, …) | ignored; metadata comes from the dump |

   Writes match `_id` with the simple collation. They are queued per target namespace
   and sent as ordered `bulkWrite`s (1000 operations or 8 MiB), so the events of each
   document keep their order; a DDL event first flushes the queues it affects.
   An update that fails because its path no longer fits the document (e.g. `$set`
   of `a.5.x` where `a` is now a string; codes 2, 14, 28) is skipped: the event that
   changed `a` comes later and sets it absolutely. Every other error fails the restore.
   Progress is reported as the pseudo-namespace `(changes during the backup)`.
4. Build indexes (except on targets the replay dropped or renamed away), then apply the
   window's index changes (`src/engine/converge-indexes.ts`), then create views. The
   replay collects `createIndexes` / `dropIndexes` per target, in order: a real `drop`
   of the collection starts its list afresh and marks it for a reset (every index
   except `_id_` is dropped first: the indexes it had before are gone), a rename moves
   the list to the new name, and an index created and dropped within the window is
   never built. Each target's list is then applied in order on top of the dumped
   indexes: creating an index that already exists with the same definition is a no-op
   on the server, dropping one that does not exist is skipped, and an index that
   conflicts with a different one of the same name or key is skipped with a warning.
   Index definitions get the same cleanup as dumped ones (no `v`; on a collection with
   a default collation, an index without one gets `{ locale: "simple" }`). This
   converges for the same reason documents do: the dumped indexes were read at some
   moment inside the window, and every later change is applied again in order.
   Building after the data replay means the intermediate states of the replay can
   never trip a unique index. `skipIndexes` leaves the window's index changes out too.

### Incremental backups

An incremental backup (FORMAT.md, "Incremental backups") is a converge window without
dumps: the same capture, started right after its parent's end time P (the cluster time
after P, so no event of the parent is recorded twice) and drained up to its own end.
Two things differ, both because nothing is read besides the change stream:

- **The end.** A converge T1 must not be earlier than anything the dumps read, so it is
  the logical clock, erring late. An incremental's end only has to be a time up to which
  the drain recorded everything: the cluster time of its time series snapshot (it copies
  every time series whole in one snapshot read, FORMAT.md), or without time series the
  `operationTime` of a `ping` (the last write the node applied); never earlier than P.
  The logical clock can be ahead of the last oplog entry (a batched `deleteMany` reserves
  a timestamp per document and writes one entry); a drain to it waits for the next
  periodic no-op write, 10 s and more on an idle deployment.

  Full converge backups keep the logical clock and therefore that wait. Their T1 must
  bound every document the dumps read, and `operationTime` can lag behind writes the
  node has already applied and a dump has already seen (observed on MongoDB 8.0 under
  load): an early T1 would leave such a change out of the replay, so the restore would
  mix moments. Ending at the stream's last position instead is not safe either: with an
  oplog hole (a write that reserved an earlier timestamp and commits later) the stream
  stops before writes a primary's dump can already read. The wait costs time, never
  correctness; an incremental has no dumps, so it can end earlier.
- **Renames.** The chain before the window holds every namespace the selection keeps as
  of P, and every later change to it is in the window, so a rename out of such a
  namespace never needs its destination recorded as of the rename (that snapshot read
  would usually be outside the snapshot window, an hour after the fact). Scratch
  collections (`tmp.*`) and namespaces the selection excludes still get the destination
  records.

The drain of an incremental times out only when the stream makes no progress for 5
minutes (a long window can take longer than that to read). Lost history is
`MS_CHANGE_HISTORY_LOST` with a hint to take a full backup.

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
- Collection option changes (`collMod`, including hiding an index or changing a TTL)
  and view changes during the window are not replayed; the dumped metadata is used.
- A rename during the window of a backed-up collection A over another one B gives B the
  indexes dumped for B plus A's index changes during the window, not the indexes A
  had before the window.
- A change event over the server's size limit fails the backup (see "Large events").
- A connection that stays down for more than about 3 seconds fails the backup (see
  "Interruptions").
- In restore modes `insert` and `upsert`, replay can overwrite documents of the
  target that share an `_id` with a document changed during the window.
- A change stream whose history falls off the oplog (`ChangeStreamHistoryLost`) fails
  the backup; it is never committed as consistent.

### Topologies

The randomized workload of the harness below also runs against a 3-member replica set
and a sharded cluster (`pnpm --filter mongoshield test:topology`, see
`test/topology/`).

**Replica sets with secondaries.** Data is read from secondaries by default
(`secondaryPreferred`); the change stream and the snapshot reads the capture makes for
renames go to the primary. Every data cursor runs in a causally consistent session
whose reads carry `afterClusterTime: T0`, so a lagging secondary waits until it has
replicated T0. A member only accepts an `afterClusterTime` up to its own logical clock,
and the driver gossips the cluster time its *connection* last saw, so before reading,
the session pings the primary once to get a signed cluster time at or after T0 to send
along (`src/engine/backup-namespace.ts`). An election during a backup either leaves it
running (the change stream resumes; reads on secondaries are not interrupted) or fails
it with `MS_CONNECTION_FAILED`, which scheduled runs retry; a failed run never commits
a manifest.

**Sharded clusters (through mongos).** The capture opens one cluster-wide change
stream on mongos, which merges the shards' events in cluster-time order, and T0/T1 are
mongos cluster times, so the argument above holds across shards: sharded and
unsharded collections restore exactly as of T1 under concurrent writes. What a sharded
cluster cannot promise:

- A converge backup can fail with `MS_UNSUPPORTED_TOPOLOGY` ("undergone a catalog
  change") when `$out` or `renameCollection` replaces a backed-up collection during
  the window and the capture has to read the destination as of the rename (see the
  rename rule above): a shard commits the rename's catalog change after the change
  event's cluster time, and refuses a snapshot read at that time where a replica set
  answers it. It depends on timing; a run that succeeds is exact. Run the backup
  again, avoid such rebuilds while backing up, or use `none`.
- Restored collections are not sharded: a restore creates ordinary collections on the
  target's primary shard, with the shard key index as a regular index. Shard the
  target collections first and restore with `mode: "insert"` to spread them again.
- `snapshot` backups work through mongos (one cluster time for every shard), within the
  snapshot window as on replica sets.
- Chunk migrations are left to mongos: reads through mongos filter orphaned
  documents, and the cluster-wide change stream does not report a migration's
  internal writes. The suite does not move chunks during a backup, so this is the
  server's guarantee rather than a tested one.

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
