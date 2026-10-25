# Atlas Free tier backups

Back up a MongoDB Atlas **Free** cluster (formerly called M0) or a **Flex** cluster with
MongoShield: encrypted, verified copies in your own storage, on a schedule, for free.

Why you might want this:

- **Free clusters have no Atlas backups.** Atlas offers a paid add-on for them, in private
  preview as of late 2026: $0.10 a day, one daily snapshot, the last 4 kept.
- **Flex clusters** get a daily snapshot, and Atlas keeps the last 8. You can't take
  on-demand snapshots, set your own schedule or retention, or restore to a point in time.
- **Legacy M2/M5 shared clusters** were moved to Flex in January 2026, so the Flex rules
  apply to them now.

MongoShield takes logical backups (documents, indexes and collection options) through the
normal driver connection. Nothing needs to be installed on the cluster and no extra Atlas
features are required.

## Quick start

```bash
npx mongoshield@next init --preset atlas-free --keygen   # or --preset atlas-flex
```

This writes `mongoshield.config.ts` and an encryption key pair. The config sets the
Atlas preset, encryption to the new public key, a gentle read pace (2 collections at a
time, at most 4 MiB/s; 8 MiB/s for Flex) and a retention policy for small clusters (7
latest, 4 weekly, 6 monthly). Keep the secret key `mongoshield.key` offline.

Then, in Atlas:

1. **Database Access → Add New Database User**, with the built-in role **Only read any
   database** (`readAnyDatabase`). Backups never write.
