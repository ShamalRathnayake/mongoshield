# Production data in staging and on laptops, safely

Bugs that only happen "with real data" are real. Copying production into
staging or onto a developer's machine, as is, also copies every email address,
phone number and payment detail to places that were never meant to hold them.
MongoShield copies databases straight from one deployment into another, and on
the way it can **mask** documents (realistic, deterministic fakes, so the app
still works) and **subset** them (a recent slice that still hangs together).

```
source ── find (secondaryPreferred) ──► note references ──► mask ──► target
                                                                     (indexes after data, views last)
```

Nothing is written to disk or backup storage in between.

## Two commands

| | `mongoshield copy` | `mongoshield pull` |
|---|---|---|
| For | refreshing staging, cloning a database under a new name | a local development copy |
| Target | `--to` (required) | `--to`, default `mongodb://localhost:27017`; must be on this machine unless `--allow-remote-target` |
| Masking | optional `--mask` | **required**: `--mask`, or `--no-mask --yes` to copy raw data deliberately |

Both share every other option, and both behave like `restore`:

- the plan is printed first (source → target, documents, how each namespace is
  selected and masked, what happens to existing data);
- by default nothing is overwritten: a target collection that holds documents
  stops the copy. `--drop` replaces targets, `--mode insert` adds to them,
  `--mode upsert` replaces documents by `_id`; these ask for confirmation
  (`--yes` in scripts);
- `--dry-run` checks everything (namespaces, conflicts, privileges, the mask
  and subset files) and writes nothing;
- `--rename 'app.*=app_staging.*'` copies under another name. Copying a
  namespace onto itself on the same cluster is always refused.

```sh
# Refresh staging from production, masked, replacing yesterday's copy.
mongoshield copy --from "$PROD_URI" --to "$STAGING_URI" \
  --include 'app.*' --mask ./mask.ts --drop --yes

# A masked, recent slice of production on your laptop.
mongoshield pull --from "$PROD_URI" --include 'app.*' \
  --mask ./mask.ts --subset ./subset.ts
```

From code, `shield.copy()` takes the same options:

```ts
import { defineMask, MongoShield } from "mongoshield";

await shield.copy({
  to: { uri: process.env.STAGING_URI },
  include: ["app.*"],
  mask: defineMask({ secret: process.env.MASK_SECRET, rules: { "app.users": { email: { fake: "email" } } } }),
  mode: "drop",
});
```

Reads use the `secondaryPreferred` read preference by default (`readPreference`
in the API), so a copy of a replica set loads a secondary, not the primary.

## Writing a mask file

A mask file is TypeScript (or JavaScript) whose default export lists, per
namespace pattern, a rule per field path:

```ts
// mask.ts
import { defineMask } from "mongoshield";

export default defineMask({
  // At least 16 characters. Keep it out of the file and out of git.
  secret: process.env.MASK_SECRET,

  rules: {
    "app.users": {
      _id: "hash",                         // keyed pseudonym of the same type
      email: { fake: "email" },            // ada.costa.k3x9q2mw@example.com
      name: { fake: "name" },              // "Mei Okafor"
      phone: { fake: "phone" },            // digits replaced, format kept
      "addresses.*.street": { fake: "address" },
      lastLoginIp: { fake: "ip" },         // 10.x.y.z / 2001:db8:…
      birthday: { fake: "date-shift", days: 90 },
      age: { hash: { range: [18, 90] } },
      notes: "redact",                     // "[redacted]"
      bio: { redact: "lorem ipsum" },
      ssn: "null",
      passwordHash: "drop",                // the field is removed
      // Custom: any function (value, context) => newValue. Return undefined to remove.
      plan: (value) => (value === "enterprise" ? "pro" : value),
      handle: (value, { hash }) => `user_${String(hash(value)).slice(0, 8)}`,
    },
    "app.orders": {
      userId: "hash",                      // same as users._id → joins still work
      "shipping.address": { fake: "address" },
    },
    // Patterns work like --include. An exact namespace wins over a pattern
    // for the same path, so this masks every `email` except the admins'.
    "*.*": { email: { fake: "email" } },
    "app.admins": { email: "keep" },
  },
});
```

The secret comes from `secret` in the file, or else from the environment
variable `MONGOSHIELD_MASK_SECRET` (another one with `--mask-secret-env VAR`).
Generate one with `openssl rand -base64 32`. MongoShield never prints it.

### Field paths

| Path | Selects |
|---|---|
| `email` | a top-level field |
| `profile.phone` | a field of an embedded document |
| `addresses.*.street` | `street` in every element of `addresses` (`*` also means "every key" in a sub-document) |
| `addresses.0.street` | `street` of the first element only |
| `addresses.street` | arrays on the way are traversed implicitly, like MongoDB queries do |

Documents are schemaless, so paths are only checked for syntax. After the
copy, a rule that **never matched a value** is reported as a warning: that is
almost always a typo (`emial`) or a field that moved.

### Operations

| Rule | Does | Types |
|---|---|---|
| `"hash"` / `{ hash: { range } }` | keyed pseudonym of the same BSON type | strings (base32, length rounded up to 16/32/64), Int32/Long/Double, ObjectId (creation time kept), UUIDs and other binary |
| `{ fake: kind }` | realistic fake: `email`, `name`, `phone`, `address`, `ip`, `uuid`, `date-shift` (`days`, default 30) | strings; `uuid` also BSON UUIDs; `date-shift` dates |
| `"redact"` / `{ redact: "text" }` | fixed text | anything |
| `"null"` | `null` | anything |
| `"drop"` | removes the field | anything |
| `"keep"` | leaves it alone (overrides a broader pattern) | anything |
| a function | `(value, { ns, path, document, hash, fake }) => newValue` | anything |

