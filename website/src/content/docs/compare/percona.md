---
title: MongoShield vs Percona Backup for MongoDB
description: How MongoShield compares with Percona Backup for MongoDB (PBM).
sidebar:
  label: vs Percona Backup
---

[Percona Backup for MongoDB](https://docs.percona.com/percona-backup-mongodb/) (PBM) is a
mature, open source backup tool for self-hosted replica sets and sharded clusters. It
runs an agent (`pbm-agent`) next to every `mongod`, coordinated through the cluster
itself, and supports logical backups, physical backups (with Percona Server for MongoDB)
and point-in-time recovery from oplog slices.

## Differences

| | Percona Backup for MongoDB | MongoShield |
|---|---|---|
| Architecture | an agent on every `mongod` node, plus the `pbm` CLI | one process anywhere that can connect with the driver; no agents |
| Needs host access | yes | no: works with managed services such as Atlas |
| Backup types | logical, physical, incremental physical | logical |
| Sharded clusters | consistent backups across shards | `converge` and `snapshot` through `mongos` |
| Point in time | oplog slicing | the change journal (change streams) |
| Storage | S3-compatible, GCS, Azure, filesystem | local, S3-compatible, GCS, Azure, SFTP |
| Encryption | server-side encryption options of the storage | age, per file, client-side; readable with the `age` CLI |
| Restore speed for large data | physical restores are fast | proportional to data size and indexes |
| Extras | — | restore drills, masked copies for staging, test helpers, mongodump import/export |

## Choose PBM when

- You run your own MongoDB servers and have large data sets where restore time matters:
  physical backups avoid re-inserting documents and rebuilding indexes.
- You want agent-based backups coordinated across a self-hosted sharded cluster.

## Choose MongoShield when

- You cannot install software on the database hosts (Atlas and other managed services).
- You want backups to run from serverless functions, CI or a container next to your app.
- You want client-side encryption with keys you hold, readable with standard tools.
