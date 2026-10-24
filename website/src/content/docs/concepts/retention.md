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

## Scopes: whose backups a policy covers

Storage locations are often shared: two `mongoshield run` jobs for different databases
or clusters, two console plans, a nightly full backup next to an hourly backup of one
collection. A policy must only see its own backups — otherwise the hourly job's
`last: 24` would delete every nightly backup, simply because they are older.

So retention is **scoped**. A scope selects backups by what their manifest records:

| Scope field | Matches | Set by |
|---|---|---|
| `clusterId` | `manifest.source.clusterId`, a hash identifying the source deployment | every backup |
| `labels` | `manifest.labels`, every given key/value pair | `mongoshield.shape` (the include/exclude selection) on backups from `mongoshield backup`, `run` and `schedule`; `mongoshield.plan` on console backups; your own `--label`s |

Every field a scope gives must match; a backup that does not record a field (no
`clusterId`, no label) does **not** match. Backups outside the scope are never planned
over or touched, and are reported as left alone. The safety rules below apply within
each scope, so every scope keeps its own newest backup.

Who prunes with which scope:

- **Scheduled runs** (`mongoshield run`, `mongoshield schedule`) prune the backups of
  the same deployment *and* the same selection (`mongoshield.shape`) as the backup they
  just wrote.
- **`mongoshield prune`** uses the same default: the configured source's cluster (it
  connects to `source.uri` / `--uri` to read it; without a source it takes the cluster
  of the matching backups and refuses if there are several) and the shape of the
  `backup` section's (or `--include`/`--exclude`) selection. `--scope-label key=value`
  scopes by your own labels instead. The output says how many backups of other
  sources/selections were left alone.
- **`mongoshield prune --all-sources`** applies the policy to every backup in the
  location, whoever wrote it. It always asks for confirmation (or `--yes`) and first
  lists what it would delete per source/selection.
- **The console** labels each plan's backups `mongoshield.plan=<plan id>` and prunes per
  plan (that label plus the connection's cluster), automatically after each run and
  from the Backups page.
- **From code**, `shield.prune(policy)` without a scope still covers the whole location;
  pass `{ scope: { clusterId: await shield.sourceClusterId(), labels: { … } } }` when
  others write there too. An empty scope is refused rather than read as "everything".

Incomplete runs have no manifest. A resumable run's checkpoint records its cluster and
labels, so it belongs to its scope and is removed once idle past the grace period. A run
that crashed without a checkpoint cannot be attributed to anyone: scoped prunes leave it
alone and report it; `--all-sources` removes it. Backups written before scoped retention
(by `mongoshield backup` without the shape label, or without a `clusterId`) are likewise
outside every default scope; prune them once with `--all-sources` or a `--scope-label`.

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
`shield.prune` does this for you, and always looks at the oldest base backup kept across
**all** scopes — the journal is shared by the location, so a segment another scope's
backup still needs is never deleted.
