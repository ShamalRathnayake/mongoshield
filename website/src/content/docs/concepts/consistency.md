---
title: Consistency
description: How MongoShield makes a backup of many collections match one moment in time.
---

A backup reads collections one after another while the application keeps writing.
Without care, the restored database mixes moments: `orders` as of 03:00:04 and `users`
as of 03:06:51, so an order can point at a user who does not exist yet. The
`consistency` option decides how MongoShield deals with this. The exact rules are in
the [consistency spec](/specs/consistency/).

| Mode | Restored state | Needs |
|---|---|---|
| `none` | each collection as of the moment it was read | nothing |
| `snapshot` | the whole backup as of one cluster time | a replica set or sharded cluster; the backup must finish within the server's snapshot window (5 minutes by default) |
| `converge` | the whole backup as of the moment it finished | a replica set or sharded cluster on MongoDB 6.0+; a user who may open a cluster-wide change stream |
| `auto` (default) | `converge` where possible, otherwise `none` | |

## `converge`: the default on replica sets

`converge` is MongoShield's equivalent of `mongodump --oplog`, built on change streams so
it also works where the oplog cannot be read (for example on Atlas shared tiers).

1. Before reading any data, note the cluster time **T0** and open a change stream from it.
2. Dump every collection as usual, while the change stream records every change to the
   backed-up namespaces into a small extra file.
3. Note the cluster time **T1** when the dump ends, and keep reading the stream until
   everything up to T1 is captured.

On restore, the documents are loaded and the recorded changes replayed in order. Each
replayed change sets absolute values (set this field, replace this document, delete this
`_id`), so applying a change to a document that already reflects it is harmless. After
the replay every document is as it was at T1.

If capture fails — the change stream history rolled off the oplog, privileges are
missing, the connection drops — the backup fails and is never committed as consistent.

## What `auto` picks

`auto` uses `converge` when the deployment is a replica set or sharded cluster on
MongoDB 6.0+ **and** the user may open a deployment-wide change stream (MongoShield
checks by opening one and closing it straight away). Otherwise it uses `none` and records
why in the manifest's `consistency.warning`, shown by `backup` and `inspect`.

A common case: the built-in `backup` role cannot open change streams. Grant
`readAnyDatabase` (or `changeStream` and `find` on all databases) to get `converge`.

`auto` never picks `snapshot`, which fails outright when a backup takes longer than the
snapshot window. Choose `snapshot` explicitly for small databases where that is fine.

## Limits

- Time series collections are restored as read: change streams do not report their writes.
- Collection-option changes (`collMod`) made during the backup are not replayed; index
  builds and drops are, after the documents, including the indexes of collections
  created during the backup.

See [Limitations](/limitations/) for the full list.
