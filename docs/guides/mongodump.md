# Working with mongodump and mongorestore

MongoShield never runs `mongodump` or `mongorestore`, but it speaks their formats in
both directions:

- **Import**: turn existing `mongodump` output (a dump directory or an archive,
  gzipped or not) into a MongoShield backup, so your old dumps get checksums,
  compression, encryption, retention and `mongoshield restore`.
- **Export**: turn any MongoShield backup into a dump directory or an archive that
  the official `mongorestore` restores, for runbooks and systems built around it.

Both directions are tested against the real MongoDB Database Tools (100.16.0) and
MongoDB 7.0 and 8.0 on every change: data is compared byte for byte, along with
indexes and collection options; time-series collections, users and roles, and
`mongodump --oplog` dumps taken while the database was being written to are covered
too.

## Migrating from mongodump

### Import a dump directory

`mongodump --out ./dump` (with or without `--gzip`) writes one directory per database.
Import the whole thing:

```sh
mongoshield import ./dump --to s3://acme-backups/prod
```

A single database's directory works too (`./dump/app`); the database is named after
the directory unless you pass `--database <name>`.

### Import an archive

`mongodump --archive=prod.archive [--gzip]` writes a single file. Gzip is detected
automatically:

```sh
mongoshield import ./prod.archive.gz --to s3://acme-backups/prod
```

You can also stream straight from mongodump, without a temporary file:

```sh
mongodump --uri "$MONGODB_URI" --archive | mongoshield import - --archive --to ./backups
```

### What you get

The result is an ordinary MongoShield backup, exactly as `mongoshield backup` would
have written it: a manifest, one compressed (and, with `--recipient` or
`--passphrase-env`, encrypted) file per collection, and SHA-256 checksums. Check it
and restore it like any other backup:

```sh
mongoshield verify <backup-id> --deep
mongoshield restore <backup-id> --rename 'app.*=app_restored.*'
```

Details worth knowing:

- **Documents are copied byte for byte.** Nothing is parsed or re-encoded, so every
  BSON type survives exactly as mongodump wrote it. Every document's framing is
  checked on the way in (and every namespace's CRC-64 for archives), so a truncated
  or damaged dump fails the import instead of producing a damaged backup.
- **Indexes, options and views** come from mongodump's `.metadata.json` files (or the
  archive prelude) and are stored unchanged.
- **Dates.** The backup is dated when the dump was taken: the newest file time of
  the dump directory or archive file (now, for stdin). Pass
  `--dumped-at 2026-01-31T02:00:00Z` to set it explicitly. This matters for
  retention and for `restore --before`; it also means an old dump does not become
  your "latest" backup.
- **Labels.** Imported backups carry the label `imported-from=mongodump@<version>`
  (when the dump says which version wrote it). Add your own with `--label env=prod`.
- **Consistency** is `none` for a plain dump: mongodump without `--oplog` reads each
  collection at a different moment, and MongoShield does not claim more than that.
  A `mongodump --oplog` dump becomes a `converge` backup (see below).
- **Filters.** `--include 'app.*'` and `--exclude 'app.audit_*'` work as for
  `mongoshield backup`.
- **Failures leave nothing behind.** As with a backup, the manifest is written last,
  and a failed or interrupted import deletes the files it wrote.

### Time-series collections

mongodump does not dump a time-series collection's measurements: it writes the
collection's metadata (`metrics.metadata.json`, `"type": "timeseries"`) and the
server's internal *bucket* documents (`system.buckets.metrics.bson`), each holding up
to 1000 measurements, column by column. MongoShield backups hold the measurements
themselves, exactly as `find` returns them, so the import unpacks the buckets:

- uncompressed buckets (`control.version` 1, open buckets of MongoDB 7.0 and older)
  are read directly;
- compressed buckets (versions 2 and 3, MongoDB 5.2+, and every bucket on 8.0) store
  each field as a *BSONColumn* (binary subtype 7): delta- and delta-of-delta-encoded,
  Simple-8b-packed, with run-length encoding, scaled doubles and interleaved
  embedded documents. MongoShield decodes the format exactly as the server does
  (`src/interop/bson-column.ts`).

The measurements of an imported backup are byte for byte what `find` on the
time-series collection returns (time field first, then the meta field, then the
other fields), which is what a native backup stores; the tests check this against
dumps of MongoDB 5.3, 6.0, 7.0 and 8.0, including the legacy column format MongoDB 5.2
and 5.3 write (interleaved control byte `0xF0`), whose buckets keep that format after
an upgrade. A bucket MongoShield cannot read (a bucket version
newer than 3, a damaged column) fails the import rather than being guessed at.

### Users, roles and system.js

