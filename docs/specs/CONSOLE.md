# MongoShield Console

Status: design for phase P7. This document is the contract for the implementation.

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
4. **SSO:** OIDC (authorization code + PKCE), or trusted reverse-proxy headers
   (`X-Forwarded-User`, accepted only together with a shared secret header the proxy
   sets).
5. **Restore safety:** restore and copy show a dry-run plan first. A restore into a
   connection marked "production" requires typing the connection's name to confirm.
6. **Headers:** a strict CSP (no inline scripts), `X-Frame-Options: DENY`, `Referrer-Policy:
   no-referrer`, and HSTS when served over TLS.
7. **Release gate:** the checklist in `docs/console-security.md` follows OWASP ASVS
   level 1, and every item is covered by an automated test where possible.

## API (JSON, under `/api`)

| Resource | Endpoints |
|---|---|
| session | `POST /session` (login) · `DELETE /session` · `GET /session` · `POST /setup` |
| users | CRUD (admin) |
| connections | CRUD · `POST /connections/:id/test` (connects and checks privileges) · `GET /connections/:id/namespaces` (database/collection tree with counts, sizes and index counts) |
| storage | CRUD · `POST /storage/:id/test` (write, read and delete a probe object) |
| plans | backup plans = connection + storage + selection + encryption + schedule + retention + notifications · CRUD · `POST /plans/:id/run` |
| backups | `GET /storage/:id/backups` (catalog) · `GET /…/:backupId` (manifest + annotations) · verify · drill · hold/release |
| browse | `GET /…/:backupId/namespaces/:ns/documents?filter=&limit=&after=` (read-only, uses `findInBackup`) |
| restore | `POST /restore/plan` (dry run) · `POST /restore` (job) |
| jobs | `GET /jobs` · `GET /jobs/:id` · `GET /jobs/:id/events` (SSE) · `POST /jobs/:id/cancel` |
| audit | `GET /audit` |
| config | `GET /config/export` (as `mongoshield.config.ts`, secrets left as env references) · `POST /config/import` |
| health | `GET /healthz` · `GET /metrics` (Prometheus text format) |

## UI pages

Overview (last runs, next runs, recovery point, warnings) · Connections · Storage ·
Backup plans · Backups (list → backup detail with namespaces, verification, drills,
holds, a document browser and a restore wizard) · Jobs (live progress) · Audit ·
Users · Settings.

The visual design is calm and information-dense, like an ops tool. Status is shown
with words and shape as well as color, light and dark themes are supported, and the
whole UI works with the keyboard.

## Tests

- **API tests** run against an in-process server with a real mongod (the test replica
  set) and memory storage. They cover each endpoint's authorization by role, CSRF
  rejection, secret redaction, the setup token's lifecycle and the audit entries.
- **UI unit tests** use Vitest with Testing Library.
- **End-to-end tests** (optional, Playwright) run setup → connection → plan → backup →
  browse → restore.
