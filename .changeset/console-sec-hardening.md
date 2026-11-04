---
"@mongoshield/console": minor
---

Console security hardening.

- **DNS rebinding:** the API now answers only to IP addresses, loopback, single-label and private names (`.local`, `.internal`, `.svc`, `.lan`, `.home.arpa`), the host of `MONGOSHIELD_PUBLIC_URL` and the new `MONGOSHIELD_ALLOWED_HOSTS` (`*` turns the check off). Other host names get `421 CONSOLE_UNKNOWN_HOST`, so a web page can no longer claim a fresh console during the setup window. **If you open the console by a public DNS name without setting `MONGOSHIELD_PUBLIC_URL`, set it (or `MONGOSHIELD_ALLOWED_HOSTS`).**
- **Reverse proxies:** new `MONGOSHIELD_TRUSTED_PROXIES` (IPs or CIDR ranges). Only from those peers are `X-Forwarded-For` (rate limits, audit) and `X-Forwarded-Host` (origin check) believed. The cross-site refusal now points at `MONGOSHIELD_PUBLIC_URL`.
- **Sub-paths:** `MONGOSHIELD_PUBLIC_URL=https://example.com/mongoshield` serves the console under that path (relative UI assets and API calls, prefixed routes, OIDC redirects and callback).
- **Sign-in:** attempts are counted before the password check (parallel guesses are limited); setup is rate-limited per address only; throttled logins are audited at most once per address and minute; the sign-in page warns about plain HTTP with Secure cookies, like the setup page.
- **OIDC:** prepared accounts are linked only by a verified email (`email_verified: true`) or the exact subject, never by `preferred_username`; a looping client can only evict its own pending sign-ins.
- **Roles:** the config export needs `admin`; non-admins see the audit log without client addresses and without usernames typed at failed sign-ins. Admins can sign a user out everywhere (`POST /api/users/:id/sign-out`, a "Sign out" button on the Users page).
- **Setup token:** valid for 1 hour instead of 24.
- **Secrets:** errors and job logs are scrubbed of storage credentials, SFTP keys, webhook URLs, the webhook secret, the OIDC client secret, the proxy secret and the metrics token too. Connection previews hide `proxyPassword`. Azure SAS tokens are refused in `endpoint=` (use the new encrypted `AZURE_STORAGE_SAS_TOKEN` credential) and hidden in old locations.
- **Targets:** webhooks and storage endpoints may not point at cloud metadata or link-local addresses, Azure's managed identity is used only with Azure Storage endpoints, and connection strings using `MONGODB-OIDC` with `ENVIRONMENT` are refused, unless `MONGOSHIELD_ALLOW_UNSAFE_TARGETS=true`.
- **Data safety:** restores into existing data checksum every file first (like the CLI), and a restore's unfinished namespaces are saved with the job so a crash still names what may be partial. Local storage cannot overlap the console's own files or the live edit journal.
- **Injection:** the exported `mongoshield.config.ts` escapes `*/`, U+2028 and U+2029; the live browser finds `$where` and friends inside DBRefs and code scopes too.
