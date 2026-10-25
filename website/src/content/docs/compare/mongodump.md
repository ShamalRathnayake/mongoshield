---
title: MongoShield vs mongodump
description: How MongoShield relates to mongodump and mongorestore, and when to use which.
sidebar:
  label: vs mongodump
---

`mongodump` and `mongorestore` are part of the MongoDB Database Tools: free, maintained by
MongoDB, Inc., and the reference for logical backups. MongoShield is built around
their format rather than against it — its backups use mongodump's directory layout and
metadata files, and it can [import and export](/guides/mongodump/) mongodump output.

## At a glance

| | mongodump / mongorestore | MongoShield |
|---|---|---|
| What it is | Go binaries | a Node.js library and CLI using the official driver |
| Install | Database Tools package for your platform | `npm install`, or the Docker image |
| Backup type | logical | logical |
| Output | a directory or archive, optionally gzipped | a directory per backup in local, S3, GCS, Azure or SFTP storage, zstd or gzip |
| Encryption | none built in (pipe through your own tooling) | age, per file: public-key recipients, cloud KMS or a passphrase |
| Integrity | — | SHA-256 of every file in a manifest; `verify` without a key, `--deep` with one |
| Consistency across collections | `--oplog` on replica sets | `converge` (change streams) or `snapshot` on replica sets and sharded clusters |
| Point-in-time recovery | oplog dumps you manage yourself (`--oplogReplay`) | a built-in change journal with `restore --at` |
| Retention, scheduling, alerts | not included | built in |
| Restore safety | inserts into existing collections; `--drop` replaces | refuses non-empty targets unless told otherwise; rename and dry run |
| Users and roles | `--dumpDbUsersAndRoles` | not backed up |
| Time series collections | dumped as internal bucket documents | backed up as plain measurements |
| Language and runtime | any shell | Node.js 22.12+ |

## Choose mongodump when

- You need users, roles or other server-level state in the dump.
- You want the official, vendor-supported tool with nothing else involved.
- You already have scripts around it and its feature set is enough.

## Choose MongoShield when

- Installing binaries is awkward: serverless functions, minimal containers, CI.
- You want encryption, integrity checks, retention, scheduling and alerting without
  building them around `mongodump`.
- You want safer restores (rename, dry run, refusing to overwrite) and restore drills.

## Performance

On one machine with local disk, MongoShield's zstd backups were 3.5–5× faster than
`mongodump --gzip` for the same size, and restores were close. Uncompressed `mongodump`
is the fastest way to get data out, and uses a third of the memory. The
[benchmarks](/compare/benchmarks/) have the numbers, the method and the caveats.

## Moving between them

- `mongoshield import ./dump` stores an existing dump as a MongoShield backup.
- `mongoshield export latest --output ./dump` writes a backup that `mongorestore --dir` loads.
- Even without MongoShield, a backup can be [restored with standard tools](/concepts/storage/#restoring-without-mongoshield).
