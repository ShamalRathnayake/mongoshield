# Docker Compose: app + MongoDB + MinIO + MongoShield

A local stack where MongoShield's scheduler backs up a live MongoDB every 10 minutes to
MinIO (S3-compatible), verifies each backup and prunes old ones.

```bash
cp .env.example .env
docker compose up -d
docker compose logs -f mongoshield
```

| Service | What it is |
|---|---|
| `mongo` | MongoDB 8 as a single-node replica set (initialised by its healthcheck) |
| `app` | inserts an order every 5 s, standing in for your application |
| `minio`, `minio-init` | S3-compatible storage and a job that creates the `backups` bucket |
| `mongoshield` | `mongoshield schedule` with [`mongoshield.config.json`](./mongoshield.config.json) |

Useful commands:

```bash
docker compose run --rm mongoshield list                      # what's in storage
docker compose run --rm mongoshield verify latest
docker compose run --rm mongoshield keygen                    # make an encryption key pair
docker compose run --rm mongoshield restore latest --rename 'shop.*=shop_restored.*'
```

Restoring an encrypted backup needs the secret key. Mount it read-only and point to it:

```bash
docker compose run --rm -v "$PWD/backup.key:/run/secrets/backup.key:ro" \
  -e MONGOSHIELD_IDENTITY_FILE=/run/secrets/backup.key mongoshield restore latest --rename 'shop.*=shop_restored.*'
```

To keep backups on a local volume instead of MinIO, set `MONGOSHIELD_STORAGE=/backups` in
`.env` and run `docker compose up -d` again.

Full guide: [docs/guides/docker.md](../../docs/guides/docker.md).
