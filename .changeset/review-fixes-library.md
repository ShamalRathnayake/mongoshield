---
"mongoshield": minor
---

Fixes from a review of the hardening release before it ships:

- Point-in-time restore checks that the base backup and journal cover every
  namespace before it writes anything, so a refusal never leaves the target
  half-restored. Without a known source deployment, each base is judged within its
  own deployment instead of refusing; new `RestoreOptions.sourceIdentity` and
  CLI `restore --source-cluster <clusterId>[/<instanceId>]` pin it.
- Prune keeps every parent of a backup that came into use while it ran, lists use
  leases once instead of once per backup, and scheduled retention keeps replica
  sets that share a set name apart.
- Releasing a use lease no longer races a renewal that is still writing.
- The S3 conditional-write probe runs next to the object being written, and a
  refused probe makes the manifest fall back instead of failing a finished backup;
  the Object Lock lookup is cached.
- File storage compares 64-bit file ids exactly (Windows), a backup's snapshot
  session is always closed, "skip duplicate _id" also works on MongoDB-compatible
  engines, and the regex safety check accepts common safe patterns such as
  `^([a-z0-9]+\.)+[a-z]+$`.
- The copy checkpoint fallback folder in the temp directory is private (0700) and
  refused if it belongs to someone else or is a symlink.
