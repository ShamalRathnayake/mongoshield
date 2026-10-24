# MongoShield console: security checklist

This is the release gate for `@mongoshield/console`. It follows the spirit of
[OWASP ASVS 4.0](https://owasp.org/www-project-application-security-verification-standard/)
level 1, limited to what applies to a self-hosted, single-process admin console.
Each item names where it is implemented and which automated test covers it.
Paths are relative to `packages/console/`.

Status: ✅ implemented and tested · 🟡 implemented, tested only in part or by review · ⏳ follow-up

## V2 Authentication

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 2.1 | No default credentials. The first admin is created with a single-use setup token printed at startup | `src/state/sessions.ts` (`issueSetupToken`), `src/server/routes/session.ts` (`POST /api/setup`), `src/server/services.ts` | `test/integration/auth.test.ts` "setup token" | ✅ |
| 2.2 | The setup token is random (256 bit), stored hashed, expires after 24 h, works once, and is replaced at every start until setup is done | `src/state/sessions.ts` | `auth.test.ts` (expiry, reuse, restart), `src/state/sessions.test.ts` | ✅ |
| 2.3 | Passwords are at least 12 characters, at most 1024; no composition rules (NIST 800-63B) | `src/server/routes/session.ts` (`passwordField`) | `auth.test.ts` "requires a strong enough password", `resources.test.ts` "weak passwords" | ✅ |
| 2.4 | Passwords are stored with scrypt, N = 2^17, r = 8, p = 1, a 16-byte random salt, and parameters stored with each hash | `src/state/passwords.ts` | `src/state/passwords.test.ts` | ✅ |
| 2.5 | Password checks are constant-time; a stored hash cannot claim a cost outside 2^14–2^20 (no downgrade, no memory exhaustion) | `src/state/passwords.ts` (`verifyPassword`) | `passwords.test.ts` "downgraded hashes" | ✅ |
| 2.6 | Unknown users and wrong passwords get the same response and take the same time (no username enumeration) | `routes/session.ts`, `passwords.ts` (`verifyAgainstDummy`) | `auth.test.ts` "same answer for unknown users" | ✅ |
| 2.7 | Login (and setup) are rate limited: 10 failures per 15 min per username and per client address, `429` + `Retry-After` | `src/server/rate-limit.ts`, `routes/session.ts` | `auth.test.ts` "rate-limits", `src/server/rate-limit.test.ts` | ✅ |
| 2.8 | Changing a user's password ends all of that user's sessions | `src/server/routes/users.ts` | `auth.test.ts` "signs a user out everywhere" | ✅ |
| 2.9 | SSO via a trusted reverse proxy: `X-Forwarded-User` is accepted only with the shared secret in `X-MongoShield-Proxy-Secret` (constant-time compare, ≥ 32 characters); a wrong secret is refused; new proxy users start as `viewer` | `src/server/auth.ts`, `src/server/config.ts` | `auth.test.ts` "trusted reverse proxy" | ✅ |
| 2.10 | OIDC (authorization code + PKCE) | n/a | n/a | ⏳ use the proxy mode (oauth2-proxy, Authelia, Pomerium) meanwhile |

## V3 Session management

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 3.1 | Session ids are 256-bit CSPRNG values; only their SHA-256 is stored | `src/state/sessions.ts`, `src/state/crypto.ts` | `auth.test.ts` "stores only hashes", `sessions.test.ts` | ✅ |
| 3.2 | A new session id at every login (no session fixation) | `routes/session.ts` (`startSession`) | `auth.test.ts` login tests | ✅ |
| 3.3 | Cookie is `HttpOnly; Secure; SameSite=Strict; Path=/` with the `__Host-` prefix (Secure can only be turned off explicitly with `MONGOSHIELD_COOKIE_SECURE=false`) | `src/server/auth.ts` (`setSessionCookie`) | `auth.test.ts` "hardened cookie" | ✅ |
| 3.4 | Idle timeout 12 h; absolute lifetime 7 days | `src/state/sessions.ts` (`isAlive`) | `auth.test.ts` "12 idle hours", `sessions.test.ts` | ✅ |
| 3.5 | Logout invalidates the session server side | `routes/session.ts` (`DELETE /api/session`) | `auth.test.ts` "logs out" | ✅ |
| 3.6 | Deleting a user ends their sessions immediately; role changes apply on the next request | `routes/users.ts`, `sessions.ts` (`findSession` reads the user) | `sessions.test.ts` "user is deleted" | ✅ |

## V4 Access control

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 4.1 | Every route checks the role server side (`viewer` < `operator` < `admin`); anonymous requests get `401` | `src/server/auth.ts` (`requireRole`), every file in `src/server/routes/` | `test/integration/roles.test.ts`: the matrix is typed against `ApiRoutes`, so a new route without a decision fails to compile | ✅ |
| 4.2 | Operators restore and drill only into connections not marked production | `routes/restore.ts`, `routes/backups.ts` | `backups.test.ts` "does not let operators restore/drill into production" | ✅ |
| 4.3 | Restores into production need an admin and the connection's name typed as `confirmName` | `routes/restore.ts` | `backups.test.ts` "requires admins to type…" | ✅ |
| 4.4 | Restore shows a dry-run plan first; the library refuses plans with conflicts | `routes/restore.ts` (`POST /api/restore/plan`) | `backups.test.ts` "plans a restore", "reports conflicts" | ✅ |
| 4.4a | Restores of selected documents (`filter`) touch only matching documents, show matching counts in the plan, refuse an empty filter, and follow the same production rules | `jobs/tasks.ts` (`planRestoreView`, `restoreJob` via `shield.restoreTenant`) | `backups.test.ts` "restoring selected documents" | ✅ |
| 4.5 | The last admin can be neither demoted nor deleted; nobody deletes their own account | `routes/users.ts` | `resources.test.ts` "protects the last admin" | ✅ |
| 4.6 | Browsing backup documents (customer data) needs `operator`; releasing a hold needs `admin` | `routes/backups.ts` | `roles.test.ts`, `backups.test.ts` "hold" | ✅ |
| 4.7 | CSRF: every state-changing request of a signed-in principal carries `x-csrf-token` = HMAC(key from `MONGOSHIELD_SECRET`, session) | `src/server/auth.ts` (`csrfProtection`), `sessions.ts` | `auth.test.ts` "CSRF and origin checks" | ✅ |
| 4.8 | State-changing requests with a foreign `Origin` are refused (also for login and setup) | `src/server/security.ts` (`sameOriginOnly`) | `auth.test.ts` "refuses cross-site requests" | ✅ |
| 4.9 | Local storage paths must stay inside the data directory | `src/jobs/storage.ts` (`localPathOf`) | `resources.test.ts` "refuses local paths outside" | ✅ |

## V5 Validation, sanitization and encoding

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 5.1 | Bodies must be `application/json` (no form-based CSRF) and at most 64 KiB | `security.ts` (`readJson`), `app.ts` (`bodyLimit`) | `auth.test.ts` "only accepts JSON", "limits request bodies" | ✅ |
| 5.2 | Every field is validated for type, length and allowed values; unknown fields are ignored; names cannot contain control characters | `src/server/validate.ts`, routes | `resources.test.ts` validation cases | ✅ |
| 5.3 | Backup ids in URLs are checked against the id format before reaching storage | `validate.ts` (`backupIdParam`) | `roles.test.ts` / `backups.test.ts` 404 cases | ✅ |
| 5.4 | Document filters are parsed as Extended JSON and run in-process by the library (no queries against live databases); page size ≤ 100, 60 s scan limit | `routes/backups.ts` | `backups.test.ts` "browsing documents" | ✅ |
| 5.5 | The exported `mongoshield.config.ts` cannot be used for code injection: all values are `JSON.stringify`-escaped, identifiers are `[A-Za-z0-9]` with a `plan` prefix | `src/server/config-export.ts` | `src/server/config-export.test.ts` (hostile plan name) | ✅ |
| 5.6 | Prometheus label values are escaped | `routes/health.ts` (`escapeLabel`) | review | 🟡 |

## V6 Stored cryptography

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 6.1 | The console refuses to start without `MONGOSHIELD_SECRET` (≥ 32 characters) and explains why | `src/server/config.ts`, `src/state/store.ts` | `src/server/config.test.ts`, `store.test.ts` | ✅ |
| 6.2 | Stored secrets (URIs, storage credentials, passphrases, webhook URLs) are encrypted with AES-256-GCM, random 96-bit IV, key = HKDF-SHA256(secret, per-directory salt, `mongoshield-console/v1`) | `src/state/crypto.ts`, `src/state/secrets.ts` | `crypto.test.ts`, `resources.test.ts` "console.json free of plaintext secrets" | ✅ |
| 6.3 | Each ciphertext is bound to its record and field (GCM additional data), so ciphertexts cannot be swapped between records | `crypto.ts`, `secrets.ts` | `crypto.test.ts` "moved to another context" | ✅ |
| 6.4 | Starting with a different secret fails immediately (key check value) | `store.ts` (`assertKeyMatches`) | `store.test.ts`, `resources.test.ts` "refuses a different secret" | ✅ |
| 6.5 | Only `node:crypto` is used; tokens come from the CSPRNG; secrets are compared in constant time | `crypto.ts` | `crypto.test.ts` | ✅ |

## V7 Errors and logging

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 7.1 | Errors have one shape (`ApiError`); unexpected errors return a generic `CONSOLE_INTERNAL` and are logged server side only | `src/server/errors.ts`, `app.ts` (`onError`) | `runner.test.ts` "describes failures safely" | ✅ |
| 7.2 | Error messages are scrubbed: credentials in any MongoDB URI and every stored secret are replaced by `***` | `src/state/redact.ts`, `app.ts` (`knownSecrets`), `jobs/runner.ts` | `resources.test.ts` "broken connection", `runner.test.ts` | ✅ |
| 7.3 | Audit log of every change and every login attempt: who, what, target, outcome, time; append-only (`O_APPEND`), mode 0600, rotated at 50 MiB (3 old files kept) | `src/state/audit.ts`, `src/server/audit.ts`, routes | `audit.test.ts`, `backups.test.ts` "records every action" | ✅ |
| 7.4 | The audit log contains no secrets | routes pass ids, names, modes and counts only | `resources.test.ts` "audit log free of secrets" | ✅ |
| 7.5 | Reading backup contents is audited (`backup.browse`) | `routes/backups.ts` | `backups.test.ts` | ✅ |

## V8 Data protection

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 8.1 | The API never returns a secret: views copy fields one by one and show only `configured` + a redacted preview | `src/server/views.ts` | every integration file asserts no secret in **any** response (`TestClient` records all bodies) | ✅ |
| 8.2 | API responses are `Cache-Control: no-store` | `security.ts` | `auth.test.ts` "security headers" | ✅ |
| 8.3 | `console.json` (0600) is written atomically: temp file, fsync, rename, directory fsync | `src/state/atomic.ts` | `store.test.ts` "saves updates atomically" | ✅ |
| 8.4 | Only one process may own a data directory (heartbeat lock; abandoned locks are taken over after 30 s) | `src/state/lock.ts` | `store.test.ts`, `resources.test.ts` "refuses a second console" | ✅ |
| 8.5 | `/healthz` reveals nothing but liveness; `/metrics` is off unless `MONGOSHIELD_METRICS_TOKEN` is set, then needs it as a bearer token | `routes/health.ts` | `auth.test.ts` "metrics" | ✅ |

## V9 Communications

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 9.1 | HSTS (1 year) when the console is served over TLS (`MONGOSHIELD_PUBLIC_URL=https://…` or an https request) | `security.ts` | `auth.test.ts` "sends HSTS" | ✅ |
| 9.2 | TLS itself is terminated by a reverse proxy or ingress | deployment docs | n/a | 🟡 |

## V14 Configuration and HTTP headers

| # | Requirement | Where | Test | Status |
|---|---|---|---|---|
| 14.1 | Strict CSP: `script-src 'self'` (no inline scripts, no eval), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'` | `security.ts` (`CONTENT_SECURITY_POLICY`) | `auth.test.ts` "strict CSP" | ✅ |
| 14.2 | `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, COOP/CORP same-origin, restrictive `Permissions-Policy` | `security.ts` | `auth.test.ts` | ✅ |
| 14.3 | Unknown `/api` paths are JSON 404s, never the SPA's `index.html` | `app.ts` | `auth.test.ts` "unknown API paths" | ✅ |
| 14.4 | No CORS: the server never sends `Access-Control-Allow-*` | `app.ts` (no CORS middleware) | review | 🟡 |
| 14.5 | Graceful shutdown: SIGTERM stops schedules, lets running jobs finish within `MONGOSHIELD_SHUTDOWN_GRACE_SECONDS`, then aborts them | `src/server/main.ts`, `services.ts` (`closeConsole`), `jobs/runner.ts` (`shutdown`) | `runner.test.ts` "grace period at shutdown" | ✅ |

## Follow-ups

- OIDC login (authorization code + PKCE, JWKS verification with `node:crypto`).
- `POST /api/config/import`.
- A recovery-point metric from the journal (`mongoshield_recovery_point_timestamp_seconds`).
- Optional Playwright end-to-end tests (setup → connection → plan → backup → browse → restore).
