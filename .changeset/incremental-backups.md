---
"mongoshield": minor
"@mongoshield/console": minor
---

Incremental backups: store only what changed since the previous backup, in chains of a
full backup followed by incrementals (docs/guides/incremental-backups.md).

- `shield.backup({ incremental: true })` (or `{ incremental: { from: "<id>" } }`) and
  `mongoshield backup --incremental [--from <id>]` record every change after the parent
  backup's end time with a change stream, DDL included (create, drop, rename, index
  changes), into the backup's `_changes/window` file. They fail with a hint to take a full
  backup when the oplog no longer reaches back to the parent (`MS_CHANGE_HISTORY_LOST`),
  on a standalone server, or when the parent has no exact end time (consistency `none`)
  or comes from another deployment or selection.
- Format: incrementals are manifests with `kind: "incremental"` and
  `chain: { base, parent, length }`, written as format version 2 so that a reader that
  does not know chains refuses them instead of restoring the wrong data; full backups
  stay version 1. Every manifest now records its `selection` (include/exclude patterns).
- Restore: `restore <incremental>` restores the base full backup and replays every
  incremental up to the chosen one in order, byte for byte as the source was at its end;
  `--at` with an incremental's id stops at a point in time inside the chain, and
  `--at` alone falls back to a chain when the change journal does not cover the time.
  find, history, diff, export, tenant restores and drills read an incremental through its
  chain.
- verify checks the whole chain (every member's files, in the same mode, and every link:
  missing, incomplete or misaligned members are reported); `--chain links` checks only
  the links. list shows the kind (`incr #3`), inspect the parent and the base.
- Retention never deletes a backup a kept incremental depends on, also across scopes;
  chains are shortened only at their newest end. replicate copies a chain's parents
  first, rekey rekeys the whole chain, and the backup guard skips incrementals.
- Scheduled runs: `backup.incremental: { fullEveryDays, maxChainLength }` makes
  `mongoshield run` / `schedule` take incrementals and a full backup whenever a new chain
  is due ("full weekly, incremental hourly"), or when an incremental is impossible. Run
  reports carry `backup.kind`, `parent`, `changes` and `fullBackupReason`.
- Console: plans get "Incremental backups between full ones" with a full-backup interval
  in days (plan field `incremental: { fullEveryDays }`, exported to and imported from
  config files); the backup list marks incrementals.
- Nothing is lost that change events do not carry: every incremental records the
  metadata of every selected namespace (options, validators, TTL and hidden indexes,
  view definitions; `content: "metadata"` entries) and copies every time series
  collection whole in one snapshot read that it ends at (`content: "full"`). A chain
  restore takes time series and views from its newest member and applies collMod
  changes (validator, TTL, hidden indexes, …) after the data. A time series that cannot
  be read consistently fails the incremental (`MS_SNAPSHOT_TOO_OLD`), or takes a full
  backup with `fallbackToFull`.
- Fix: manifest part ranges (`files[].range`) are written and read with the stored field
  order of embedded-document `_id`s (they were reordered by `JSON.stringify` for
  integer-like keys), and `history` compares them in that order, so it reads the right
  part. The CLI's Extended JSON arguments keep the field order they were typed in.
