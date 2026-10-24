# Docker

The official image runs the MongoShield CLI on distroless Node.js 24 as a non-root user.

```
ghcr.io/shamalrathnayake/mongoshield:next      # latest build from main
ghcr.io/shamalrathnayake/mongoshield:2.0.0     # a release (also :2.0, :2, :latest)
```

Images are multi-arch (amd64, arm64), signed with cosign, and ship an SBOM and SLSA
provenance. The entrypoint is the `mongoshield` CLI and the default command is
`schedule`, so any CLI command works as the container's arguments.

## One-off commands

```bash
docker run --rm --init \
  -e MONGODB_URI='mongodb+srv://backup:…@cluster0.example.mongodb.net/' \
  -e MONGOSHIELD_STORAGE='s3://acme-backups/prod?region=eu-west-1' \
  -e MONGOSHIELD_RECIPIENTS='age1…' \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  ghcr.io/shamalrathnayake/mongoshield:next backup
```

`--init` lets Ctrl-C and `docker stop` interrupt the command promptly (Node.js as PID 1
gets no default signal handling).

Backing up to a local directory instead: mount a volume at `/backups`, which the image
prepares for its non-root user (uid 65532):

```bash
docker run --rm --init -e MONGODB_URI -v mongoshield-backups:/backups \
  ghcr.io/shamalrathnayake/mongoshield:next backup --to /backups
```

A bind-mounted host directory must be writable by uid 65532
(`sudo chown 65532:65532 ./backups`), or run with `--user "$(id -u):$(id -g)"`.

## Running the scheduler

`schedule` stays running and backs up on `schedule.cron` from the config file, with
locking, verification, retention and notifications (see the
[scheduling guide](./scheduling.md)). The working directory is `/app`, where the CLI looks
for `mongoshield.config.{ts,js,mjs,json}`:

```bash
docker run -d --name mongoshield --restart unless-stopped \
  -e MONGODB_URI -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -v "$PWD/mongoshield.config.json:/app/mongoshield.config.json:ro" \
  ghcr.io/shamalrathnayake/mongoshield:next
```

```json
{
  "storage": "s3://acme-backups/prod?region=eu-west-1",
  "encryption": { "recipients": ["age1…"] },
  "retention": { "last": 3, "daily": 7, "weekly": 4, "monthly": 12 },
  "schedule": { "cron": "15 3 * * *", "verify": "fast" },
  "heartbeat": "https://hc-ping.com/your-uuid"
}
```

A TypeScript config with `import { defineConfig } from "mongoshield"` works too: the
package is resolvable from `/app`.

On `docker stop`, the scheduler lets a running backup finish (up to a grace period) or
aborts it cleanly. Give it time with `docker stop -t 120`.

There is no `HEALTHCHECK`: a process that answers is not the same as backups that
succeed. Use `heartbeat` (healthchecks.io, Cronitor, Better Stack…) or `notify` to be told
when backups stop arriving.

A full Compose stack (MongoDB, MinIO, the scheduler) is in
[`examples/docker-compose`](../../examples/docker-compose/).

## Configuration through the environment

| Variable | Meaning |
|---|---|
| `MONGODB_URI` or `MONGOSHIELD_URI` | connection string |
| `MONGOSHIELD_STORAGE` | `s3://bucket/prefix?region=…&endpoint=…&forcePathStyle=true`, or a path |
| `MONGOSHIELD_RECIPIENTS` | comma-separated age public keys to encrypt for |
| `MONGOSHIELD_PASSPHRASE` | passphrase encryption instead of recipients |
| `MONGOSHIELD_IDENTITY` / `MONGOSHIELD_IDENTITY_FILE` | age secret key (or a file with it) for restore and `verify --deep` |
| `MONGOSHIELD_COMPRESSION` | `zstd` (default), `gzip` or `none` |
| `AWS_*` | S3 credentials and region, read by the AWS SDK |

Environment variables override the config file; command-line flags override both.

## Restoring

```bash
docker run --rm -it --init -e MONGODB_URI \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -v "$HOME/backup.key:/run/secrets/backup.key:ro" -e MONGOSHIELD_IDENTITY_FILE=/run/secrets/backup.key \
  ghcr.io/shamalrathnayake/mongoshield:next \
  restore latest --from s3://acme-backups/prod --rename 'app.*=app_restored.*'
```

## Image variants and building your own

The published image includes the AWS SDK (S3 and S3-compatible storage, AWS KMS). Build
with other cloud SDKs from the repository root:

```bash
docker build -f docker/Dockerfile --build-arg CLOUD_SDKS=gcs,azure -t mongoshield:custom .
```

`CLOUD_SDKS` takes a comma-separated list of `s3`, `gcs`, `azure`, `sftp`, or `all` / `none`.
Approximate sizes: `none` ~160 MB, `s3` ~180 MB, `all` ~310 MB (uncompressed).

The image has no shell. To debug, build `--target deps` (Debian slim with the same
`node_modules`), or swap the runtime base for `gcr.io/distroless/nodejs24-debian12:debug-nonroot`.

## Verifying the signature

```bash
cosign verify ghcr.io/shamalrathnayake/mongoshield:next \
  --certificate-identity-regexp '^https://github.com/ShamalRathnayake/mongoshield/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
