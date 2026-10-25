# MongoShield Console

Status: implemented (phase P7), including OIDC sign-in, config import, on-demand
pruning and the journal recovery-point metric. This document is the contract for the
implementation.

The console is a self-hosted web UI for everything around backups. You start one
container, open a browser, add a connection and a storage location, and get
scheduled, verified, encrypted backups with a point-and-click restore. It also has a
live data browser (databases → collections → documents, with filters, projections,
sorts, counts, stats and indexes), and, when an admin turns it on for a connection,
Compass-like editing of live documents. Unlike Compass, every live write is backed by
MongoShield: it is conditional on the document not having changed since it was loaded,
its pre-image is journaled first (sealed, in the connection's journal storage) so it can
be undone from the Edit history page, and it is audited (see "Live data" below). The
console still runs no arbitrary commands, shell or server-side JavaScript, and builds no
aggregations.

```bash
docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console
# Open http://localhost:8080: create the admin, paste a connection string, Back up now.
```

Nothing has to be configured first (see "First run" below): the console generates its
secret into the volume, lets the first visitor create the admin for a short window after
start, and creates a "Local backups" storage location. Operators who want to choose
these themselves pass `MONGOSHIELD_SECRET` (or `_FILE`), `MONGOSHIELD_ADMIN_*`,
`MONGOSHIELD_SETUP_WINDOW_MINUTES` and `MONGOSHIELD_DEFAULT_STORAGE`.

## Architecture

```
packages/console          npm: @mongoshield/console (bin: mongoshield-console)
  src/server/             Hono app on @hono/node-server: REST API + static UI
  src/state/              the console's own data: one JSON document + audit log, atomic writes
  src/jobs/               in-process job runner (backup / restore / verify / drill / prune / preview)
  src/server/oidc/        OIDC relying party: discovery, JWKS, ID token checks (node:crypto only)
  src/server/live/        live data browser: conditional writes, the pre-image journal, undo
  src/ui/                 React 19 + Vite single-page app, built into dist/ui
```

- The **server** uses only the public `mongoshield` API (`MongoShield`, `runScheduledJob`,
  `BackupScheduler`, `listBackups`, `findInBackup`, …). Nothing the UI can do is
  impossible from the CLI or the library.
- **State** lives in `/data/console.json`, written atomically (write to a temp file,
  fsync, rename). Secrets inside it (URIs, storage credentials, age identities,
  passphrases) are encrypted with AES-256-GCM, using a key derived (HKDF) from
  `MONGOSHIELD_SECRET` (or the file in `MONGOSHIELD_SECRET_FILE`). Without either, the
  console generates a secret on the first start into `/data/secret.key` and reuses it;
  it refuses to start when the key file is malformed or readable by others, and when a
  data directory created with an operator's secret is started without it. The API never
  returns a secret, only `"configured": true` and a redacted preview, with one deliberate
  exception: an admin can download a plan's recovery key (`POST /api/plans/:id/recovery-key`,
  audited).
- **Audit log:** `/data/audit.jsonl`, one line per action: who, what, when, target and
  outcome. It is append-only and shown in the UI.
- **Jobs** run in the server process, one at a time per connection. They are scheduled
  with the same `BackupScheduler` and lock as `mongoshield schedule`, so a console and a
  CronJob can safely share a storage location. Live progress streams to the UI over
  Server-Sent Events.

## Security

1. **No default password.** While no admin exists, the setup page creates the first one
   without a token during the setup window (15 minutes after start by default,
   `MONGOSHIELD_SETUP_WINDOW_MINUTES`, 0 to turn it off); the page and the log say so,
   and the setup is audited with the client address. The single-use setup token printed
   to the logs (`/setup?token=…`, valid 24 hours) works at any time, and is the only way in
   after the window. `MONGOSHIELD_ADMIN_USERNAME` + `MONGOSHIELD_ADMIN_PASSWORD(_FILE)`
   create the admin at start instead (only while no user exists).
2. **Passwords** are hashed with scrypt (N=2^17). Sessions use a random 256-bit id in an
   `HttpOnly; Secure; SameSite=Strict` cookie, with an idle timeout of 12 hours. A CSRF
   token is required on every state-changing request. Login is rate-limited.
3. **Roles:** `viewer` (read everything except secrets), `operator` (run backups,
   verifies and drills, restore into non-production targets), `admin` (everything,
   including connections, storage, users and restores into connections marked
   "production"). On top of the role, an admin can grant a user the `data:write`
   permission (operators and admins only), which live edits need; no role includes it.
4. **SSO:** OIDC (authorization code + PKCE, see below), or trusted reverse-proxy
   headers (`X-Forwarded-User`, accepted only together with a shared secret header the
   proxy sets).
5. **Restore safety:** restore and copy show a dry-run plan first, and the restore
   wizard can preview what the restore would change in the target (read only, see
   "Restore preview" below). A restore into a connection marked "production" requires
   typing the connection's name to confirm.
6. **Headers:** a strict CSP (no inline scripts), `X-Frame-Options: DENY`, `Referrer-Policy:
   no-referrer`, and HSTS when served over TLS.
