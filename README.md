# MongoShield

**Backup, restore and copy MongoDB from Node.js. No `mongodump` required.**

MongoShield is a TypeScript library and CLI that backs up MongoDB using only the official
Node.js driver. It runs anywhere Node runs: your laptop, a Docker container, a Kubernetes
CronJob, GitHub Actions, AWS Lambda or Vercel. Backups are compressed, optionally encrypted,
and written to local disk or any S3-compatible bucket.

📖 **Documentation: https://shamalrathnayake.github.io/mongoshield/**

> **Status: release candidate.** The first stable release, 2.0.0, is being prepared;
> until it is out, install from the `next` npm tag. See the [roadmap](#roadmap).

```bash
npx mongoshield@next init      # writes mongoshield.config.ts and generates an encryption key
npx mongoshield@next backup
npx mongoshield@next restore latest --rename 'app.*=app_restored.*'
```

## Why MongoShield

- **No binaries.** Pure Node.js, so it works where you can't install mongo-tools.
- **Restores are first-class.** Rename on restore, safe defaults that refuse to overwrite
  data, dry runs, and every collection type (capped, clustered, time series, views,
  validators, collations, every index type).
- **No lock-in.** Backups use the mongodump layout and BSON, standard zstd or gzip
  compression and standard [age](https://age-encryption.org) encryption. If MongoShield
  disappeared tomorrow you could still restore with off-the-shelf tools:

  ```bash
  age -d -i recovery.key users.bson.zst.age | zstd -d > users.bson && mongorestore …
  ```

- **Verifiable.** Every file's SHA-256 is recorded in a manifest. `mongoshield verify`
  checks a backup without a key; `--deep` decrypts and parses every document.
- **Safe retention.** Keep the last N backups plus hourly/daily/weekly/monthly/yearly ones,
  with safety floors that never delete your newest backup. Retention is scoped per source
  and selection, so jobs sharing a bucket never prune each other's backups.
- **Incremental backups.** `mongoshield backup --incremental` stores only the changes
  since the previous backup; scheduled runs can take a full backup weekly and incrementals
  hourly, and restores replay the chain exactly. See the
  [incremental backups guide](docs/guides/incremental-backups.md).
- **Bounded memory.** Everything streams; what the backup holds does not grow with
  database size (its peak RSS is still higher than `mongodump`'s).
- **Fast compressed backups.** zstd, with large collections split into parts compressed
  in parallel: 3.5–5× faster than `mongodump --gzip` for the same size in our
  [benchmarks](docs/benchmarks.md), which also show where `mongodump` is faster.
- **Atlas Free tier backups.** Atlas Free (M0) clusters have no built-in backups and Flex
  clusters keep only 8 daily snapshots. MongoShield recognises these tiers and adapts
  (gentle read pace, no refused commands); `mongoshield init --preset atlas-free` and a
  [nightly GitHub Actions workflow](examples/github-actions/atlas-free-tier-s3.yml) get you
  started. See the [Atlas Free tier guide](docs/guides/atlas-free-tier.md).

## Install

```bash
npm install mongoshield@next mongodb
# for S3, R2, B2, MinIO, DigitalOcean Spaces…
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

### Requirements

- **Node.js 22.12** or newer, or **Bun 1.4** / **Deno 2.9** or newer
  (`bunx --bun mongoshield`, `deno run -A npm:mongoshield`; see the
  [Bun and Deno guide](docs/guides/bun-and-deno.md) for what is tested there).
- `mongodb` (driver 6.10+ or 7.x) is a peer dependency, so MongoShield uses the same
  driver version as your app.

## Library usage

```ts
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI! }, // or { client } to reuse your app's MongoClient
  storage: s3Storage({ bucket: "acme-backups", prefix: "prod/" }),
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY!] }, // this machine can't decrypt
});

// Back up everything except sessions.
const backup = await shield.backup({
  exclude: ["*.sessions"],
  labels: { trigger: "nightly" },
  signal: AbortSignal.timeout(14 * 60_000),
});
console.log(backup.id, backup.manifest.totals);

// Check it.
const report = await shield.verify({ backup: backup.id, mode: "fast" });

// Restore it next to the original data.
await shield.restore({
  backup: "latest",
  rename: { "app.*": "app_restored.*" },
  decryption: { identities: [process.env.BACKUP_SECRET_KEY!] },
});

