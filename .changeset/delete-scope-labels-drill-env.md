---
"mongoshield": minor
---

- `mongoshield delete <id>` and `shield.deleteBackup(id)`: delete one backup by id. The
  manifest goes first (so no reader ever sees a half-deleted backup), then its files,
  annotations and checkpoint. Backups on hold, still write-once (`retainDays` / object
  lock) or needed by an incremental backup are refused with the new `MS_BACKUP_PROTECTED`
  (exit code 35). Asks for confirmation (`--yes` in scripts), supports `--json`, and logs
  an audit line (id, objects, bytes, who, when).
- `retention.scopeLabels`: labels that mark a job's backups and scope its retention, so
  two jobs with the same source and selection in one storage location never prune each
  other's backups. Used by `mongoshield run`/`schedule` and by `mongoshield prune`.
- `MONGOSHIELD_DRILL_URI`: the drill's scratch deployment from the environment, for
  `drill.targetUri` and `mongoshield drill` (instead of `--target-uri`), so it can come
  from a secret.
