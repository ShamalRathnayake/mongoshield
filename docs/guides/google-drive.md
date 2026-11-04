# Google Drive

Back up into your own Google Drive with `gdrive://` storage. A free Google account has
15 GB, needs no credit card, and MongoShield talks to the Drive API with plain `fetch`,
so there is no SDK to install.

The quickest way to set everything up, including a nightly GitHub Actions workflow, is
one command (the full walkthrough is in
[Atlas Free + Netlify in 10 minutes](atlas-free-netlify.md)):

```bash
npx mongoshield init --github
```

This guide explains what that sets up, and how to use Google Drive storage by hand.

## Quick start

```bash
npx mongoshield login gdrive        # shows a code; approve it on any device
export MONGOSHIELD_GDRIVE_TOKEN='1//0g…'   # the token login printed
export MONGODB_URI='mongodb+srv://backup:<password>@cluster0.abcde.mongodb.net/'
npx mongoshield backup --to gdrive://my-app --recipient age1…
npx mongoshield list --from gdrive://my-app
```

`login gdrive` uses Google's sign-in for TVs and other devices without a keyboard. It
prints a short code and a link (`https://www.google.com/device`). Open the link on any
device, your phone works, sign in, enter the code and choose **Allow**. This also works
over SSH and in Codespaces, where no local browser can open.

