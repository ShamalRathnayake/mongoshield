---
"mongoshield": minor
---

Make incrementals, the change journal and consistency fallbacks work across more deployments, and tell apart replica sets that share a name.

- Incremental backups on Atlas Free and Flex now adapt like full backups: a regex-only change stream filter, the gentler parallelism and read limit, and `includeUsersAndRoles` refused up front.
- The change journal detects Atlas Free/Flex and uses the regex-only filter there. It refuses standalone servers and MongoDB before 6.0 at start with `MS_UNSUPPORTED_TOPOLOGY`. A change stream the server cannot open at all (for example an unknown `showExpandedEvents`) is now a fatal error instead of being retried forever.
- `consistency: "auto"` falls back to `none` with a warning when the server refuses the change stream probe as unsupported, and on any probe error from Amazon DocumentDB, Azure Cosmos DB or FerretDB. Explicit modes still fail loudly.
- An Atlas tier that refuses snapshot reads now gets a clear `MS_UNSUPPORTED_TOPOLOGY` before any collection is read (consistency `snapshot`), and while recording a rename's destination (converge).
- New `warnings` on completed backup results, and `backup.consistency` / `backup.warnings` in run reports. These cover `auto` falling back to `none`, incrementals that keep falling back to full backups on `MS_SNAPSHOT_TOO_OLD`, and Queryable Encryption collections backed up without their state collections.
- Manifests and checkpoints record `source.instanceId`, a hash of the replica set's `replicaSetId`, when the user may read it. Incrementals, resume and the backup guard compare it when both sides have one, and older backups still match on `clusterId` alone. There is no format version bump.
- A server selection timeout on a single-host connection string now suggests `directConnection=true`.
