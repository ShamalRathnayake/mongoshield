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

## Finding what to mask

You cannot mask a field you do not know about. `mongoshield mask suggest`
samples every collection, finds personal data by value patterns **and** field
names, and suggests a rule per field in the mask file format:

```sh
mongoshield mask suggest --from "$PROD_URI" --include 'app.*'
```

```
app.users (1,000 documents sampled)
  FIELD            FOUND                CONFIDENCE  MATCHED  EXAMPLE                  RULE                               STATUS
  email            email                      1.00     100%  xxx.xxxxx@xxxx.xxx       { fake: "email" }                  new
  ssn              national ID: us-ssn        1.00      99%  ###-##-####              "hash"                             new
  firstName        person name                0.90     100%  Xxxx                     { fake: "name" }                   new
  birthday         date of birth              0.90     100%  ####-##-##               { fake: "date-shift", days: 365 }  new
  resetToken       secret: token              0.90     100%  [secret, 43 characters]  "hash"                             new
  addresses.*.zip  postal code                0.75      98%  #####                    "redact"                           new

6 new rules; add to the `rules` of your mask file:

  "app.users": {
    email: { fake: "email" }, // email · 100% of 1,000 values · confidence 1
    …
  },
```

It is careful with production, where it usually runs: it only reads (one
`$sample` of at most `--sample` documents per collection, default 1000, at most
10 000), one collection at a time, from a secondary when there is one, with a
server-side time limit. Views and empty collections are skipped. Its output
**never contains a sampled value**: examples are shapes (letters become `x`,
digits `#`), secrets show only their length, and object keys that are data
(a document keyed by email or user id) become `*` in paths.

### What it detects

| Found | How | Suggested rule |
|---|---|---|
| email | value pattern | `{ fake: "email" }` |
| phone | E.164 (`+44 20 7946 0958`) and separated national formats; plain digits only when the field name says phone | `{ fake: "phone" }` |
| person name | field name (`firstName`, `customerName`, `name` in `users` or under `owner`), confirmed by name-like values | `{ fake: "name" }` |
| address | street patterns (`221B Baker Street`, `Hauptstraße 5`) and field names (`street`, `address.line1`) | `{ fake: "address" }` |
| postal code | US ZIP+4, UK and Canadian postcodes by value; plain codes (`94105`) only when the field name says zip/postcode | `"redact"` |
| card number | 13–19 digits passing the Luhn checksum, with a real issuer prefix | `"redact"` |
| IBAN | country length and mod-97 checksum | `"redact"` |
| IP address | IPv4 and IPv6 | `{ fake: "ip" }` |
| national ID | US SSN, UK NI number, Spanish DNI/NIE, Brazilian CPF, Sri Lankan NIC, Indian Aadhaar (Verhoeff); with an id-like field name also Canadian SIN (Luhn), Dutch BSN (11-proef) and plain digit forms | `"hash"` |
| date of birth | field name (`dob`, `birthDate`), confirmed by date values | `{ fake: "date-shift", days: 365 }` for dates, `"redact"` for strings |
| secret | JWTs, vendor API keys (Stripe, GitHub, AWS, Slack, …), password hashes (bcrypt, argon2, …); random tokens when the field name says token/secret/key | `"drop"` for passwords, `"hash"` for tokens |
| geolocation | GeoJSON geometries; `[lng, lat]` pairs and latitude/longitude numbers under location-like names | `"null"`; `{ hash: { range: [-90, 90] } }` for a latitude |
| text with PII | notes and messages that contain emails or phone numbers | `"redact"` |

When values are not the type an operation needs (a phone stored as a number),
the rule falls back to `"hash"` for numbers and `"redact"` otherwise.

Each finding has a **confidence** (0–1) and the **share** of sampled values
that matched; findings below `--min-confidence` (default 0.5) are left out.
Value evidence counts most where formats have checksums; a field name that
agrees raises the confidence and lets a smaller share count. To keep the report
worth reading, ObjectIds, UUIDs, hex digests, numbers (counters, prices),
booleans and enums (a handful of values repeated across many documents, like
`status`) never produce a finding on their own.

**Review every rule.** Detection works on samples and patterns: a rare value
outside the sample, or a format it does not know, is missed, and an unusual
harmless field can be flagged.

### Checking and updating a mask file

With `--mask`, fields that the file already masks are marked `covered`
(naming the rule, e.g. `covered by *.* → email (fake:email)`), and `kept` when a
`keep` rule leaves them alone on purpose. Only the rest are suggested. Coverage
uses the same rule selection as the copy itself, so a rule on `addresses.zip`
covers `addresses.*.zip`, and `profile: "drop"` covers `profile.email`.

`--write` adds the new rules to the `--mask` file:

| The file | `--write` |
|---|---|
| does not exist | creates it: JSON for `.json`, a `defineMask` module for `.ts`/`.mts`/`.js`/`.mjs` (secret from `MONGOSHIELD_MASK_SECRET`) |
| is a `.json` file | merges the new rules in; existing rules and keys are never changed |
| is a TypeScript/JavaScript file | **leaves it untouched** and prints the snippet to paste |