Users and custom roles in a dump become the backup's users and roles entries, the
same thing `mongoshield backup --users-and-roles` stores. Both of mongodump's forms
are read:

| mongodump | Files |
|---|---|
| a full dump (or `--db admin`) | `admin/system.users.bson`, `admin/system.roles.bson` |
| `--db app --dumpDbUsersAndRoles` | `app/$admin.system.users.bson`, `app/$admin.system.roles.bson` |

The documents are the server's own `admin.system.users` / `admin.system.roles`
documents and are copied unchanged, password hashes included (so encrypt the backup:
the import warns when it is not). `--include` / `--exclude` select users the way
restore does: a user of database `app` is imported when the patterns select
`app.system.users` (`app.*` does). Restore them with
`mongoshield restore <id> --users-and-roles create`.

`system.js` (stored JavaScript functions) is imported as an ordinary collection, as
`mongoshield backup` treats it.

### Dumps taken with `--oplog`

`mongodump --oplog` dumps every collection while also recording the oplog of the
whole dump (`oplog.bson`, or the archive's oplog), so that
`mongorestore --oplogReplay` can bring the restored data to the moment the dump
ended. MongoShield converts that oplog into the change events of a
[`converge` backup](../specs/CONSISTENCY.md): `mongoshield restore` replays them
after loading the documents, which gives the same result, as of the oplog's last
entry (the manifest's `consistency.to`).

Each oplog entry becomes the event a change stream would have reported for it:
inserts, deletes, replacements, updates (from their `$v: 2` diff, as `$set` /
`$unset` / array truncations of the new values), collection creation and drops,
index builds and drops, and the writes of transactions, applied at their commit.
Every replayed write sets absolute values, so it does not matter which of them a
dumped document already reflected.

Some oplogs cannot be replayed correctly, and then the import fails and says so: an
update of a field whose name contains a `.` or starts with `$` (`$set` cannot
address it), renames, `emptycapped` and other commands no change event can express,
and transactions that started before the oplog. Import such dumps without their
oplog:

```sh
mongoshield import ./dump --to ./backups --ignore-oplog
```

The backup then has consistency `none`, like a dump without `--oplog`. Writes to
time-series collections and to users and roles during the dump are not replayed (as
in a native converge backup); the manifest's `consistency.warning` says so when the
oplog had any.

### What is not imported

These are reported as warnings ("Not imported: …") and in the `skipped` list of the
library result:

| In the dump | Why |
|---|---|
| `system.*` collections other than `system.js` (`system.profile`, `system.views`, …) | MongoShield backs up user data only, like `mongoshield backup`. Views come from their own metadata files. |
| `admin.system.version` / `$admin.system.version` | The auth schema version only mongorestore needs; `mongoshield export` writes it again. |
| `system.buckets.<name>` without `<name>.metadata.json` | The dump is incomplete: mongodump always writes both. |
| `oplog.bson` with `--ignore-oplog` | Left out on request. |

### From code

```ts
import { importMongodump } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const storage = s3Storage({ bucket: "acme-backups", prefix: "prod/" });

const result = await importMongodump({ directory: "./dump" }, storage, {
  compression: "zstd",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  labels: { env: "prod" },
  // ignoreOplog: true,   // for a --oplog dump whose oplog cannot be replayed
});
console.log(result.id, result.manifest.consistency.mode, result.skipped);

// An archive: a path or any readable stream; gzip is detected when omitted.
await importMongodump({ archive: "./prod.archive.gz" }, storage);
```

## Getting a mongorestore-compatible copy

### Export a dump directory

```sh
mongoshield export latest --output ./dump
mongorestore --uri "$TARGET_URI" --dir ./dump
```

With `--gzip`, every file is gzipped exactly like `mongodump --gzip`; restore with
`mongorestore --gzip --dir ./dump`.

### Export an archive

```sh
mongoshield export latest --format archive --output prod.archive.gz --gzip
mongorestore --uri "$TARGET_URI" --gzip --archive=prod.archive.gz
```

Or pipe it straight into mongorestore:

```sh
mongoshield export latest --format archive --output - | mongorestore --uri "$TARGET_URI" --archive
```

### Options

| Flag | Meaning |
|---|---|
| `[backup]` | a backup id or `latest` (default) |
| `--format directory\|archive` | mongodump's `--out` layout (default) or `--archive` |
| `--output <path>` | a new or empty directory, or a new archive file; `-` streams an archive to stdout |
| `--gzip` | gzip each file (directory) or the whole archive, like `mongodump --gzip` |
| `--include`, `--exclude` | export only some namespaces (and the users and roles of their databases) |
| `--identity-file`, `--passphrase-env` | keys for encrypted backups |
| `--from <storage-url>` | where the backups are (default: config) |

What the export guarantees:

- The output is decrypted and decompressed, split collections are joined into one
  `.bson` file, and every stored file is checked against the manifest's size and
  SHA-256 while it is read. Each namespace's document count is compared with the
  manifest. If anything does not match, the export fails and removes what it wrote.
- File names follow mongodump's rules exactly, including escaping (`we/ird name` →
  `we%2Fird+name.bson`) and the shortened names mongodump uses for very long
  collection names, so mongorestore finds every collection.
- A `prelude.json` with the source server version is written, as mongodump 100.12+ does.
- Nothing is overwritten: the output directory must be new or empty, and an archive
  file must not exist yet.

### Time-series collections

mongorestore restores a time-series collection by creating it from its metadata and
inserting bucket documents into `system.buckets.<name>`, so the export computes
buckets from the backup's measurements, written as `system.buckets.<name>.bson` (or
the archive's `system.buckets.<name>` namespace) next to `<name>.metadata.json`,
exactly where mongodump puts them.

The buckets are uncompressed (`control.version` 1, which every server version reads;
the server compresses a bucket the next time it writes to it). Their bounds
(`control.min` / `control.max`) must be exact, since queries use them to skip
buckets. MongoShield only combines measurements into one bucket when it can order
their values exactly as the server does: the same meta value, the same time window
(`bucketMaxSpanSeconds`, start rounded down by `bucketRoundingSeconds`), at most 1000
measurements and 125 KiB, and for every field values of one type among int32, int64,
double, date, timestamp, ObjectId, bool and string (strings only without a
collation). A field holding anything else, such as an embedded document, appears in
at most one measurement per bucket. Ordinary metrics share buckets just as on the
server; unusual data simply gets more, smaller buckets. Each measurement keeps its
field order. The tests check restored collections with filtered queries and the
server's `validate` command.

Two limits, both from what a bucket can hold: a measurement whose time is before 1970
or after 2106 (bucket ids hold seconds as an unsigned 32-bit number), or one so large
that it does not fit a 16 MiB bucket with its bounds, fails the export; restore such
collections with `mongoshield restore`, or leave them out with `--exclude`.

### Users and roles

Backups taken with `--users-and-roles` export their users and roles in both of
mongodump's forms, each with the auth schema version mongorestore checks first:

| Restored by | Files |
|---|---|
| a full `mongorestore --dir ./dump` (or `--nsInclude 'admin.*'`) | `admin/system.users.bson`, `admin/system.roles.bson`, `admin/system.version.bson` |
| `mongorestore --db app --restoreDbUsersAndRoles ./dump/app` | `app/$admin.system.users.bson`, `app/$admin.system.roles.bson`, `app/$admin.system.version.bson` |

In an archive they are the namespaces of the same names, before the collections
(`mongorestore --archive=… --db app --restoreDbUsersAndRoles` restores one
database's users). mongorestore merges them into the server with their password
hashes, so users log in with their old passwords. As with any mongodump output,
`mongorestore --drop` also replaces the users of what it restores. `--include` /
`--exclude` keep the users and roles of the selected databases (`app.*` selects
`app`'s users).

Atlas Search index definitions stay in the exported metadata files as an extra
`searchIndexes` field, which mongorestore ignores (it never creates search indexes).

### From code

```ts
import { exportBackup } from "mongoshield";

const summary = await exportBackup(storage, "latest", {
  format: "archive",
  output: "./prod.archive.gz", // or a Writable stream
  gzip: true,
  decryption: { identities: [process.env.BACKUP_IDENTITY] },
});
console.log(summary.namespaces, summary.usersAndRoles);
```

## Reading and writing archives yourself

The archive codec is available on its own, for tools that want to inspect or
produce mongodump archives without MongoShield backups:

```ts
import { createArchiveReader, createArchiveWriter } from "mongoshield";

// archive bytes → { kind: "prelude" | "namespaceStart" | "document" | "namespaceEnd", … }
fs.createReadStream("dump.archive").pipe(createArchiveReader());
```

The reader applies mongorestore's checks (magic number, framing, per-namespace
CRC-64, every announced namespace present). Piping the reader's events into the
writer reproduces a mongodump archive byte for byte. The byte layout is documented
in `packages/mongoshield/src/interop/archive-format.ts`.

## Running the compatibility tests

The tests in `packages/mongoshield/test/integration/interop*.test.ts` run the real
mongodump and mongorestore. Fetch them once with
`node scripts/fetch-mongo-tools.ts` (from `packages/mongoshield`; it prints the `bin`
directory, which `MONGO_TOOLS_BIN` may point to). Without the tools the tests are
skipped locally; in CI (`CI=true`) they fail instead, so they can never be skipped
there by accident.
