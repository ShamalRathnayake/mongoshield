# mongoshield

## 2.0.0

### Major Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`f49712e`](https://github.com/ShamalRathnayake/mongoshield/commit/f49712ea1d356f78ab2f5f43bfdc37ae320dd888) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - First stable release. MongoShield backs up, restores and copies MongoDB from Node.js using
  only the official driver, with no `mongodump` binary:
  - Backups in the mongodump directory layout and BSON, compressed with zstd or gzip and
    optionally encrypted with age (public keys, passphrases or AWS / GCP / Azure KMS), with a
    SHA-256 checksum for every file and a manifest written last.
  - Storage on local disk, S3 and S3-compatible services, Google Cloud Storage, Azure Blob
    Storage and SFTP, including immutable (object lock) backups.
  - Restores with safe defaults: nothing is overwritten unless asked, rename on restore, dry
    runs, single-document and tenant restores, every collection type, index, validator, user
    and role.
  - Verification, restore drills, retention with holds, a scheduler with locks, retries,
    notifications and heartbeats, OpenTelemetry, and point-in-time recovery from a change
    journal.
  - Copying between deployments with deterministic PII masking and subsetting, and
    `mongoshield/testing` helpers that snapshot and reset test databases.
  - A CLI (`mongoshield`), a Docker image, a GitHub Action and a Helm chart.