7. **Release gate:** the checklist in `docs/console-security.md` follows OWASP ASVS
   level 1, and every item is covered by an automated test where possible.

## First run

What a fresh data directory gets, so that `docker run` and a browser are enough:

| Step | What happens | Choose yourself with |
|---|---|---|
| Secret | 32 random bytes, hex, written atomically to `<data>/secret.key` (temp file + fsync + no-clobber `link`, mode 0600). Logged as generated, with where it is. | `MONGOSHIELD_SECRET`, `MONGOSHIELD_SECRET_FILE` (both at once is refused) |
| Admin | the setup window (above), or the environment admin | `MONGOSHIELD_SETUP_WINDOW_MINUTES`, `MONGOSHIELD_ADMIN_*` |
| Storage | "Local backups" (`backups`, i.e. `<data>/backups`), created once: the `defaults` marker in `console.json` keeps a deleted default deleted, and a data directory that already has users, connections, storage or plans is left as it is | `MONGOSHIELD_DEFAULT_STORAGE=false` |

**Welcome flow.** An admin who signs in to a console without connections lands on
`#/welcome`: paste a connection string, check it (`POST /api/connections/check`), confirm
the name and the production flag, save, and land on the connection's live data browser
(`#/connections/:id/data`), which shows the backup actions bar above the data.

- **Pasting.** The page and the server clean the text the same way
  (`src/shared/connection-string.ts`): quotes, a `mongosh "…" [--username u]` command,
  and line breaks are removed; a password in the string moves to a masked field (Atlas's
  `<db_password>` placeholder asks for it there); raw special characters in the user name
  or password are percent-encoded. The server refuses strings that still hold a
  placeholder. The password is never shown again: the page shows the masked string.
