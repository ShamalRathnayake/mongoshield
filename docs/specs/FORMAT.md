# MongoShield backup format, version 1

This document specifies how MongoShield stores a backup: which objects it writes to
a storage location, what each one contains, and how a reader decides that a backup
is complete and intact. It is a public contract. Backups written by any MongoShield
2.x release follow it, and the data inside them stays readable by standard tools
(`age`, `zstd`, `gzip`, `mongorestore`) without MongoShield.

The reference implementation lives in `packages/mongoshield/src/format/`
(`manifest.ts`, `layout.ts`, `manifest-io.ts`, `metadata.ts`, `bson-stream.ts`,
`hashing.ts`) and `packages/mongoshield/src/compression/`. Encryption is specified
separately in [ENCRYPTION.md](./ENCRYPTION.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## Overview

A backup is a set of objects under one directory-like key prefix:

```
backups/
  2026-11-14T03-00-04Z_7f3a9c/           one directory per backup; the name is the backup id
    manifest.json                         written last; its presence means "complete"
    backup-key.age                        passphrase and KMS backups: the per-backup key envelope
    app/                                  one directory per database
      users.metadata.json.age             collection options, indexes, type, uuid
      users.bson.zst.age                  the documents, as concatenated BSON
      orders.metadata.json.age
      orders.000.bson.zst.age             a large collection split into parts
      orders.001.bson.zst.age
      active_users.metadata.json.age      a view: metadata only, no data file
    _changes/
      window.bson.zst.age                 converge backups: the changes made while the backup ran
```

The layout is the one `mongodump --out` produces (a directory per database, a
`.bson` and a `.metadata.json` file per collection), with compression and encryption
added as file extensions. Every file except the manifest is processed the same way:

```
BSON or metadata JSON  →  compress (data files only)  →  encrypt (if enabled)  →  store
```

## Storage keys

Storage adapters are plain blob stores (a local directory, S3 or compatible, memory).
Keys are relative POSIX paths: segments separated by `/`, never starting with `/`,
never containing `\`, NUL, empty segments, `.` or `..`, and at most 1024 characters.

Readers MUST NOT derive file names themselves. The manifest lists the key of every
file in the backup; the naming rules below exist so that keys are safe, unique and
recognisable to a person browsing the bucket, and they may evolve without a format
version bump.

### Backup ids

A backup id is the UTC start time to the second, with the colons replaced by `-`,
followed by `_` and 6 random lowercase hex characters:

```
2026-11-14T03-00-04Z_7f3a9c
^^^^^^^^^^^^^^^^^^^^ ^^^^^^
start time (UTC)     random suffix, so two backups started in the same second never collide
```

Pattern: `^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[0-9a-f]{6}$`.

Ids are safe in paths and URLs, and they sort chronologically as plain strings,
which makes "latest" and "before date X" cheap to answer from a listing of the
`backups/` prefix. The id is also the backup's directory name and the manifest's `id`.

### File keys

All keys inside a backup are relative to `backups/<id>/`.

| File | Key | Example |
|---|---|---|
| Manifest | `manifest.json` | `manifest.json` |
| Collection data | `<db>/<collection>.bson<compression><encryption>` | `app/users.bson.zst.age` |
| Collection data, split | `<db>/<collection>.<part>.bson<compression><encryption>` | `app/orders.002.bson.zst` |
| Collection metadata | `<db>/<collection>.metadata.json<encryption>` | `app/users.metadata.json.age` |

`<part>` is the 0-based part number, zero-padded to at least three digits.

| Extension | Meaning |
|---|---|
| `.bson` | concatenated BSON documents |
| `.metadata.json` | mongodump-compatible collection metadata (Extended JSON) |
| `.zst` | zstd-compressed |
| `.gz` | gzip-compressed |
| `.age` | age-encrypted (always the last extension: it is applied last) |

Metadata files are small and are never compressed. They are encrypted whenever the
backup is, because index definitions, validators and view pipelines can reveal a lot
about the data. The manifest is never compressed or encrypted (see
[The manifest](#the-manifest)).

### Name encoding

Database and collection names are turned into single key segments by
`encodeNameSegment()`:

1. The characters `A-Z a-z 0-9 _ . -` are kept as they are, so common names stay
   readable: `users` stays `users`, `system.views` stays `system.views`.
2. Every other character is percent-encoded, one `%XX` (uppercase hex) per UTF-8 byte:
   `a/b` → `a%2Fb`, `my db` → `my%20db`, `café` → `caf%C3%A9`, `%` → `%25`.
3. A name made only of dots (`.`, `..`, …) is encoded entirely (`..` → `%2E%2E`) so it
   can never act as a relative path segment.
4. If the encoded segment is longer than 180 characters, it is cut to 163 characters
   and `~` plus the first 16 hex characters of the SHA-256 of the original name is
   appended, giving exactly 180 characters. With the longest suffix
   (`.000.bson.zst.age`) a file name stays well under the 255-byte limit of common
   filesystems.

The encoding is not meant to be reversed: the manifest records each namespace's
`db` and `collection` names next to its file keys.

## Data files

A data file holds the collection's documents as concatenated BSON, exactly as
`mongodump` writes them and `mongorestore` reads them:

```
document := int32 length (little-endian, includes itself) · elements · 0x00
file     := document*
```

- Writers SHOULD store documents byte for byte as the server returned them, for
  example by reading with `find(..., { raw: true })`, so no BSON type is ever converted.
- Readers MUST check each length prefix (at least 5) and each terminating `0x00`,
  and MUST treat input that ends inside a document as corrupt. MongoShield's reader
  also rejects documents larger than 64 MiB by default, as a guard against corrupt
  length prefixes (MongoDB's own limit is 16 MiB).
- A view has no data file; its `files` list in the manifest is empty.

### Split parts

A large collection MAY be written as several parts, `<collection>.000.bson…`,
`<collection>.001.bson…`, and so on. The manifest lists the parts in order. Each part
contains only whole documents, so decompressed (and decrypted) parts concatenated in
order are a single valid `.bson` file.

MongoShield splits a collection into contiguous `_id` ranges, in `_id` order, and
records each part's range in the manifest (`range`, below). A collection that is not
split keeps the plain `<collection>.bson…` name, so small backups look exactly like
mongodump output. See [PARTS-AND-RESUME.md](PARTS-AND-RESUME.md).

### Compression

| `compression` | Format | Notes |
|---|---|---|
| `zstd` | Zstandard frames ([RFC 8878](https://www.rfc-editor.org/rfc/rfc8878)) | default level 3; every frame carries a content checksum |
| `gzip` | gzip members ([RFC 1952](https://www.rfc-editor.org/rfc/rfc1952)) | default level 6 |
| `none` | uncompressed | |

All data files of a backup use the compression named in the manifest. A compressed
file MAY consist of several concatenated zstd frames or gzip members (for example,
Node.js may end a zstd stream with a small empty frame). Both formats allow this and
the standard `zstd` and `gzip` tools decompress such files. A zstd reader MUST reject
input that ends inside a frame.

### Encryption

When the manifest's `encryption` is not `null`, every data and metadata file is an
independent age v1 file, encrypted to the recipients listed there. See
[ENCRYPTION.md](./ENCRYPTION.md).

Passphrase backups (`encryption.recipients` is `["scrypt"]` and `encryption.keyFile` is
set) encrypt every data and metadata file to a one-off X25519 recipient instead. Its
identity is stored in the key envelope `backup-key.age` (an age-keygen key file,
age-encrypted with the passphrase), so scrypt runs once per backup rather than once per
file. Readers decrypt `encryption.keyFile` with the passphrase, after checking its size
and SHA-256, and use the identity inside for every other file. See
[ENCRYPTION.md, "Passphrase backups"](./ENCRYPTION.md#passphrase-backups).

KMS backups (`encryption.recipients` contains `kms:<provider>:<key>` labels and
`encryption.keyFile` is set) use the same envelope, but `backup-key.age` is encrypted
with one `mongoshield-kms` stanza per cloud KMS key instead of a passphrase. Every data
and metadata file is encrypted to the one-off recipient **and** to every `age1…`
recipient also listed in `encryption.recipients` (offline recovery keys), so those
identities open the data files directly. Readers either use such an identity, or
decrypt `encryption.keyFile` through the KMS (after checking its size and SHA-256). See
[ENCRYPTION.md, "KMS backups"](./ENCRYPTION.md#kms-backups).

## Metadata files

`<collection>.metadata.json` uses the shape mongodump writes, so it can be handed to
`mongorestore` as is. It is a single line of **canonical** Extended JSON v2:

```json
{"options":{},"indexes":[{"v":{"$numberInt":"2"},"key":{"_id":{"$numberInt":"1"}},"name":"_id_"}],"uuid":"8a3d0b6e2f1c4b5a9e7d6c5b4a392817","collectionName":"users","type":"collection"}
```

| Field | Type | Meaning |
|---|---|---|
| `options` | document | the `options` of the collection from `listCollections`: validator, collation, capped size, `viewOn` and `pipeline` for views, `timeseries` settings, … Empty for a plain collection. |
| `indexes` | array of documents | the index specifications from `listIndexes`. Empty for views. |
| `uuid` | string, optional | the collection UUID as 32 lowercase hex characters without dashes. Omitted when unknown. |
| `collectionName` | string | the collection name, without the database name |
| `type` | string | `collection`, `view` or `timeseries` |
| `searchIndexes` | array, optional | MongoShield extension (2.0): the collection's Atlas Search and Vector Search indexes (below). Omitted when there are none. |

Each entry of `searchIndexes` is what `createSearchIndexes` needs to recreate the index,
taken from `$listSearchIndexes` without its status fields (`status`, `queryable`,
`statusDetail`, …):

| Field | Type | Meaning |
|---|---|---|
| `name` | string | the index name, e.g. `default` |
| `type` | string | `search` (Atlas Search) or `vectorSearch` (Atlas Vector Search) |
| `definition` | document | the index definition (`latestDefinition`): mappings, analyzers, vector fields, … |

mongodump does not capture search indexes, so only MongoShield writes this field.
mongorestore parses the file into a struct that ignores unknown fields, so a backup with
`searchIndexes` still restores with mongorestore (checked with mongorestore 100.16.0);
it just does not create the search indexes. Servers without Atlas Search have no search
indexes to list, so their backups never contain the field. Restoring onto such a server
skips the definitions with a warning. A reader that finds a search index `type` it does
not know MUST refuse it (`MS_FORMAT_UNSUPPORTED`) rather than build a different index.

Compatibility details:

- Fields are written in the order of mongodump's `Metadata` struct:
  `options, indexes, uuid, collectionName, type` (then `searchIndexes`, when present). mongorestore does not depend on the
  order; keeping it makes files easy to compare with real mongodump output.
- Canonical (not relaxed) Extended JSON keeps BSON types exact: `{"$numberInt":"1"}`
  stays an int32, `{"$numberLong":"3600"}` an int64, `{"$numberDouble":"1.0"}` a
  double, and dates and regular expressions in validators or partial filter
  expressions stay dates and regular expressions.
- Readers MUST accept files written by mongodump, which may omit `options` (when
  empty), `uuid` (when unknown) and, in old versions, `type` (meaning `collection`).
  Readers MUST ignore fields they do not know.
- A reader that finds a `type` it does not know MUST refuse to restore that namespace
  rather than guess (`MS_FORMAT_UNSUPPORTED`). A file that is not valid Extended JSON
  or lacks `collectionName` is damaged (`MS_INTEGRITY_FAILED`).

## Changes file (converge backups)

A backup taken with consistency `converge` (see [CONSISTENCY.md](./CONSISTENCY.md))
also stores every change made to the backed-up namespaces while it ran, between the
cluster times `consistency.from` (T0) and `consistency.to` (T1). The manifest lists it
as `changes`; its key is `_changes/window.bson[.zst|.gz][.age]`. (A collection named
`window` in a database named `_changes`, which would get the same key, gets a
`~<hash>` suffix like a case collision.)

- The file is concatenated BSON, compressed and encrypted exactly like a data file.
- Each document is a MongoDB change stream event, as the server sent it for a
  cluster-wide change stream opened with `showExpandedEvents: true`: `operationType`,
  `clusterTime`, `ns`, `documentKey`, `fullDocument`, `updateDescription`
  (`updatedFields`, `removedFields`, `truncatedArrays`, `disambiguatedPaths`), `to`
  and `operationDescription` for DDL events, and the other standard fields.
- Events are in the order the stream returned them, which is cluster-time order;
  none is earlier than `consistency.from` or later than `consistency.to`.
- Two kinds of events are written by MongoShield rather than taken verbatim:
  - an `update` whose changed paths cannot be expressed with update operators
    (field names containing `.` or starting with `$`) carries `fullDocument`, the
    document as it was right after the update (read at the event's cluster time);
  - after a `rename` whose source the backup does not hold as of the rename (e.g. a
    `$out` that started before T0), the destination is recorded as it was right after
    the rename: a `drop`, a `create` and one `insert` per document, all with the
    rename's `clusterTime`, `ns` set to the destination, and `synthesized: true`.
- Readers MUST replay the events in file order, and only after loading the data
  files: each event's effect is absolute (set this value, replace with this document,
  delete this `_id`), which is what makes the replay converge to T1.
- `changes.events` is the number of events in the file; a reader that decodes the
  file SHOULD compare it.

## The manifest

`manifest.json` is UTF-8 JSON (plain JSON, not Extended JSON), pretty-printed with two
spaces and a trailing newline. It is the commit marker and the table of contents of
the backup. It is never encrypted, so a backup can be listed, inspected and checked
for integrity without any key; it therefore contains no secrets, but it does reveal
database and collection names, document counts, sizes and labels.

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | integer | `1` for this specification |
| `id` | string | the backup id; equals the backup's directory name |
| `tool` | string | the writer, e.g. `mongoshield@2.0.0` |
| `status` | `"complete"` | always `complete`: an incomplete backup has no manifest |
| `startedAt`, `completedAt` | string | ISO 8601 date-times with a time zone (`Z` or `±hh:mm`) |
| `source.topology` | string | `standalone`, `replicaSet`, `sharded` or `unknown` |
| `source.serverVersion` | string | MongoDB server version, e.g. `8.0.4` |
| `source.clusterId` | string, optional | stable, non-secret identifier of the source deployment (a hash, never a URI) |
| `consistency.mode` | string | `none`, `snapshot` or `converge` |
| `consistency.from`, `consistency.to` | `{ t, i }`, optional | cluster times (BSON Timestamp seconds and increment) bounding the data |
| `consistency.warning` | string, optional | set when a stronger mode was requested but could not be used, or (converge) known limits that apply to this backup |
| `compression` | string | `zstd`, `gzip` or `none`, for every data file |
| `encryption` | object or `null` | `null` when unencrypted |
| `encryption.scheme` | `"age-v1"` | see ENCRYPTION.md |
| `encryption.recipients` | string[] (at least 1) | public recipients (`age1…`), `scrypt`, or KMS labels `kms:<provider>:<key>` (e.g. `kms:aws:arn:aws:kms:…`); never secrets |
| `encryption.keyFile` | `{ key, size, sha256 }`, optional | passphrase and KMS backups: the key envelope (`backup-key.age`), relative to the backup directory |
| `labels` | object of strings | user labels, e.g. `{ "env": "prod" }` |
| `namespaces` | array | one entry per collection, view or time-series collection, plus the users and roles entries of backups taken with `includeUsersAndRoles` (below) |
| `changes` | stored file plus `events` (integer), optional | converge backups only: the changes file (above) and its number of events |
| `immutableUntil` | ISO 8601 date-time with offset, optional | set when the backup was written with write-once retention (`retainDays`): every file and the manifest are locked by the storage until then; prune keeps the backup until this time |
| `totals.namespaces` | integer | number of entries in `namespaces` |
| `totals.documents` | integer | sum of `documents` over all namespaces |
| `totals.bytesRaw` | integer | sum of `bytesRaw` over all namespaces |
| `totals.bytesStored` | integer | sum of `size` over every data part, metadata file and the changes file (not the manifest or the key envelope) |

Each entry of `namespaces`:

| Field | Type | Meaning |
|---|---|---|
| `ns` | string | full namespace, `<db>.<collection>` |
| `db`, `collection` | string | the names, unencoded |
| `type` | string | `collection`, `view` or `timeseries`; or `users` / `roles` (below) |
| `documents` | integer | documents written; always 0 for views |
| `bytesRaw` | integer | size of the BSON documents before compression and encryption |
| `files` | array of stored files | the data parts, in order; empty for views |
| `metadata` | stored file | the metadata file |

A stored file is `{ "key", "size", "sha256" }`:

| Field | Meaning |
|---|---|
| `key` | key relative to the backup directory, e.g. `app/users.bson.zst.age` |
| `size` | size in bytes of the stored object, after compression and encryption |
| `sha256` | lowercase hex SHA-256 of the stored bytes |

Entries of `files` may also carry `range` (added in 2.0 without a format bump; readers
that ignore it lose nothing): the part's `_id` bounds as canonical Extended JSON,
`{ "from": <inclusive>, "to": <exclusive> }`, with `{ "$minKey": 1 }` / `{ "$maxKey": 1 }`
for the open ends (the last part also holds a document whose `_id` is `MaxKey`).

Because `size` and `sha256` cover the bytes as stored, anyone with read access can
verify a backup's integrity without decrypting it. Readers SHOULD check both while
restoring and MUST NOT report a restore as successful if they do not match.

Readers MUST ignore manifest fields they do not know (the reference reader drops them).

### Users and roles entries

A backup taken with `includeUsersAndRoles` (CLI `--users-and-roles`, config
`backup.usersAndRoles`) has two more `namespaces` entries, after the collections. They
were added in 2.0 without a format bump: only backups taken with the option have them,
and a reader that does not know the two types refuses the manifest instead of
misreading it.

| `ns` | `type` | Data file | Holds |
|---|---|---|---|
| `admin.system.roles` | `roles` | `admin/system.roles.bson[.zst\|.gz][.age]` | the custom roles of the backed-up databases |
| `admin.system.users` | `users` | `admin/system.users.bson[.zst\|.gz][.age]` | the users of the backed-up databases |

"The backed-up databases" are those of the backed-up namespaces, or every database
when the backup had no `include` patterns. The data file is concatenated BSON,
compressed and encrypted like any data file, one document per user or role, sorted by
`_id`, in the shape of the server's own `admin.system.users` / `admin.system.roles`
documents (`usersInfo` with credentials and custom data, `rolesInfo` with privileges,
without computed fields such as `mechanisms` or `inheritedPrivileges`):

```json
{"_id":"app.alice","userId":{"$binary":…},"user":"alice","db":"app","credentials":{"SCRAM-SHA-256":{…}},"customData":{…},"roles":[{"role":"readWrite","db":"app"}]}
{"_id":"app.reporting","role":"reporting","db":"app","privileges":[{"resource":{"db":"app","collection":"orders"},"actions":["find"]}],"roles":[]}
```

`documents` counts the users (roles); the metadata file is a plain mongodump-style file
with `collectionName` `system.users` (`system.roles`), type `collection` and no indexes.

**Credentials are sensitive.** They are SCRAM hashes, not passwords, but they allow
offline guessing of weak passwords and, for SCRAM-SHA-1, logging in to other
deployments where the same user has the same password. Backups holding users SHOULD be
encrypted; the writer logs a warning when they are not.

Readers restore these entries only when asked (`restore({ usersAndRoles })`), with
user-management commands and never as collections: roles first (`createRole`, then
`updateRole` for inherited roles), then users through `_mergeAuthzCollections` like
mongorestore, which keeps the password hashes. See `src/engine/restore-authz.ts`.

## Commit protocol

1. The writer picks a new backup id and writes every data, metadata and changes file under
   `backups/<id>/`, in any order and in parallel, recording each file's size and
   SHA-256 as it streams.
2. Only after every file has been stored successfully, the writer writes
   `manifest.json`. When the storage supports conditional writes, the manifest is
   written with "if none match" (`If-None-Match: *` on S3), so an existing manifest
   can never be overwritten.
3. Each object write is atomic: readers see either the whole object or nothing.

Consequences:

- A backup directory **without** `manifest.json` is incomplete (still running,
  crashed or aborted). Readers MUST ignore it; retention MAY delete it once it is
  clearly abandoned.
- A manifest is immutable once written, and may live under write-once retention
  (S3 Object Lock). Anything learned later, such as verification results, is stored
  as separate objects next to the manifest, never by rewriting it.
- When `immutableUntil` is set, every object of the backup, the manifest included, was
  written with storage-level retention until that time (S3 Object Lock, GCS object
  retention or an Azure immutability policy). Pruning tools MUST NOT try to delete the
  backup earlier; the storage would refuse anyway. See `docs/guides/immutable-backups.md`.

## Objects next to backups

A few objects live outside `backups/<id>/`, so that a backup directory stays a plain
mongodump-layout directory. Readers that ignore them can still restore every backup.

```
annotations/<id>/rekey/<time>.json    rekey records: new digests and recipients after a rekey
erasures/<time>-<random>.json         the GDPR erasure ledger (append-only)
```

- **Rekey records** (see [ENCRYPTION.md](ENCRYPTION.md#rekeying)) list, per rewritten
  file, its previous and new size and SHA-256, and the backup's `encryption.recipients`
  after the rekey. Readers apply `complete` records in time order over the manifest and
  ignore `pending` ones, and ignore all of them while the manifest's `immutableUntil` is
  in the future. A reader that ignores rekey records sees the original digests: fast
  verification then reports the rewritten files as changed, which is safe.
- **Erasure records** (`formatVersion: 1`) name a namespace or pattern, a reason, and a
  match: either an Extended JSON filter, or per-field HMAC-SHA-256 digests of an exact
  match on strings (see `src/extras/erasure-match.ts`). MongoShield deletes matching
  documents after every restore, rollback and copy. Records are never rewritten; a record
  that cannot be read fails the restore rather than being skipped.

## Restoring without MongoShield

Every layer is a standard format, so a backup can be restored with off-the-shelf tools:

1. Copy `backups/<id>/` to a local directory.
2. If encrypted, decrypt each `.age` file: `age -d -i key.txt -o users.bson.zst users.bson.zst.age`.
3. Decompress each data file: `zstd -d users.bson.zst` or `gunzip users.bson.gz`.
4. For a split collection, concatenate the parts in order:
   `cat orders.000.bson orders.001.bson > orders.bson`, then remove the part files.
5. Remove the `_changes/` directory of a converge backup (mongorestore would take it
   for a database), then run `mongorestore --dir <directory>`. Without the replay the
   result is the documents as read, i.e. consistency `none`.

## Versioning and compatibility promise

- `formatVersion` changes only when a reader of the previous version would
  misread a new backup. Adding optional manifest fields, new labels or new
  file-naming rules does not change it (readers ignore unknown fields and take keys
  from the manifest).
- Example: `changes` (converge backups) was added within version 1. A reader that
  ignores it restores the documents as read, the same result as consistency `none`.
- Example: `encryption.keyFile` (passphrase backups) was added within version 1. A
  reader that ignores it cannot decrypt such a backup, but it fails cleanly with a
  "no matching identity" error rather than misreading data, and no earlier release
  wrote passphrase backups it would now misread. KMS backups (`kms:` labels) were
  added the same way: an older reader fails cleanly, and an identity listed as a
  recovery recipient still opens every data file without knowing about KMS at all.
- Example: `immutableUntil` (immutable backups) was added within version 1. A reader
  that ignores it restores the backup normally; only its prune would attempt to delete
  locked objects early, which the storage refuses.
- A MongoShield release reads every backup whose `formatVersion` is less than or equal
  to the highest version it knows. On a higher version it stops with
  `MS_FORMAT_UNSUPPORTED` and asks for an upgrade, instead of guessing.
- Format changes are made by updating this document and `MANIFEST_FORMAT_VERSION`
  together, through an RFC.
