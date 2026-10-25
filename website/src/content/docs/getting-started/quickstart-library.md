---
title: Library quickstart
description: Back up, verify, restore and prune from TypeScript with the MongoShield class.
---

Everything the CLI does is available from code. The CLI is a thin layer over the same
`MongoShield` class.

```sh
npm install mongoshield mongodb
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage   # only for S3-compatible storage
```

```ts
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI! }, // or { client } to reuse your app's MongoClient
  storage: s3Storage({ bucket: "acme-backups", prefix: "prod/" }),
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY!] }, // this machine can't decrypt
});

// Back up everything except sessions.
const backup = await shield.backup({
  exclude: ["*.sessions"],
  labels: { trigger: "nightly" },
  signal: AbortSignal.timeout(14 * 60_000),
});
console.log(backup.id, backup.manifest.totals);

// Check it: sizes and SHA-256 of every file, no key needed.
const report = await shield.verify({ backup: backup.id, mode: "fast" });
if (!report.ok) console.error(report.problems);

// Restore it next to the original data.
await shield.restore({
  backup: "latest",
  rename: { "app.*": "app_restored.*" },
  decryption: { identities: [process.env.BACKUP_SECRET_KEY!] },
});

// Keep 7 daily, 4 weekly and 12 monthly backups.
await shield.prune({ daily: 7, weekly: 4, monthly: 12 });

await shield.close();
```

## Things worth knowing

- **Errors** are always a `MongoShieldError` with a stable `code` (for example
  `MS_STORAGE_FORBIDDEN`); check with `isMongoShieldError(error, code)`. See
  [Error codes](/reference/errors/).
- **Cancellation:** every long operation takes an `AbortSignal`. An aborted backup never
  writes a manifest, so it is never mistaken for a complete one.
- **No console output:** the library logs nothing unless you pass a `logger` (pino
  works through `fromPino`).
- **Memory stays flat:** everything streams, whatever the size of the database.
- **Storage adapters** live in their own entry points (`mongoshield/storage/file`,
  `/s3`, `/gcs`, `/azure`, `/sftp`, `/memory`), so cloud SDKs load only when used.

## Next

- An overview of every export: [Library API](/reference/library/).
- Running backups from a function or worker: [Running backups unattended](/guides/scheduling/#from-code-lambda-vercel-your-own-worker).
