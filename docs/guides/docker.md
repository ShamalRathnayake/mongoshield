# Docker

Two images run MongoShield in Docker: the **web console** (a management UI: add a
connection, browse it, back it up, restore) and the **CLI** (scripts, cron, CI). Both run
on distroless Node.js 24 as a non-root user (uid 65532). The console comes first below;
the CLI image starts at [The CLI image](#the-cli-image).

## The web console

```bash
docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console
```

Open http://localhost:8080. There is nothing to configure first:

1. **Create the admin.** For 15 minutes after the console starts, the setup page creates
   the first admin without a token. After that (or with `MONGOSHIELD_SETUP_WINDOW_MINUTES=0`)
   it needs the one-time link the console prints in its log (`docker logs <container>`),
   or a restart to open the window again. Whoever opens the page first in that window
   becomes the admin, so on a machine reachable from other networks publish the port on
   loopback only until then: `-p 127.0.0.1:8080:8080`.
2. **Paste a connection string**, the console tests it and suggests a name and whether it
   is production (always shown, so you can change it), then opens the live data browser.
3. **Back up now** writes an encrypted backup to the **Local backups** location
   (`/data/backups`), created on the first start. **Restore a backup** opens the restore
   wizard, and the backup can become a nightly schedule in one click.

What the first start does by itself, and how to do it yourself instead:

| On first start | How to choose yourself |
|---|---|
| Generates the secret that encrypts the stored connection strings, credentials and backup keys, in `/data/secret.key` (32 random bytes, mode 0600). The log says so. | `-e MONGOSHIELD_SECRET="$(openssl rand -hex 32)"`, or `MONGOSHIELD_SECRET_FILE=/run/secrets/<name>` for Docker/Compose/Kubernetes secrets, on a **fresh** volume |
| Opens the 15-minute setup window | `MONGOSHIELD_SETUP_WINDOW_MINUTES` (0 = token only), or create the admin from the environment: `MONGOSHIELD_ADMIN_USERNAME` (or `_EMAIL`) + `MONGOSHIELD_ADMIN_PASSWORD` or `MONGOSHIELD_ADMIN_PASSWORD_FILE` (headless installs; ignored once any user exists) |
| Creates the **Local backups** storage location | `MONGOSHIELD_DEFAULT_STORAGE=false`; add S3, GCS, Azure or SFTP under Storage at any time |

The secret is the one thing that must not be lost or changed: a console started with a
different `MONGOSHIELD_SECRET` than its data directory was created with refuses to start
(it could not read anything it stored), and one started without the variable on a volume
that was created with it refuses too, with a message saying so. Existing deployments that
pass `MONGOSHIELD_SECRET` behave exactly as before.

**Back up the volume, and keep that copy private.** `/data` holds the console's state, the
generated `secret.key` next to what it encrypts, and the local backups. A copy of the
volume is therefore a copy of every stored connection string. Backups that must survive
the loss of this machine belong in an off-machine location (add one under Storage). Every
"Back up now" plan is encrypted with a key the console keeps; download its **recovery key**
when the console offers it, and store it apart from the volume: with it, the CLI restores
those backups without the console (`--identity-file`).

### Connecting to MongoDB

Inside a container, `localhost` is the console's own container, not your computer.

| Where MongoDB runs | Connection string |
|---|---|
| Another container | Put both on one network (`docker network create backup`, `--network backup` on both) and use the container's name: `mongodb://mongo:27017/?replicaSet=rs0`. Compose does this for you. |
| On the host machine | `mongodb://host.docker.internal:27017/?directConnection=true`. Docker Desktop and OrbStack provide that name; on Linux add `--add-host=host.docker.internal:host-gateway`, and make mongod listen on that interface (`bindIp`). |
| MongoDB Atlas or any server | Paste the string as Atlas shows it (see below). |

### Atlas in the console

`mongodb+srv://` strings work from the image as they are: Node.js resolves the SRV and TXT
records (the TXT record's `replicaSet` and `authSource` are applied) and TLS is checked
against Node's bundled certificate authorities, which include Atlas's. When you paste a
string from Atlas's "Connect" dialog, the console asks for the password the string leaves
out (`<db_password>`), in a separate masked field, and encodes special characters for you;
it also accepts the `mongosh "…"` command line. When the connection fails, it says why in
plain words: the IP access list (with an optional, opt-in lookup of the console's public
IP to add under **Network Access**), a wrong password, a paused cluster, a typo in the
cluster name, TLS, or missing roles. More in the [Atlas guide](./atlas.md).

For a server whose certificate comes from your own certificate authority, mount the CA and
name it in the connection string:

```bash
docker run -p 8080:8080 -v mongoshield:/data \
  -v "$PWD/ca.pem:/certs/ca.pem:ro" ghcr.io/shamalrathnayake/mongoshield-console
# connection string: mongodb+srv://user:pass@cluster0.example.com/?tlsCAFile=/certs/ca.pem
```

`docker/smoke/console-srv-tls.sh` proves this end to end without Atlas: CoreDNS on the
Docker network serves the SRV and TXT records, mongod requires TLS with a private CA, and
the console (started with `--dns`) connects with `tlsCAFile`, and explains the failure as a
TLS problem without it.

### Plain HTTP, HTTPS and other machines

Session cookies are `Secure` by default. Browsers accept them over plain HTTP only on
`localhost` (Chrome, Edge and Firefox treat it as a secure origin), so
`http://localhost:8080` works, but `http://192.168.1.20:8080` from another machine cannot
sign in. For access from other machines, put a TLS reverse proxy (Caddy,
Traefik, nginx, an ingress) in front and set `MONGOSHIELD_PUBLIC_URL=https://…`. For a quick
evaluation on a trusted network only, `MONGOSHIELD_COOKIE_SECURE=false` allows plain HTTP.

### Stopping, health and Compose

`docker stop` and Ctrl-C (under `docker run -it`) stop the console within seconds, exit
code 0; running jobs get `MONGOSHIELD_SHUTDOWN_GRACE_SECONDS` (60) to finish, so give
`docker stop -t 70` when a backup may be running. The image has a `HEALTHCHECK` on
`/healthz`. A Compose file with MongoDB and the console is in
[`examples/console-compose`](../../examples/console-compose/). Every setting is listed in
the [console specification](../specs/CONSOLE.md) and the
[security checklist](../console-security.md) explains the trade-offs above.

## The CLI image

The CLI image runs the MongoShield CLI on distroless Node.js 24 as a non-root user.

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
  ghcr.io/shamalrathnayake/mongoshield:2 backup
```

`--init` lets Ctrl-C and `docker stop` interrupt the command promptly (Node.js as PID 1
gets no default signal handling).

Backing up to a local directory instead: mount a volume at `/backups`, which the image
prepares for its non-root user (uid 65532):

```bash
docker run --rm --init -e MONGODB_URI -v mongoshield-backups:/backups \
  ghcr.io/shamalrathnayake/mongoshield:2 backup --to /backups
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
  ghcr.io/shamalrathnayake/mongoshield:2
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

Several containers may share one bucket (one per database or cluster, say). Retention
is scoped: each scheduler only prunes backups of its own source deployment and its own
`backup.include`/`exclude` selection, never the other containers' backups. To apply a
policy to everything in the bucket at once, run
`docker run --rm … mongoshield prune --all-sources --daily 7` (it lists what it would
delete per source and needs `--yes` without a terminal).

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
  ghcr.io/shamalrathnayake/mongoshield:2 \
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
cosign verify ghcr.io/shamalrathnayake/mongoshield:2 \
  --certificate-identity-regexp '^https://github.com/ShamalRathnayake/mongoshield/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