// Keep 7 daily, 4 weekly and 12 monthly backups of this deployment. The scope leaves
// backups of other sources/selections in the same storage alone (omit it to prune all).
await shield.prune(
  { daily: 7, weekly: 4, monthly: 12 },
  { scope: { clusterId: await shield.sourceClusterId() } },
);
```

Storage adapters:

| Import | Use |
|---|---|
| `fileStorage({ path })` from `mongoshield/storage/file` | local disk, NFS, SMB |
| `s3Storage({ bucket, prefix, endpoint? })` from `mongoshield/storage/s3` | AWS S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces, Wasabi |
| `memoryStorage()` from `mongoshield/storage/memory` | tests |

## CLI

| Command | What it does |
|---|---|
| `init` · `keygen` | create `mongoshield.config.ts`; generate an age key pair |
| `backup` | back up (split, resumable with `--max-duration`, immutable with `--retain-days`, only the changes with `--incremental`) |
| `restore [id]` | restore with `--rename`, `--mode`, `--dry-run`, or `--at <time>` (point in time) |
| `list` · `inspect <id>` | see backups, their verification, drills, holds and locks |
| `verify [id] [--deep]` · `drill` | check integrity; prove a backup restores and measure the RTO |
| `rehearse-upgrade --target-version 8.0` | prove a backup works on a newer MongoDB before upgrading ([guide](docs/guides/upgrade-rehearsal.md)) |
| `find` · `restore-tenant` · `history` · `diff` | single documents, one tenant, a document's history, what changed |
| `copy` · `pull` | production → staging/local, with deterministic PII masking and subsetting |
| `mask suggest` | find personal data in a sample and suggest mask rules for `copy`/`pull` |
| `snapshot` · `rollback` | named snapshot before a migration, and rolling back to it |
| `import` · `export` | mongodump directories/archives in and out; JSONL/CSV export |
| `prune` · `hold` · `release` | retention (last N + hourly…yearly), with holds and safety floors |
| `run` · `schedule` | one scheduled job (lock → backup → verify → replicate → prune → notify), or the cron scheduler |
| `journal start` · `journal status` | continuous change journal for point-in-time recovery |
| `replicate` · `rekey` | off-site copies (3-2-1); rotate who can decrypt existing backups |
| `erase` · `erasures` | GDPR erasure ledger, re-applied after every restore |

Every command supports `--help` and `--json`. Exit codes are listed in
[docs/errors.md](./docs/errors.md).

### Configuration

```ts
// mongoshield.config.ts
import { defineConfig } from "mongoshield";

export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "s3://acme-backups/prod",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  decryption: { identityFiles: ["./mongoshield-identity.txt"] },
  backup: { exclude: ["*.sessions"] },
  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
});
```

Environment variables (`MONGODB_URI`, `MONGOSHIELD_STORAGE`, `MONGOSHIELD_RECIPIENTS`,
`MONGOSHIELD_IDENTITY_FILE`, …) work without a config file; see
[`src/config/env.ts`](./packages/mongoshield/src/config/env.ts).

## How a backup is stored

```
backups/2026-11-14T03-00-04Z_7f3a9c/
  manifest.json                 written last: if it exists, the backup is complete
  app/users.metadata.json.age   collection options and indexes (mongodump format)
  app/users.bson.zst.age        documents as BSON, compressed, encrypted
```

The full format is specified in [docs/specs/FORMAT.md](./docs/specs/FORMAT.md) and the
encryption profile in [docs/specs/ENCRYPTION.md](./docs/specs/ENCRYPTION.md).

## Web console

`@mongoshield/console` is a self-hosted web UI for everything around backups:
connections, storage, backup plans with schedules, live job progress, verification and
drills, a read-only document browser inside backups, a restore wizard with dry-run
plans, and a live data browser. Editing live documents is opt-in per connection and
per user, and backed by MongoShield: every write is conditional on the document not
having changed, its pre-image is journaled first so it can be undone, and it is audited.

```bash
docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console
```

Open http://localhost:8080, create the admin, paste your connection string (Atlas strings
included) and click **Back up now**: three clicks to an encrypted, verified backup in the
volume, then one click each to restore it, check it or make it nightly. Nothing to
configure first: the console generates its secret into the volume, lets the first visitor
create the admin for 15 minutes after start, and creates a "Local backups" location. Each
of these can be chosen yourself instead (`MONGOSHIELD_SECRET`, `MONGOSHIELD_ADMIN_*`, …);
the trade-offs are in the [Docker guide](./docs/guides/docker.md#the-web-console).

See [docs/specs/CONSOLE.md](./docs/specs/CONSOLE.md) and
[docs/console-security.md](./docs/console-security.md).

## Deploying

Docker image, GitHub Action, Helm chart, Kubernetes CronJob, and examples for AWS Lambda,
Vercel Cron, docker-compose and NestJS live in [`docker/`](./docker), [`action/`](./action),
[`deploy/`](./deploy) and [`examples/`](./examples), with guides in
[docs/guides](./docs/guides).

On Kubernetes, the **MongoShield operator** (`@mongoshield/operator`, chart
[`deploy/helm/mongoshield-operator`](./deploy/helm/mongoshield-operator)) manages backups as
custom resources: a `MongoShieldBackupPlan` becomes a validated CronJob, every run is a
`MongoShieldBackup` whose status holds the backup id, sizes and verification result, and a
`MongoShieldRestore` restores declaratively (overwriting needs an explicit confirmation),
and a `MongoShieldDrill` proves a backup restores and measures the RTO.
Events, Prometheus metrics and leader election included; see
[docs/guides/kubernetes-operator.md](./docs/guides/kubernetes-operator.md).

## Roadmap

| Phase | Status |
|---|---|
| P0 Foundations | done |
| P1 Backup & restore (file, S3, CLI) | done |
| P2 Encryption, verification, retention, consistency, mongodump interop | done |
| P3 GCS, Azure, SFTP, KMS, scheduler, alerts, drills, OpenTelemetry, Docker, Helm, Action | done |
| P4 Split and resumable backups, rate limits, immutable storage | done |
| P5 Copy with PII masking, subsetting, single-document restore, search indexes, users and roles, test helpers | done |
| P6 Point-in-time recovery (change journal) | done |
| P7 Web console and recovery extras (tenant restore, history, diff, snapshots, erasure ledger, replication, rekey) | done |

Next: real-cloud and sharded-cluster test runs, then the 2.0.0 release.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: see [SECURITY.md](./SECURITY.md).

## License

MIT. MongoShield is not affiliated with MongoDB, Inc.
