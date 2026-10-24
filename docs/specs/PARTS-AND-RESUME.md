# Split collections and resumable backups

Status: implemented in phase P4 (sections 1–3 and 5 describe the code as built;
section 4 is owned by the immutable-backups work). This document is the contract.

## Goals

1. **Large collections are dumped in parallel** and can be retried one piece at a time.
2. **A backup can stop and continue later**, so databases larger than one
   serverless invocation (15 minutes on Lambda, less on Vercel) can still be backed up.
3. **Backups don't hurt production**: reads can be rate-limited and sent to secondaries.
4. **Backups can be made immutable** where the storage supports it.

## 1. Parts

A collection whose size exceeds `partSizeBytes` (default 256 MiB of raw BSON, read from
`$collStats` `storageStats.size`, summed over shards) is split into **parts**, each a
contiguous `_id` range dumped into its own file:

```
app/orders.000.bson.zst.age     _id in [MinKey, b1)
app/orders.001.bson.zst.age     _id in [b1, b2)
app/orders.002.bson.zst.age     _id in [b2, MaxKey]
```

A collection that is not split keeps mongodump's plain name (`app/users.bson.zst`) and
is read in natural order, exactly as before parts existed.

- **Boundaries** come from `$sample` of `_id` values (20 samples per wanted part, at
  most 100,000), sorted **by the server** (`$sort: { _id: 1 }`, so mixed types are
  ordered exactly like the `_id` index orders them), and taken at even intervals.
  Repeated values are dropped, so there may be fewer parts than wanted. Boundaries
  keep their exact BSON types (`promoteValues: false`): a Long above 2^53 must not
  become a double, or a resumed run would cut the collection somewhere else.
- **Each part** is read with
  `find(query, { hint: { _id: 1 }, sort: { _id: 1 }, min: { _id: lower }, max: { _id: upper } })`
  (the first part has no `min`, the last no `max`). Index bounds are used instead of
  `{ _id: { $gte, $lt } }` because query comparisons are *type-bracketed*:
  `{ $gte: ObjectId(…), $lt: "abc" }` matches nothing, so a collection with mixed `_id`
  types would silently lose documents. Index bounds compare in plain BSON order.
  `max` is exclusive even when only `min` is given, so the last part additionally
  reads the (at most one) document whose `_id` is `MaxKey`, which sorts last anyway.
  Sorting by `_id` makes a part's content well defined, which is what makes retries
  and resumption correct.
- **Concurrency:** all parts of all collections go through one pool of `parallelism`
  workers (default 4), so parts of one large collection run side by side.
- **Never split:** views (no data), time series (their statistics describe buckets),
  clustered collections (their `_id` index is the collection itself), and collections
  without a plain `{ _id: 1 }` index (capped collections created without one). Also
  when `$collStats` cannot be read (missing privilege): the collection is then dumped
  as one part, with a debug log.
- **Manifest:** each part is one entry in the namespace's `files` array, in `_id`
  order. Restore, verify and export already process `files` in order (export writes
  them into one mongodump `.bson` file). Split parts also record their bounds:

  ```json
  "files": [{ "key": "app/orders.000.bson.zst", "size": 1, "sha256": "…",
              "range": { "from": { "$minKey": 1 }, "to": { "$oid": "…" } } }]
  ```

  `range` is optional canonical Extended JSON (`from` inclusive, `to` exclusive). It is
  informational for readers; FORMAT.md documents it.

Code: `src/engine/backup-parts.ts` (planning), `backup-dump.ts` (plans and the pool),
`backup-namespace.ts` (one part).

## 2. Checkpoints and resumption

A run can be stopped at a part boundary and continued by a later process.

- **Time budget.** `backup({ maxDurationMs })` stops *starting* parts once the budget
  is nearly used up. Parts already running are never interrupted (they would only have
  to be redone). A part starts only if, judging by the average duration of the parts
  finished so far in this invocation, it would end before the deadline minus a reserve
  for the checkpoint write (5% of the budget, at most 10 s). Every invocation starts at
  least one part, so a budget that is too small still makes progress
  (`src/engine/backup-budget.ts`).
- **Result.** When parts are left, the run writes the checkpoint and returns
  `{ status: "checkpointed", id, durationMs, checkpoint: { key, partsDone, partsTotal,
  documents, bytesRaw } }` instead of committing a manifest. A completed run returns
  `{ status: "complete", id, manifest, durationMs }`. `runBackup` / `shield.backup`
  are overloaded: without `maxDurationMs` and `resume` the type is always the complete
  result.