- **Checking.** `POST /api/connections/check` (admin) connects with the string and returns
  the test result plus a suggested name (Atlas cluster, replica set or host; unique) and a
  production suggestion with its reason (Atlas and other servers yes, this machine and
  Docker hosts no). Failures come with a `problem`: what went wrong in plain words, a fix,
  links (Atlas Network Access, Database Access, …) and the scrubbed driver message
  (`src/server/connection-problems.ts`: DNS/SRV not found, Atlas IP access list, paused
  cluster, wrong credentials (18, or Atlas's 8000), missing privileges, TLS, refused
  connections with Docker advice, timeouts). Atlas clusters get their tier (`shared` for
  Free/Flex, `dedicated`) from one read-only `getParameter` probe; users with per-database
  roles get `readableDatabases` (from `listDatabases` with `authorizedDatabases: true`) and
  advice on the roles to grant. A successful check is remembered (by URI hash, 10 minutes)
  so the connection saved right after keeps what it found (`deployment` on the view).
  `POST /api/connections/:id/test` returns the same richer result and records `deployment`.
- **The public IP.** For an Atlas IP access list, `POST /api/network/public-ip` (admin)
  asks `https://checkip.amazonaws.com/` for the console's egress address, only when the
  admin clicks "Show my public IP address"; the answer must be an IP address. Audited.
- **Back up now.** `POST /api/quick-backup` (admin, `{ connectionId, include? }`) creates
  the connection's quick plan on the first click (`origin: "quick"`, one per connection)
  and runs it: the default storage (else the first local location; cloud storage is never
  picked silently), everything except admin/local/config unless `include` says otherwise,
  zstd, consistency `auto`, a fast verify, and encryption with a **managed key** (below).
  Later clicks reuse the plan and save a changed selection on it. The bar then offers, one
  click each: check the backup (deep verify), test a restore (a drill into temporary
  databases, not for production connections), back up every night (a `PUT` of the plan
  with `0 2 * * *` in the browser's time zone and retention 7 daily, 4 weekly, 12
  monthly), and restore (the restore wizard on the newest backup).
- **Managed keys.** `encryption: { kind: "managed" }` makes the console generate an age
  X25519 key pair (the library's `generateIdentity`): backups are encrypted to the public
  key; the private key is sealed in `console.json` like any stored secret (context
  `plan:<id>:identity`), so restores, verifies, drills and previews of that storage need no
  typing (`decryptionFor` offers every managed key of plans writing there). The view shows
  only `recipient` and `recoveryKeySaved`. `POST /api/plans/:id/recovery-key` (admin)
  returns the private key as a commented key file (`--identity-file` for the CLI), audits
  `plan.recovery_key` (public key only) and marks it saved; the UI offers it once after the
  first backup and reminds until then. A plan whose key was never saved can be neither
  deleted nor switched to another encryption (`409 CONSOLE_RECOVERY_KEY_NOT_SAVED`). The
  export writes the public key as `recipients`, and importing that back keeps the key.

## Single sign-on with OIDC

Set `MONGOSHIELD_OIDC_ISSUER` and `MONGOSHIELD_OIDC_CLIENT_ID` (plus usually
`MONGOSHIELD_OIDC_CLIENT_SECRET`) and register `<console>/api/oidc/callback` as the
redirect URL at the provider. The login page then offers "Sign in with single sign-on".

| Variable | Meaning |
|---|---|
| `MONGOSHIELD_OIDC_ISSUER` | Issuer URL (https; http only on localhost). Discovery: `<issuer>/.well-known/openid-configuration` |
| `MONGOSHIELD_OIDC_CLIENT_ID` | The console's client id |
| `MONGOSHIELD_OIDC_CLIENT_SECRET` | Its secret; omit for a public client (PKCE only) |
| `MONGOSHIELD_OIDC_REDIRECT_URL` | `<console>/api/oidc/callback`; defaults to `MONGOSHIELD_PUBLIC_URL` + that path |
| `MONGOSHIELD_OIDC_SCOPES` | Default `openid profile email` (`openid` is always added) |
| `MONGOSHIELD_OIDC_ROLE_CLAIM` | Claim with groups or roles, e.g. `groups`, `realm_access.roles` (dots walk into objects) |
| `MONGOSHIELD_OIDC_ROLES_MAP` | `ops-admins=admin,ops=operator`, or JSON `{"cn=admins,dc=example":"admin"}` for values with commas |
| `MONGOSHIELD_OIDC_DEFAULT_ROLE` | Role when no mapping matches: `viewer` (default), `operator`, `admin`, or `none` to refuse |
| `MONGOSHIELD_OIDC_AUTO_PROVISION` | `false`: only existing accounts may sign in (default `true`) |
| `MONGOSHIELD_OIDC_CLOCK_SKEW_SECONDS` | Tolerance for `exp`/`nbf`/`iat` (default 60, at most 300) |

A half-configured setup (a client id without an issuer, a misspelt `MONGOSHIELD_OIDC_*`
variable, an http redirect URL) stops the console at startup.

**Flow.** `GET /api/oidc/login` creates a pending login in memory (random `state`,
`nonce` and PKCE verifier; 10 minutes; at most 1000 pending), stores its id in a
`SameSite=Lax`, `HttpOnly` cookie (`__Host-` prefixed when cookies are secure) and
redirects to the provider. `GET /api/oidc/callback` consumes the pending login of that
cookie (single use), checks `state` (and RFC 9207 `iss` when sent), redeems the code at
the token endpoint with the verifier (`client_secret_basic`, `client_secret_post` when
that is all the provider offers, or none for public clients), and verifies the ID token:

- signature with `node:crypto` against the provider's JWKS: RS256 (≥ 2048-bit keys),
  ES256 (P-256) and EdDSA (Ed25519); `none`, HMAC and every other algorithm are refused,
  and the key type must fit the algorithm; keys marked `use: enc`, or pinned to another
  `alg`, are ignored;
- keys are cached for an hour; a token with an unknown `kid` triggers one JWKS refresh
  (key rotation), at most once a minute;
- `iss` equals the issuer exactly; `aud` contains the client id; with several audiences
  `azp` must be the client id; `exp`, `nbf` and `iat` within the clock skew; `nonce`
  matches; `sub` present.

On success the browser gets a normal console session (same cookie, CSRF and timeouts
as password logins) and is sent to `/#/`; on failure to `/#/?sso_error=<code>` (codes:
`OidcErrorCode` in `src/shared/api.ts`), and the details go to the server and audit logs
only.

**Accounts.** An identity is bound to a console account by issuer + `sub`, never by
name. At the first sign-in the console looks for an unlinked SSO-only account (no
password: created by an admin, or by the trusted proxy when both SSO modes are on) with
the identity's username (`preferred_username`, else a verified `email`, else `sub`, else
a stable `oidc-<hash>`) and links it; a password account with that name is never taken
over. Without a match, auto-provisioning creates an SSO-only account; with it off, the
sign-in is refused. Admins can create SSO-only accounts in the Users page (leave the
password empty) whenever OIDC or the proxy is configured. With a role claim, the role
follows the provider at every sign-in (the last admin is never demoted); without one,
roles are managed in the console. Logout ends the console session only (no
provider-side logout).

## Importing a config

`POST /api/config/import` (admin; Settings page) takes a `mongoshield.config.ts` as
JSON: one `defineConfig` argument, or several keyed by plan name. Send `dryRun: true`
first; the answer lists every connection, storage location and plan the import creates,
updates (field by field, `from` → `to`) or leaves unchanged, plus warnings. The same body
with `dryRun: false` applies it in one state update, planned again against the current
state (all or nothing), and audits each record it creates or changes.

- Validation uses the library's own `ConfigSchema` (exported by `mongoshield`), so the
  console accepts exactly what the CLI accepts; unknown keys are errors. Settings the
  library knows but the console does not manage become warnings.
- Secrets never travel in the document: a connection string with a password or secret
  options, `encryption.passphrase`, notification URLs and `decryption` are refused. They
  go in `secrets[<plan>]` (`uri`, `passphrase`, `notifyUrls`, `storageCredentials`).
  Leaving them out of the document (`source: {}`, `encryption: {}`, notify targets
  without `url`, which is what the export becomes with unset environment variables)
  keeps what the console stores for that plan.
- Settings that would make an imported plan weaker than the file (`encryption.kms`,
  `backup.retainDays`, `schedule.verify: "drill"`) are refused; settings the console does
  not manage (tuning, locks, retries, guard, replicate, heartbeat, `notify.on`,
  `retention.hourly`/`minVerified`) are reported as warnings and ignored.
- Connections are matched by their redacted URI and storage by URL; new connections are
  marked production. Existing connections and storage are never changed by an import.

## Incremental plans

A plan with `incremental: { fullEveryDays }` (the plan editor's "Incremental backups
between full ones") runs with the library's `backup.incremental`: each run is an
incremental backup of the changes since the plan's newest backup, and a full backup when
there is none yet, when the chain's full backup is `fullEveryDays` old, or when an
incremental is impossible (see docs/guides/incremental-backups.md). The plan label scopes
which backups a run may continue, so two plans never chain onto each other. The field is
exported as `backup.incremental` and imported from it (an empty `{}` takes the library's
default of 7 days). Backup summaries mark incrementals (`kind: "incremental"`,
`chainLength`), and retention keeps every backup a kept incremental depends on.

## Pruning

A backup run applies its plan's retention right after the backup (as `mongoshield run`
does). Retention is scoped per plan: every backup a plan writes is labelled
`mongoshield.plan=<plan id>`, and the prune only covers backups with that label from the
plan's connection's deployment (its `clusterId`). Plans that share a storage location
therefore never prune each other's backups, and neither do CLI jobs writing there (their
backups carry no plan label). To apply a policy on demand (say, after tightening it), the
Backups page has "Apply retention…" (admin): `POST /api/plans/:id/prune/plan` shows which
of the plan's backups its policy keeps (with reasons) and removes, and how many other
backups in the storage it leaves alone (`outOfScope`); then `POST /api/plans/:id/prune`
with the ids shown starts a `prune` job. Both read the cluster id from the plan's
connection. The job takes the same storage lock as backup runs, plans again and refuses
(`CONSOLE_PRUNE_PLAN_CHANGED`) if it would now delete anything that was not confirmed.
Holds, immutable backups and each plan's newest complete backup are always kept (the
library's safety rules). Backups written before plans were labelled are outside every
plan's scope; remove them with `mongoshield prune --all-sources` if needed.

