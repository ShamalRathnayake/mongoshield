---
"mongoshield": minor
---

The drive storage is now reachable everywhere storage URLs are accepted:

- `gdrive://`, `onedrive://` and `dropbox://` resolve through the storage registry like every other built-in scheme, and are published as `mongoshield/storage/gdrive`, `mongoshield/storage/onedrive` and `mongoshield/storage/dropbox`.
- `mongoshield login gdrive|onedrive|dropbox` uses each adapter's own sign-in, so the token it prints is exactly what that storage refreshes with. `login onedrive --business` also allows work and school accounts (experimental). A Dropbox sign-in over SSH or in a Codespace asks you to paste the code Dropbox shows.
- `mongoshield init --github` asks where backups go (Google Drive first), signs in to the drive, and sets up nightly encrypted backups in GitHub Actions with a first run.
- New storage capability `storageLock: false`, for storage that can never hold a storage lock. `schedule.lock` defaults to `"none"` there (Google Drive) and stays `"storage"` everywhere else.
- The shipped OAuth client IDs of all three providers live in one place, `src/storage/oauth/apps.ts`.