### Minor Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Atlas Free tier backups: first-class support for MongoDB Atlas Free (M0), Flex and legacy
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

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Bun and Deno support: the library, the CLI and config files now run on Bun 1.4+ and
  Deno 2.9+ (`bunx --bun mongoshield`, `deno run -A npm:mongoshield`), tested in CI at the
  oldest and newest version of each. See docs/guides/bun-and-deno.md.
  - age encryption works on Bun, whose `node:crypto` has no ChaCha20-Poly1305: where the
    cipher is missing, MongoShield loads the audited `@noble/ciphers` (a new dependency,
    imported lazily) and produces the same bytes. Node.js and Deno keep using `node:crypto`
    and never load it.
  - A damaged zstd file under Deno is now reported as `MS_INTEGRITY_FAILED` instead of
    crashing the process (Deno's `node:zlib` threw the codec error outside the stream).
  - New `pnpm --filter mongoshield test:runtimes`: end-to-end smoke scenarios (backup,
    deep verify, restore, corruption, cancellation, backpressure, CLI and Ctrl-C) run
    against the built package under Node.js, Bun and Deno.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Restore preview. The console's restore wizard has a "Preview changes" step between the
  dry-run plan and the confirmation: per namespace, the documents only in the backup, only
  in the target, changed and identical, what the chosen mode would do with them, index and
  option differences, and a drill-down to one document's fields side by side (secret-looking
  values hidden). It runs as a read-only, cancellable, time-limited `preview` job
  (`POST /api/restore/preview`), samples namespaces above 100,000 documents and says so, keeps
  document lists and contents to the document browser's role, and is audited. The library's
  `diff` gains `rename` (compare each namespace with the one a restore would write) and
  `sample: { above, size }` (compare large namespaces against a live deployment by `_id`
  lookups of a sample, with estimated counts and `sampled` on the namespace).

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - - `mongoshield delete <id>` and `shield.deleteBackup(id)`: delete one backup by id. The
  manifest goes first (so no reader ever sees a half-deleted backup), then its files,
  annotations and checkpoint. Backups on hold, still write-once (`retainDays` / object
  lock) or needed by an incremental backup are refused with the new `MS_BACKUP_PROTECTED`
  (exit code 35). Asks for confirmation (`--yes` in scripts), supports `--json`, and logs
  an audit line (id, objects, bytes, who, when).
  - `retention.scopeLabels`: labels that mark a job's backups and scope its retention, so
    two jobs with the same source and selection in one storage location never prune each
    other's backups. Used by `mongoshield run`/`schedule` and by `mongoshield prune`.
  - `MONGOSHIELD_DRILL_URI`: the drill's scratch deployment from the environment, for
    `drill.targetUri` and `mongoshield drill` (instead of `--target-uri`), so it can come
    from a secret.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Incremental backups: store only what changed since the previous backup, in chains of a
  full backup followed by incrementals (docs/guides/incremental-backups.md).
  - `shield.backup({ incremental: true })` (or `{ incremental: { from: "<id>" } }`) and
    `mongoshield backup --incremental [--from <id>]` record every change after the parent
    backup's end time with a change stream, DDL included (create, drop, rename, index
    changes), into the backup's `_changes/window` file. They fail with a hint to take a full
    backup when the oplog no longer reaches back to the parent (`MS_CHANGE_HISTORY_LOST`),
    on a standalone server, or when the parent has no exact end time (consistency `none`)
    or comes from another deployment or selection.
  - Format: incrementals are manifests with `kind: "incremental"` and
    `chain: { base, parent, length }`, written as format version 2 so that a reader that
    does not know chains refuses them instead of restoring the wrong data; full backups
    stay version 1. Every manifest now records its `selection` (include/exclude patterns).
  - Restore: `restore <incremental>` restores the base full backup and replays every
    incremental up to the chosen one in order, byte for byte as the source was at its end;
    `--at` with an incremental's id stops at a point in time inside the chain, and
    `--at` alone falls back to a chain when the change journal does not cover the time.
    find, history, diff, export, tenant restores and drills read an incremental through its
    chain.
  - verify checks the whole chain (every member's files, in the same mode, and every link:
    missing, incomplete or misaligned members are reported); `--chain links` checks only
    the links. list shows the kind (`incr [#3](https://github.com/ShamalRathnayake/mongoshield/issues/3)`), inspect the parent and the base.
  - Retention never deletes a backup a kept incremental depends on, also across scopes;
    chains are shortened only at their newest end. replicate copies a chain's parents
    first, rekey rekeys the whole chain, and the backup guard skips incrementals.
  - Scheduled runs: `backup.incremental: { fullEveryDays, maxChainLength }` makes
    `mongoshield run` / `schedule` take incrementals and a full backup whenever a new chain
    is due ("full weekly, incremental hourly"), or when an incremental is impossible. Run
    reports carry `backup.kind`, `parent`, `changes` and `fullBackupReason`.
  - Console: plans get "Incremental backups between full ones" with a full-backup interval
    in days (plan field `incremental: { fullEveryDays }`, exported to and imported from
    config files); the backup list marks incrementals.
  - Nothing is lost that change events do not carry: every incremental records the
    metadata of every selected namespace (options, validators, TTL and hidden indexes,
    view definitions; `content: "metadata"` entries) and copies every time series
    collection whole in one snapshot read that it ends at (`content: "full"`). A chain
    restore takes time series and views from its newest member and applies collMod
    changes (validator, TTL, hidden indexes, …) after the data. A time series that cannot
    be read consistently fails the incremental (`MS_SNAPSHOT_TOO_OLD`), or takes a full
    backup with `fallbackToFull`.
  - Fix: manifest part ranges (`files[].range`) are written and read with the stored field
    order of embedded-document `_id`s (they were reordered by `JSON.stringify` for
    integer-like keys), and `history` compares them in that order, so it reads the right
    part. The CLI's Extended JSON arguments keep the field order they were typed in.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Masking suggestions: `mongoshield mask suggest` samples collections (read-only, bounded `$sample`,
  one collection at a time, `secondaryPreferred`) and detects personal data by value patterns and
  field names: emails, phones, person names, addresses, postal codes, card numbers (Luhn), IBANs
  (mod-97), IP addresses, national ids (US SSN, UK NI number, Spanish DNI/NIE, Brazilian CPF, Sri
  Lankan NIC, Indian Aadhaar, Canadian SIN, Dutch BSN), dates of birth, secrets (JWTs, API keys,
  password hashes, tokens), geolocation and free text containing emails or phones. It prints one
  suggested mask rule per field, ordered by confidence, with masked examples only; `--mask` marks
  fields the mask file already covers, `--write` merges new rules into a JSON mask file or creates
  a new one (existing TypeScript/JavaScript mask files are never rewritten; the snippet is printed),
  `--json` prints the report. From code: `suggestMasks(client, options)` and `detectPii(documents)`.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Scoped retention: pruning one source or selection never deletes another's backups in a shared
  storage location. `shield.prune(policy, { scope })` takes `{ clusterId?, labels? }` and reports
  `outOfScope`; scheduled runs and `mongoshield prune` scope by the source's cluster and the
  `mongoshield.shape` label (which `mongoshield backup` now writes too); `mongoshield prune
--all-sources` prunes the whole location after a per-source confirmation, `--scope-label` scopes
  by custom labels. Journal pruning keeps segments any scope's base backup still needs.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Upgrade rehearsals: prove a backup works on a newer MongoDB release before upgrading production.
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

### Patch Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Correctness fixes found by a full test sweep:
  - Restore, copy, change replay and point-in-time recovery keep every document's field order,
    including integer-like keys, and so do index keys, validators, users and roles, part bounds,
    copy checkpoints and subset references.
  - Converge backups never replay events after the manifest's end of the window, replay indexes
    created during the window, survive dropped or replaced collections and network errors, and
    delete leftover files before the manifest commits.
  - `resume: "auto"` only continues a checkpoint with the same labels, so two jobs with the same
    selection never resume each other's backup.
  - Ctrl-C cancels a connection attempt immediately (exit code 60).
  - mongodump interop handles time series buckets, users, roles, `system.js` and oplog files.
  - Console: OIDC sign-in, config import, scoped prune, metrics; a run's prune no longer deletes
    other plans' backups.
