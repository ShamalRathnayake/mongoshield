---
"mongoshield": major
---

First stable release. MongoShield backs up, restores and copies MongoDB from Node.js using
only the official driver, with no `mongodump` binary:

- Backups in the mongodump directory layout and BSON, compressed with zstd or gzip and
  optionally encrypted with age (public keys, passphrases or AWS / GCP / Azure KMS), with a
  SHA-256 checksum for every file and a manifest written last.
- Storage on local disk, S3 and S3-compatible services, Google Cloud Storage, Azure Blob
  Storage and SFTP, including immutable (object lock) backups.
- Restores with safe defaults: nothing is overwritten unless asked, rename on restore, dry
  runs, single-document and tenant restores, every collection type, index, validator, user
  and role.
- Verification, restore drills, retention with holds, a scheduler with locks, retries,
  notifications and heartbeats, OpenTelemetry, and point-in-time recovery from a change
  journal.
- Copying between deployments with deterministic PII masking and subsetting, and
  `mongoshield/testing` helpers that snapshot and reset test databases.
- A CLI (`mongoshield`), a Docker image, a GitHub Action and a Helm chart.
