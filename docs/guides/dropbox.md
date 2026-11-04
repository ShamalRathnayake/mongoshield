# Dropbox

Back up into your own Dropbox, with no credit card and no cloud account. A free Basic
plan has 2 GB, enough for many small databases (backups are compressed and
encrypted). MongoShield only gets an **App folder**: it can see and change
`Apps/<app name>/` in your Dropbox (`Apps/MongoShield/` with MongoShield's own app)
and nothing else.

```sh
npx mongoshield login dropbox          # opens Dropbox, prints the token to store
export MONGOSHIELD_DROPBOX_TOKEN=…     # the refresh token it printed
npx mongoshield backup --storage dropbox://backups
```

Backups land in `Apps/MongoShield/backups/backups/<id>/` (the app folder, then the
folder from the URL, then MongoShield's normal layout).

## Log in

`mongoshield login dropbox` runs Dropbox's OAuth flow (authorization code with PKCE,
offline access) and prints a **refresh token**. Store it as the secret
`MONGOSHIELD_DROPBOX_TOKEN`; in GitHub Actions:

```sh
gh secret set MONGOSHIELD_DROPBOX_TOKEN   # paste the token
```

The refresh token does not expire on its own (Dropbox documents no expiry). It stops
working when you unlink the app (Dropbox → Settings → Connected apps). Each run
exchanges it for a short-lived access token (about 4 hours) and renews that as needed.

Dropbox has no device-code flow, so the code comes back one of two ways:

- **On your own computer** the login listens on `http://127.0.0.1:53917/callback`
  (or `:53918` if that port is busy). Approve in the browser and the terminal
  continues by itself.
- **Over SSH, in a Codespace, or when both ports are busy** the login asks Dropbox to
  show the code instead. Open the printed URL on any device, choose **Allow**, and
  paste the code into the terminal.

If the browser runs on another machine than the terminal, you can also paste the
address the browser ends up on (`http://127.0.0.1:53917/callback?code=…`, which fails
to load there) instead of the code.

## Where to use it

```yaml
# .github/workflows/mongoshield-backup.yml (excerpt)
concurrency:
  group: mongoshield-backup
  cancel-in-progress: false
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: ShamalRathnayake/mongoshield/action@v2
        env:
          MONGOSHIELD_DROPBOX_TOKEN: ${{ secrets.MONGOSHIELD_DROPBOX_TOKEN }}
        with:
          uri: ${{ secrets.MONGODB_URI }}
          storage: dropbox://backups
          recipients: ${{ vars.BACKUP_PUBLIC_KEY }}
```

No SDK is installed: the adapter talks to the Dropbox API with `fetch`.

From code:

```ts
import { dropboxStorage } from "mongoshield/storage/dropbox";

const storage = dropboxStorage({
  folder: "backups",
  refreshToken: process.env.MONGOSHIELD_DROPBOX_TOKEN,
});
```

| Option | Default | Meaning |
|---|---|---|
| `folder` | (required) | Folder inside the app folder, e.g. `"backups"` or `"prod/mongo"` |
| `refreshToken` | | The token from `mongoshield login dropbox` |
| `accessToken` | | A ready access token instead (e.g. generated in the App Console); not renewed |
| `clientId` | `MONGOSHIELD_DROPBOX_CLIENT_ID`, then MongoShield's app | The app the refresh token belongs to |
| `clientSecret` | `MONGOSHIELD_DROPBOX_CLIENT_SECRET` for URLs | Only for your own app if it does not allow PKCE |
| `chunkSize` | 8 MiB | Upload chunk; a multiple of 4 MiB up to 148 MiB. Objects up to this size go up in one request |
| `maxRetries` | 6 | Retries for rate limits, 5xx, timeouts and network errors |
| `retryBaseDelayMs` | 500 | First backoff delay, doubled per retry (max 30 s); `Retry-After` is always honoured |
| `requestTimeoutMs` | 180000 | Time allowed per request until Dropbox answers (uploads include sending the chunk) |
| `fetch` | global `fetch` | A custom `fetch` (proxies, tests) |

The URL form is `dropbox://<folder>` (for example `dropbox://prod/mongo`). It takes no
parameters; the token always comes from `MONGOSHIELD_DROPBOX_TOKEN`, never the URL.

## How it behaves

- **Atomic uploads.** Objects up to `chunkSize` go up in one request; larger ones in an
  upload session, one chunk at a time, so memory use stays at one chunk. Nothing is
  visible until the last request commits the file, so a failed run leaves no partial
  files. Every request carries Dropbox's content hash, and full downloads are checked
  against it.
- **Locking works.** Dropbox can refuse to create a file that already exists
  (`mode: add` with `strict_conflict`), so the normal storage lock protects against two
  runs at once. The workflow's `concurrency` group is still a good idea.
- **Deleting is soft.** Pruned backups go to Dropbox's *Deleted files*, where you can
  restore them for 30 days (longer on some paid plans). They do not count against your
  quota. Permanent delete exists only on Dropbox Business team accounts, so MongoShield
  does not use it.
- **Folders stay.** Dropbox folders are real. When old backups are pruned, their empty
  folders remain; they use no space. MongoShield never deletes folders, because a
  folder delete also deletes anything another run is writing into it.
- **Names are case-insensitive.** `Users` and `users` are the same name on Dropbox. The
  backup layout already gives such collections distinct file names, as it does for
  macOS and Windows disks.
- **Free space** is read from Dropbox before each backup: a backup that clearly will not
  fit is refused, and you are warned past 80% full.
- **Rate limits.** Dropbox limits writes per account (`too_many_write_operations`) and
  requests per app. Both are retried with backoff, waiting as long as `Retry-After`
  says.
- **No immutability.** Anyone with the token can delete files, so `retainDays` is
  refused on `dropbox://` storage. Use S3, GCS or Azure for
  [immutable backups](immutable-backups.md).

## Use your own Dropbox app

MongoShield ships its own app key. To use your own app instead (for example inside a
company):

1. [App Console](https://www.dropbox.com/developers/apps) → **Create app** →
   **Scoped access** → **App folder** → name it.
2. **Permissions** tab: tick exactly these scopes, then **Submit**:

   | Scope | Used by |
   |---|---|
   | `files.metadata.read` | `files/get_metadata`, `files/list_folder`, `files/list_folder/continue` |
   | `files.content.read` | `files/download` |
   | `files.content.write` | `files/upload`, `files/upload_session/start`, `…/append_v2`, `…/finish`, `files/delete_batch`, `files/delete_batch/check` |
   | `account_info.read` | `users/get_space_usage` (every app has it) |

   `files.metadata.write` is **not** needed: uploads create their own folders and
   deleting is part of `files.content.write`.
3. **Settings** tab → OAuth 2:
   - **Allow public clients (Implicit Grant & PKCE)**: on.
   - **Redirect URIs**: add both, exactly (Dropbox matches the whole URI, port and path
     included):

     ```
     http://127.0.0.1:53917/callback
     http://127.0.0.1:53918/callback
     ```
4. Use the app key:

   ```sh
   export MONGOSHIELD_DROPBOX_CLIENT_ID=<app key>
   npx mongoshield login dropbox
   ```

   and set the same `MONGOSHIELD_DROPBOX_CLIENT_ID` wherever backups run (a repository
   variable in GitHub), because the refresh token only works with the app that issued
   it. `MONGOSHIELD_DROPBOX_CLIENT_SECRET` is only needed if you turned public clients
   off.

A new app is in *development* status: only you and up to 500 other users can link it.
That is fine for your own team.

## Troubleshooting

| Error | Cause and fix |
|---|---|
| `MS_STORAGE_FORBIDDEN` "Dropbox rejected the login (invalid_grant)" | The refresh token was revoked (app unlinked) or belongs to another app. Run `mongoshield login dropbox` again and update the secret; check `MONGOSHIELD_DROPBOX_CLIENT_ID`. |
| `MS_CONFIG_INVALID` "MONGOSHIELD_DROPBOX_TOKEN is not set" | Pass the secret to the step (`env:` in the workflow). |
| `MS_STORAGE_INSUFFICIENT_SPACE` | The Dropbox account is full. Delete other files or keep fewer backups (`retention`). Emptying *Deleted files* does not help: they do not count. |
| `MS_STORAGE_IO` "too_many_write_operations" | Something else kept writing to the same Dropbox for minutes. Run again later. |
| The browser shows "redirect_uri mismatch" | Your own app is missing one of the redirect URIs above, or has a typo in it. |
| `MS_CONFIG_INVALID` "ports … are all in use" | Only with `mode: "loopback"`; free port 53917 or 53918, or use the pasted code. |

## For the maintainer: publishing MongoShield's Dropbox app

MongoShield's own app starts in development status. Dropbox lets up to 500 users link
an app in development, but **once 50 users have linked it, linking stops working two
weeks later unless the app has been approved for production**. Apply for production
approval in the App Console (**Apply for production**) before the app reaches 50 linked
users, ideally in launch week. The release is not done until the application is
submitted.

The app must keep exactly the settings above: App folder access, the four scopes,
public clients on, and both redirect URIs.