`hash`, `fake` and `redact` work on values: inside an array they apply to each
element (`tags: "hash"` hashes every tag), and `null` stays `null`. `null`,
`drop` and functions get the whole value.

A value an operation cannot handle (`hash` on a boolean, `fake: "email"` on a
number) is **left unchanged with a warning**, once per rule and type, and
counted in the result's `mask` report. Set `onUnsupported: "null"` to replace
such values with `null`, or `"fail"` to stop the copy instead. A custom
function that throws always stops the copy: masking fails closed.

### The determinism guarantee

With the same secret, `hash` and `fake` turn equal input values into equal
outputs, **in every collection, field, document and run**. The output depends
only on the secret, the operation and the value, never on where the value is.
That is what keeps relationships intact:

```ts
"app.users":  { _id: "hash" },
"app.orders": { userId: "hash" },   // orders.userId still equals users._id
```

So: **mask both sides of a reference with the same operation.** A `$lookup`
from orders to users finds exactly the users it found before. More details:

- Numbers are hashed by value, as MongoDB compares them: `Int32(5)`, `Long(5)`
  and `Double(5)` all become the same number (each keeping its own type).
- Integer and ObjectId hashing never maps two different ids to the same id
  (integers go through a keyed permutation), so unique indexes on hashed ids
  keep building. `range` gives up that guarantee (many values, few outputs):
  use it for ages and amounts, not for ids.
- Fake emails carry a keyed 8-character tag, so distinct emails stay distinct
  and a unique index on email still builds. Names, addresses and phone numbers
  may repeat, like real ones do.
- Re-running a copy with the same secret produces the same masked data, so
  bug reports ("user `k3x9q2mw…` can't check out") stay reproducible across
  refreshes. Change the secret to get an unrelated mapping.
- Without the secret, masked values cannot be traced back (HMAC-SHA256). With
  it, anyone can test guesses ("is this the hash of ada@corp.com?"), so treat
  it like a password.

## Subsetting

A full copy of a large database is slow and often unnecessary. A subset file
picks root documents with filters and then follows references, so the slice
still hangs together:

```ts
// subset.ts
import { defineSubset } from "mongoshield";

export default defineSubset({
  filters: {
    "app.orders": { createdAt: { $gte: new Date("2026-09-01") } },
  },
  follow: [
    { from: "app.orders.userId", to: "app.users._id" },
    { from: "app.orders.items.productId", to: "app.products._id" },
    { from: "app.users.companyId", to: "app.companies._id" },
    { from: "app.users.managerId", to: "app.users._id" },    // cycles are fine
  ],
});
```

What each copied namespace gets:

| Namespace has | Copied documents |
|---|---|
| no filter, no incoming `follow` | all of them |
| a filter | those matching it |
| an incoming `follow` (a `to` side) | only those referenced by copied documents |
| both | the filtered ones plus the referenced ones (references never dangle) |

References are followed transitively: orders → users → companies, and
users → managers → their managers, until nothing new is referenced. Each
value is followed once, so cycles end. Arrays are followed element by element
(`items.productId`, `tagIds`).

Namespaces in the subset file are **source** namespaces (before `--rename`).
`"db.collection.field"` is split at the longest copied namespace; for
collection names with dots, write `{ ns: "app.events.2026", path: "userId" }`.
A filter or rule that names a namespace not being copied is an error, so a
typo cannot silently copy everything.

**How the references are kept.** The set of referenced values can be huge
(millions of user ids), and MongoShield never lets memory grow with the data.
So the values go into a temporary collection in the target database
(`__mongoshield_subset_<run>_<n>`, keyed by the value, which deduplicates for
free) and are read back in `$in` queries of `batchSize` values (default 1000)
against the source. The client holds one batch at a time; the alternative,
recomputing the sets on the source with aggregations, would load the
(usually production) source instead of the target you are writing to anyway.

These temporary collections hold **source** values of the reference fields
(unmasked: they are needed to query the source). They exist only while the
copy runs and are dropped at the end, also after a failure or Ctrl-C. If the
reference fields are themselves sensitive (an email used as a foreign key),
keep that in mind for the target you choose.

Masking and subsetting combine: references are noted from each document
**before** it is masked, then the masked document is written.

## Privileges

- Source user: what the built-in `backup` role grants (`find`,
  `listCollections`, `listIndexes`).
- Target user: what the built-in `restore` role grants; plus `update` for
  `--mode upsert`, and `find` when following references (the temporary
  collections are read back). `readWrite` on the target databases covers both.

Everything is checked before the first write, and every missing privilege is
listed at once.

## Things to know

- **A copy is not atomic.** Documents written during the copy may or may not
  be included, and different collections are read at slightly different
  times. For a point-in-time copy, restore a snapshot backup instead.
- **Not resumable yet.** If a copy is interrupted, run it again with `--drop`;
  the error lists the namespaces that were completed and those that may be
  partial.
- **Indexes are built after the data**, one bulk build per collection. If
  masking makes values collide on a uniquely indexed field (e.g. `fake: name`
  on a unique field, or `hash` with a `range`), that index build fails and the
  error says which one.
- **Views are copied last**, as definitions; their `viewOn` follows renames
  within the same database. They read the (masked) copied data.
- **Indexes on masked fields stay valid**, but query plans can change if the
  value distribution changes a lot (`redact` makes every value equal).
