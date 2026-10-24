---
"@mongoshield/console": minor
---

Zero-setup console: `docker run -p 8080:8080 -v mongoshield:/data ghcr.io/shamalrathnayake/mongoshield-console`
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
