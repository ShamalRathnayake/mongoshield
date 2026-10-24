---
"mongoshield": patch
"@mongoshield/console": patch
---

Correctness fixes found by a full test sweep:

- Restore, copy, change replay and point-in-time recovery keep every document's field order,
  including integer-like keys, and so do index keys, validators, users and roles, part bounds,
  copy checkpoints and subset references.
- Converge backups never replay events after the manifest's end of the window, replay indexes
  created during the window, survive dropped or replaced collections and network errors, and
  delete leftover files before the manifest commits.
- `resume: "auto"` only continues a checkpoint with the same labels, so two jobs with the same
  selection never resume each other's backup.
- Ctrl-C cancels a connection attempt immediately (exit code 60).
- mongodump interop handles time series buckets, users, roles, `system.js` and oplog files.
- Console: OIDC sign-in, config import, scoped prune, metrics; a run's prune no longer deletes
  other plans' backups.
