---
"mongoshield": minor
"@mongoshield/console": minor
---

Upgrade rehearsals: prove a backup works on a newer MongoDB release before upgrading production.
`mongoshield rehearse-upgrade [backup] --target-version 8.0` (and `shield.rehearseUpgrade()`)
checks the backup against MongoDB's 4.0–8.0 compatibility notes (geoHaystack and legacy index
keys, NaN TTLs, unknown index/collection options, removed server-side JavaScript functions, the
8.0 null/undefined change, Queryable Encryption preview collections, MONGODB-CR users, the
one-major-at-a-time upgrade path, and more), restores it into a server of that version (a
`--target-uri` scratch deployment checked for its version and against the backup's source, or an
ephemeral mongod via the optional `mongodb-memory-server` package), and runs the drill checks plus
`validate`, every view and every validator there. `--analyze-only` and
`shield.checkUpgradeCompatibility()` run the analysis without a server. Rehearsals are recorded as
drills with the version they proved, shown by `inspect` and the console's Verification & drills
tab. See docs/guides/upgrade-rehearsal.md.
