---
"mongoshield": minor
---

Scoped retention: pruning one source or selection never deletes another's backups in a shared
storage location. `shield.prune(policy, { scope })` takes `{ clusterId?, labels? }` and reports
`outOfScope`; scheduled runs and `mongoshield prune` scope by the source's cluster and the
`mongoshield.shape` label (which `mongoshield backup` now writes too); `mongoshield prune
--all-sources` prunes the whole location after a per-source confirmation, `--scope-label` scopes
by custom labels. Journal pruning keeps segments any scope's base backup still needs.
