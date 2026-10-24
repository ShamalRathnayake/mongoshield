---
title: Library API
description: An overview of the main exports of the mongoshield package, with examples.
---

Everything exported from `mongoshield` and its subpath entry points is covered by
semver. Types are included; your editor shows every option with its documentation. This
page is a map of the main pieces. The source of truth is
[`src/index.ts`](https://github.com/ShamalRathnayake/mongoshield/blob/main/packages/mongoshield/src/index.ts).

## Entry points

| Import | Contains |
|---|---|
| `mongoshield` | `MongoShield`, scheduling, the journal, masking, interop, keys, errors, format types |
| `mongoshield/storage/file` | `fileStorage({ path })`: local disk, NFS, SMB |
| `mongoshield/storage/s3` | `s3Storage({ bucket, prefix, endpoint? })`: S3 and compatible services |
| `mongoshield/storage/gcs` | `gcsStorage(…)`: Google Cloud Storage |
| `mongoshield/storage/azure` | `azureStorage(…)`: Azure Blob Storage |
| `mongoshield/storage/sftp` | `sftpStorage(…)`: SFTP |
| `mongoshield/storage/memory` | `memoryStorage()`: in-process, for tests |
| `mongoshield/kms` | KMS clients for AWS, Google Cloud and Azure, and the KMS stanza helpers |
| `mongoshield/testing` | `useMongoSnapshot`, `createDatabaseSnapshot`: fast test database resets |

## `MongoShield`

The main class. One instance holds a source, a storage adapter and the encryption
settings; each method is one operation.

```ts
import { MongoShield } from "mongoshield";
import { fileStorage } from "mongoshield/storage/file";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI }, // or { client }: reuse a connected MongoClient
  storage: fileStorage({ path: "./backups" }),
  compression: "zstd",                       // default
  encryption: { recipients: ["age1…"] },     // optional
  logger,                                    // optional; silent by default
});
```

| Method | Does |
|---|---|
| `backup(options?)` | Backs up the source. Returns the backup id and manifest (or a checkpoint with `maxDurationMs`). |
| `restore(options)` | Restores a backup (`"latest"`, an id, or `{ before: date }`); `at` restores to a point in time. |
| `planRestore(options)` | The restore plan without writing anything (what `dryRun` prints). |
| `verify(options)` | `"fast"` checks sizes and SHA-256 without a key; `"deep"` decrypts and parses everything. |
| `drill(options)` | Restores into a scratch deployment, checks it, cleans up, and reports the RTO. |
| `copy(options)` | Copies between deployments, with optional `mask` and `subset`. |
| `find(options)` | Streams the documents of one backed-up collection that match a filter. |
| `restoreDocuments(options)` | Restores only the matching documents. |
| `list()` | The catalog: every backup with status, size and verification results. |
| `prune(policy, options?)` | Deletes what the retention policy no longer keeps. |
| `hold(id, { reason })` / `release(id)` | Protects a backup from pruning, and lifts that. |
| `close()` | Releases the storage adapter's resources. |

```ts
// Restore one database under a new name, refusing to touch existing data.
const result = await shield.restore({
  backup: "latest",
  include: ["app.*"],
  rename: { "app.*": "app_restored.*" },
  mode: "fail-if-exists",             // default; also "drop", "insert", "upsert"
  decryption: { identityFiles: ["./backup.key"] },
  onProgress: (event) => { /* namespace:start, namespace:progress, overall … */ },
});

// Find a document in a backup without restoring anything.
for await (const user of shield.find({
  backup: "latest",
  namespace: "app.users",
  filter: { email: "ada@example.com" },
  decryption: { identityFiles: ["./backup.key"] },
})) {
  console.log(user);
}
```

## Running backups unattended

| Export | Does |
|---|---|
| `runScheduledJob(shield, config, options)` | One scheduled run: lock, backup, guard, verify, prune, notify, heartbeat. Never throws; returns a run report. |
| `BackupScheduler` | The in-process cron scheduler behind `mongoshield schedule`. |
| `storageLock`, `mongoLock`, `noLock` | Locks that stop two runners backing up at once. |
| `checkBackupSanity` | The backup guard: compares a new backup with the previous one. |
| `notifyRun`, `sendWebhook`, `pingHeartbeat` | Notifications to webhooks, Slack, Discord and heartbeat services. |

See [Running backups unattended](/guides/scheduling/).

## Point-in-time recovery

| Export | Does |
|---|---|
| `startJournal(options)` | Starts the journal writer; returns a handle with `stop()`, `status()` and `done`. |
| `journalStatus(storage)` | Recovery point, RPO, covered ranges and gaps. |
| `planPointInTimeRestore`, `replayJournal` | The two halves of `restore({ at })`, for custom flows. |
| `pruneJournal`, `listBaseBackups` | Journal retention. |

```ts
import { startJournal } from "mongoshield";

const journal = await startJournal({
  client,                                   // a connected MongoClient
  storage,                                  // the same storage as the backups
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  takeBaseBackup: (signal) => shield.backup({ consistency: "converge", signal }),
});
process.once("SIGTERM", () => void journal.stop());
await journal.done;
```

See [Point-in-time recovery](/guides/point-in-time-recovery/).

## Copying, masking and subsetting

`defineMask` and `defineSubset` give type checking to mask and subset files; pass them
to `shield.copy({ mask, subset })`. See
[Production data in staging](/guides/staging-data/).

## mongodump interop

`importMongodump(source, storage, options)` turns a `mongodump` directory or archive into
a MongoShield backup; `exportBackup(storage, backup, options)` writes a backup as a
directory or archive for `mongorestore`. See
[Working with mongodump](/guides/mongodump/).

## Keys and config

| Export | Does |
|---|---|
| `generateIdentity()` | A new age key pair (secret identity and public recipient). |
| `identityToRecipient(identity)` | The public recipient of a secret identity. |
| `parseIdentityFile(text)` | Reads an age key file. |
| `defineConfig(config)` | Type checking for `mongoshield.config.ts` ([reference](/reference/config/)). |

## Errors

Every failure is a `MongoShieldError` with a stable `code`, a message and, where
possible, a `hint`. Secrets never appear in messages.

```ts
import { isMongoShieldError } from "mongoshield";

try {
  await shield.backup();
} catch (error) {
  if (isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")) {
    // fix the storage credentials
  }
  throw error;
}
```

`ERROR_CODES` lists every code; see [Error codes](/reference/errors/).

## The format and storage adapters

`ManifestSchema`, `MANIFEST_FORMAT_VERSION` and the `Manifest` types describe the
[backup format](/specs/format/). To store backups somewhere new, implement the
`StorageAdapter` interface (`put`, `get`, `list`, `delete`, `capabilities`, …) and pass
the object as `storage`.

## Logging and telemetry

The library prints nothing. Pass a `logger` (`fromPino(pino())` adapts pino) and, for
traces and metrics, `telemetry` with `@opentelemetry/api` installed. See
[Observability](/guides/observability/).
