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
docker run -p 8080:8080 -v mongoshield-console:/data \
  -e MONGOSHIELD_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/shamalrathnayake/mongoshield-console
# The log prints a one-time setup link: http://localhost:8080/setup?token=…
```

With Node.js 22.12 or newer:

```bash
MONGOSHIELD_SECRET="$(openssl rand -hex 32)" \
MONGOSHIELD_DATA_DIR=./console-data \
  npx @mongoshield/console
```

Keep `MONGOSHIELD_SECRET` safe: it derives the key that encrypts the connection strings,
storage credentials and backup keys the console stores. Without it they cannot be read.

## Configuration

Everything is set with environment variables:

| Variable | Meaning |
|---|---|
| `MONGOSHIELD_SECRET` | Required, at least 32 characters. Encrypts stored secrets. |
| `MONGOSHIELD_DATA_DIR` | Where `console.json` and the audit log live (default `/data`). |
| `PORT` / `HOST` | Listen address (default `8080` / `0.0.0.0`). |
| `MONGOSHIELD_PUBLIC_URL` | The console's public URL, e.g. `https://backups.example.com`. |
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
