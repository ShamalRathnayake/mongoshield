# Upgrade rehearsal

Major MongoDB upgrades remove features and change behaviour: 5.0 dropped geoHaystack
indexes, 6.0 removed JavaScript functions your views may call, 8.0 stopped matching
`undefined` when you query for `null`. Most teams find out in production. An **upgrade
rehearsal** finds out first: it checks a backup against MongoDB's compatibility notes,
restores it into a server of the new version, and proves the data works there.

```bash
mongoshield rehearse-upgrade --target-version 8.0.13
```

```
Compatibility MongoDB 7.0.32 → 8.0.13, in-place path: 7.0.32 → 8.0 (20 rules checked)
  ▲ warning  app.users: the validator compares "deletedAt" with null: from 8.0 on that no longer
             matches fields holding the deprecated undefined type, so updates to such documents
             fail validation. The live rehearsal counts how many documents hold undefined there.
             null-matches-undefined, MongoDB 8.0: https://www.mongodb.com/docs/manual/release-notes/8.0-compatibility/

Restore into MongoDB 8.0.13 (an ephemeral server): 1,204,311 documents in 3 min 12 s
NAMESPACE     TYPE        DOCUMENTS          INDEXES  SAMPLED  RESULT
app.users     collection  1,204,311/1,204,311    4/4      100  ok
NAMESPACE     CHECK       RESULT  DETAIL
app.users     validate    passed  validate passed (1204311 records, 4 indexes)
app.users     validator   passed  every document satisfies the validator
app.users     undefined   passed  no document holds undefined in "deletedAt"
✔ Rehearsal passed: backup 2026-11-14T03-00-04Z_7f3a9c from MongoDB 7.0.32 works on 8.0.13.
```

## What it does

1. **Analysis.** The backup's metadata (collection options, indexes, validators, view
   pipelines), its users and roles (if it has them) and stored JavaScript (`system.js`)
   are checked against the rules below. No server is needed for this part.
2. **Restore.** The backup is restored into temporary databases on a server running the
   target version: a scratch deployment you give with `--target-uri`, or an **ephemeral
   mongod** started for the rehearsal and deleted afterwards.
3. **Checks.** Everything a restore drill (`mongoshield drill`) checks (document counts, every
   index, views, 100 random documents per collection compared byte for byte, your own
   `--assertions`), plus what only the new server can tell:
   - `validate` on every collection and time series,
   - every view queried (a removed operator or a JavaScript error only shows up when a view
     runs, not when it is created),
   - every validator evaluated against the restored documents,
   - when the upgrade crosses 8.0: how many documents hold `undefined` in a field a
     validator compares with `null`.
4. **Record.** The result is stored next to the backup as a drill with the version it
   proved: `mongoshield inspect` and the console's *Verification & drills* tab show it.

Exit code 0 means the rehearsal passed, 33 means it found problems, so CI can gate an
upgrade on it.

## Where the new server comes from