## Restore preview

Between the dry-run plan and the confirmation, the restore wizard offers "Preview
changes": what the restore would do to the target's data, before anything is written.
`POST /api/restore/preview` takes the plan's body (storage, backup, target, include,
exclude, rename, mode and typed keys; not `filter`: a selected-documents restore has no
preview, its plan already counts what it replaces) and starts a `preview` job. The job
plans the restore (`shield.planRestore`) and compares the backup with the target through
the library's `diff` against the live deployment, with the same rename rules, so each
backed-up namespace is compared with the namespace it would be restored into and with
nothing else. `GET /api/restore/preview/:id` (the job id) then returns, per namespace:

- documents only in the backup, only in the target, changed and identical (matched by
  `_id`, compared by their exact BSON bytes);
- what the chosen mode does with them (`effect`: inserted, replaced, deleted, kept;
  none for a conflict or a skipped view), next to the plan's action;
- index names that differ (only in the backup, only in the target, defined differently)
  and the collection options that differ;
- `accuracy`: `exact`, or `sampled` for namespaces with more than 100,000 documents,
  whose first 1,000 backed-up documents are looked up in the target by `_id` and whose
  counts are extrapolated (the UI says "Estimate" and prefixes them with ≈).

`GET /api/restore/preview/:id/documents?ns=&category=changed|backup-only|live-only`
pages through the `_id`s the preview kept (500 per namespace and category at most, fewer
when there are many namespaces; for a target that does not exist yet, the first
backed-up ones), and `POST /api/restore/preview/:id/document` with
`{ ns, id }` (plus typed keys) shows one of them in both versions with the fields that
differ, by dotted path, BSON types counting. Only listed `_id`s can be opened.

Rules and bounds:

- **Read only.** Planning and comparing use listCollections, listIndexes, counts and
  `find`; the target is never written to.
- **Roles.** Starting and reading a preview follows the dry-run plan's rules (operator,
  admin for production targets, checked again on every request). `_id` lists and
  document contents also need the document browser's role (`documentsVisible` in the
  view says whether the user has it).
- **Secrets.** Values of fields whose names look like secrets (password, token, apiKey,
  privateKey, secret, credential, …) are shown as `***`, and the change is still
  reported. Typed keys are used by the job and each document request and never stored;
  connection strings and keys are scrubbed from errors as in every job.
- **Bounds.** The job stops after 10 minutes (`CONSOLE_PREVIEW_TIMEOUT`) and can be
  cancelled; leaving the wizard step cancels a running preview. Previews of one target
  run one at a time, in their own lane (a long backup of the same deployment does not
  hold them up). Results are kept in memory only: 20 previews at most, each for an hour.
- **Audit.** `restore.preview` (start), `restore.preview_documents` (an `_id` page) and
  `restore.preview_document` (a document), with namespaces and counts, never ids or
  contents.

