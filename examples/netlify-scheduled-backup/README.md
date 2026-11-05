# Netlify: scheduled backup to Google Drive

> **Read this first.** This example relies on **undocumented behaviour**: Netlify
> documents scheduled functions and background functions, but not a scheduled function
> starting a background one. It works at the time of writing and may stop working
> without notice. It is meant for **small databases** only: a scheduled function stops
> after 30 seconds, and a background function after 15 minutes. The recommended way to
> back up a Netlify app is GitHub Actions: `npx mongoshield init --github`
> ([Atlas Free + Netlify in 10 minutes](../../docs/guides/atlas-free-netlify.md)).

Two functions:

- [`backup-schedule.mts`](./netlify/functions/backup-schedule.mts), a **scheduled
  function** (`schedule: "@daily"`), calls the background function with a shared secret
  and returns at once.
- [`backup-background.mts`](./netlify/functions/backup-background.mts), a **background
  function** (the `-background` suffix makes it one), backs up to Google Drive, verifies
  the backup and prunes old ones (keeps the last 7, plus 4 weekly and 6 monthly).

## Setup

1. Copy `netlify/functions/` and `netlify.toml` into your site (merge the `[functions]`
   section if you have one), and install the packages:

   ```bash
   npm install mongoshield mongodb
   npm install -D @netlify/functions
   ```

2. Create the keys and the Google Drive token on your machine:

   ```bash
   npx mongoshield keygen --output backup.key   # keep backup.key offline; note the age1… key
   npx mongoshield login gdrive                 # approve the code; note the token
   ```

3. In the Netlify UI (**Site configuration → Environment variables**), set:

   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | connection string of a read-only user (**Only read any database** on Atlas) |
   | `MONGOSHIELD_GDRIVE_TOKEN` | the token from `mongoshield login gdrive` (mark it secret) |
   | `MONGOSHIELD_RECIPIENTS` | the `age1…` public key from `keygen` |
   | `BACKUP_TRIGGER_SECRET` | a long random string (`openssl rand -hex 32`) |
   | `BACKUP_FOLDER` | optional: folder inside the drive's `MongoShield` folder, default `netlify` |
   | `MONGOSHIELD_GDRIVE_CLIENT_ID`, `MONGOSHIELD_GDRIVE_CLIENT_SECRET` | only with your own OAuth client |

4. Deploy. To test, run the scheduled function from the Netlify UI (the function's page
   has a **Run now** button), then watch the `backup-background` log.

## Limits to know

- **Time.** The background function aborts the backup 90 s before its 15-minute limit,
  to leave time for verifying and pruning. An aborted backup is never marked complete,
  but nothing retries it the same night. On an Atlas Free cluster, whose throughput is
  capped, that means databases of roughly tens of megabytes.
- **No locking.** Google Drive can't hold MongoShield's storage lock. A daily schedule
  doesn't overlap itself, but don't also back up into the same folder from somewhere
  else at the same time.
- **Failures are quiet.** Errors only appear in the function log. Add a heartbeat (see
  [observability](../../docs/guides/observability.md)) if you want to hear about them.
- **Atlas IP access list.** Netlify functions have no fixed outgoing IP addresses, so
  the cluster must allow `0.0.0.0/0`. Keep the backup user read-only, with a long
  random password.

More on the storage: [Google Drive](../../docs/guides/google-drive.md).
