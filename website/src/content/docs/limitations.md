---
title: Limitations
description: What MongoShield does not do, or does not do yet, collected from the specs and guides.
---

An honest list, gathered from the [specs](/specs/format/) and guides. Most of these are
consequences of taking *logical* backups through the driver.

## In general

- **Logical backups only.** Restores re-insert every document and rebuild every index,
  so restore time grows with data size. For very large deployments, storage snapshots
  or physical backups restore faster (see [Compare](/compare/percona/)).
- **User data only.** Users, roles, server settings and `system.*` collections are not
  backed up.
- **2.0 is pre-release.** It is published on the `next` npm tag while in development.
- **The web console** ([spec](/specs/console/)) is a design, not yet implemented.

## Consistency and point-in-time recovery

- `converge` and the journal need a replica set or sharded cluster on MongoDB 6.0+ and a
  user who may open cluster-wide change streams; the built-in `backup` role is not enough.
  Without that, `auto` falls back to `none`.
- `snapshot` fails if the backup outlasts the server's snapshot window (5 minutes by
  default).
- **Time series collections** are not converged or journaled: change streams do not
  report their writes. They are restored as read.
- Index, collection-option (`collMod`) and view changes made during a backup, or after a
  base backup, are not replayed; the dumped metadata is used.
- Collections created during a backup, or after a base backup, are restored without
  secondary indexes.
- A change event larger than 16 MiB fails a converge backup, as does a transient network
  error during capture (no resume yet).
- On MongoDB 6.0 (before `disambiguatedPaths` in 6.1), an update to a field name that
  contains a dot looks like an update to a nested field (the manifest records a warning).
- In restore modes `insert` and `upsert`, the converge replay can overwrite target
  documents that share an `_id` with a document changed during the backup.
- The journal refuses passphrase encryption; use recipients or KMS keys.
- Base backups must include every namespace the journal records.

## Encryption

- The manifest is not encrypted: database and collection names, counts, sizes and labels
  are visible to anyone who can read the storage.
- The manifest is not signed: someone with write access to the storage and a public key
  could substitute files. Use [immutable backups](/guides/immutable-backups/) and
  separate credentials for writing and restoring.
- No post-quantum, SSH or plugin age recipients, and no ASCII-armored files.
- The `age` CLI cannot unwrap KMS-protected keys; keep an offline recovery recipient.

## Storage

- Immutable (write-once) backups need S3 Object Lock, GCS object retention or Azure
  immutability; local disk and SFTP cannot lock objects.
- The journal writer's lease needs conditional writes (file, S3, GCS, Azure).

## mongodump interop

- `import` skips time series collections (mongodump stores internal bucket documents),
  `system.*` collections, users and roles, and `oplog.bson`.
- `export` does not export time series collections.

## Copies

- `copy` and `pull` are not atomic and not resumable: re-run an interrupted copy with
  `--drop`.
- Masking can make values collide on a unique index, which then fails to build.

## Serverless platforms

- Lambda and Vercel limit how long a function runs. Use `--max-duration` and `--resume`
  to back up in slices, or run the Docker image where there is no time limit.

Found something missing from this list? [Open an issue](https://github.com/ShamalRathnayake/mongoshield/issues).
