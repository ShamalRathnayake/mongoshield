# Recovery recipes

Most incidents are not "the cluster is gone". They are "one customer's data is wrong",
"who changed this document?", or "what did last night's import touch?". These recipes
answer them from your backups, without restoring a whole deployment.

| Question | Tool |
|---|---|
| Put back a few documents | [`find --restore`](#single-document-restore) |
| Put back one tenant, in every collection | [`restore-tenant`](#restore-one-tenant) |
| How did this document look over time? | [`history`](#document-history) |
| What changed between two backups, or since the last one? | [`diff`](#diff) |
| Give me this collection as JSON Lines or CSV | [`export --format jsonl\|csv`](#exporting-as-json-lines-or-csv) |

All of them read backups in-process: filters are evaluated by MongoShield, not by the
server. Backups taken with consistency `converge` are read as they were at the end of the
backup: the changes recorded while the backup ran are applied to the dumped documents
first, exactly as a full restore would replay them. The supported operators are equality, `$eq $ne $gt $gte $lt $lte $in $nin
$exists $type $regex $and $or $nor $not $elemMatch $size`; anything else fails with
`MS_CONFIG_INVALID` instead of matching the wrong documents. Regexes accept the options
`i m s u x` (and `(?i)`-style options at the start of the pattern); they run on
JavaScript's engine, so PCRE-only syntax such as possessive quantifiers or atomic groups
is not supported, and `l` is rejected. Strings always compare with the simple (binary)
collation. Filters and ids on the
command line are [Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/):
`'{"_id":{"$oid":"6523f1c2a1b2c3d4e5f60718"}}'`, `'{"createdAt":{"$gte":{"$date":"2026-10-01T00:00:00Z"}}}'`.

Every command takes `--from <storage>` (default: your config), and `--identity-file` or
`--passphrase-env` for encrypted backups.

## Single-document restore

Someone deleted a user an hour ago:

```bash
mongoshield find app.users '{"email":"ada@example.com"}'              # look first
mongoshield find app.users '{"email":"ada@example.com"}' --restore     # then put it back
```

The default mode, `insert`, only writes documents whose `_id` is missing, so nothing that
exists is overwritten. `--mode upsert` replaces existing documents with the backed-up
version (and asks first). `--dry-run` shows the counts and writes nothing.

```ts
await shield.restoreDocuments({
  backup: "latest",
  namespace: "app.users",
  filter: { email: "ada@example.com" },
});
```

## Restore one tenant

In a multi-tenant database every collection carries a tenant field. `restore-tenant`
restores only the documents of one tenant, in every selected collection, and never touches
the others.

```bash
# Always look first: per collection, what would be deleted, inserted, replaced, skipped.
mongoshield restore-tenant --filter '{"tenantId":"acme"}' --include 'app.*' --dry-run

# Put acme back exactly as it was in that backup.
mongoshield restore-tenant 2026-10-20T03-00-04Z_7f3a9c \
  --filter '{"tenantId":"acme"}' --include 'app.*' --mode replace-tenant
```

| Mode | What happens to the tenant's current documents |
|---|---|
| `insert` (default) | kept; backed-up documents whose `_id` is missing are added |
| `upsert` | replaced by their backed-up version; missing ones added; newer ones kept |
| `replace-tenant` | **all deleted first**, then the backed-up ones inserted: the tenant ends up exactly as backed up, and documents created since are gone |

Safety rails:

- The dry run is always printed first. `replace-tenant`, and `upsert` when it would
  replace documents, ask for confirmation; in scripts pass `--yes`.
- An empty filter (`{}`) is refused: it would select every tenant.
- Views are skipped, and so are time series collections (they have no unique `_id` to
  restore by; restore them whole with `restore`).
- `replace-tenant` is not a transaction. If it fails half-way (a damaged backup file, a
  lost connection), run the same command again: it deletes and inserts the same
  documents, so it is safe to repeat.

When collections name the tenant differently, give per-collection filters. They override
`--filter`; without `--filter`, only the listed collections are restored:

```bash
mongoshield restore-tenant --filter '{"tenantId":"acme"}' \
  --filter-for 'app.invoices={"customer.tenant":"acme"}'
```

To check before touching production, restore into a sandbox database with
`--rename 'app.*=acme_check.*'` (missing collections are created with the backed-up
options and indexes), then compare.

```ts
const result = await shield.restoreTenant({
  backup: "latest",
  tenantFilter: { tenantId: "acme" },
  include: ["app.*"],
  mode: "replace-tenant",
  dryRun: true, // look at result.namespaces first
});
```

## Document history

```bash
mongoshield history app.users '{"$oid":"6523f1c2a1b2c3d4e5f60718"}'
```

```
2026-10-21 09:14:02Z  update (journal, 1792574042:3)
    ~ plan: "pro"
2026-10-21 03:00:04Z  backup 2026-10-21T03-00-04Z_7f3a9c  present
    ~ address.city: "Oslo" → "Bergen"
2026-10-20 03:00:02Z  backup 2026-10-20T03-00-02Z_1b2c3d  present
    (first known version)
```

`history` looks the document up by `_id` in the newest backups that hold its collection
(10 by default; `--backups 25` or `--backups all`), and, if you run the
[change journal](point-in-time-recovery.md), adds every journaled change to it in
between, including the changes since the latest backup. Each version shows what changed
since the version before it. `--skip-journal` leaves the journal out; `--json` prints
everything as canonical Extended JSON.

Notes:

- `_id`s compare like a query: `42` finds an `_id` stored as Int32, Long or Double 42.
  Strings need JSON quotes: `'"ada"'`.
- For split collections only the part whose `_id` range can hold the id is read; for
  others the backup's collection is scanned until the document is found.
- `update` events show the changed fields; the next full version (a backup, an insert or
  a replace) is diffed against the last full one.
- Backups taken with consistency `converge` show the document as it was at the end of
  the backup (the changes recorded while it ran are applied).

```ts
const history = await shield.history({ namespace: "app.users", id: new ObjectId("…") });
```

## Diff

```bash
mongoshield diff 2026-10-20T03-00-04Z_7f3a9c                  # that backup → the latest
mongoshield diff 2026-10-20T03-00-04Z_7f3a9c 2026-10-21T03-00-02Z_1b2c3d
mongoshield diff latest --live "$MONGODB_URI" --details       # the latest backup → now
```

For every collection, `diff` reports documents added, removed and changed (matched by
`_id`, compared by their exact BSON bytes), plus index and collection-option differences
(validators, collation, TTL, …). `--details` adds up to 10 example `_id`s per category
(`--examples 50` for more) and the names of the indexes and options that differ.
Against a live deployment, only the databases the backup holds are compared unless you
pass `--include`.

How it scales: each document is reduced to its `_id` and a SHA-256 of its bytes. Up to
250,000 documents per collection are compared in memory; larger collections are spilled
to temporary files bucketed by `_id` hash and compared bucket by bucket, so memory stays
bounded whatever the size, and each side is read exactly once.

Things to know: the live side is read without a snapshot, so a database being written to
gives an approximate answer; a changed field order counts as a change; time series
collections (whose `_id`s need not be unique) are compared approximately.

Previewing a restore from code: `shield.diff()` also takes `rename` (the restore's
rename rules: each backed-up namespace is compared with the namespace it would be
restored into, and nothing else on the live side) and, against a live deployment,
`sample: { above, size }` (namespaces with more than `above` documents are compared by
their first `size` backed-up documents, default 1,000, looked up by `_id`; the counts
are then estimates and the namespace carries `sampled`). The console's restore preview
is built on both.

```ts
const preview = await shield.diff({
  from: "latest",
  to: { live: client },
  rename: { "app.*": "app_restored.*" },
  sample: { above: 100_000 },
});
```

## Exporting as JSON Lines or CSV

```bash
# One Extended JSON document per line, readable by mongoimport and most data tools.
mongoshield export --format jsonl --namespace app.users --output users.jsonl

# Every BSON type kept ({"$numberLong": …}), for a lossless round-trip.
mongoshield export --format jsonl --ejson canonical --namespace app.users --output users.jsonl

# A spreadsheet: chosen columns, dotted paths, only active users, to stdout.
mongoshield export latest --format csv --namespace app.users \
  --fields _id,name,address.city,items.0.sku --filter '{"active":true}' --output - > users.csv
```

CSV follows RFC 4180: cells with commas, quotes, line breaks or leading/trailing spaces
are quoted and inner quotes doubled. Strings, numbers and booleans are written plainly,
dates as ISO 8601, ObjectIds as hex, missing values and `null` as empty cells, and
anything else (embedded documents, arrays, binary) as Extended JSON. Exports never
overwrite an existing file. (Cells are not escaped against spreadsheet formulas; treat
exports of untrusted data with the usual care.)

For `mongorestore`, use the mongodump formats instead (`--format directory` or `archive`,
see [mongodump interop](mongodump.md)).

```ts
await shield.exportDocuments({
  backup: "latest",
  namespace: "app.users",
  format: "csv",
  fields: ["_id", "name", "address.city"],
  output: "users.csv",
});
```
