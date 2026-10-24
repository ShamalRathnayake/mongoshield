---
title: Retention & safety
description: How MongoShield decides which backups to keep, and the safety rules that always apply.
---

Deleting backups is the most dangerous thing MongoShield does, so pruning is deliberately
conservative: when in doubt, it keeps.

## The policy

```ts
retention: { last: 3, daily: 7, weekly: 4, monthly: 12 }
```

- `last: N` keeps the N most recent complete backups.
- `hourly`, `daily`, `weekly`, `monthly` and `yearly` keep the newest backup of each of
  the last N periods **that have a backup** — the same semantics as restic's and borg's
  `--keep-*`. `daily: 7` means "one backup for each of the last 7 days that have one",
  not "the last 7 calendar days", so a week without backups does not empty your history.
- Periods are calendar periods in UTC; weeks are ISO weeks starting on Monday.

One backup can satisfy several rules at once, and every reason is recorded, so
`mongoshield prune --dry-run` explains exactly why each backup is kept or removed.

## Safety rules

These apply whatever the policy says:

1. A policy without any count keeps everything.
2. The newest complete backup is always kept.
3. Held backups are always kept ([`mongoshield hold`](/reference/cli/hold/)), for
   example during an incident or a legal hold.
4. At least `minVerified` verified backups are kept.
5. Incomplete runs (no manifest) are removed only after a grace period of a day, since
   they may still be running; backups with an invalid manifest are never removed
   automatically (they may come from a newer MongoShield).
6. Backups dated in the future are kept.
7. [Immutable backups](/guides/immutable-backups/) are kept until their lock expires;
   the storage would refuse to delete them anyway.

## Guarding against bad backups

Retention keeps the newest backups — which is only good if they are good. Two features
help:

- **Verification** after every scheduled backup (`schedule.verify`); nothing is pruned
  after a backup that failed or did not verify.
- **The backup guard** refuses to commit a backup that looks like data was lost since the
  previous one, for example when a collection lost more than half its documents. See
  [the backup guard](/guides/scheduling/#the-backup-guard).

## Running it

- `mongoshield prune --dry-run` shows the plan; `mongoshield prune` applies it (asks for
  confirmation, `--yes` in scripts).
- Scheduled runs prune after each good backup (`schedule.prune`, on by default).
- From code: `shield.prune({ daily: 7, weekly: 4 })`, or `planRetention()` for the plan
  alone (a pure function with no I/O).

With [point-in-time recovery](/concepts/point-in-time-recovery/), prune the journal
after backups: segments older than the oldest kept base backup can no longer be used.
