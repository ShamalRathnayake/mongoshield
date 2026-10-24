---
title: Point-in-time recovery
description: Restore to any second between backups with MongoShield's change journal.
---

Nightly backups can lose up to a day of data. The **change journal** records every
change between backups, so a restore can stop at any second: just before the bad deploy,
the accidental `deleteMany`, or the ransomware.

```
 base backup (03:00)        journal: every change, in 5-minute segments           now
 ──────●────────────────────▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮──────▶
                                                    ▲ restore --at 14:31:59
```

## How it works

- A **journal writer** (`mongoshield journal start`, or `startJournal()` from code)
  follows a deployment-wide change stream and writes every change into compressed,
  encrypted **segments** next to your backups, a few minutes or megabytes at a time.
  Exactly one writer runs per storage location; a lease in storage enforces that.
- A small state file records the **recovery point**: the newest moment up to which the
  journal is complete. How far behind "now" it is is your **RPO**, normally under one
  segment interval. `mongoshield journal status` shows it.
- A **point-in-time restore** (`mongoshield restore --at 2026-11-14T14:31:59Z`) restores
  the newest base backup taken before that moment, then replays the journal up to it,
  with the same replay rules as [`converge`](/concepts/consistency/).

A date is rounded down to its second, and that second's writes are **not** replayed: if
you name the second the bad `deleteMany` ran, it is not replayed. Pass a cluster time
(`t:i`) for exact control. `--dry-run` shows which backup and segments would be used.

## Requirements

- A replica set or sharded cluster on MongoDB 6.0+ (Atlas included).
- A user allowed to open a cluster-wide change stream, e.g. `readAnyDatabase`.
- Base backups with a cluster time: `consistency: "converge"` (what `auto` picks on a
  replica set) or `"snapshot"`, including every namespace the journal records.
- Storage with conditional writes (file, S3, GCS, Azure) for the writer's lease.
- Encryption with recipients or KMS keys. Passphrases are refused for the journal,
  because every segment is its own file and scrypt costs about a second per file.

## Gaps are recorded, never hidden

If the writer falls so far behind that the server's oplog no longer holds the changes it
needs, the missing range is recorded as a gap. A restore to a time inside a gap fails
with `MS_CHANGE_HISTORY_LOST` and lists the ranges that *can* be recovered.

Set it up with the [point-in-time recovery guide](/guides/point-in-time-recovery/); the
on-disk format is in the [journal spec](/specs/journal/).