## Live data

The data browser (Connections → a connection → "Browse live data", `#/connections/:id/data`)
reads a connection's databases directly. Reading needs the operator role, like the backup
document browser, and is audited (`live.browse`: who, which namespace, how many documents;
never the documents). `admin`, `config`, `local` and `system.*` collections are not
browsable (they hold MongoDB's users, roles and replication state).

- **Documents:** `GET /api/live/:id/documents?ns=&filter=&projection=&sort=&skip=&limit=`.
  Filter, projection and sort are Extended JSON objects (≤ 16 KiB); `$where`,
  `$function` and `$accumulator` are refused anywhere inside them; sorts are 1 or -1;
  `limit` ≤ 100 and `skip` ≤ 100,000 (filter instead of paging deeper); queries time out
  after 30 s (and stop on the server when the browser aborts the request). Each document
  comes as relaxed Extended JSON with its `_id` (canonical Extended JSON) and its
  `version` (SHA-256 of its BSON); with `ejson=canonical` also as canonical Extended JSON
  (`canonical`, for the JSON view; the backup document browser takes the same parameter
  and adds a parallel `canonical` array). Documents read with a projection are partial
  and carry no version, so they cannot be edited.
- **Counts without explain:** no filter, the collection's metadata estimate
  (`estimated`); with a filter, `countDocuments` bounded to 10,000 and 5 s (`exact`, or
  `at-least` when it stopped).
- **Collection:** `GET /api/live/:id/collection?ns=` gives the type, counts, sizes from
  one `$collStats` call (document, storage and index bytes, average document size), the
  indexes (key, unique, sparse, hidden, TTL, partial filter, size) and whether the caller
  may write there (and why not). When `$collStats` is refused the sizes are left out and
  `statsUnavailable` says why in words (an Atlas Free/Flex cluster, or a user without the
  privilege); the page still answers 200. The namespace tree marks capped collections.
- **Samples:** `GET /api/live/:id/sample?ns=&filter=&size=` (schema and chart views, field
  suggestions) runs `[{$match}, {$sample}]` for at most 10 s: 200 documents unless asked,
  at most 1,000 (200 on an Atlas shared tier; larger sizes are capped and the reply says
  the size used). `GET /api/storage/:id/backups/:backupId/sample` reads the first
  documents of a backup instead (`method: "first"`, same caps). Audited as `live.browse` /
  `backup.browse` with `sample: true`.
- **Exports:** `GET /api/live/:id/export?ns=&filter=&projection=&sort=&format=&limit=&ejson=`
  and `GET /api/storage/:id/backups/:backupId/export?ns=&filter=&format=&limit=&ejson=`
  return the viewer's result as a file (`{filename, contentType, content, documents,
  truncated}`): `json` (one array, a document per line), `jsonl`, or `csv` (a column per
  field path, nested fields flattened as `address.city`, BSON values as one cell such as
  the ObjectId's hex or the date's ISO text, arrays as JSON text, RFC 4180 quoting, and
  text cells starting with `=`, `+`, `-`, `@`, TAB or CR prefixed with `'` so spreadsheets
  do not run them as formulas). 1,000 documents unless asked, at most 10,000 and 16 MiB
  (`truncated: true` when it stopped early); live queries time out after 30 s. Audited as
  `live.export` / `backup.export` with the count, format and whether it was filtered or
  truncated.
- **Atlas Free and Flex:** live connections on an Atlas host (`*.mongodb.net`) get one
  read-only probe (`getParameter` of `featureCompatibilityVersion`, refused with code 8000
  on shared tiers), cached per client; an Atlas refusal of `$collStats` proves it too. On
  a shared tier (`sharedTier: true` on the collection info) samples read at most 200
  documents, and only one sample or export runs at a time per connection (four
  otherwise): the tier allows about 100 operations per second for all its clients. Others
  wait their turn for up to 30 s, then get `429 CONSOLE_LIVE_BUSY`.

**Editing is off by default.** A write needs all of: the operator role or higher, the
`data:write` permission (granted per user on the Users page; even admins need it), and
"Allow live edits" turned on for the connection by an admin
(`PUT /api/connections/:id/live-edits`). For a connection marked production, turning it on
also needs the connection's name typed again and a reason; both are recorded (the reason
on the connection and in the audit log). Marking a connection production later turns live
edits off until an admin confirms again. The settings also choose the journal storage and
the bulk cap (`maxBulkDocuments`, default 1,000, at most 10,000).

Operations: edit a document (an Extended JSON editor that checks the text, shows a
field-level diff and saves only after review), insert, duplicate (insert a copy without
`_id`), delete one, and "update many" / "delete many" by filter. No replacement documents
or pipelines in bulk updates: only the field update operators (`$set`, `$unset`, `$inc`,
`$mul`, `$rename`, `$min`, `$max`, `$currentDate`, `$push`, `$pull`, `$pullAll`,
`$addToSet`, `$pop`), and never on `_id`.