A mask module is a program: it can read `process.env`, compute keys, hold
custom functions and comments, and rewriting it could silently change what
gets masked. JSON has none of that, so it is the format to use when you want
suggestions merged automatically. New rules are keyed by the exact namespace
that was sampled, so they apply exactly where the data was found.

```sh
mongoshield mask suggest --include 'app.*' --mask ./mask.json --write
# review mask.json, then
mongoshield pull --include 'app.*' --mask ./mask.json
```

There is deliberately no `copy --mask-suggested`: masking from a fresh sample
on every copy would make the masking depend on which documents happened to be
sampled (a field could be masked one day and copied raw the next), and nobody
would have reviewed the rules. Suggest, review, commit the mask file, then copy
with it.

From code, `suggestMasks(client, options)` returns the same report (with
`rules` ready for `defineMask`), and `detectPii(documents)` runs the detectors
on documents you already have:

```ts
import { defineMask, suggestMasks } from "mongoshield";

const report = await suggestMasks(client, { include: ["app.*"], sampleSize: 500, mask: current });

// Only `new` suggestions are in report.rules; add them namespace by namespace.
const rules = { ...current.rules };
for (const [ns, fields] of Object.entries(report.rules)) rules[ns] = { ...rules[ns], ...fields };
const mask = defineMask({ ...current, rules });
```

## Writing a mask file

A mask file is TypeScript (or JavaScript) whose default export lists, per
namespace pattern, a rule per field path (a `.json` file with a `rules`
object works too, without functions or `process.env`):

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
| `"hash"` / `{ hash: { range } }` | keyed pseudonym of the same BSON type | strings and symbols (base32, length rounded up to 16/32/64), Int32/Long/Double, Decimal128, ObjectId (creation time kept), UUIDs, vectors and other binary (not encrypted binary, subtype 6) |
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

- Numbers are hashed by their exact value, as MongoDB compares them: `Int32(5)`,
  `Long(5)`, `Double(5)` and `Decimal128("5.00")` all become the same number
  (each keeping its own type). Values that only look alike stay apart:
  `Double(2^53)` and `Long(2^53 + 1)`, or `Double(0.1)` and `Decimal128("0.1")`
  (a double cannot hold one tenth exactly).
- Integer, Decimal128 and ObjectId hashing never maps two different values to the
  same value (integers, large doubles and decimal digits go through keyed
  permutations), so unique indexes on hashed ids keep building. Doubles above
  2^53 stay doubles above 2^53, and a Long that a double can hold exactly hashes to
  the same number as that Double. A fractional Decimal128 keeps its sign, its number
  of significant digits and its decimal places (`19.99` → `73.41`). `range` gives up
  the no-collision guarantee (many values, few outputs): use it for ages and
  amounts, not for ids. An Int32 whose `range` result does not fit an Int32
  becomes a Long rather than wrapping around.
- Vectors (binary subtype 9) stay valid vectors of the same element type and
  length (float32 elements in [-1, 1)), so vector search indexes still build.
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

A **time series** collection can be selected one way only: by a filter, or by
references through one field (e.g. `"app.metrics.meta.deviceId"`). Its
measurements have no unique `_id`, so a measurement both matched and referenced,
or referenced twice, would be copied twice: such a subset is refused before
anything is written, and a referenced measurement holding several values at the
followed field stops the copy. There is no measurement identity to deduplicate
by (two measurements may be identical and must both be copied).

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
- **Interrupted copies resume.** The CLI records progress in a checkpoint file,
  `.mongoshield/copy-<id>.json` in the working directory (`--checkpoint <file>`
  puts it elsewhere; from code, pass `checkpoint: "<file>"`). If a copy stops,
  run the same command again with `--resume` (`resume: true`): finished
  namespaces are skipped, and the others continue after the last `_id` known to
  be written. Large collections are read in `_id` ranges of about 256 MiB, like a
  backup's parts, in parallel. Masking is keyed by the secret alone and the first
  run's subset filters are reused (a filter computed from the clock still selects
  the same slice), so the result is exactly what one uninterrupted copy gives.
  The mask rules and secret, follow rules, patterns, renames and mode must not
  change, and the targets must not have been dropped meanwhile; otherwise the
  resume is refused. Collections without an `_id` index (time series, clustered)
  cannot continue mid-way: an unfinished one is emptied and copied again. The
  file is **local on purpose**: it holds source `_id`s (part boundaries and
  progress), which a masked or subset copy must not put into the target. It is
  written with owner-only permissions and deleted when the copy completes.
- **Atlas Search and Vector Search indexes** are copied like restore recreates
  them: after the regular indexes, building in the background on Atlas. A target
  without Atlas Search gets a warning and the result lists the indexes in
  `searchIndexes.notCreated`. `--skip-search-indexes` skips them.
- **Indexes are built after the data**, one bulk build per collection. If
  masking makes values collide on a uniquely indexed field (e.g. `fake: name`
  on a unique field, or `hash` with a `range`), that index build fails and the
  error says which one.
- **Views are copied last**, as definitions; their `viewOn` follows renames
  within the same database. They read the (masked) copied data.
- **Indexes on masked fields stay valid**, but query plans can change if the
  value distribution changes a lot (`redact` makes every value equal).