**An ephemeral server** (the default) needs the optional
[`mongodb-memory-server`](https://github.com/typegoose/mongodb-memory-server) package. It
downloads the exact version once (cached in `~/.cache/mongodb-binaries`), runs it as a
single-node replica set on a temporary directory, and deletes it afterwards:

```bash
npm install --save-dev mongodb-memory-server
mongoshield rehearse-upgrade --target-version 8.0.13
```

A download needs the full version (`8.0.13`, not `8.0`). To run a binary you already have,
pass `--mongod-binary /path/to/mongod` (then `--target-version 8.0` is enough).
`MONGOMS_SYSTEM_BINARY`, if set, takes precedence (that is how mongodb-memory-server works):
the rehearsal checks the server's version and refuses one that does not match.

**Your own scratch deployment** is closer to production (same topology, storage engine,
settings, data size on real disks) and gives a realistic RTO:

```bash
mongoshield rehearse-upgrade latest --target-version 8.0 --target-uri "$STAGING_80_URI"
```

The target must run the target version (`8.0` accepts any 8.0 patch, `8.0.13` only that
one), and it must not be the deployment the backup was taken from: the same guard as
drills refuses it (by deployment id and collection UUIDs). Only temporary databases
(`msdrill_<run>_<db>`) are written, and they are dropped afterwards (`--keep` keeps them).

## Only the analysis

```bash
mongoshield rehearse-upgrade --target-version 8.0 --analyze-only --json
```

Reads only the backup's metadata, so it runs anywhere storage is reachable, in seconds.
Use it in CI for every backup, and the full rehearsal before the upgrade itself.

## From code

```ts
import { MongoShield } from "mongoshield";

const shield = new MongoShield({ storage: process.env.BACKUP_URL });

// Analysis only: no database.
const analysis = await shield.checkUpgradeCompatibility({ backup: "latest", targetVersion: "8.0" });

// The full rehearsal, on an ephemeral 8.0.13 (or pass `target: { uri }`).
const report = await shield.rehearseUpgrade({ backup: "latest", targetVersion: "8.0.13" });
if (!report.ok) {
  for (const problem of report.problems) console.error(`${problem.subject}: ${problem.problem}`);
}
```

`report.compatibility.findings` lists every finding with its rule id, severity, the
release that made the change and a link to where MongoDB documents it; `report.checks`
lists every live check, passed ones included; `report.drill` is the drill report.

## The rules

**Problems** fail on the target (the restore or an in-place upgrade refuses it, documents
expire, writes are blocked). **Warnings** work, but differently, or only under conditions a
backup cannot show; review them. *Target* rules apply whenever the target is that release
or newer; *crossing* rules only when the upgrade crosses it (a behaviour change that
already happened on your source is not news).

| Rule | Since | Kind | Severity | What it finds |
|---|---|---|---|---|
| `index-geohaystack` | 5.0 | target | problem | geoHaystack indexes, removed in 5.0 (setting FCV 5.0 deletes them) |
| `index-ttl-nan` | 5.0 | target | problem | TTL indexes with `expireAfterSeconds: NaN`, treated as 0: documents expire at once |
| `index-weights-without-text` | 5.0 | target | problem | `weights` on an index that is not a text index |
| `index-invalid-key` | 3.4 | target | problem | legacy key values (`0`, `""`, `true`, unknown types) current servers refuse |
| `index-unknown-option` | 3.4 | target | problem | index options `createIndexes` does not accept (`safe`, …) |
| `index-version-legacy` | 3.4 | target | warning | v0/v1 indexes: an in-place upgrade keeps the old format, the restore rebuilt them as v2 |
| `collection-unknown-option` | 5.0 | target | problem | collection options `create` rejects since 5.0 (MMAPv1 leftovers such as `usePowerOf2Sizes`) |
| `collection-no-id-index` | 4.0 | target | warning | collections created with `autoIndexId: false`, which get an `_id` index |
| `encryption-preview` | 7.0 | crossing | problem | Queryable Encryption collections from the 6.x preview, incompatible with 7.0 GA |
| `encryption-range-preview` | 8.0 | target | problem | encrypted fields using `rangePreview`, removed in 8.0 |
| `view-pipeline-too-long` | 5.0 | target | problem | views with more than 1000 pipeline stages |
| `view-on-buckets` | 6.1 | target | warning | views on `system.buckets.*` collections, no longer permitted |
| `regex-invalid-options` | 5.1 | target | problem | regex options other than `imxsu` in validators (block all writes) and views |
| `javascript-removed-functions` | 6.0 | target | problem | `Array.concat(…)`, `String.trim(…)` and the other static functions MozJS-91 removed, in views |
| `javascript-stored-removed-functions` | 6.0 | target | warning | the same in stored functions (`system.js`) |
| `javascript-deprecated` | 8.0 | target | warning | `$function`, `$accumulator`, `$where`: deprecated in 8.0 |
| `rank-null-missing` | 8.0 | crossing | warning | `$rank` / `$denseRank` in views: null and missing now rank the same |
| `add-floating-point` | 6.1 | crossing | warning | `$add` in views and validators: no more floating-point rounding correction |
| `null-matches-undefined` | 8.0 | crossing | warning | validators and views comparing with `null` (and `$lookup` joins): `undefined` no longer matches |
| `user-mongodb-cr` | 4.0 | target | problem | users with only MONGODB-CR credentials, which cannot log in |
| `user-scram-sha1-only` | 5.1 | target | warning | users with only SCRAM-SHA-1, which FIPS mode disables by default |
| `role-ldap-mapping` | 8.0 | target | warning | roles named like LDAP groups: LDAP is deprecated in 8.0 |

And about the versions themselves: a target **older** than the source is a problem (a
downgrade, not covered); the same release is a warning (a patch upgrade at most); a jump of
more than one major is a warning that lists every step an **in-place** upgrade must take
(`6.0 → 7.0 → 8.0`, setting the feature compatibility version after each), because a
rehearsal restores straight into the target and so does not test the steps in between.
Targets newer than 8.x get a warning that their own notes were not checked.

Sources: MongoDB's "Compatibility Changes" pages for
[4.0](https://github.com/mongodb/docs/blob/v4.0/source/release-notes/4.0-compatibility.txt),
[5.0](https://github.com/mongodb/docs/blob/v5.0/source/release-notes/5.0-compatibility.txt),
[6.0](https://github.com/mongodb/docs/blob/v6.0/source/release-notes/6.0-compatibility.txt),
[7.0](https://www.mongodb.com/docs/manual/release-notes/7.0-compatibility/) and
[8.0](https://www.mongodb.com/docs/manual/release-notes/8.0-compatibility/), the
[8.0 upgrade procedure](https://www.mongodb.com/docs/manual/release-notes/8.0-upgrade-replica-set/),
and, for index and collection options, the server's own validation code
([index_key_validate.h](https://github.com/mongodb/mongo/blob/r8.0.13/src/mongo/db/catalog/index_key_validate.h),
[create.idl](https://github.com/mongodb/mongo/blob/r8.0.13/src/mongo/db/commands/create.idl)).

## What a rehearsal does not prove

- **Your application.** Driver versions, query shapes and performance on the new release
  are not tested: the rehearsal proves the *data* and its definitions work.
- **The in-place steps.** A logical restore into 8.0 skips 6.0 → 7.0 → 8.0 binary swaps
  and FCV changes. Follow MongoDB's upgrade procedure for each step.
- **Changes the backup cannot show.** Server parameters, configuration files, sharding
  settings (shard keys are not in backups), LDAP or X.509 setup, query behaviour of code
  outside views and validators.
- **Users and roles** are analysed but not restored (drills never restore them).
