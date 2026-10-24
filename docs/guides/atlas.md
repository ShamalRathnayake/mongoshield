# MongoDB Atlas

MongoShield connects to Atlas like any application: with the driver and a `mongodb+srv://`
connection string. It complements Atlas Cloud Backup with portable copies you own, in
your own bucket and cloud, in standard formats, and works on tiers without Cloud
Backup.

## 1. A database user for backups

Create a dedicated user (Database Access → Add New Database User) with the built-in role
**Only read any database** (`readAnyDatabase`). Backups never write to your data.

```bash
atlas dbusers create --username mongoshield-backup --password '<generated>' --role readAnyDatabase
```

Extra privileges only when you use these features:

| Feature | Needs |
|---|---|
| `schedule.lock: "mongo"` | `readWrite` on the `mongoshield` database (the lock document). The default `storage` lock needs nothing. |
| `restore` | a **separate** user with `readWriteAnyDatabase` (or `readWrite` on the target databases), used only when restoring |

## 2. The connection string

Copy it from Connect → Drivers:

```
mongodb+srv://mongoshield-backup:<password>@cluster0.abcde.mongodb.net/
```

- URL-encode special characters in the password.
- To keep backup reads off the primary, add `?readPreference=secondary`. With analytics
  nodes, `?readPreference=secondary&readPreferenceTags=nodeType:ANALYTICS` sends them there.
- MongoShield never logs or stores the password: it is stripped from errors, logs and
  manifests.

## 3. Network access

Atlas only accepts connections from addresses on the project's **IP Access List** (or
through private networking). Where backups run decides what to allow:

| Where MongoShield runs | Recommended |
|---|---|
| A server, VM or Kubernetes cluster | its egress IP (NAT gateway); or VPC peering / Private Endpoint (M10+) |
| AWS Lambda | a VPC with a NAT gateway + Elastic IP; or PrivateLink |
| GitHub Actions | no fixed IPs on standard runners: larger runners with static IPs, a self-hosted runner, or add/remove the runner IP during the job with the Atlas CLI |
| Vercel | Secure Compute / static IPs (paid plans) |
| Your laptop | your current IP, temporarily |

`0.0.0.0/0` works but makes the password the only protection. If you must use it, use a
long random password and the read-only user above.

A connection that times out with "No suitable server responded in time" is almost always
the access list.

## 4. Consistency on Atlas

Every Atlas cluster is a replica set, so `consistency: "snapshot"` works on dedicated
tiers (M10+) for backups that finish within the snapshot window (5 minutes by default).
On shared and Flex tiers some server features are restricted; use the default (`auto`)
there. See [CONSISTENCY.md](../specs/CONSISTENCY.md).

## 5. Search indexes, users and roles

mongodump skips both; MongoShield can keep them.

- **Atlas Search and Vector Search indexes** are backed up automatically with each
  collection (their definitions, in the metadata file). On restore they are created
  after the regular indexes and then build in the background on Atlas; restore does
  not wait for them to become queryable. Restoring onto a server without Atlas Search
  restores everything else and warns about the search indexes it left out. Pass
  `--skip-search-indexes` (`skipSearchIndexes: true`) to leave them out on purpose.
- **Users and custom roles** are backed up with `--users-and-roles`
  (`includeUsersAndRoles: true`, config `backup.usersAndRoles: true`). They include
  password hashes, so encrypt such backups. Restore them with
  `--users-and-roles create` (or `replace`). Atlas manages database users through its
  own API and refuses to restore password hashes, so on Atlas restored users get a
  random password and are listed as needing a password reset; custom roles may also be
  refused there (create them in the Atlas UI instead).

## 6. Try it

```bash
export MONGODB_URI='mongodb+srv://mongoshield-backup:…@cluster0.abcde.mongodb.net/'
npx mongoshield@next backup --to ./backups --exclude '*.sessions'
npx mongoshield@next verify --from ./backups
```

Then schedule it on your platform: [Docker](./docker.md), [Kubernetes](./kubernetes.md),
[GitHub Actions](./github-actions.md), [AWS Lambda](./aws-lambda.md) or [Vercel](./vercel.md).
