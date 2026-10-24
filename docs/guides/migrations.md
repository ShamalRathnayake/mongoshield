# Snapshots before migrations

A schema migration that goes wrong halfway is one of the most common ways to damage a
production database: a `$set` with the wrong filter, a dropped collection, a backfill
that writes garbage. The fix is cheap if you planned for it: take a snapshot right
before migrating, and roll back to it if the migration fails.

```sh
mongoshield snapshot v42-add-orders-index --include 'app.*'
npx migrate-mongo up              # or your migration tool
# … it went wrong:
mongoshield rollback v42-add-orders-index
```

## What a snapshot is

A snapshot is an ordinary MongoShield backup with the label
`mongoshield.snapshot=<label>`, taken with consistency `auto` (a single point in time on
replica sets and sharded clusters, see [CONSISTENCY.md](../specs/CONSISTENCY.md)). It uses
your configured storage, compression and encryption, shows up in `mongoshield list`, and
is pruned by your retention policy like any other backup. Put a hold on it if you want to
keep it longer (`mongoshield hold <id> --reason "before v42"`).

Labels are up to 128 letters, digits and `. _ - : + @`. Taking a snapshot with a label
that already exists is fine: rollback always uses the newest one.

## What a rollback does

`mongoshield rollback <label>`:

1. finds the newest complete snapshot with that label (or `--id <backup-id>`);
2. shows the plan: each collection of the snapshot, its documents in the snapshot and
   in the live database, and what will happen to it;
3. asks for confirmation (`--yes` in scripts; without a terminal and without `--yes` it
   refuses with exit code 3);
4. takes a **safety snapshot** labelled `pre-rollback-<label>` of the live collections it
   is about to replace (skip it with `--no-safety-snapshot`), so the rollback itself can
   be undone with `mongoshield rollback pre-rollback-<label>`;
5. restores the snapshot over the live data in `drop` mode: each collection is dropped
   and recreated with its documents, options and indexes exactly as snapshotted;
6. re-applies the [GDPR erasure ledger](gdpr-erasure.md), so nobody erased since the
   snapshot comes back (`--skip-erasures` to opt out).

Collections the migration **created** are not in the snapshot and are left alone; drop
them yourself if needed. Use `--include` to roll back only some collections, and
`--dry-run` to see the plan without writing anything.

A rollback replaces data: writes your application made after the snapshot, to the
collections being rolled back, are lost (they are in the safety snapshot). Stop writers,
or put the application in maintenance mode, for the migration window.

## From code

```ts
import { MongoShield, rollback, snapshot } from "mongoshield";

const shield = new MongoShield({ source: { uri: process.env.MONGODB_URI }, storage });

await snapshot(shield, { label: "v42", include: ["app.*"] });
try {
  await migrate();
} catch (error) {
  const result = await rollback(shield, { label: "v42" });
  console.error(`Rolled back to ${result.snapshotId}; safety snapshot ${result.safetySnapshotId}`);
  throw error;
}
```

`rollback(shield, options)` takes `label` or `backupId`, `include`/`exclude`, `mode`
(default `"drop"`), `dryRun`, `decryption` (for encrypted snapshots), `safetySnapshot`
(default `true`) and `skipErasures`.

## Recipes

### migrate-mongo

Wrap `up` in a script, so a failed migration rolls back automatically:

```sh
#!/usr/bin/env bash
set -euo pipefail
label="migrate-$(date -u +%Y%m%dT%H%M%SZ)"
mongoshield snapshot "$label" --include 'app.*' --quiet
if ! npx migrate-mongo up; then
  echo "Migration failed; rolling back to $label" >&2
  mongoshield rollback "$label" --yes
  exit 1
fi
```

migrate-mongo records applied migrations in its `changelog` collection. If that
collection is in the snapshot (it is with `app.*`), the rollback also restores the
changelog, so `migrate-mongo status` shows the failed migration as pending again.

### Mongoose (and other in-app migration runners)

Migration runners that live in the application, such as `ts-migrate-mongoose` or a
hand-written `migrations` collection, run with the application's own connection. Take
the snapshot from the same process before the runner starts:

```ts
import mongoose from "mongoose";
import { MongoShield, rollback, snapshot } from "mongoshield";

await mongoose.connect(process.env.MONGODB_URI!);
const shield = new MongoShield({
  // Reuse the driver client Mongoose already opened.
  source: { client: mongoose.connection.getClient() },
  storage,
});
const label = `release-${process.env.GIT_SHA}`;
await snapshot(shield, { label, include: ["app.*"] });
try {
  await runMigrations(); // your Mongoose migration runner
} catch (error) {
  await rollback(shield, { label });
  throw error;
}
```

MongoShield never closes a client it did not create, so the Mongoose connection stays
open.

### CI / CD pipelines

Snapshot as its own pipeline step, so a failed deploy can roll back from a later, manual
step:

```yaml
# GitHub Actions
- name: Snapshot before migrating
  run: npx mongoshield snapshot "deploy-${{ github.run_id }}" --include 'app.*'
- name: Migrate
  run: npx migrate-mongo up
- name: Roll back on failure
  if: failure()
  run: npx mongoshield rollback "deploy-${{ github.run_id }}" --yes
```

The CI job needs the same configuration as your backups (storage, `MONGODB_URI`) and, for
encrypted snapshots, the decryption key in the rollback step only (`--identity-file`, or
`decryption.identityFiles` in the config): the snapshot step needs only the public
recipient.
