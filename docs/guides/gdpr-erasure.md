# GDPR erasure and backups

Under GDPR article 17 ("right to erasure") and similar laws, you must delete a
person's data when they ask. Deleting it from the live database is easy. The hard part
is your backups: they are immutable on purpose (often object-locked), and restoring one
from before the request would bring the person's data straight back.

Regulators generally accept that backups are not rewritten, **as long as erased data is
not restored into use** and the backups expire on a documented schedule. MongoShield's
erasure ledger is how you keep that promise.

## How it works

Every erasure is recorded once, next to your backups:

```sh
mongoshield erase app.users '{"email": "ada@example.com"}' \
  --reason "GDPR request #4471" --by dpo@example.com --now
```

- the request is appended to the ledger, `erasures/<time>-<random>.json`, in your backup
  storage (never rewritten, and copied by [`mongoshield replicate`](#replicas));
- `--now` also deletes the matching documents from the live database;
- from then on, **every restore, rollback and copy deletes the matching documents
  again** after it has written its data, for as long as any backup holds them.

The namespace can be a single collection, a pattern (`'app.*'`: every collection of
`app`) or `'*'`. Patterns are matched against the namespace as it is in the backup, so
erasures also apply when you restore under another name (`--rename 'app.*=app_old.*'`).

To see the ledger: `mongoshield erasures list` (or `--json`). To apply it to a database
restored by some other tool, e.g. `mongorestore`: `mongoshield erasures apply --uri …`.

## The ledger does not keep the personal data

The filter of an erasure is usually the very data being erased (an email address).
Storing it as written would keep it forever, in a file whose purpose is to prove it is
gone. So:

| Filter | Stored as | Applied by |
|---|---|---|
| Exact match with at least one string: `{"email": "ada@example.com"}`, `{"tenant": 7, "username": "ada"}` | One HMAC-SHA-256 digest per field; the values are not stored | Scanning each restored collection, hashing those fields of every document |
| Only ids or numbers: `{"_id": {"$oid": "…"}}`, `{"userId": 1042}` | The filter as written (ids are opaque) | `deleteMany` (uses indexes) |
| Anything with query operators: `{"email": {"$in": […]}}` | The filter as written | `deleteMany` |

Prefer exact matches on an id or an email. Avoid operator filters that contain personal
data; the CLI warns when it stores one.

**Set an erasure secret.** Hashed filters are keyed with it, so someone who can read the
ledger cannot confirm a guess ("was ada@example.com erased?") by hashing it themselves:

```sh
export MONGOSHIELD_ERASURE_SECRET="$(openssl rand -base64 32)"   # keep it with your other secrets
```

or `erasures: { secret: process.env.ERASURE_SECRET }` in `mongoshield.config.ts`. Without
a secret, filters are still hashed (unreadable), but with a public key. Records say which
key they used; when the ledger holds keyed records, a restore without the secret, or with
a different one, **refuses to start** rather than restore data it then could not erase.

Hashed matching follows MongoDB's equality where it matters: numbers compare by value
whatever their type, a field holding an array matches when any element does, and dotted
paths (`contacts.email`) descend into sub-documents and arrays of them.

## From code

```ts
import { applyErasures, recordErasure } from "mongoshield";

await recordErasure(shield.storage, {
  namespace: "app.users",
  filter: { email: "ada@example.com" },
  reason: "GDPR request #4471",
  requestedBy: "dpo@example.com",
  secret: process.env.ERASURE_SECRET,
});
```

`shield.restore()`, `shield.copy()`, tenant restores and `rollback()` apply the ledger
automatically; pass `skipErasures: true` to opt out (for example for a forensic restore
into an isolated environment). `applyErasures(client, storage, { namespaces, rename,
since, secret, dryRun })` applies it by hand. The result of a restore includes
`erasures: { erasures, documentsDeleted, namespaces }`.

## Replicas

`mongoshield replicate` copies new ledger records to the destination before it copies
any backup, so a restore from an off-site copy erases the same people. Keep the ledger's
storage as durable as the backups themselves: a lost ledger means erased data could come
back from a restore.

## What to tell your auditor

- Erasures are executed on the live database at the time of the request (`--now`).
- Backups are not modified; they expire with the retention policy (state it).
- Every restore path re-applies the ledger before the data is used; restores without it
  are refused when its keys are missing, and an unreadable ledger record fails the
  restore.
- The ledger holds no personal data in readable form: exact-match filters on strings are
  stored as keyed HMAC-SHA-256 digests.
