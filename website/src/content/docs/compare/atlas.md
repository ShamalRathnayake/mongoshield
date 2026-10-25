---
title: MongoShield vs Atlas backups
description: How MongoShield compares with MongoDB Atlas Cloud Backups, and how the two can work together.
sidebar:
  label: vs Atlas backups
---

MongoDB Atlas includes managed backups for its clusters: storage-level snapshots on a
schedule and, on supporting tiers, continuous cloud backup for point-in-time restores.
They are integrated, need no setup beyond a policy, and restore large clusters far faster
than any logical tool can. If you are on Atlas, **keep them on.**

MongoShield is not a replacement for Atlas backups. It is an independent, logical copy
that you control, and it works alongside them.

## Differences

| | Atlas Cloud Backups | MongoShield |
|---|---|---|
| Backup type | storage snapshots, managed by Atlas | logical (documents and metadata), run by you |
| Where backups live | Atlas-managed storage (some options let you export snapshots to your own bucket) | your storage: local, S3 and compatible, GCS, Azure, SFTP |
| Format | snapshot data files | mongodump layout, zstd/gzip, age: readable with standard tools |
| Restore target | Atlas clusters (downloadable snapshots on some tiers) | any MongoDB: Atlas, self-hosted, a laptop |
| Restore granularity | a whole cluster | selected databases or collections, renamed, or single documents (`find --restore`) |
| Restore speed for large data | fast (no re-insert, no index rebuild) | proportional to data size and indexes |
| Point in time | continuous backup on supporting tiers | the change journal |
| Encryption | Atlas encryption at rest, optionally with your KMS key | age, per file, with keys you hold |
| Cost | billed by Atlas per backup storage and tier | your storage costs |
| Availability | depends on the cluster tier | any tier, including shared and free clusters |

Atlas plans, tiers and features change; check the Atlas documentation for what your
cluster includes.

## Why run both

- **A copy outside the account.** A compromised or mistakenly deleted Atlas project, or a
  billing problem, does not take an independent copy in your own bucket with it.
- **Long-term, portable archives** you can open without Atlas.
- **Granular restores** — one collection, one document — and copies into staging with
  masking.
- **Shared and free tiers**, where Atlas backups are limited.

See the [Atlas guide](/guides/atlas/) for the database user, network access and
consistency settings MongoShield needs on Atlas.
