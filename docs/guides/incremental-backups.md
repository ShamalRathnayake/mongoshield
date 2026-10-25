# Incremental backups

A full backup reads every document, every time. An **incremental backup** stores only
what changed since the previous backup, so you can back up every hour (or every few
minutes) at the cost of the changes, and keep a full backup once a week.

```
 Sunday 03:00      03:00 + 1 h     + 2 h       + 3 h            next Sunday 03:00
 ───●───────────────▲──────────────▲───────────▲─── … ────────────●──────────▲── …
   full            incr #1        incr #2     incr #3            full       incr #1
   (all data)      (changes)      (changes)   (changes)          new chain
```

Backups form a **chain**: a full backup (the chain's **base**) followed by incrementals,
each holding the changes after the previous one, up to the moment it was taken.
Restoring an incremental restores the base and replays every incremental up to it, so
the result is the database exactly as it was when that incremental finished. The format
and the exact rules are in [docs/specs/FORMAT.md](../specs/FORMAT.md#incremental-backups).

## Requirements

- A **replica set or sharded cluster on MongoDB 6.0+** (Atlas included): changes are
  recorded with a deployment-wide change stream, as for `consistency: "converge"`.
- A user allowed to open it: `changeStream` and `find` on every database, e.g. the
  `readAnyDatabase` role (see [CONSISTENCY.md](../specs/CONSISTENCY.md#converge) for a
  least-privilege role).
- A first **full backup taken with consistency `converge` or `snapshot`** (what `auto`
  picks on a replica set). A backup taken with `none` mixes moments and cannot be
  continued.
- An **oplog that reaches back to the previous backup**. Take incrementals more often
  than your oplog window (`rs.printReplicationInfo()` shows it); when the oplog no
  longer holds the changes since the last backup, the incremental fails with
  `MS_CHANGE_HISTORY_LOST` and a hint to take a full backup (scheduled runs take one
  automatically, below).
- The **same selection** every time: an incremental continues the newest backup of the
  same deployment with the same `include` / `exclude` patterns. Per-collection `query`
  filters cannot be used (change events are recorded whole).

## Taking incremental backups

### CLI

```bash
mongoshield backup --include 'app.*'                    # the full backup: the chain's base
mongoshield backup --include 'app.*' --incremental      # only the changes since the newest backup
mongoshield backup --include 'app.*' --incremental --from 2026-11-14T04-00-02Z_1a2b3c
```

`--from` continues a given backup instead of the newest one (the new incremental's chain
then branches off there). The summary shows the parent, the chain position and the number
of changes:

```
✔ Incremental backup complete.
Backup id    2026-11-14T05-00-01Z_9e8d7c
Parent       2026-11-14T04-00-02Z_1a2b3c
Chain        incremental #2 after full backup 2026-11-14T03-00-04Z_7f3a9c
Changes      48,213
```

### Library

```ts
const full = await shield.backup({ include: ["app.*"] });
// … later
const incremental = await shield.backup({ include: ["app.*"], incremental: true });
// or continue a specific backup:
await shield.backup({ include: ["app.*"], incremental: { from: full.id } });
```

`incremental.fallbackToFull: true` takes a full backup instead whenever an incremental is
not possible (no backup to continue, lost oplog history, a standalone server); the
result's `fullBackupReason` says why. `fullAfterMs` and `maxChainLength` start a new chain
with a full backup once the chain's base is that old, or the chain that long.

### Scheduled: full weekly, incremental hourly

`mongoshield run` and `mongoshield schedule` decide the kind of each run themselves with
`backup.incremental`:

```ts
// mongoshield.config.ts
export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "s3://acme-backups/prod",
  encryption: { recipients: [process.env.BACKUP_RECIPIENT] },
  backup: {
    include: ["app.*"],
    // A full backup when the chain's base is a week old; incrementals in between.
    incremental: { fullEveryDays: 7 },
  },
  schedule: { cron: "0 * * * *" },          // every hour
  retention: { last: 48, daily: 14, weekly: 8 },
});
```

Each run takes an incremental of the newest backup, and a **full** backup when:

- there is nothing to continue yet (the first run);
- the chain's full backup is older than `fullEveryDays` (default 7);
- the chain already holds `maxChainLength` incrementals (no limit by default);
- an incremental is impossible, e.g. the oplog no longer reaches back to the last backup.

The run report says which kind was taken (`backup.kind`, and `backup.fullBackupReason`
for a full one). An incremental is verified with `chain: "links"`: its own files and the
links of its chain (each earlier member was verified by the run that took it).

In the **console**, tick "Incremental backups between full ones" in a plan's "When"
section and set the full-backup interval in days.

## Restoring

```bash
mongoshield restore 2026-11-14T05-00-01Z_9e8d7c --rename 'app.*=app_restored.*'
```

The plan shows the base backup's collections and names the incrementals that will be
replayed after it. `restore latest` restores the newest backup, which is often an
incremental. Everything is checked before the first write: every member of the chain
exists and lines up, and every changes file reads, decrypts and parses.

**A point in time inside the chain.** `--at` with an incremental's id restores its chain
up to that moment (any time from the base's end to the incremental's end):

```bash
mongoshield restore 2026-11-14T05-00-01Z_9e8d7c --at 2026-11-14T04:37:00Z
```

`--at` without an id uses the [change journal](point-in-time-recovery.md) when one covers
the time, and otherwise an incremental chain that does.

**Encryption.** Each backup of a chain is encrypted on its own (its own key envelope for
passphrase and KMS backups), so restoring a chain needs the keys of every member. Rekey
and replicate handle chains: `mongoshield rekey <incremental>` and `mongoshield replicate
<incremental>` include every backup it depends on (parents first, for replication).

## Checking, listing and reading chains

- `mongoshield list` shows the kind of each backup: `full`, or `incr #3` for the third
  incremental after its full backup.
- `mongoshield inspect <id>` shows the parent and the base (`Kind  incremental #2, after
  … (base …)`), and for a full backup how many incrementals continue it.
- `mongoshield verify <incremental>` checks the whole chain: every member's files, in the
  same mode (`--deep` decrypts and parses every member), and every link. A missing or
  damaged member is reported as `chain <id>` or `<member id>/<file key>`. `--chain links`
  checks only the links and the incremental's own files.
- `find`, `history`, `diff`, `export`, `restore-tenant` and `drill` read an incremental as
  its base with the chain's changes overlaid, so they show the data as of that
  incremental. Collections created after the base can only be read by restoring.

## Retention

Incremental backups count as backups like any other (`last: 48` keeps the 48 newest,
whatever their kind), and **a backup that a kept incremental depends on is never
deleted**. A chain is therefore only ever shortened at its newest end, and goes as a whole
once nothing keeps any member. Holds work the same way: holding an incremental keeps its
chain. Backups that another job's incremental depends on are kept too, even when they are
in the scope being pruned.

Plan retention with chains in mind: `daily: 14` keeps each day's newest backup, usually
that day's last incremental, and with it the chain back to its full backup.

## Limits

- **Time series collections** are copied whole by every incremental (change streams do
  not report their writes), in one snapshot read that the incremental ends at. A large
  time series makes every incremental read it all; when the read outlives the server's
  snapshot window (`minSnapshotHistoryWindowInSeconds`, 5 minutes) the incremental fails
  with `MS_SNAPSHOT_TOO_OLD` (scheduled runs take a full backup instead). A time series
  is never left out silently.
- **Collection options, validators, TTLs, hidden indexes and views** are recorded as
  every incremental's metadata and applied after the data on restore (`collMod`). Options
  `collMod` cannot change (collation, capped size, clustered keys) stay as the base had
  them; a change made between an incremental's metadata read and its end is picked up by
  the next incremental. A point-in-time restore inside the last window uses the metadata
  of the newest incremental that ends before the chosen time.
- **Users and roles** come from the newest member of the chain taken with
  `--users-and-roles` (each such incremental stores a fresh copy).
- The oplog must reach back to the previous backup's end; size it for your incremental
  interval with room to spare.
- A rename into the selection from an excluded collection, or an `$out` that started
  before the previous backup and finished after it, is recorded with a snapshot read at
  the rename's time; when that is outside the snapshot window the incremental fails, and
  a full backup is needed (scheduled runs take one).
- Long chains restore more slowly: every change since the base is replayed. Keep chains
  to days, not months (`fullEveryDays`, `maxChainLength`).
