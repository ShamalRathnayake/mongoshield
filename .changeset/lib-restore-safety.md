---
"mongoshield": minor
---

Safer restores, retention and copies:

- Point-in-time restores pick the newest base backup that suits the restore (covers every selected namespace, has no query filter on them, comes from one deployment) and refuse clearly when none does; `planPointInTimeRestore` takes `include`, `exclude` and `clusterId`, and the journal replay refuses namespaces the base never covered.
- A backup that failed verification is never continued by an incremental; incrementals verified with `chain: "links"` are recorded as such and count towards `minVerified` only once their whole chain is verified.
- Restores, verifies, drills and running backups hold a use lease (`annotations/<id>/leases/`) that prune and delete respect, so a backup is never pruned while it is read or still being written.
- Drop-mode restores verify every data part first by default (`verifyFirst`), and `replace-tenant` checks the parts before deleting the tenant.
- Insert mode skips only duplicate `_id`s; a collision on another unique index fails the restore. Skipped documents are reported in `documentsSkipped`.
- On S3 buckets with Object Lock, deleting a still-locked object is refused instead of hiding it behind a delete marker.
- `restoreDocuments` (`find --restore`) applies the erasure ledger like every other restore.
- Retention periods count in `timeZone` (`schedule.timezone` for scheduled runs and `mongoshield prune`); UTC remains the default.
- Namespace wildcards are matched in linear time, and `$regex` filters with nested quantifiers or over 1024 characters are refused, so a pattern can no longer block the process.
- Exports are written with mode 0600 (directories 0700); replication errors, CLI warnings and `--verbose` output are scrubbed of secrets; a password in a command-line connection string draws a warning, and `MONGOSHIELD_URI_FILE` reads the connection string from a file.
- Masked copies warn about validators, partial indexes and views that refer to masked fields.
- `mongoshield --config f schedule` (global flags first) keeps the scheduler's own SIGTERM handling.
