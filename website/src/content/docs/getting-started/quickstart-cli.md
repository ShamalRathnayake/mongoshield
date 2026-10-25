---
title: "Quickstart: CLI in 5 minutes"
description: Create a config, take an encrypted backup, verify it and restore it next to the original data.
sidebar:
  label: "Quickstart: CLI"
---

This walks through a first backup and restore against any MongoDB you can reach. It
writes backups to a local `./backups` directory; switching to S3 later is a one-line
change.

The short version:

```sh
npx mongoshield init      # writes mongoshield.config.ts and generates an encryption key
npx mongoshield backup
npx mongoshield restore latest --rename 'app.*=app_restored.*'
```

## 1. Point it at a database

```sh
export MONGODB_URI='mongodb://localhost:27017'
```

The connection string stays in the environment; it never goes in the config file.

## 2. Create a config

```sh
npx mongoshield init
```

`init` asks where to store backups, which environment variable holds the connection
string, and whether to encrypt. Choose to generate a key: it writes the **secret** key to
`./mongoshield.key` and puts only the **public** key (`age1…`) in the config, so the
machine taking backups cannot read them.

```ts
// mongoshield.config.ts (abridged)
import { defineConfig } from "mongoshield";

export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "./backups",
  compression: "zstd",
  encryption: { recipients: ["age1…"] },
  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
});
```

:::caution[Keep the secret key safe]
Without `mongoshield.key` the encrypted backups cannot be read — there is no backdoor.
Store a copy somewhere else (a password manager, a printed copy in a safe), and never
commit it.
:::

## 3. Back up

```sh
npx mongoshield backup
```

Progress is shown while it runs; at the end it prints the backup id, document count,
sizes and compression ratio. A backup only counts as complete once its manifest is
written, so an interrupted run never looks like a good backup.

## 4. Look at it

```sh
npx mongoshield list             # every backup, newest first
npx mongoshield inspect latest   # namespaces, documents, sizes, consistency
npx mongoshield verify latest    # checks every file's size and SHA-256; no key needed
```

`verify --deep --identity-file ./mongoshield.key` also decrypts and parses every
document.

## 5. Restore next to the original

```sh
npx mongoshield restore latest \
  --rename 'app.*=app_restored.*' \
  --identity-file ./mongoshield.key
```

The plan is printed first. By default, a restore never overwrites anything: it stops if
a target collection already has documents. `--rename` restores into new databases next
to the live data; `--dry-run` shows the plan and writes nothing. Replacing data needs an
explicit `--mode drop` (or `--drop`) and a confirmation.

## Next

- Store backups in the cloud: `storage: "s3://my-bucket/prod"` (see [Install](/getting-started/install/#storage-urls)).
- Run backups on a schedule: [Running backups unattended](/guides/scheduling/).
- Every command and flag: [CLI reference](/reference/cli/).
