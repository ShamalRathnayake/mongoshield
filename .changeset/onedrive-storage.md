---
"mongoshield": minor
---

OneDrive storage (`onedrive://<folder>`), on Microsoft Graph with plain `fetch` and no SDK:

- Backups go to the app's own folder (`Files.ReadWrite.AppFolder`). Objects under 4 MiB are uploaded in one request; larger ones are staged in a temp file and sent through an upload session in 320 KiB-multiple fragments (10 MiB by default, `fragmentSizeMiB`). Conditional writes use `conflictBehavior: fail`, so the normal storage lock works. Range reads, paged listings, the drive quota (`space()`), retries on 429/503 with `Retry-After`, and Graph errors mapped to `MS_STORAGE_*` codes. Deleted files go to the OneDrive recycle bin (kept 30 days, counted against the quota): permanent delete needs whole-drive access.
- Sign-in with the device code flow (`loginOneDrive`), personal Microsoft accounts by default; work and school accounts are experimental behind `business: true` / `?business=true`. The secret is `MONGOSHIELD_ONEDRIVE_TOKEN`.
- Token rotation: Microsoft refresh tokens expire 90 days after issue, so the newest one is written to an encrypted token state file (`MONGOSHIELD_ONEDRIVE_TOKEN_STATE`, AES-256-GCM with a key derived from the secret). The GitHub Action keeps that file in the Actions cache for `onedrive://` storage. From day 75 without working rotation, backups log a warning and report it in `BackupResult.warnings`.
- Storage adapters may report warnings of their own (`warnings()`); backups log them and add them to their result.
