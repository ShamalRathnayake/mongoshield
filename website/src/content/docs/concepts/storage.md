---
title: How a backup is stored
description: The layout of a backup in storage, the manifest, and how to restore one without MongoShield.
---

A MongoShield backup is a directory of plain files under `backups/<id>/` in your storage.
The layout is the one `mongodump --out` produces, with compression and encryption added
as file extensions. The full contract is [the format spec](/specs/format/).

```
backups/
  2026-11-14T03-00-04Z_7f3a9c/        one directory per backup; the name is the backup id
    manifest.json                     written last; its presence means "complete"
    app/                              one directory per database
      users.metadata.json.age         collection options, indexes, type, uuid
      users.bson.zst.age              the documents, as concatenated BSON
      orders.000.bson.zst.age         a large collection split into parts
      orders.001.bson.zst.age
```

## The pipeline

Every file except the manifest goes through the same steps:

```
BSON or metadata JSON  →  compress (data files only)  →  encrypt (if enabled)  →  store
```

- **Data files** hold documents byte for byte as the server returned them, so no BSON
  type is ever converted.
- **Metadata files** are mongodump-compatible canonical Extended JSON: collection
  options, validators, collations, time series settings, view pipelines and every index.
- **Compression** is zstd (default) or gzip, both standard formats.
- **Encryption** is standard [age](https://age-encryption.org); see
  [Encryption](/concepts/encryption/).

## The manifest is the commit marker

`manifest.json` is written only after every other file is stored, and never rewritten.
A directory without a manifest is an incomplete run (still running, crashed or aborted)
and is ignored by every reader. On storage with conditional writes, the manifest is
written with "if none match", so it can never be overwritten.

The manifest lists every file with its size and SHA-256, plus the namespaces, document
counts, consistency mode, compression, encryption recipients (public keys only) and your
labels. It is **not encrypted**, so a backup can be listed, inspected and checked for
integrity without any key — which also means it reveals database and collection names,
counts and sizes.

## Backup ids

A backup id is its UTC start time plus a random suffix, for example
`2026-11-14T03-00-04Z_7f3a9c`. Ids are safe in paths and URLs and sort chronologically
as plain strings, so "latest" and "before a date" are cheap to answer.

## Large collections

Collections larger than `partSizeBytes` (256 MiB of raw BSON by default) are split into
parts by `_id` range. Parts are dumped in parallel, retried one at a time, and let a
backup stop and resume later. Decompressed parts concatenated in order form one valid
`.bson` file. See [Split collections and resumable backups](/specs/parts-and-resume/).

## Restoring without MongoShield

Because every layer is a standard format, a backup can be restored with off-the-shelf
tools:

1. Copy `backups/<id>/` to a local directory.
2. Decrypt each `.age` file: `age -d -i key.txt -o users.bson.zst users.bson.zst.age`.
3. Decompress: `zstd -d users.bson.zst` (or `gunzip users.bson.gz`).
4. For a split collection, concatenate the parts in order into one `.bson` file.
5. Remove the `_changes/` directory if there is one, then run `mongorestore --dir <directory>`.

Done this way, the result is the documents as they were read (consistency `none`): the
change replay that makes a `converge` backup consistent is MongoShield's job. To get a
mongorestore-ready copy with MongoShield's help, use
[`mongoshield export`](/reference/cli/export/).

The format version only changes when an older reader would misread a new backup; newer
optional fields are ignored by older readers.
