# mongoshield

## 2.1.0

### Minor Changes

- [#72](https://github.com/ShamalRathnayake/mongoshield/pull/72) [`3444b11`](https://github.com/ShamalRathnayake/mongoshield/commit/3444b115d7fba6e57eb591cd5148b501896881d3) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Storage for everyone: a storage-scheme registry, B2 and R2 presets, a free-space check and a new `init` menu.
  
  - **Storage-scheme registry.** `registerStorageScheme(scheme, factory, { owner?, replace? })` adds `<scheme>://` URLs that `resolveStorage`, the CLI, config files and the console understand. The first-party schemes use the same registry; registering an existing scheme fails unless `replace: true`. `registeredStorageSchemes()` and `isStorageSchemeRegistered()` list and check them, and `resolveStorage(url, { env })` injects the environment factories read credentials from. `assertValidKey`, `assertValidPrefix` and `throwIfAborted` are exported for adapter authors.
  - **Contract test kit.** `mongoshield/testing/storage` exports `describeStorageConformance(name, setup, { describe, it, beforeEach, afterEach })`, the storage conformance suite every built-in adapter passes. It works with Vitest, Jest and node:test and adds no dependency. See `docs/guides/community-storage-adapters.md` and `examples/community-storage-adapter`.
  - **Backblaze B2 and Cloudflare R2.** `b2://bucket/prefix?region=us-west-004` and `r2://<accountId>/bucket/prefix` (and `b2Storage` / `r2Storage` from `mongoshield/storage/s3`) configure the S3 adapter with each service's endpoint, region, addressing style and `WHEN_REQUIRED` checksums. B2 credentials are an application key (`AWS_ACCESS_KEY_ID` = keyID, `AWS_SECRET_ACCESS_KEY` = applicationKey). The GitHub Action installs the S3 SDK for them, and the console accepts them with stored keys.
  - **Free-space check.** Adapters may implement `space()` (total, used, free and trash bytes); the file adapter does. Before the first write, a backup refuses with `MS_STORAGE_INSUFFICIENT_SPACE` when the previous full backup would not fit, warns past 80% full (logs, `warnings` and a `storage:space` progress event), counts the trash as used, and skips the check when the storage reports nothing.
  - **`mongoshield init` asks where backups go**: Google Drive, Dropbox, GitHub artifacts, Backblaze B2, Cloudflare R2, then a directory and every storage URL, with the next steps and secrets for each choice. `--destination` picks one without the menu.
  - **`mongoshield login <provider>`** signs in to Google Drive (a device code) or Dropbox (a browser sign-in with PKCE), prints the refresh token once with the secret it belongs in, and `--gh` stores it with `gh secret set` instead. MongoShield ships its own Google and Dropbox OAuth apps, so no app of your own is needed; `MONGOSHIELD_<PROVIDER>_CLIENT_ID` (and `_CLIENT_SECRET`) still override them.

- [#72](https://github.com/ShamalRathnayake/mongoshield/pull/72) [`dc25354`](https://github.com/ShamalRathnayake/mongoshield/commit/dc25354904ed9539c8a18e8c1d5ec32d793eda83) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - The drive storage is now reachable everywhere storage URLs are accepted:
  
  - `gdrive://` and `dropbox://` resolve through the storage registry like every other built-in scheme, and are published as `mongoshield/storage/gdrive` and `mongoshield/storage/dropbox`.
  - `mongoshield login gdrive|dropbox` uses each adapter's own sign-in, so the token it prints is exactly what that storage refreshes with. A Dropbox sign-in over SSH or in a Codespace asks you to paste the code Dropbox shows.
  - `mongoshield init --github` asks where backups go (Google Drive first), signs in to the drive, and sets up nightly encrypted backups in GitHub Actions with a first run.
  - New storage capability `storageLock: false`, for storage that can never hold a storage lock. `schedule.lock` defaults to `"none"` there (Google Drive) and stays `"storage"` everywhere else.
  - The shipped OAuth client IDs of all three providers live in one place, `src/storage/oauth/apps.ts`.

- [#72](https://github.com/ShamalRathnayake/mongoshield/pull/72) [`8a226be`](https://github.com/ShamalRathnayake/mongoshield/commit/8a226be565f66b3d75484cf586776307562c62b6) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Add Dropbox storage: `dropbox://<folder>` backs up into the app folder of your own Dropbox
  (2 GB free, no credit card), with no SDK to install. `dropboxStorage()` uploads with
  `files/upload` or a streamed upload session, supports range reads, conditional writes
  (so the normal storage lock works), batched deletes and a free-space check, and retries
  Dropbox's rate limits. `loginDropbox()` runs the PKCE login with a loopback redirect or a
  pasted code and returns the refresh token for `MONGOSHIELD_DROPBOX_TOKEN`. See
  docs/guides/dropbox.md.

- [#72](https://github.com/ShamalRathnayake/mongoshield/pull/72) [`87357ce`](https://github.com/ShamalRathnayake/mongoshield/commit/87357ce06eafea4e5c39cd5086d84e6dde89625b) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Google Drive storage, end to end:
  
  - `gdrive://<folder>` storage (and `gdriveStorage` from `mongoshield/storage/gdrive`): backups go into a `MongoShield` folder in the user's My Drive, with keys mapped to nested folders. It uses the Drive API with plain `fetch` (no SDK) and only the `drive.file` permission. Large files go up as resumable uploads in 256 KiB-multiple chunks while they stream; overwrites never show two versions; deletes are permanent; rate limits are retried with backoff; `space()` reports the account's quota. Google Drive has no conditional writes, so `schedule.lock` defaults to `"none"` there and GitHub Actions' `concurrency:` keeps runs apart.
  - `mongoshield login gdrive`: Google's device sign-in (approve a code on any device, also over SSH). The refresh token goes in `MONGOSHIELD_GDRIVE_TOKEN`; bring your own OAuth client with `MONGOSHIELD_GDRIVE_CLIENT_ID` / `_CLIENT_SECRET`.
  - `mongoshield init --github`: generates an age key pair (public key in the repository variable `MONGOSHIELD_RECIPIENTS`, private key saved locally), writes `.github/workflows/mongoshield-backup.yml` (nightly backup, verify and retention `{ last: 7, weekly: 4, monthly: 6 }`) and the config, sets the secrets with `gh` (or prints the commands), and starts and follows the first run.
  - The recovery kit: a passphrase-protected copy of the secret key at `_state/recovery-kit.age` in the storage. `restore` uses it when no identity is given, asking for the passphrase or reading `MONGOSHIELD_RECOVERY_PASSPHRASE`. It is optional and changes nothing in the backup format.
  - New guides: [Google Drive](docs/guides/google-drive.md) and [Atlas Free + Netlify in 10 minutes](docs/guides/atlas-free-netlify.md), and an example of a Netlify scheduled function starting a background function (undocumented behaviour, small databases only).

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Make incrementals, the change journal and consistency fallbacks work across more deployments, and tell apart replica sets that share a name.
  
  - Incremental backups on Atlas Free and Flex now adapt like full backups: a regex-only change stream filter, the gentler parallelism and read limit, and `includeUsersAndRoles` refused up front.
  - The change journal detects Atlas Free/Flex and uses the regex-only filter there. It refuses standalone servers and MongoDB before 6.0 at start with `MS_UNSUPPORTED_TOPOLOGY`. A change stream the server cannot open at all (for example an unknown `showExpandedEvents`) is now a fatal error instead of being retried forever.
  - `consistency: "auto"` falls back to `none` with a warning when the server refuses the change stream probe as unsupported, and on any probe error from Amazon DocumentDB, Azure Cosmos DB or FerretDB. Explicit modes still fail loudly.
  - An Atlas tier that refuses snapshot reads now gets a clear `MS_UNSUPPORTED_TOPOLOGY` before any collection is read (consistency `snapshot`), and while recording a rename's destination (converge).
  - New `warnings` on completed backup results, and `backup.consistency` / `backup.warnings` in run reports. These cover `auto` falling back to `none`, incrementals that keep falling back to full backups on `MS_SNAPSHOT_TOO_OLD`, and Queryable Encryption collections backed up without their state collections.
  - Manifests and checkpoints record `source.instanceId`, a hash of the replica set's `replicaSetId`, when the user may read it. Incrementals, resume and the backup guard compare it when both sides have one, and older backups still match on `clusterId` alone. There is no format version bump.
  - A server selection timeout on a single-host connection string now suggests `directConnection=true`.

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Platform and credential fixes found by the environment and security audits:
  
  - zstd is only chosen where the runtime has it (Node 22.15 / 23.8 and later): the
    `atlas-free` / `atlas-flex` presets and the config written by `mongoshield init` use
    gzip on Node 22.12-22.14 instead of failing every backup. `defaultCompression()` and
    `isZstdAvailable()` are now exported.
  - File storage: a conditional write whose `link()` reports EEXIST for its own file
    (NFSv3 retransmits) counts as written; the no-hard-link lock (SMB, FAT) measures its
    age with the file server's clock; renames are retried for a moment on Windows when
    another program holds the file, and EPERM is no longer described as a read-only
    filesystem.
  - The storage lock holds the lock when a retried create finds its own lock object.
  - Windows device names (`con`, `nul`, `aux`, `com1`, …) are escaped in backup keys and
    in mongodump directory exports (docs/specs/FORMAT.md).
  - S3: conditional writes are only trusted without a check on AWS and Cloudflare R2;
    other endpoints are probed once. A store without them makes the storage lock refuse
    clearly and the manifest write fall back to an unconditional put. New options
    `conditionalWrites` and `responseChecksumValidation`; with a custom `endpoint` both
    checksum settings default to `WHEN_REQUIRED`. `s3://` URLs accept
    `conditionalWrites`, `responseChecksumValidation`, `partSizeMiB` and `queueSize`,
    `gs://` URLs `chunkSizeMiB`, `az://` URLs `blockSizeMiB` and `uploadConcurrency`, to
    bound upload memory in small functions (docs/guides/aws-lambda.md).
  - `copy` / `pull` write their checkpoint once before changing the target, and the CLI
    keeps the default checkpoint in the system temp directory when the working directory
    is not writable.
  - TypeScript and JavaScript configs that import `mongoshield` resolve to the running
    package, so they load under `npx` and in the GitHub Action.
  - `redactMongoUri` also hides `proxyPassword` and `sslPEMKeyPassword`.
  - Notify and heartbeat URLs can come from `{ env: "NAME" }` or `{ file: "/path" }`
    references, and the heartbeat from `MONGOSHIELD_HEARTBEAT_URL`.
  - Storage URLs refuse credentials inside `endpoint=` (an Azure SAS token, presigned S3
    parameters), and `az://` URLs using `DefaultAzureCredential` refuse an endpoint
    outside Azure Storage's domains unless `allowCustomEndpoint=true`.

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Safer restores, retention and copies:
  
  - Point-in-time restores pick the newest base backup that suits the restore (covers every selected namespace, has no query filter on them, comes from one deployment) and refuse clearly when none does; `planPointInTimeRestore` takes `include`, `exclude` and `clusterId`, and the journal replay refuses namespaces the base never covered.
  - A backup that failed verification is never continued by an incremental; incrementals verified with `chain: "links"` are recorded as such and count towards `minVerified` only once their whole chain is verified.
  - Restores, verifies, drills and running backups hold a use lease (`annotations/<id>/leases/`) that prune and delete respect, so a backup is never pruned while it is read or still being written.
  - Drop-mode restores verify every data part first by default (`verifyFirst`), and `replace-tenant` checks the parts before deleting the tenant.
  - Insert mode skips only duplicate `_id`s; a collision on another unique index fails the restore. Skipped documents are reported in `documentsSkipped`.
  - On S3 buckets with Object Lock, deleting a still-locked object is refused instead of hiding it behind a delete marker.
  - `restoreDocuments` (`find --restore`) applies the erasure ledger like every other restore.
  - Retention periods count in `timeZone` (`schedule.timezone` for scheduled runs and `mongoshield prune`); UTC remains the default.
  - Namespace wildcards are matched in linear time, and `$regex` filters with nested quantifiers or over 1024 characters are refused, so a pattern can no longer block the process.
  - Exports are written with mode 0600 (directories 0700); replication errors, CLI warnings and `--verbose` output are scrubbed of secrets; a password in a command-line connection string draws a warning, and `MONGOSHIELD_URI_FILE` reads the connection string from a file.
  - Masked copies warn about validators, partial indexes and views that refer to masked fields.
  - `mongoshield --config f schedule` (global flags first) keeps the scheduler's own SIGTERM handling.

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Retention and incremental chains now tell apart two replica sets that share a set
  name (for example staging and prod both called `rs0`). Prune scopes accept an
  `instanceId` next to `clusterId`, the new `shield.sourceIdentity()` returns both,
  and the CLI's `prune` and the console's plan retention use it. A chain whose
  parent came from a different replica set with the same name is reported as a
  mismatch. Backups written before `instanceId` existed keep matching as before.

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Fixes from a review of the hardening release before it ships:
  
  - Point-in-time restore checks that the base backup and journal cover every
    namespace before it writes anything, so a refusal never leaves the target
    half-restored. Without a known source deployment, each base is judged within its
    own deployment instead of refusing; new `RestoreOptions.sourceIdentity` and
    CLI `restore --source-cluster <clusterId>[/<instanceId>]` pin it.
  - Prune keeps every parent of a backup that came into use while it ran, lists use
    leases once instead of once per backup, and scheduled retention keeps replica
    sets that share a set name apart.
  - Releasing a use lease no longer races a renewal that is still writing.
  - The S3 conditional-write probe runs next to the object being written, and a
    refused probe makes the manifest fall back instead of failing a finished backup;
    the Object Lock lookup is cached.
  - File storage compares 64-bit file ids exactly (Windows), a backup's snapshot
    session is always closed, "skip duplicate _id" also works on MongoDB-compatible
    engines, and the regex safety check accepts common safe patterns such as
    `^([a-z0-9]+\.)+[a-z]+$`.
  - The copy checkpoint fallback folder in the temp directory is private (0700) and
    refused if it belongs to someone else or is a symlink.

### Patch Changes

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - GitHub Action and container images:
  
  - The Action installs the cloud SDK for storage set in the config file or in
    `MONGOSHIELD_STORAGE`, not only in the `storage` input, and points a missing optional
    package at its `packages:` input.
  - An empty `version` now runs the release the Action ref belongs to (never `next`).
    mongoshield, the MongoDB driver and the SDKs are installed at exact versions with
    `npm install --ignore-scripts`.
  - The Action masks the URL-decoded password and secret-looking `args`, and logs the
    command line with them replaced by `***`.
  - Images: base images pinned by digest, exact SDK versions, `NPM_BEFORE` to freeze npm
    resolution at the commit time, a host-aware console HEALTHCHECK (IPv4 and IPv6), and
    `:latest` of the console image now follows releases only.

## 2.0.1

### Patch Changes

- The README on npmjs.com shows its images (they load from GitHub) and fits npm's size
  limit: the full configuration reference stays on GitHub, linked from the npm page.

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
