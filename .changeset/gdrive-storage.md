---
"mongoshield": minor
---

Google Drive storage, end to end:

- `gdrive://<folder>` storage (and `gdriveStorage` from `mongoshield/storage/gdrive`): backups go into a `MongoShield` folder in the user's My Drive, with keys mapped to nested folders. It uses the Drive API with plain `fetch` (no SDK) and only the `drive.file` permission. Large files go up as resumable uploads in 256 KiB-multiple chunks while they stream; overwrites never show two versions; deletes are permanent; rate limits are retried with backoff; `space()` reports the account's quota. Google Drive has no conditional writes, so `schedule.lock` defaults to `"none"` there and GitHub Actions' `concurrency:` keeps runs apart.
- `mongoshield login gdrive`: Google's device sign-in (approve a code on any device, also over SSH). The refresh token goes in `MONGOSHIELD_GDRIVE_TOKEN`; bring your own OAuth client with `MONGOSHIELD_GDRIVE_CLIENT_ID` / `_CLIENT_SECRET`.
- `mongoshield init --github`: generates an age key pair (public key in the repository variable `MONGOSHIELD_RECIPIENTS`, private key saved locally), writes `.github/workflows/mongoshield-backup.yml` (nightly backup, verify and retention `{ last: 7, weekly: 4, monthly: 6 }`) and the config, sets the secrets with `gh` (or prints the commands), and starts and follows the first run.
- The recovery kit: a passphrase-protected copy of the secret key at `_state/recovery-kit.age` in the storage. `restore` uses it when no identity is given, asking for the passphrase or reading `MONGOSHIELD_RECOVERY_PASSPHRASE`. It is optional and changes nothing in the backup format.
- New guides: [Google Drive](docs/guides/google-drive.md) and [Atlas Free + Netlify in 10 minutes](docs/guides/atlas-free-netlify.md), and an example of a Netlify scheduled function starting a background function (undocumented behaviour, small databases only).