2. **Network Access**: allow the IP address backups run from. For GitHub-hosted runners,
   see [the workflow templates](#nightly-backups-with-github-actions).
3. Copy the connection string from **Connect → Drivers**. Adding `compressors=zlib`
   compresses the data on the wire, which helps with the Free tier's data transfer
   allowance (see below):

```bash
export MONGODB_URI='mongodb+srv://backup:<password>@cluster0.abcde.mongodb.net/?compressors=zlib'
npx mongoshield@next backup
npx mongoshield@next verify
```

## What MongoShield does on Free and Flex clusters

When it connects, MongoShield checks two things:

- Is the cluster on Atlas? Atlas host names end in `.mongodb.net`.
- Is it a Free or Flex cluster? MongoShield sends one read-only `getParameter`. Free and
  Flex clusters refuse it with error code 8000 (`AtlasError`), and dedicated clusters
  don't.

If it finds a Free or Flex cluster, it adapts by itself. You don't need the preset for
this; the preset just writes the same values into your config.

| On a Free/Flex cluster | What MongoShield does |
|---|---|
| Operations per second are capped and throttled | Backups default to `parallelism: 2` and `maxBytesPerSecond: 4 MiB`. Restores into the cluster default to `parallelism: 2` with 1 insert worker per collection. Any value you set yourself wins. |
| Change stream filters on `ns.db` may use only strings and regexes, no `$in` | The `converge` change stream uses regex filters instead. |
| `usersInfo` and every read of the `admin` database are refused | `--users-and-roles` fails before anything is read, with a hint to use the Atlas CLI. |
| Users and roles can only be changed through Atlas (true on every Atlas tier) | Restores with `--users-and-roles create` or `replace` into any Atlas cluster fail before anything is written. |
| Search index commands may be refused | MongoShield warns once and backs up everything else. |
| Some commands and operators (`$where`, server-side JavaScript…) are refused | You get `MS_UNSUPPORTED_TOPOLOGY` with the Atlas message and a hint, not a generic failure. |

The log tells you when this happens:

```
Atlas Free/Flex tier detected: parallelism 2, reads limited to 4 MiB/s to stay within the
tier's throughput. Set parallelism or maxBytesPerSecond to override.
```

Detection is best effort. If you connect through a proxy or tunnel whose host name isn't
`*.mongodb.net` and Atlas doesn't report its members, set `preset: "atlas-free"` in the
config so the read pace still applies.

## Consistency

Free and Flex clusters are replica sets running MongoDB 8.0 and support change streams.
The default consistency (`auto`) therefore uses **converge**: collections are read while a
change stream records what changes, and restore replays those changes. The result is the
database as it was at the end of the backup.

If the database user can't open a change stream on the whole cluster, MongoShield falls
back to `none` and records why in the manifest's `consistency.warning`. The
`readAnyDatabase` role is enough. With `none`, collections can reflect slightly different
moments if the application writes during the backup.

`consistency: "snapshot"` is not documented as unsupported on these tiers, but MongoShield
has not been run against a real Free cluster in snapshot mode. Prefer the default.

## Atlas limits that matter for backups

From the Atlas documentation as of October 2026. Limits change, so check the linked pages.

| Limit | Free | Flex |
|---|---|---|
| Storage (data + indexes) | 512 MB | 5 GB |
| Operations per second | 100 | 500 |
| Data transfer | 10 GB in + 10 GB out per rolling 7 days | no cap documented |
| Connections | 500 | 500 |
| Databases / collections | 100 / 500 | 100 / 500 |
| Server version | MongoDB 8.0, upgraded by Atlas | 8.0 or later |
| Atlas backups | none, or a paid add-on in preview | daily snapshot, last 8 kept |
| Open change streams | 5 | 10 (one page says none: see below) |

**Data transfer:** a nightly full backup of a full 512 MB Free cluster reads about
3.5 GB a week, inside the 10 GB allowance but not by much if your application is busy.
`compressors=zlib` in the connection string compresses that traffic, and so does a
smaller backup scope (`exclude: ["*.sessions"]`).

**Pausing:** Atlas pauses Free clusters that have had no connections for 30 days. A
nightly backup is a connection, so a backed-up cluster won't be paused. That's an honest
side effect, not a feature: don't rely on it.

## Restoring

The safest default is to restore next to the original data:

```bash
npx mongoshield@next restore latest --identity-file mongoshield.key --rename 'app.*=app_restored.*'
```

Restoring needs a separate database user with **Read and write to any database**
(`readWriteAnyDatabase`). Keep the backup user read-only.

On a Free cluster, everything you restore counts toward the 512 MB, indexes included, and
toward the 500-collection limit. Make sure there's room for the restored data before you
restore next to the original. You can also restore into a local `mongod`, a Flex
cluster or a dedicated cluster. Backups are standard mongodump-layout BSON, so they don't
depend on the tier they came from.

**Users and roles:** Atlas manages database users and custom roles through its UI, the
Admin API, the Atlas CLI or Terraform, and it rolls back changes made with database
commands. Keep their definitions in code (Terraform), or export them:

```bash
atlas dbusers list --projectId <id> --output json > atlas-users.json
atlas customDbRoles list --projectId <id> --output json > atlas-roles.json
```

## Nightly backups with GitHub Actions

Two ready-to-copy workflows, both linted in CI with actionlint:

- [`atlas-free-tier-s3.yml`](../../examples/github-actions/atlas-free-tier-s3.yml)
  backs up to Amazon S3 or Cloudflare R2. R2's free tier is plenty for a Free cluster. It
  runs nightly, verifies each backup and prunes old ones. It can optionally add the
  runner's IP to the Atlas IP Access List for one hour and remove it afterwards. Atlas
  removes the entry by itself even if the job is cancelled.
- [`atlas-free-tier-artifact.yml`](../../examples/github-actions/atlas-free-tier-artifact.yml)
  needs no cloud account: each night's encrypted backup is kept as a GitHub Actions
  artifact for 30 days. Artifacts expire (after 90 days at most) and live in the same
  GitHub account as your code, so treat this as a rolling safety net, not an archive.

GitHub-hosted runners have no fixed IP address. Either allow `0.0.0.0/0` in Atlas, with a
long random password and the read-only user, or let the S3 workflow manage a temporary
access list entry with an Atlas API key that has the **Project Network Access Manager**
role.

## Honest limits

- MongoShield's test suite can't reach a real Atlas cluster. Detection and adaptation
  are tested against the documented replies (host names, error code 8000) and with a
  real replica set standing in for a Free cluster. Real Free and Flex clusters may behave
  differently in ways the documentation doesn't cover. Please report anything that
  surprises you.
- These are logical backups. A restore rebuilds indexes, which takes longer than restoring
  a storage snapshot, and on a Free cluster it runs at the tier's throughput.
- The Atlas triggers documentation says Flex clusters don't support change streams. The
  Flex limits page says they do, with the `ns.db` filter restriction. If change streams
  are refused on your cluster, `auto` falls back to `none` and says so.
- The [point-in-time recovery journal](./point-in-time-recovery.md) has not been adapted
  to these tiers yet.

## Sources

- [Atlas Free Cluster Limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)
- [Atlas Flex Limitations](https://www.mongodb.com/docs/atlas/reference/flex-limitations/)
- [Unsupported Commands in Atlas](https://www.mongodb.com/docs/atlas/unsupported-commands/), including "Limited Commands" (`getParameter`, `serverStatus`, `aggregate`…)
- [Back Up a Free Cluster](https://www.mongodb.com/docs/atlas/backup/cloud-backup/free-cluster-backup/) and [Flex Cluster Backups](https://www.mongodb.com/docs/atlas/backup/cloud-backup/flex-cluster-backup/)
- [Migrating M2/M5 and Serverless to Flex](https://www.mongodb.com/docs/atlas/flex-migration/)
- [Atlas Triggers limitations](https://www.mongodb.com/docs/atlas/atlas-ui/triggers/limitations/) (open change streams per tier)
- [Add Database Users](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/) (users are managed by Atlas)
- [IP Access List](https://www.mongodb.com/docs/atlas/security/ip-access-list/) and [Add Entries to Project IP Access List](https://www.mongodb.com/docs/api/doc/atlas-admin-api-v2/operation/operation-creategroupaccesslistentry) (`deleteAfterDate`)
- [SERVER-28245](https://jira.mongodb.com/browse/SERVER-28245): error code 8000 is reserved for the Atlas shared-tier proxy
