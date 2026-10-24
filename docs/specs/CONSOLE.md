# MongoShield Console

Status: implemented (phase P7), including OIDC sign-in, config import, on-demand
pruning and the journal recovery-point metric. This document is the contract for the
implementation.

The console is a self-hosted web UI for everything around backups. You start one
container, open a browser, add a connection and a storage location, and get
scheduled, verified, encrypted backups with a point-and-click restore. It is
deliberately **not** a data browser like MongoDB Compass: you can't edit live
documents, run arbitrary queries or build aggregations. Leaving those out keeps it
focused, and it keeps the security risk of a web app holding production credentials
as small as possible.

```bash
docker run -p 8080:8080 -v mongoshield:/data \
  -e MONGOSHIELD_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/shamalrathnayake/mongoshield-console
# The log prints a one-time setup link: http://localhost:8080/setup?token=…
```

## Architecture

```
packages/console          npm: @mongoshield/console (bin: mongoshield-console)
  src/server/             Hono app on @hono/node-server: REST API + static UI
  src/state/              the console's own data: one JSON document + audit log, atomic writes
  src/jobs/               in-process job runner (backup / restore / verify / drill / prune)
  src/server/oidc/        OIDC relying party: discovery, JWKS, ID token checks (node:crypto only)
  src/ui/                 React 19 + Vite single-page app, built into dist/ui
```

- The **server** uses only the public `mongoshield` API (`MongoShield`, `runScheduledJob`,
  `BackupScheduler`, `listBackups`, `findInBackup`, …). Nothing the UI can do is
  impossible from the CLI or the library.
- **State** lives in `/data/console.json`, written atomically (write to a temp file,
  fsync, rename). Secrets inside it (URIs, storage credentials, age identities,
  passphrases) are encrypted with AES-256-GCM, using a key derived (HKDF) from
  `MONGOSHIELD_SECRET`. Without that variable the console refuses to start. The API
  never returns a secret, only `"configured": true` and a redacted preview.
- **Audit log:** `/data/audit.jsonl`, one line per action: who, what, when, target and
  outcome. It is append-only and shown in the UI.
- **Jobs** run in the server process, one at a time per connection. They are scheduled
  with the same `BackupScheduler` and lock as `mongoshield schedule`, so a console and a
  CronJob can safely share a storage location. Live progress streams to the UI over
  Server-Sent Events.

## Security

1. **No default password.** The first start prints a single-use setup token to the logs.
   `/setup?token=…` creates the first admin. The token expires after use or after 24 hours.
2. **Passwords** are hashed with scrypt (N=2^17). Sessions use a random 256-bit id in an
   `HttpOnly; Secure; SameSite=Strict` cookie, with an idle timeout of 12 hours. A CSRF
   token is required on every state-changing request. Login is rate-limited.
3. **Roles:** `viewer` (read everything except secrets), `operator` (run backups,
   verifies and drills, restore into non-production targets), `admin` (everything,
   including connections, storage, users and restores into connections marked
   "production").
4. **SSO:** OIDC (authorization code + PKCE, see below), or trusted reverse-proxy
   headers (`X-Forwarded-User`, accepted only together with a shared secret header the
   proxy sets).
5. **Restore safety:** restore and copy show a dry-run plan first. A restore into a
   connection marked "production" requires typing the connection's name to confirm.
6. **Headers:** a strict CSP (no inline scripts), `X-Frame-Options: DENY`, `Referrer-Policy:
   no-referrer`, and HSTS when served over TLS.
7. **Release gate:** the checklist in `docs/console-security.md` follows OWASP ASVS
   level 1, and every item is covered by an automated test where possible.

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

## API (JSON, under `/api`)

| Resource | Endpoints |
|---|---|
| session | `POST /session` (login) · `DELETE /session` · `GET /session` · `POST /setup` |
| users | CRUD (admin) |
| connections | CRUD · `POST /connections/:id/test` (connects and checks privileges) · `GET /connections/:id/namespaces` (database/collection tree with counts, sizes and index counts) |
| storage | CRUD · `POST /storage/:id/test` (write, read and delete a probe object) |
| plans | backup plans = connection + storage + selection + encryption + schedule + retention + notifications · CRUD · `POST /plans/:id/run` · `POST /plans/:id/prune/plan` (dry run) · `POST /plans/:id/prune` (job) |
| backups | `GET /storage/:id/backups` (catalog) · `GET /…/:backupId` (manifest + annotations) · verify · drill · hold/release |
| browse | `GET /…/:backupId/namespaces/:ns/documents?filter=&limit=&after=` (read-only, uses `findInBackup`) |
| restore | `POST /restore/plan` (dry run) · `POST /restore` (job) |
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

Overview (last runs, next runs, recovery point, warnings) · Connections · Storage ·
Backup plans · Backups (list with "Apply retention…" → backup detail with namespaces,
verification, drills, holds, a document browser and a restore wizard; the wizard
takes a passphrase or age private keys for backups the console cannot decrypt itself,
used for that restore only and never stored) · Jobs (live
progress) · Audit · Users (with SSO-only accounts) · Settings (export and import of
the config) · Login (password and "Sign in with single sign-on").

The visual design is calm and information-dense, like an ops tool. Status is shown
with words and shape as well as color, light and dark themes are supported, and the
whole UI works with the keyboard.

## Tests

- **API tests** run against an in-process server with a real mongod (the test replica
  set) and memory storage. They cover each endpoint's authorization by role, CSRF
  rejection, secret redaction, the setup token's lifecycle and the audit entries.
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
  restoring selected documents and a whole backup into production (typed name, private
  key) with the data checked in MongoDB, a drill, hold/release, a prune dry run, the
  audit log and sign-out. The other specs cover what viewers and operators see and what
  the API refuses them, CSRF (including a tab whose token went stale), the theme
  toggle, keyboard-only use of the restore wizard, and an accessibility smoke check on
  every page (landmarks, a level-1 heading, labelled controls, named buttons and links,
  `alt` on images). Every test fails on a console error or a CSP violation. Build first
  (`pnpm --filter mongoshield build && pnpm --filter @mongoshield/console build`);
  locally, `MONGOMS_SYSTEM_BINARY=$(which mongod)` skips the mongod download.
