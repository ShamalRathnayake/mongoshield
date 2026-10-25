# @mongoshield/console

**A self-hosted web console for [MongoShield](https://www.npmjs.com/package/mongoshield):
scheduled, verified, encrypted MongoDB backups with a point-and-click restore.**

Add a connection and a storage location (local disk, S3 or S3-compatible, Google Cloud
Storage, Azure Blob Storage, SFTP), create a backup plan with a schedule, and get live job
progress, verification and restore drills, a read-only browser for the documents inside a
backup, a restore wizard with dry-run plans, and a live data browser (databases,
collections, documents, indexes, stats). Live editing is off by default: an admin turns it
on per connection and grants `data:write` per user, and every write is conditional, has its
pre-image journaled (sealed) for one-click undo, and is audited. It never runs arbitrary
commands, shell or server-side JavaScript.

📖 **Documentation: https://shamalrathnayake.github.io/mongoshield/**

## Run it

With Docker (recommended):

```bash
docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console
```

Open http://localhost:8080 and:

1. **Create the admin.** No token needed for the first 15 minutes after the console
   starts (after that, use the one-time link from `docker logs`, or restart it).
2. **Paste a connection string.** It is tested right away; Atlas strings with a
   `<db_password>` placeholder ask for the password separately. The name and whether it
   is production are suggested (and shown, so you can change them).
3. **Back up now.** An encrypted, verified backup lands in "Local backups" (`/data/backups`).
   Then: **Restore a backup**, **Check the backup**, **Test a restore**, **Back up every
   night**, and download the **recovery key** when offered.

Three clicks from an empty volume to the first backup. On a machine other people can
reach, publish the port on loopback (`-p 127.0.0.1:8080:8080`) until the admin exists, or
create the admin from the environment (below). A Compose file with MongoDB is in
[examples/console-compose](https://github.com/ShamalRathnayake/mongoshield/tree/main/examples/console-compose).

With Node.js 22.12 or newer:

```bash
MONGOSHIELD_DATA_DIR=./console-data npx @mongoshield/console
```

## The secret

The console encrypts the connection strings, storage credentials and backup keys it
stores with a key derived from a secret. Without `MONGOSHIELD_SECRET` it generates one on
the first start into `<data>/secret.key` (mode 0600) and says so in the log. That key then
sits in the same volume as what it protects: **a copy of the volume includes the key**, so
keep such copies private. To keep the secret elsewhere, pass `MONGOSHIELD_SECRET` (or
`MONGOSHIELD_SECRET_FILE` for Docker and Kubernetes secrets) when creating a fresh volume.
The secret must never change for a data directory: a different one is refused at startup.

## Configuration

Everything is set with environment variables, and none is required:

| Variable | Meaning |
|---|---|
| `MONGOSHIELD_SECRET` / `MONGOSHIELD_SECRET_FILE` | The secret (≥ 32 characters), or a file holding it. Default: generated into `<data>/secret.key`. |
| `MONGOSHIELD_DATA_DIR` | Where `console.json`, the audit log and the local backups live (default `/data`). |
| `MONGOSHIELD_SETUP_WINDOW_MINUTES` | Minutes after start during which the first admin can be created without the setup token (default 15; 0 = always need the token). |
| `MONGOSHIELD_ADMIN_USERNAME` (or `_EMAIL`), `MONGOSHIELD_ADMIN_PASSWORD` / `_PASSWORD_FILE` | Create the first admin at start (headless installs). Ignored once any user exists. |
| `MONGOSHIELD_DEFAULT_STORAGE` | `false`: do not create the "Local backups" location on a fresh volume. |
| `PORT` / `HOST` | Listen address (default `8080` / `0.0.0.0`). |
| `MONGOSHIELD_PUBLIC_URL` | The console's public URL, e.g. `https://backups.example.com`. |
| `MONGOSHIELD_COOKIE_SECURE` | `false` allows sign-in over plain HTTP from other machines (evaluation only; on localhost it works without). |
| `MONGOSHIELD_OIDC_ISSUER`, `MONGOSHIELD_OIDC_CLIENT_ID`, … | OIDC single sign-on. |
| `MONGOSHIELD_TRUST_PROXY_SECRET` | Single sign-on through a trusted reverse proxy. |
| `MONGOSHIELD_METRICS_TOKEN` | Enables Prometheus metrics at `/metrics`. |

The full list, the security model (roles, sessions, audit log, CSRF, encryption at rest)
and the API are documented in the
[console specification](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/specs/CONSOLE.md)
and the
[security checklist](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/console-security.md).

## Versions

The console is released together with `mongoshield` and always uses the same version
number: `@mongoshield/console@2.0.0` runs on `mongoshield@2.0.0`.

## License

MIT. MongoShield is not affiliated with MongoDB, Inc.
