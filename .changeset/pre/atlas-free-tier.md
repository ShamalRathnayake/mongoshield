---
"mongoshield": minor
---

Atlas Free tier backups: first-class support for MongoDB Atlas Free (M0), Flex and legacy
shared M2/M5 clusters.

- When it connects, MongoShield recognises Atlas by its `*.mongodb.net` host names, and
  recognises a Free/Flex cluster because the cluster refuses a read-only `getParameter`
  probe with error code 8000 (`AtlasError`). On those tiers it adapts by itself:
  - Backups default to `parallelism: 2` and at most 4 MiB/s of reads. Restores into the
    tier use 2 collections at a time with 1 insert worker each. Explicit settings win.
  - Converge change streams use regex-only `ns.db` filters, the only kind the tier
    accepts.
  - If the tier refuses change streams, `auto` falls back to `none` with a warning that
    names Atlas.
  - Refused search index listings are reported once.
  - Other tier refusals become `MS_UNSUPPORTED_TOPOLOGY` with a hint.
- Users and roles: `includeUsersAndRoles` is refused on Free/Flex, which allow no reads
  of users. `usersAndRoles: "create" | "replace"` restores into any Atlas cluster are
  refused before anything is written, because Atlas manages users only through its API.
  Both errors point to the Atlas CLI instead.
- New config option `preset: "atlas-free" | "atlas-flex"`. A preset fills in its
  defaults (compression, read pace, retention) under every other config layer. The
  presets are exported as `CONFIG_PRESETS` / `CONFIG_PRESET_NAMES`, and `isAtlasHost` /
  `isAtlasRefusal` are exported too.
- New `mongoshield init --preset atlas-free|atlas-flex`, which writes a config ready for
  those clusters and prints the Atlas setup steps.
- New guide: docs/guides/atlas-free-tier.md.
- New GitHub Actions templates: a nightly backup to S3/R2, and one kept as a GitHub
  artifact. Both are linted with actionlint in CI.
