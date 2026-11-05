# Back up to OneDrive

Store encrypted MongoShield backups in your own OneDrive. A free Microsoft account comes
with 5 GB. You don't need a credit card or a cloud account.

```
onedrive://mongoshield-backups
```

MongoShield only gets access to **its own app folder** (`Apps/MongoShield/` in your
OneDrive) through the `Files.ReadWrite.AppFolder` permission. It can't see or change
anything else in your drive. The URL names a folder inside that app folder.

Personal Microsoft accounts (outlook.com, hotmail.com, live.com) are supported. Work and
school accounts are **experimental**; see [Work and school accounts](#work-and-school-accounts-experimental).

## Quick start

1. **Sign in** on any device:

   ```bash
   npx mongoshield login onedrive
   ```

   It shows a code and a link (`https://microsoft.com/devicelogin`). Open the link,
   enter the code and approve. This works over SSH and in Codespaces too. The command
   prints the value of one secret, `MONGOSHIELD_ONEDRIVE_TOKEN`.

2. **Store the secret** in your GitHub repository (Settings → Secrets and variables →
   Actions), or let `npx mongoshield init --github` do it for you:

   ```bash
   gh secret set MONGOSHIELD_ONEDRIVE_TOKEN
   ```

3. **Use it** in the backup workflow:

   ```yaml
   - uses: ShamalRathnayake/mongoshield/action@v2
     with:
       uri: ${{ secrets.MONGODB_URI }}
       storage: onedrive://mongoshield-backups
       recipients: ${{ vars.BACKUP_PUBLIC_KEY }}
     env:
       MONGOSHIELD_ONEDRIVE_TOKEN: ${{ secrets.MONGOSHIELD_ONEDRIVE_TOKEN }}
   ```

The Action keeps the sign-in alive on its own (see [Token rotation](#token-rotation)).
Nothing else is needed.

## Token rotation

This part matters if your backups run for more than three months.

Microsoft refresh tokens **expire 90 days after they were issued, even if you use them
every day**. Each time MongoShield uses one, Microsoft returns a new one with its own 90
days. If every run started from the same repository secret, backups would stop on day 90.

So MongoShield keeps the newest token:

- After every refresh it writes the new token to a **token state file**, named by
  `MONGOSHIELD_ONEDRIVE_TOKEN_STATE`. The next run starts from that file instead of the
  secret.
- The file is encrypted with AES-256-GCM, using a key derived (HKDF-SHA256) from the
  `MONGOSHIELD_ONEDRIVE_TOKEN` secret. Without the secret nobody can read the file or
  plant a different token in it. If a file doesn't decrypt with the current secret,
  MongoShield ignores it and replaces it.
- The **GitHub Action does this for you** when the storage is `onedrive://`. It restores
  the file from the Actions cache before the run and saves it afterwards, even when the
  run fails. Each run saves under a key of its own (`mongoshield-onedrive-token-<workflow>-<job>-<run>`),
  and the next run restores the newest one. The cache only ever holds ciphertext.

As long as the gap between two runs is under 90 days, the chain never breaks. A nightly
job is far inside that.

Outside the Action (cron on a server, a long-running app), set
`MONGOSHIELD_ONEDRIVE_TOKEN_STATE` to a file that survives between runs, for example
`/var/lib/mongoshield/onedrive-token.json`. MongoShield creates it with mode 0600 and
replaces it atomically.

Things to know:

- **One OneDrive account per job.** Two Action steps in the same job with different
  OneDrive sign-ins would share one cache key prefix. Put them in separate jobs.
- **The Actions cache evicts entries** nobody has used for 7 days, and the oldest
  entries once a repository goes over 10 GB. A nightly job always keeps its entry fresh.
  If the entry is lost, the next run starts from the secret again. That is fine until the
  secret is 90 days old (see below).
- **A password change revokes** every token. So does removing the app at
  https://account.live.com/consent/Manage. Sign in again after either.

## The day-75 warning

MongoShield tracks when the token a run started from was issued. The `login` value
records its own issue date, and the state file records each rotated token's. From
**day 75** a backup:

- logs a warning, and
- adds it to the backup result's `warnings`, which scheduled runs copy into the run
  report.

The warning says how old the sign-in is and on which date Microsoft stops accepting it:

```
The OneDrive sign-in in MONGOSHIELD_ONEDRIVE_TOKEN is 75 days old; Microsoft stops
accepting it 90 days after issue (2027-02-03). Rotated tokens are not being kept: …
```

With working rotation the starting token is never older than the gap between two runs,
so **you only see this warning when rotation isn't being kept**. That happens when:

- you run outside the Action without `MONGOSHIELD_ONEDRIVE_TOKEN_STATE`, or
- the state file isn't carried from one run to the next. The message then says *not
  being carried over*: check the cache steps, or that the job isn't paused for weeks.

A sign-in you made with your own tooling (a bare refresh token, not the `onedrive1.…`
value `login` prints) has no recorded issue date. Without a state file MongoShield
can't warn about it.

## What to do at day 90

Do this before day 90, as soon as you see the warning:

1. Run `npx mongoshield login onedrive` again.
2. Replace the `MONGOSHIELD_ONEDRIVE_TOKEN` secret with the new value.

That's all. The next run sees a new secret, ignores the old state file (it no longer
decrypts) and starts a new chain from the new sign-in.

If you missed it, backups fail from day 90 with `MS_STORAGE_FORBIDDEN` ("Could not
refresh the OneDrive sign-in: invalid_grant …"), with the same instructions in the hint.
No backup data is lost; sign in again and the next run works.

## How objects are stored

- **Keys are folders.** `backups/<id>/app/users.bson.zst.age` is the file `users.bson.zst.age`
  in `Apps/MongoShield/mongoshield-backups/backups/<id>/app/`. The backup layout is the same
  as on every other storage.
- **Uploads.** OneDrive needs an object's total size before an upload session starts.
  MongoShield therefore picks the upload by size:
  - Objects under 4 MiB go up in a single request, from memory.
  - Larger ones are first written to a temp file in `os.tmpdir()`, with mode 0600. Then
    they are sent through an upload session, in 10 MiB fragments (multiples of 320 KiB,
    as OneDrive requires).

  The temp file is always removed afterwards. Make sure the temp folder has room for your
  largest collection file. On GitHub's runners it has plenty.
- **Atomic writes.** A file only appears when its last fragment arrives. An upload that
  fails is cancelled, so a partial file is never visible.
- **Locking.** OneDrive can refuse an existing name, through
  `@microsoft.graph.conflictBehavior: fail`. So the normal storage lock works, and
  `schedule.lock` needs no change.
- **Deleting.** Deleted backups go to the OneDrive **recycle bin**. They stay there for
  up to 30 days and still count against your quota. Permanent deletion needs access to
  the whole drive (`Files.ReadWrite`), which MongoShield deliberately doesn't ask for. If
  pruning doesn't seem to free space, empty the recycle bin at
  https://onedrive.live.com/?id=recyclebin. The free-space check counts the recycle bin.
- **Free space.** MongoShield reads the drive quota (total, used, remaining, in the recycle
  bin) before a backup. Microsoft documents the quota for the broader `Files.Read`
  permissions, so with the app-folder permission alone OneDrive may not report it. The
  check is then skipped quietly.
- **Throttling.** Microsoft Graph answers `429` or `503` when it wants a client to slow
  down. MongoShield waits as long as the `Retry-After` header asks, then retries.
- **Names.** OneDrive treats names case-insensitively. MongoShield's layout already
  keeps collections such as `Users` and `users` in separate files, as it does for macOS
  and Windows disks.

## URL and options

```
onedrive://<folder>[/<subfolder>…][?business=true][&fragmentSizeMiB=10]
```

| URL parameter | Option (`onedriveStorage`) | Default | Meaning |
|---|---|---|---|
| host and path | `folder` | required | Folder inside the app folder |
| `business=true` | `business: true` | off | Allow a work or school sign-in (experimental) |
| `fragmentSizeMiB` | `fragmentSize` (bytes) | 10 MiB | Upload session fragment size: a multiple of 320 KiB, at most 60 MiB. In the URL, use 5, 10, 15 … 60 |
| | `tempDirectory` | `os.tmpdir()` | Where objects of 4 MiB or more are staged |
| | `token` | `MONGOSHIELD_ONEDRIVE_TOKEN` | The sign-in |
| | `tokenStatePath` | `MONGOSHIELD_ONEDRIVE_TOKEN_STATE` | The token state file |
| | `clientId` / `clientSecret` | from the token, then MongoShield's app | Your own app registration |

| Environment variable | Meaning |
|---|---|
| `MONGOSHIELD_ONEDRIVE_TOKEN` | The sign-in printed by `mongoshield login onedrive` (secret) |
| `MONGOSHIELD_ONEDRIVE_TOKEN_STATE` | Path of the token state file (the Action sets it) |
| `MONGOSHIELD_ONEDRIVE_CLIENT_ID` | Client id of your own app registration |
| `MONGOSHIELD_ONEDRIVE_CLIENT_SECRET` | Its client secret (confidential apps only; device login needs none) |

In code:

```ts
import { onedriveStorage } from "mongoshield/storage/onedrive";

const storage = onedriveStorage({
  folder: "mongoshield-backups",
  token: process.env.MONGOSHIELD_ONEDRIVE_TOKEN ?? "",
  tokenStatePath: "/var/lib/mongoshield/onedrive-token.json",
});
```

## Bring your own app

By default MongoShield signs in with its own Microsoft app registration. Until that app's
client id ships in a release, and whenever you'd rather use your own (your
organisation's policy, say), register an app like this:

1. Azure portal → **App registrations** → **New registration**. Choose *Personal Microsoft
   accounts only*. You don't need a redirect URI.
2. **Authentication** → *Allow public client flows*: **Yes**. The device code flow
   needs this.
3. **API permissions** → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder`.
   `offline_access` is requested at sign-in.
4. Set `MONGOSHIELD_ONEDRIVE_CLIENT_ID` to the *Application (client) ID* when you run
   `login`. The value `login` prints records the client id, so CI doesn't need the
   variable.

The app folder is named after the app registration (`Apps/<app name>/`).

## Work and school accounts (experimental)

```bash
npx mongoshield login onedrive --business   # signs in through login.microsoftonline.com/common
```

```
onedrive://mongoshield-backups?business=true
```

Without the opt-in, a work or school sign-in is refused with `MS_CONFIG_INVALID`.

This stays experimental until it has been tested on a real tenant:

- Microsoft's documentation disagrees about app folders on OneDrive for Business.
- Many tenants need an administrator to approve third-party apps.
- MongoShield's app isn't publisher-verified for business use yet.

Please report what you find.

## Troubleshooting

| Error | Meaning and fix |
|---|---|
| `MS_STORAGE_FORBIDDEN` *Could not refresh the OneDrive sign-in: invalid_grant* | The sign-in expired (day 90) or was revoked (password change). Run `npx mongoshield login onedrive` and replace the secret |
| `MS_STORAGE_FORBIDDEN` *accessDenied* | The token lacks the app-folder permission, or the app was removed from the account. Sign in again |
| `MS_STORAGE_INSUFFICIENT_SPACE` | The drive is full. Empty the recycle bin, keep fewer backups (`retention`), or add storage |
| `MS_CONFIG_INVALID` *No Microsoft app (client id)* | Set `MONGOSHIELD_ONEDRIVE_CLIENT_ID` (see [Bring your own app](#bring-your-own-app)) |
| `MS_STORAGE_IO` *throttling* | Microsoft Graph kept answering 429/503. Run later, or less often |
