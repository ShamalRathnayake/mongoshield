# Working with mongodump and mongorestore

MongoShield never runs `mongodump` or `mongorestore`, but it speaks their formats in
both directions:

- **Import**: turn existing `mongodump` output (a dump directory or an archive,
  gzipped or not) into a MongoShield backup, so your old dumps get checksums,
  compression, encryption, retention and `mongoshield restore`.
- **Export**: turn any MongoShield backup into a dump directory or an archive that
  the official `mongorestore` restores, for runbooks and systems built around it.

Both directions are tested against the real MongoDB Database Tools (100.16.0) on
every change: data is compared byte for byte, along with indexes and collection
options.

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
- **Consistency** is recorded as `none`: mongodump without `--oplog` reads each
  collection at a different moment, and MongoShield does not claim more than that.
- **Filters.** `--include 'app.*'` and `--exclude 'app.audit_*'` work as for
  `mongoshield backup`.
- **Failures leave nothing behind.** As with a backup, the manifest is written last,
  and a failed or interrupted import deletes the files it wrote.

### What is not imported

These are reported as warnings ("Not imported: …") and in the `skipped` list of the
library result:

| In the dump | Why |
|---|---|
| Time-series collections (`<name>.metadata.json` with `"type":"timeseries"`, data in `system.buckets.<name>.bson`) | mongodump stores the server's internal, column-compressed *bucket* documents. MongoShield backups store plain measurements and let the server rebuild buckets on restore; converting buckets back is not supported. Back these collections up with `mongoshield backup`. |
| `system.*` collections (`admin.system.version`, `system.js`, `system.profile`, …) | MongoShield backs up user data only, like `mongoshield backup`. |
| `$admin.system.users` / `$admin.system.roles` (`--dumpDbUsersAndRoles`) | Not imported from dumps. Take a MongoShield backup with `--users-and-roles` to back up users and roles. |
| `oplog.bson` (`--oplog`) | Replaying an oplog is not supported. |

### From code

```ts
import { importMongodump } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const storage = s3Storage({ bucket: "acme-backups", prefix: "prod/" });

const result = await importMongodump({ directory: "./dump" }, storage, {
  compression: "zstd",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  labels: { env: "prod" },
});
console.log(result.id, result.skipped);

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
| `--include`, `--exclude` | export only some namespaces |
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

Time-series collections are not exported: mongorestore expects their internal bucket
documents, which a MongoShield backup does not contain. Restore them with
`mongoshield restore --include 'app.metrics'`.

Users and roles (backups taken with `--users-and-roles`) are not exported either;
restore them with `mongoshield restore --users-and-roles create`. Atlas Search index
definitions stay in the exported metadata files as an extra `searchIndexes` field,
which mongorestore ignores (it never creates search indexes).

### From code

```ts
import { exportBackup } from "mongoshield";

const summary = await exportBackup(storage, "latest", {
  format: "archive",
  output: "./prod.archive.gz", // or a Writable stream
  gzip: true,
  decryption: { identities: [process.env.BACKUP_IDENTITY] },
});
console.log(summary.namespaces, summary.skipped);
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
