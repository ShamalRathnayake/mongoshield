---
"mongoshield": minor
"@mongoshield/console": patch
---

Retention and incremental chains now tell apart two replica sets that share a set
name (for example staging and prod both called `rs0`). Prune scopes accept an
`instanceId` next to `clusterId`, the new `shield.sourceIdentity()` returns both,
and the CLI's `prune` and the console's plan retention use it. A chain whose
parent came from a different replica set with the same name is reported as a
mismatch. Backups written before `instanceId` existed keep matching as before.