**Every write is conditional.** The browser sends back the `version` it loaded. The
server reads the document, refuses with `409 CONSOLE_LIVE_CONFLICT` if it changed (or was
deleted), and then writes with a compare-and-swap filter (`_id` plus
`$expr: {$eq: ["$$ROOT", {$literal: <pre-image>}]}`), so a change that slips in between
the check and the write is refused by MongoDB itself. Edits keep the exact BSON type of
every field the user did not touch (a double that reads `1` stays a double; a Long stays
a Long), and an edit cannot change `_id`. Inserts get an ObjectId from the console when
they have no `_id`, and never overwrite an existing `_id`.

**The live edit journal.** Before any write, the console stores the document's pre-image
(and intended post-image) in the journal; if that fails, nothing is written
(`502 CONSOLE_LIVE_JOURNAL`). The journal lives in the connection's journal storage
location (usually the one its backups go to) under `live-edits/<connection>/<entry>/`,
outside `backups/`, so catalogs and retention never see it; without one it lives in the
data directory (`<data>/live-journal/`). It is never kept in `console.json`, which is
rewritten whole on every change, while pre-images can be 16 MiB each. Every journal object
is sealed with the console's AES-256-GCM key (the key that protects stored secrets),
with the connection, entry and part bound in as additional data, whatever encryption the
plans writing to that storage use: pre-images are customer data and are never stored in
plaintext. Only a console with the same `MONGOSHIELD_SECRET` can read them back, which is
all undo needs. `console.json` keeps only the index (the newest 1,000 entries: who, when,
namespace, `_id`, before/after hashes, counts, status).

**Undo** (Edit history page, `POST /api/live-edits/:id/undo`, `data:write`) is the same
conditional write in reverse: it restores the pre-image only while the document is still
exactly what the edit left (else `409`, nothing changed), and it is journaled like any
other edit, so undoing an undo redoes the edit. Single-document entries are undone at once;
bulk entries by a job.

**Bulk edits** need a preview first (`POST /api/live/:id/bulk/preview`: the matching count,
the cap, and the text to type, e.g. `delete 42 documents in app.orders`). The confirmation
(`POST /api/live/:id/bulk`) must repeat that text exactly and the previewed count; it starts
a `live-edit` job (one per connection at a time) that refuses to run if the count has
changed or is over the cap, collects the matching `_id`s, and then works 100 documents at
a time: journal the batch's pre-images, change each document with its own compare-and-swap
(documents that changed meanwhile are skipped and counted), and record the post-images.
Jobs show progress and can be cancelled between batches.

**Audit:** `connection.live_edits`, `live.browse`, `live.export`, `backup.export`,
`live.insert`, `live.update`, `live.delete`, `live.bulk_update(.start)`,
`live.bulk_delete(.start)`, `live.undo(.start)` and `live.history_read`, with the connection, namespace, `_id`, the journal entry and the
SHA-256 of the document before and after; refused writes are audited with
`conflict: true`. Document contents never go into the audit log. Documents are shown as
they are (no field is hidden: the user may edit any field), while error messages keep the
usual scrubbing of connection strings and stored secrets.

Live write bodies may be up to 1 MiB of Extended JSON (other API bodies stay at 64 KiB);
larger documents are read-only here.

## API (JSON, under `/api`)

| Resource | Endpoints |
|---|---|
| session | `POST /session` (login) · `DELETE /session` · `GET /session` (with `setup: { tokenRequired, windowEndsAt }` before setup) · `POST /setup` (token optional during the setup window) |
| users | CRUD (admin) |
| connections | CRUD · `POST /connections/check` (a pasted string, before saving; admin) · `POST /connections/:id/test` (connects and checks privileges) · `GET /connections/:id/namespaces` (database/collection tree with counts, sizes and index counts) · `PUT /connections/:id/live-edits` (admin) |
| live data | `GET /live/:id/collection?ns=` · `GET /live/:id/documents?ns=&filter=&projection=&sort=&skip=&limit=&ejson=` · `GET /live/:id/sample?ns=&filter=&size=` · `GET /live/:id/export?ns=&filter=&projection=&sort=&format=&limit=&ejson=` (operator) · `POST /live/:id/documents` (insert) · `PUT /live/:id/documents` (replace) · `POST /live/:id/documents/delete` · `POST /live/:id/bulk/preview` · `POST /live/:id/bulk` (job) (`data:write`) |
| live edits | `GET /live-edits?connectionId=&limit=&before=` · `GET /live-edits/:id` (operator, audited) · `POST /live-edits/:id/undo` (`data:write`) |
| storage | CRUD · `POST /storage/:id/test` (write, read and delete a probe object) |
| onboarding | `POST /quick-backup` ("Back up now", admin) · `POST /network/public-ip` (admin, on click) |
| plans | backup plans = connection + storage + selection + encryption + schedule + retention + notifications · CRUD · `POST /plans/:id/run` · `POST /plans/:id/recovery-key` (managed keys, admin) · `POST /plans/:id/prune/plan` (dry run) · `POST /plans/:id/prune` (job) |
| backups | `GET /storage/:id/backups` (catalog) · `GET /…/:backupId` (manifest + annotations) · verify · drill · hold/release |
| browse | `GET /…/:backupId/documents?ns=&filter=&limit=&after=&ejson=` · `GET /…/:backupId/sample?ns=&filter=&size=` · `GET /…/:backupId/export?ns=&filter=&format=&limit=&ejson=` (operator, read-only, uses `findInBackup`) |
| restore | `POST /restore/plan` (dry run) · `POST /restore` (job) · `POST /restore/preview` (job) · `GET /restore/preview/:id` · `GET /restore/preview/:id/documents?ns=&category=&limit=&after=` · `POST /restore/preview/:id/document` |
| jobs | `GET /jobs` · `GET /jobs/:id` · `GET /jobs/:id/events` (SSE) · `POST /jobs/:id/cancel` |
| audit | `GET /audit` |
| config | `GET /config/export` (as `mongoshield.config.ts`, secrets left as env references) · `POST /config/import` (dry run, then apply) |
| oidc | `GET /oidc/login` · `GET /oidc/callback` (browser redirects, not JSON) |
| health | `GET /healthz` · `GET /metrics` (Prometheus text format) |

