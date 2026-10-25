# Docker Compose: the MongoShield console + MongoDB

The web console next to a MongoDB 8 replica set, with nothing to configure:

```bash
docker compose up -d
```

1. Open http://localhost:8080 and create the admin (the setup page works without a token
   for 15 minutes after the console starts; after that, use the one-time link from
   `docker compose logs console`, or restart the console).
2. Paste the connection string

   ```
   mongodb://mongo:27017/?replicaSet=rs0
   ```

   `mongo` is the MongoDB service's name on the Compose network. The console suggests
   "not production" for it; confirm and continue to the data browser.
3. Press **Back up now**. The backup goes to **Local backups** (`/data/backups` in the
   `console-data` volume), encrypted with a key the console keeps. Save the recovery key
   when the console offers it: it restores these backups even without the console.
4. **Restore a backup** opens the restore wizard; **Make this a schedule** turns the
   one-click backup into a nightly plan.

| Service | What it is |
|---|---|
| `mongo` | MongoDB 8 as a single-node replica set (initialised by its healthcheck) |
| `console` | `ghcr.io/shamalrathnayake/mongoshield-console`, port 8080 on localhost only |

Put some data in first, if you like:

```bash
docker compose exec mongo mongosh --quiet --eval \
  'db.getSiblingDB("shop").orders.insertMany([{ total: 12.5 }, { total: 99 }])'
```

Options (copy `.env.example` to `.env`):

- `MONGOSHIELD_ADMIN_USERNAME` + `MONGOSHIELD_ADMIN_PASSWORD`: create the admin at the
  first start (no setup page).
- `CONSOLE_IMAGE=mongoshield-console:local`: use an image built from this repository
  (`docker build -f docker/console.Dockerfile -t mongoshield-console:local ../..`).

The `console-data` volume holds the console's state, its generated secret key
(`secret.key`) and the local backups. A copy of the volume therefore contains the key
next to what it encrypts: keep such copies private, and add an off-machine storage
location (S3, GCS, Azure, SFTP) under **Storage** for backups that must survive this
machine. To manage the secret yourself, set `MONGOSHIELD_SECRET` (or
`MONGOSHIELD_SECRET_FILE` with a Compose secret) before the first start.

Full guide: [docs/guides/docker.md](../../docs/guides/docker.md).