What login prints is a **refresh token**. Store it as the secret
`MONGOSHIELD_GDRIVE_TOKEN` (a GitHub Actions secret, or your platform's secret store). It
is the only credential `gdrive://` needs. Treat it like a password: anyone who has it can
read and delete the backups MongoShield wrote (and nothing else in your drive).

## Where backups go

MongoShield creates one folder in **My Drive** the first time it runs, named
`MongoShield`. `gdrive://<folder>` is a folder inside it, created on first use too:

| URL | Folder in My Drive |
|---|---|
| `gdrive://my-app` | `MongoShield/my-app/` |
| `gdrive://acme/prod` | `MongoShield/acme/prod/` |

Every storage key becomes folders plus a file, so the drive shows the usual layout:

```
MongoShield/
  my-app/
    backups/
      2026-11-14T03-17-04Z_7f3a9c/
        manifest.json
        app/
          users.metadata.json.age
          users.bson.zst.age
    _state/
      recovery-kit.age
```

MongoShield finds its folder again by a private marker that only it can see, not by
its name. You can rename the `MongoShield` folder or move it inside My Drive, and
backups keep working. Don't move files out of it or rename files inside it: MongoShield
reads backups by their names.

### Permissions

MongoShield asks for one permission, `drive.file`: "see, edit, create and delete only
the specific Google Drive files you use with this app". It can't see your other files.
The flip side: files you copy into the folder by hand are invisible to MongoShield, so
you can't add a backup to it by uploading one in the browser.

## The URL

```
gdrive://<folder>[/<more folders>][?chunkSizeMiB=<n>]
```

| Parameter | Default | Meaning |
|---|---|---|
| `chunkSizeMiB` | `8` | Size of each upload request for large files, in MiB. One chunk per upload is held in memory, so it can be sent again after a network error |

The token never goes in the URL. A URL with a user name or password is refused.

## Environment variables

| Variable | Meaning |
|---|---|
| `MONGOSHIELD_GDRIVE_TOKEN` | The refresh token from `mongoshield login gdrive`. A secret |
| `MONGOSHIELD_GDRIVE_CLIENT_ID` | Your own OAuth client, instead of MongoShield's (see [below](#your-own-oauth-client)) |
| `MONGOSHIELD_GDRIVE_CLIENT_SECRET` | That client's secret |

A token belongs to the OAuth client that issued it. If you switch clients, run
`mongoshield login gdrive` again.

## In GitHub Actions

`init --github` writes this workflow. Set the secrets `MONGODB_URI` and
`MONGOSHIELD_GDRIVE_TOKEN`, and the repository variable `MONGOSHIELD_RECIPIENTS` (your
`age1…` public key):

```yaml
# .github/workflows/mongoshield-backup.yml
name: MongoShield backup

on:
  schedule:
    - cron: "17 3 * * *"
  workflow_dispatch:

# Google Drive cannot hold a storage lock, so GitHub keeps runs apart instead.
concurrency:
  group: mongoshield-backup
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
        with:
          persist-credentials: false
      - name: Check the encryption key is set
        env:
          RECIPIENTS: ${{ vars.MONGOSHIELD_RECIPIENTS }}
        run: |
          if [ -z "$RECIPIENTS" ]; then
            echo "::error::Set the repository variable MONGOSHIELD_RECIPIENTS to your age1… public key."
            exit 1
          fi
      - uses: ShamalRathnayake/mongoshield/action@<commit-sha> # v2.1.0
        with:
          command: run
          config: mongoshield.config.json
          uri: ${{ secrets.MONGODB_URI }}
          recipients: ${{ vars.MONGOSHIELD_RECIPIENTS }}
        env:
          MONGOSHIELD_GDRIVE_TOKEN: ${{ secrets.MONGOSHIELD_GDRIVE_TOKEN }}
```

with this config next to it:

```json
{
  "storage": "gdrive://my-app",
  "schedule": { "cron": "17 3 * * *", "lock": "none", "verify": "fast" },
  "retention": { "last": 7, "weekly": 4, "monthly": 6 }
}
```

`command: run` takes the backup, verifies it and prunes old backups with the
retention policy. See [GitHub Actions](github-actions.md) for the action's inputs.

## In code

```ts
import { MongoShield } from "mongoshield";
import { gdriveStorage } from "mongoshield/storage/gdrive";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI },
  storage: gdriveStorage({
    folder: "my-app",
    refreshToken: process.env.MONGOSHIELD_GDRIVE_TOKEN,
    clientId: process.env.MONGOSHIELD_GDRIVE_CLIENT_ID,
    clientSecret: process.env.MONGOSHIELD_GDRIVE_CLIENT_SECRET,
  }),
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
});
```

| Option | Default | Meaning |
|---|---|---|
| `folder` | required | Folder path inside the app folder, e.g. `"my-app"` or `"acme/prod"` |
| `refreshToken` | | The token from `mongoshield login gdrive` |
| `clientId`, `clientSecret` | | The OAuth client the refresh token belongs to |
| `accessToken` | | An access token, or an async function returning one, instead of a refresh token. The function is called again after a 401 |
| `chunkSize` | 8 MiB | Upload chunk size in bytes, a multiple of 256 KiB |
| `appFolderName` | `"MongoShield"` | Name of the app folder when it is created |
| `deleteConcurrency` | `8` | Files deleted in parallel |
| `retries` | `7` | Retries after a rate limit, a 5xx or a network error |
| `retryBaseMs` | `1000` | First retry delay, doubled each time up to 32 s |
| `requestTimeoutMs` | `60000` | How long one request may wait for a response |

## How it behaves

- **Uploads.** Files up to 5 MiB go up in one request. Larger ones use Drive's
  resumable upload in chunks, read from the backup stream as they are sent, so memory
  stays at about one chunk per file. Drive creates the file only when the last chunk
  arrives: a failed or cancelled upload leaves nothing behind. Every upload is checked
  against the MD5 Drive computes.
- **Overwrites.** Drive allows several files with the same name in one folder. When
  MongoShield replaces a file (a manifest, a state file), it uploads the new one first,
  then deletes the older ones. Readers always use the newest file of a name, so they
  never see two versions or a half-written one.
- **No locks.** Drive can't refuse a file name that already exists, so MongoShield can't
  keep its storage lock there. For `gdrive://`, `schedule.lock` defaults to `"none"`.
  Make sure only one backup runs at a time: in GitHub Actions, `concurrency:
  mongoshield-backup` does that. Don't set `schedule.lock: "storage"` with Google
  Drive; use `"mongo"` (a lock document in the source database) if several schedulers
  could start at once.
- **Deletes are permanent.** Pruning deletes files directly, not into the Drive trash,
  so space is freed at once. Folders a delete leaves empty are removed too, except the
  ones right under your folder (`backups/`, `_state/`).
- **Free space.** Before each backup MongoShield reads the account's quota and refuses
  to start when the backup clearly won't fit. The 15 GB of a free account are shared
  with Gmail and Google Photos, and files in the trash still count.
- **Rate limits.** Google answers busy periods with 403 `rateLimitExceeded` /
  `userRateLimitExceeded` or 429. MongoShield waits and retries with exponential
  backoff, as Google recommends.
- **No immutable backups.** Drive has no write-once retention, so `retainDays` is
  refused with `MS_CONFIG_INVALID`. See [immutable backups](immutable-backups.md) for
  storage that supports it.

## Limits

| Limit | Value |
|---|---|
| Free storage | 15 GB per Google account, shared with Gmail and Photos |
| Largest file | 5 TB (a single collection part; MongoShield's parts are far smaller) |
| Refresh tokens | expire after 6 months without use; at most 100 per Google account per OAuth client (the oldest stops working when a new one is issued) |
| API quota | one quota per OAuth client, shared by every user of that client |

Nightly backups use the token every day, so it doesn't expire from disuse. Logging in
more than 100 times with the same account silently invalidates the oldest token, which
matters only if you log in again and again (for example on many machines).

## Your own OAuth client

MongoShield ships an OAuth client, and its quota is shared by all MongoShield users. If
you back up often or a lot, or your organisation wants its own app, create one:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project
   and enable the **Google Drive API**.
2. **Google Auth Platform → Branding**: fill in the app name and support email.
   **Audience**: External (or Internal for a Workspace organisation). **Data access**:
   add the scope `https://www.googleapis.com/auth/drive.file`.
3. **Clients → Create client**, type **TVs and Limited Input devices**. Copy the
   client id and secret.
4. Set `MONGOSHIELD_GDRIVE_CLIENT_ID` and `MONGOSHIELD_GDRIVE_CLIENT_SECRET`, run
   `mongoshield login gdrive`, and set the same two variables wherever backups run.

The client secret of this client type is not confidential (Google treats it as part of
an installed app), but there is no reason to publish it either.

**Publish the app.** While an app's publishing status is **Testing**, Google expires
its refresh tokens after **7 days**, and nightly backups would stop after a week. Set
the publishing status to **In production**. Because `drive.file` is a non-sensitive
scope, that needs Google's brand verification but no security assessment. An app used
only inside a Workspace organisation (Audience: Internal) has no such limit.

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `MS_CONFIG_INVALID` "Google Drive storage needs a token in MONGOSHIELD_GDRIVE_TOKEN" | the variable is not set where the backup runs | set the secret, and pass it to the step (`env:` in GitHub Actions) |
| `MS_CONFIG_INVALID` "No Google OAuth client is configured" | this build has no shipped client, or the client variables are empty | set `MONGOSHIELD_GDRIVE_CLIENT_ID` and `_CLIENT_SECRET` ([your own client](#your-own-oauth-client)) |
| `MS_CONFIG_INVALID` "does not support conditional writes" | `schedule.lock` is `"storage"` | set `schedule.lock: "none"` (and a `concurrency:` group), or `"mongo"` |
| `MS_STORAGE_FORBIDDEN` "Google refused the Google Drive token … revoked or has expired" | the token expired (6 months unused, 7 days with an app in Testing, or more than 100 newer tokens), or someone removed MongoShield's access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) | run `mongoshield login gdrive` again and update the secret |
| `MS_STORAGE_FORBIDDEN` with a quota hint | Google's API quota was used up even after retries | try later, or use [your own client](#your-own-oauth-client) |
| `MS_STORAGE_INSUFFICIENT_SPACE` | the Google account is full | empty the Drive trash, delete large Gmail attachments or Photos, prune old backups (`mongoshield prune`), or buy more storage |
| `MS_ABORTED` "The Google login was declined" | **Allow** wasn't chosen on the approval page | run `mongoshield login gdrive` again |
| `MS_TIMEOUT` "The Google login code expired" | the code wasn't approved in time | run it again and approve within a few minutes |

## Restoring

Restoring reads from the same URL:

```bash
export MONGOSHIELD_GDRIVE_TOKEN='1//0g…'
npx mongoshield restore --from gdrive://my-app --rename 'app.*=app_restored.*'
```

Without `--identity-file`, `restore` uses the recovery kit that `init --github` put in
the drive: it asks for the kit's passphrase (or reads `MONGOSHIELD_RECOVERY_PASSPHRASE`).
See [the recovery kit](../specs/ENCRYPTION.md#recovery-kit).

To restore without MongoShield's Drive support, download the folder from
drive.google.com (it arrives as a zip) and restore from the unzipped directory:
`npx mongoshield restore --from ./my-app`.