`/metrics` (bearer `MONGOSHIELD_METRICS_TOKEN`) exposes `mongoshield_console_jobs{kind,status}`,
`mongoshield_console_jobs_running`, `mongoshield_backup_last_success_timestamp_seconds{plan}`,
`mongoshield_backup_last_duration_seconds{plan}` and, for each storage location with a
change journal (read with the library's `journalStatus`, cached for 30 s),
`mongoshield_recovery_point_timestamp_seconds{storage}`, `mongoshield_journal_rpo_seconds{storage}`,
`mongoshield_journal_gaps{storage}` and `mongoshield_journal_status_ok{storage}`. Alert on
`time() - mongoshield_recovery_point_timestamp_seconds > <RPO>`.

## UI pages

Setup (first admin; within the setup window without a token) · Welcome (first connection,
for consoles without one) · Overview (last runs, next runs, recovery point, warnings) ·
Connections (with the live
edit settings) → Live data (the record browser below; with `data:write` the editor with
its diff review, insert, duplicate, delete and bulk edits) ·
Edit history (journal entries, details, undo) · Storage ·
Backup plans · Backups (list with "Apply retention…" → backup detail with namespaces,
verification, drills, holds, a document browser and a restore wizard: choose, review
the plan, preview the changes (summary per namespace, the documents of one, one
document's fields side by side), confirm; the wizard takes a passphrase or age private keys for backups the console cannot decrypt itself,
used for that restore only and never stored) · Jobs (live
progress) · Audit · Users (with SSO-only accounts and the `data:write` permission) · Settings (export and import of
the config) · Login (password and "Sign in with single sign-on").

The visual design is calm and information-dense, like an ops tool. Status is shown
with words and shape as well as color, light and dark themes are supported, and the
whole UI works with the keyboard.

### Browsing records

The live data browser and the backup document browser are one experience (the backup
one is read-only, and has no sort or projection because backups are read in storage
order):

- **Navigation.** A tree on the left: connections → databases → collections (the backup
  browser starts at its databases), with type icons for collections, views, time series
  and capped collections, document counts (sizes where known), and a search box that
  filters collection names. It is an ARIA tree (↑/↓, →/←, Enter). Breadcrumbs name the
  connection, database and collection. Opening a connection's data page without a
  collection goes back to the last one opened there.
- **Views**, switched per collection and remembered (with the columns, card fields and
  chart field, in the browser's localStorage; each backup of a namespace shares them):
  - *Table*: one column per field, nested fields flattened as dot paths; column picker,
    reorder (drag a header, or Move up/down), resize (drag, or ← / → on the handle), sort
    by clicking a header (on the server), type-aware cells (dates, ObjectIds with their
    creation time, numbers, booleans, null vs missing, binary sizes, UUIDs, arrays as chips
    with counts, nested documents in a popover); sticky header; only the rows in view are
    rendered; ↑/↓ move between rows and Enter opens one.
  - *Tree*: an expandable tree per document with a type badge per field, expand/collapse
    all, copy value (C), copy path (P) and the value menu (F).
  - *JSON*: syntax-highlighted relaxed or canonical Extended JSON (the canonical text comes
    from the server, `ejson=canonical`), wrap toggle, copy a document or the page.
  - *Cards*: a summary per document with a chosen (or guessed) title and subtitle field.
  - *Schema*: from a sample (`GET …/sample`: a `$sample` of the collection, or the first
    documents of a backup; the size is always stated): per field path its presence, type
    distribution with percentages, common values or examples, a cardinality hint, and for
    numbers and dates min/max with a small histogram.
  - *Chart*: documents of the sample by a few-valued field (bars) or a number/date field
    (histogram), plain HTML bars with names and counts, no chart library.
- **Querying.** The filter box suggests field names from the page and the sample (and
  operators after `$`); Enter applies. Sort and projection have pickers. Clicking any value
  (a cell, a card field, a tree row, a schema value or histogram bar, a chart bar) offers
  "is", "is not" and "has the field" filters, merged into what is typed; the applied
  filter shows as removable chips. Each collection keeps a history of applied queries.
  Problems are explained under the box before any request; the server's guards
  (`$where`, `$function`, `$accumulator`, limits) are unchanged. A slow page can be
  cancelled (the request is aborted, and the server stops the query).
- **Detail panel.** Opening a document shows it in a panel with Tree, JSON and Fields
  tabs, Previous/Next (or [ and ]) through the page, "Copy as JSON", and, when live edits
  are allowed, Edit, Duplicate and Delete.
- **Export.** "Export" downloads the current result (filter, sort, projection) as JSON,
  JSON Lines or CSV, up to 10,000 documents (`GET …/export`, see "Live data").
- **Bounded on purpose.** Pages are at most 100 documents, counts are estimates unless
  filtered, samples are capped (200 by default, 100 on Atlas Free/Flex). The queries the
  UI runs by itself (samples for the schema and the suggestions) are requested only when
  needed, debounced, and run one at a time per connection, with a one-second gap on Atlas
  shared tiers (`sharedTier` in the collection info). Sizes that MongoDB refuses to report
  (`$collStats` on shared tiers or without the privilege) show as "—" with the reason.

## Tests

- **API tests** run against an in-process server with a real mongod (the test replica
  set) and memory storage. They cover each endpoint's authorization by role, CSRF
  rejection, secret redaction, the setup token's lifecycle and the audit entries.
- **Live data tests** (`test/integration/live.test.ts`) cover browsing (filters,
  projections, sorts, counts, stats, indexes, refused operators and namespaces), the
  settings and their production rules, the `data:write` permission, conditional writes
  and conflicts (including a change between the check and the write), type preservation,
  the sealed journal in storage and in the data directory, undo and redo, bulk caps,
  confirmations and jobs, and the audit entries; `roles.test.ts` checks that every
  write route refuses every role without the permission.
- **First-run tests** (`test/integration/first-run.test.ts`, `onboarding.test.ts`,
  `src/state/secret-key.test.ts`, `src/server/config.test.ts`,
  `src/server/connection-problems.test.ts`, `src/shared/connection-string.test.ts`) cover the
  generated secret (permissions, corruption, races, env precedence, `_FILE`), the setup
  window (the test clock and fake timers; the token still works; restarts), the
  environment admin, the default storage's idempotency, the connection check (paste
  cleaning, placeholders, raw passwords, every friendly error, per-database users), Back
  up now with its managed key and restore without typing a key, the recovery key rules,
  the nightly PUT and the public IP lookup. `docker/smoke/console-zero-setup.sh` and
  `console-srv-tls.sh` run the real image in CI (no env, fresh volume; SRV + TXT + TLS
  through a CoreDNS container and a TLS mongod).
- **OIDC tests** run the whole redirect flow against an in-process fake provider
  (`test/helpers/oidc-provider.ts`: a real HTTP server with discovery, JWKS and a token
  endpoint that checks PKCE and client authentication and signs RS256/ES256/EdDSA tokens),
  with one test per rejection the relying party makes.
- **Unit tests** sit next to the code (`src/**/*.test.ts`): state store, lock, crypto,
  runner, schedules, storage, validation, JOSE and OIDC settings.
- **UI unit tests** use Vitest with Testing Library against the mock backend
  (`src/ui/mock`), through the real router, API client and session handling.
- Coverage of `packages/console` is kept at or above 85% of lines and 80% of branches
  (`pnpm --filter @mongoshield/console coverage`).
- **End-to-end tests** (`pnpm --filter @mongoshield/console test:e2e`, Playwright and
  Chromium, in CI as the `e2e` job) drive the BUILT console (`dist/server/main.mjs`) on
  a random port with a temporary data directory, local file storage and a real mongod
  with authentication (`e2e/global-setup.ts`). `e2e/journey.spec.ts` is the whole
  admin journey: first-run setup with the link from the server log, connections (the
  secret is never shown again), storage, a plan (namespace picker, age recipients,
  schedule preview), run now with live progress, verification, the document browser,
  restoring selected documents, a restore preview over them (counts, the effect of
  upsert, an edited document's fields), and a whole backup into production (preview,
  typed name, private key) with the data checked in MongoDB, a drill, hold/release, a
  prune dry run, the audit log and sign-out. `e2e/onboarding.spec.ts` takes the quick path
  (paste, check, save, Back up now, the recovery key download, check, nightly, restore) and
  counts the clicks: three from the setup page to a running backup. The other specs cover what viewers and operators see and what
  the API refuses them, CSRF (including a tab whose token went stale), the theme
  toggle, keyboard-only use of the restore wizard (through its preview, down to one
  document), and an accessibility smoke check on
  every page (landmarks, a level-1 heading, labelled controls, named buttons and links,
  `alt` on images). Every test fails on a console error or a CSP violation. Build first
  (`pnpm --filter mongoshield build && pnpm --filter @mongoshield/console build`);
  locally, `MONGOMS_SYSTEM_BINARY=$(which mongod)` skips the mongod download.
