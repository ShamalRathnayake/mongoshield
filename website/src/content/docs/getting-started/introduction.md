---
title: Introduction
description: What MongoShield is, what it does, and when to use something else.
---

MongoShield is a TypeScript library and command-line tool that backs up, restores and
copies MongoDB databases. It uses only the official Node.js driver: there is no
`mongodump` binary to install, so it runs wherever Node.js runs — a laptop, a Docker
container, a Kubernetes CronJob, GitHub Actions, AWS Lambda or Vercel.

:::note[Status]
MongoShield 2.0 is in active development and published on the `next` npm tag. The 1.x
alpha line is deprecated.
:::

## What a backup is

A backup is a directory of ordinary files in storage you control: local disk, S3 or an
S3-compatible service, Google Cloud Storage, Azure Blob Storage or SFTP.

```
backups/2026-11-14T03-00-04Z_7f3a9c/
  manifest.json                 written last: if it exists, the backup is complete
  app/users.metadata.json.age   collection options and indexes (mongodump format)
  app/users.bson.zst.age        documents as BSON, compressed, encrypted
```

Every layer is a standard format — mongodump's directory layout and BSON, zstd or gzip
compression, and [age](https://age-encryption.org) encryption. If MongoShield disappeared,
you could still restore with off-the-shelf tools:

```sh
age -d -i recovery.key users.bson.zst.age | zstd -d > users.bson && mongorestore …
```

See [How a backup is stored](/concepts/storage/) for the details.

## What it does

- **Back up** every collection type with its options and indexes, compressed and
  optionally encrypted, with a SHA-256 checksum for every file.
- **Restore** with safe defaults: nothing is overwritten unless you ask, `--rename`
  restores next to live data, and `--dry-run` shows the plan first.
- **Verify** a backup without the key (sizes and checksums), or deeply by decrypting and
  parsing every document; run **restore drills** that prove a backup restores.
- **Keep the right backups** with a retention policy that never deletes your newest
  backup, held backups or (on supporting storage) backups that are still write-locked.
- **Run unattended** on a schedule, with locks, retries, notifications and heartbeats.
- **Recover to a point in time** with a change journal recorded between backups.
- **Copy** data between deployments, with deterministic masking and subsetting, for
  staging environments and laptops.

## When to use something else

MongoShield takes *logical* backups: it reads documents through the driver and writes
them back on restore, rebuilding indexes. For very large deployments, restore time is
dominated by re-inserting data and rebuilding indexes; storage-level snapshots (Atlas
Cloud Backups, filesystem snapshots, Percona Backup for MongoDB's physical backups)
restore faster. See [Compare](/compare/mongodump/) and [Limitations](/limitations/) for
an honest picture.

## Next steps

- [Install](/getting-started/install/) the CLI or the library.
- Follow the [CLI quickstart](/getting-started/quickstart-cli/) for a first backup and
  restore in five minutes.
- Or use it from code: [Library quickstart](/getting-started/quickstart-library/).
