# @mongoshield/console

## 2.0.0

### Major Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - First release of the self-hosted web console: connections and storage locations, backup
  plans with schedules, live job progress, verification and restore drills, a read-only
  browser for documents inside backups, and a restore wizard with dry-run plans. Sign-in with
  local accounts, OIDC or a trusted reverse proxy; roles, an audit log and encrypted secrets
  at rest. Released in lockstep with `mongoshield`, so both share a version number.

### Minor Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Live data browsing and editing. Connections get a live data browser (databases →
  collections → documents with Extended JSON filters, projections and sorts, paging,
  explain-free counts, collection stats and indexes), read-only by default for operators.
  Editing is opt-in: an admin turns on "Allow live edits" per connection (production
  connections need the name typed again and a recorded reason) and grants the new
  `data:write` permission per user. Every write is backed by MongoShield: it is conditional
  on the document not having changed since it was loaded (version check plus a
  compare-and-swap filter), its pre-image is stored first in a sealed live edit journal in
  the connection's journal storage (or the data directory), it can be undone (conditionally)
  from the new Edit history page, and it is audited with before/after hashes. Edits show a
  field-level diff and keep the BSON type of untouched fields; insert, duplicate and delete
  one are supported, and "update many" / "delete many" need a preview count, a typed
  confirmation and a per-connection cap, and run as `live-edit` jobs. No commands, shell or
  server-side JavaScript are ever run.

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`085d6a1`](https://github.com/ShamalRathnayake/mongoshield/commit/085d6a1b535fffb05d5a58ecac2ed5d4c3e7bcec) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - A record browser to rival Compass, for live data and backups alike:
  - A navigation tree of connections, databases and collections (type icons for views,
    time series and capped collections, counts, search, keyboard navigation), breadcrumbs,
    and the last opened collection remembered.
  - Six views, remembered per collection: a table (flattened nested fields, column picker,
    reorder, resize, server-side sort, type-aware cells, virtualized rows), an expandable
    tree with type badges and copy actions, syntax-highlighted relaxed or canonical
    Extended JSON, summary cards, a schema of a sample (types, presence, values,
    histograms) and a simple chart.
  - Querying made simple: field name suggestions, sort and projection pickers, quick
    filters from any value, filter chips, a per-collection query history, and cancelling a
    slow query.
  - A document detail panel with previous/next, copy as JSON and the edit actions.
  - Export of the current result as JSON, JSON Lines or CSV (new bounded, audited
    endpoints), and new sample endpoints for the schema view.
  - Atlas Free/Flex aware: refused size statistics show as "—" with the reason, samples
    are smaller, and background queries are paced per connection.
  - A refreshed design system (spacing and type scales, color tokens for both themes,
    consistent buttons, inputs, tables, badges, skeleton loaders and toasts) across the
    console.

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

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`085d6a1`](https://github.com/ShamalRathnayake/mongoshield/commit/085d6a1b535fffb05d5a58ecac2ed5d4c3e7bcec) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Zero-setup console: `docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console`
  and a browser are enough.
  - **Secret.** Without `MONGOSHIELD_SECRET`, the console generates one on the first start
    into `/data/secret.key` (mode 0600, written atomically) and says so in the log; a
    malformed or world-readable key file is refused. `MONGOSHIELD_SECRET_FILE` reads the
    secret from a file (Docker and Kubernetes secrets). Consoles that pass
    `MONGOSHIELD_SECRET` behave exactly as before, and a data directory created with one
    refuses to start without it.
  - **First admin.** For 15 minutes after start (`MONGOSHIELD_SETUP_WINDOW_MINUTES`, 0 to turn
    it off) the setup page creates the first admin without the token; the token from the
    log keeps working. `MONGOSHIELD_ADMIN_USERNAME` (or `_EMAIL`) and
    `MONGOSHIELD_ADMIN_PASSWORD` (or `_PASSWORD_FILE`) create it at start instead. Setups are
    audited with the method and the client address.
  - **Default storage.** A fresh data directory gets a "Local backups" location
    (`/data/backups`); `MONGOSHIELD_DEFAULT_STORAGE=false` skips it.
  - **Welcome flow.** A console without connections opens on a welcome page: paste a
    connection string (quotes, `mongosh "…"`, wrapped lines and Atlas `<db_password>`
    placeholders are handled; the password moves to a masked field and is encoded), check it
    (`POST /api/connections/check`, with plain-language explanations of DNS/SRV, IP access
    list, paused cluster, credentials, TLS, privileges and Docker localhost problems, an
    opt-in public IP lookup, the Atlas tier and per-database access), confirm the suggested
    name and production setting, and land on the live data browser with a backup actions
    bar: **Back up now** (`POST /api/quick-backup`), then check the backup, test a restore,
    back up every night and restore, one click each. Three clicks from setup to the first
    backup.
  - **Managed keys.** Plans can be encrypted with a key the console generates and keeps
    (`encryption: { kind: "managed" }`): restores need no typing, and the recovery key can be
    downloaded once (`POST /api/plans/:id/recovery-key`, admin, audited). A plan whose
    recovery key was never saved cannot be deleted or switched to another encryption.
  - Connections remember what their last test found (`deployment`: topology, version, Atlas
    tier), and `POST /api/connections/:id/test` explains failures like the welcome page.

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

- Updated dependencies [[`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`f49712e`](https://github.com/ShamalRathnayake/mongoshield/commit/f49712ea1d356f78ab2f5f43bfdc37ae320dd888)]:
  - mongoshield@2.0.0