- **The checkpoint** lives at `_state/checkpoints/<backup id>.json`, outside the backup
  directory, so the directory stays mongodump-shaped. It is written after planning and
  rewritten after every finished part (so even a process that is killed loses only the
  parts in flight), and holds (`src/engine/backup-checkpoint.ts`):
  - the options fingerprint: include/exclude (sorted), a SHA-256 of the `query`
    filters (never the filters: they may hold customer data), compression, the
    encryption kind with its recipients / KMS key names, and `retainDays`;
  - the source (topology, version, `clusterId`), labels and start time of the first
    invocation, the number of invocations and the tool version;
  - how files are encrypted: the manifest recipients, the public recipients the files
    are encrypted to, and the key envelope's stored-file entry (size + SHA-256);
  - the plan: every namespace with its metadata file, `_id` boundaries (canonical
    Extended JSON) and parts, and every finished part's size, SHA-256, document and
    byte counts.
  No secret is stored. `partSizeBytes` is not part of the fingerprint: the stored plan
  decides where parts are cut.
- **Resuming.** `backup({ resume })` takes a backup id, `"latest"` (the newest
  checkpoint) or `"auto"` (the newest checkpoint with the same fingerprint and source,
  or a new backup when there is none). It refuses (`MS_CONFIG_INVALID`) a different
  fingerprint (naming the fields that differ), a different deployment (`clusterId`),
  and a backup whose manifest already exists; a missing checkpoint is
  `MS_BACKUP_NOT_FOUND`. It then checks with `head()` that every metadata file and
  finished part still exists with its recorded size, and re-hashes the small key
  envelope; anything changed is `MS_INTEGRITY_FAILED` (start a new backup). Only the
  remaining parts are dumped. When every part is done it writes the manifest
  (`startedAt` = the first invocation's start) and deletes the checkpoint.
- **Encryption on resume.** Recipient backups use the (identical) current recipients.
  Passphrase backups unlock the key envelope with the given passphrase (one scrypt per
  invocation), which also proves it is the passphrase the backup started with
  (`MS_DECRYPTION_FAILED` otherwise). KMS backups reuse the envelope's public
  recipient from the checkpoint, so resuming needs no KMS decrypt permission.
- **Retention.** With `retainDays`, every invocation locks its files until the first
  invocation's start + `retainDays`, so all files and the manifest share one
  `immutableUntil` (`retainDays` is in the fingerprint).
- **Failures.** A resumable run that fails (or is aborted) after its first checkpoint
  keeps its files and saves its progress, so it can be resumed; before that, and when
  `beforeCommit` (the backup guard) refuses the manifest, everything is deleted like
  any failed run, checkpoint included.
- **Consistency:** a resumed backup spans several invocations, so only mode `none` is
  allowed with `maxDurationMs` or `resume` (`snapshot`/`converge` are refused with
  `MS_CONFIG_INVALID`). `auto` resolves to `none`, and the manifest's
  `consistency.warning` names the time span the reads covered and the number of
  invocations. (Resuming a change stream across invocations is a possible later
  extension.)
- **Pruning:** an incomplete run's age is measured from its last activity, which
  includes its checkpoint's modification time, so a checkpointed run is kept for the
  grace period (`incompleteGraceMs`, default 24 h) after its last invocation. Older
  ones are pruned, and their checkpoint is deleted with them.

The CLI exposes this as `mongoshield backup --max-duration 14m` and
`mongoshield backup --resume <id|latest|auto>` (a value is required: `parseArgs` has
no optional values). A checkpointed run exits 0 and prints
``checkpointed: resume with `mongoshield backup --resume <id>` ``; `--json` prints the
result with its `status`, `--quiet` the id. `mongoshield run` passes `resume: "auto"`
whenever `backup.maxDurationMs` is configured, so each scheduled invocation continues
the newest matching checkpoint; its report has `status: "checkpointed"` (verify is
skipped, prune still runs; notifications and heartbeats count it as a success, webhooks
get `backup.checkpointed`). Other CLI flags: `--part-size 256MiB`,
`--read-preference …`, `--max-docs-per-second …`, `--max-bytes-per-second 50MiB`,
`--retain-days 30`. All of them also exist in the config file's `backup` section
(`partSizeBytes`, `maxDurationMs`, `readPreference`, `readPreferenceTags`,
`maxDocumentsPerSecond`, `maxBytesPerSecond`, `retainDays`).

## 3. Production-friendly reads

- `readPreference` (default `"secondaryPreferred"`) and `readPreferenceTags` apply to
  every data read and to planning reads (`$collStats`, `$sample`). By consistency mode:
  - `none`: as configured.
  - `converge`: as configured, but when the preference is not `primary` every part
    runs in its own causally consistent session whose operation time is the window
    start T0, so a lagging secondary waits until it has applied T0
    (`readConcern.afterClusterTime`). Otherwise it could return data older than T0
    that replaying the changes from T0 would not repair.
  - `snapshot`: always the primary (the snapshot time is pinned there).
- `maxDocumentsPerSecond` and `maxBytesPerSecond` are enforced by one limiter shared by
  all parts (so they bound the backup as a whole), in a throttle stage right after the
  counting stage. It is a token bucket in its virtual-scheduling form (GCRA) with a
  250 ms burst; delays under 5 ms are carried over rather than slept, so timer
  resolution does not cap throughput. Holding a document back stops the stream, and
  backpressure makes the cursor ask for its next batch later, so the server only does
  the work we consume (`src/engine/rate-limit.ts`).
- An adaptive batch size keeps each cursor batch near 4 MiB: `4 MiB / average document
  size`, clamped to 16–100,000 documents. The average comes from `$collStats` for the
  first part of a collection and from what the finished parts actually read for the
  following ones. (The driver fixes a cursor's batch size when it opens, so it adapts
  per part, not within one.)

## 4. Immutable backups

- `PutOptions.retainUntil?: Date` asks the adapter to apply write-once retention
  (S3 Object Lock in compliance or governance mode, GCS object retention, Azure blob
  immutability policy). Adapters that can't do this report `capabilities.objectLock = false`,
  and asking for retention then fails with `MS_CONFIG_INVALID` before any data is read.
- `backup({ retainDays })` applies retention to every file and the manifest. The manifest
  records `immutableUntil`.
- `prune` never tries to delete a backup before `immutableUntil`. It reports such backups
  as kept with the reason "immutable until …".
- The retention mode is an adapter option, `retention: { mode: "compliance" | "governance" }`
  on `s3Storage`, `gcsStorage` and `azureStorage` (default `"compliance"`). It maps to S3
  `COMPLIANCE`/`GOVERNANCE`, GCS `Locked`/`Unlocked` and Azure `Locked`/`Unlocked`.
- The bucket or container must be prepared (S3 Object Lock enabled, GCS object retention
  enabled, Azure version-level immutability). If it is not, the first retained put fails
  with `MS_CONFIG_INVALID` and a hint naming the setting.
- Deleting or overwriting a retained object fails with `MS_STORAGE_FORBIDDEN`. Prune
  reports such refusals as skipped, not as failures (clock skew or a manifest-less
  partial backup can hit locked objects).
- `memoryStorage({ objectLock: true })` enforces retention in memory, for tests.
- Engine (owned by the backup pipeline): with `retainDays`, compute
  `retainUntil = run start + retainDays` once per backup (so every object, and the
  manifest, share one date), check
  `storage.capabilities.objectLock` before reading any data (fail with
  `MS_CONFIG_INVALID`), pass the same `retainUntil` to every put including the manifest,
  and write `immutableUntil: retainUntil.toISOString()` in the manifest. Resumed runs reuse
  the original `retainUntil` from the checkpoint.

## 5. Memory

Peak memory is roughly:

```
baseline + parallelism × (cursor batch ≈ 4 MiB + compression window + upload buffer)
```

The upload buffer is about 16 MiB per stream for S3's default part size and 4 MiB for
local disk.

`bench/memory.ts` checks this (`node bench/memory.ts --docs N --parallelism P
--heap-mib H`): it seeds N documents of ~1 KiB, runs the backup in a child process
started with `--max-old-space-size=H` (a backup that buffered the database would crash),
samples RSS, heap and off-heap buffers every 20 ms, and reports throughput. Results on
an Apple-silicon laptop, local mongod 7.0, file storage, zstd, 64 MiB parts, heap
limit 128 MiB:

| documents | raw data | parallelism | duration | throughput | heap used | off-heap buffers | peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1 MiB | 4 | 0.1 s | — | 25 MiB | 20 MiB | 135 MiB |
| 150,000 | 146 MiB | 1 | 0.6 s | 240k docs/s | 33 MiB | 39 MiB | 184 MiB |
| 1,200,000 | 1.17 GiB | 1 | 4.2 s | 285k docs/s, 280 MiB/s | 33 MiB | 39 MiB | 280 MiB |
| 150,000 | 146 MiB | 4 | 0.6 s | 243k docs/s | 47 MiB | 64 MiB | 248 MiB |
| 600,000 | 585 MiB | 4 | 1.5 s | 409k docs/s, 400 MiB/s | 45 MiB | 64 MiB | 327 MiB |
| 1,200,000 | 1.17 GiB | 4 | 3.1 s | 389k docs/s, 380 MiB/s | 47 MiB | 91 MiB | 369 MiB |

What MongoShield holds (JavaScript heap plus off-heap buffers: cursor batches, stream
chunks) stays flat as the database grows and scales with `parallelism`: about 70 MiB
at parallelism 1 and 110–140 MiB at 4, in line with the estimate above. Peak RSS is
higher and creeps up with the amount of data pushed through (+100 MiB for 8× the
data): that is the allocator keeping freed buffer memory and V8 collecting external
buffers lazily, not data held by the backup; it did not grow the heap, and the 64 and
128 MiB heap limits were never a problem. The benchmark's data is highly compressible
(1.2 GiB → 4 MiB), so these runs measure the read path, not the upload.
