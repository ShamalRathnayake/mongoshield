# Atlas Free + Netlify in 10 minutes

Your app runs on Netlify and its data lives in a MongoDB Atlas Free cluster. Atlas keeps
no backups of Free clusters. This guide gets you an encrypted backup in your own Google
Drive in about 10 minutes, then one every night, with no credit card and nothing to host.

The app stays on Netlify. The backups run in **GitHub Actions**, which is free for
public repositories and has a monthly allowance of free minutes for private ones, and
has no 30-second or 15-minute limit to fight.

You need:

- the GitHub repository of your app, cloned on your machine, with
  [`gh`](https://cli.github.com) logged in (`gh auth login`). Without `gh`, MongoShield
  prints the commands to run instead;
- Node.js 22.12 or later;
- a Google account (a fresh one is fine; it has 15 GB free).

## 1. Prepare Atlas (3 minutes)

In the [Atlas UI](https://cloud.mongodb.com), on your Free cluster's project:

1. **Database Access → Add New Database User.** Password authentication, a user such as
   `backup`, and the built-in role **Only read any database**. Backups never write, so
   this user can't damage your data even if its password leaks.
2. **Network Access → Add IP Address → Allow access from anywhere** (`0.0.0.0/0`).
   GitHub's hosted runners have no fixed IP addresses, so there is no smaller list that
   works. The trade-off: the cluster accepts connections from any address, and only the
   password protects it. Keep that password long and random (Atlas's **Autogenerate
   Secure Password**), and the user read-only. If your organisation can't accept that,
   run backups from a machine with a fixed IP instead
   (see [Atlas Free tier backups](atlas-free-tier.md)).
3. **Connect → Drivers**, copy the connection string, and put in the password. Adding
   `compressors=zlib` saves some of the Free tier's data transfer allowance:

   ```
   mongodb+srv://backup:<password>@cluster0.abcde.mongodb.net/?compressors=zlib
   ```

## 2. Run `init --github` (5 minutes)

In your app's repository:

```bash
npx mongoshield init --github
```

It asks a few questions and does the rest. Step by step:

1. **Where backups go.** Choose **Google Drive** (the first entry). The menu also offers
   Dropbox, GitHub artifacts, Backblaze B2, Cloudflare R2 and any storage URL.
2. **Google sign-in.** It shows a code and the link `https://www.google.com/device`.
   Open it on any device, sign in to the Google account that should hold the backups,
   enter the code and choose **Allow**. MongoShield only gets access to the files it
   creates, nothing else in the drive. The result is a token that becomes the
   repository secret `MONGOSHIELD_GDRIVE_TOKEN`.
3. **Encryption keys.** It generates an age key pair. The **public** key goes into the
   repository variable `MONGOSHIELD_RECIPIENTS`: GitHub Actions can encrypt backups with
   it but can never read them. The **private** key is saved as `./mongoshield.key`
   (readable only by you). Don't commit it: add it to `.gitignore`.
4. **Recovery kit.** It asks for a passphrase, and puts a copy of the private key,
   locked with that passphrase, into the drive as `_state/recovery-kit.age`. If you lose
   `mongoshield.key`, the passphrase is enough to restore. Pick one you will remember or
   keep in a password manager; without the key file *and* the passphrase, the backups
   can't be decrypted by anyone. (In a script, set `MONGOSHIELD_RECOVERY_PASSPHRASE`
   instead of typing it.)
5. **The connection string.** The one from step 1 becomes the repository secret
   `MONGODB_URI`. It is never written to a file in the repository.
6. **Files.** It writes `mongoshield.config.json` (where backups go, a nightly schedule
   and retention: the last 7 backups, plus 4 weekly and 6 monthly) and
   `.github/workflows/mongoshield-backup.yml` (every night at 03:17 UTC, and on demand).
   Both are safe to commit: they hold no secrets.
7. **Secrets.** With `gh` logged in, it sets `MONGODB_URI`, `MONGOSHIELD_GDRIVE_TOKEN`
   and `MONGOSHIELD_RECIPIENTS` on the repository for you. Without `gh`, it prints the
   `gh secret set` and `gh variable set` lines to copy, reading the secret values from
   private temporary files, so they never appear on screen or in your shell history.
8. **Commit and push.** GitHub can only start a workflow that is on the default
   branch, so it offers to commit and push the two files. Say no if you'd rather open a
   pull request; then merge it and run `gh workflow run mongoshield-backup.yml`.
9. **The first backup.** It starts the workflow and follows it until it finishes. You
   see the backup succeed (or the error) before you close the terminal.

## 3. Check the first backup (1 minute)

`init` ends by printing whether the run succeeded and a link to it. The run's log shows
the new backup's id, its size and the verification result.

Open [drive.google.com](https://drive.google.com): **MongoShield → <your app> →
backups** holds one folder per backup. From your machine:

```bash
export MONGOSHIELD_GDRIVE_TOKEN='1//0g…'      # the same token
npx mongoshield list --from gdrive://<your-app>
```

From now on the workflow runs every night. GitHub emails you when a run fails. Each run
verifies the new backup and deletes the ones the retention policy no longer keeps.

## Restoring

Restore next to the live data first, check it, then decide:

```bash
export MONGODB_URI='mongodb+srv://admin:<password>@cluster0.abcde.mongodb.net/'   # a user that can write
export MONGOSHIELD_GDRIVE_TOKEN='1//0g…'
npx mongoshield restore --from gdrive://<your-app> --identity-file ./mongoshield.key \
  --rename 'app.*=app_restored.*'
```

Lost `mongoshield.key`? Leave out `--identity-file`. `restore` finds the recovery kit in
the drive and asks for its passphrase:

```bash
npx mongoshield restore --from gdrive://<your-app> --rename 'app.*=app_restored.*'
```

The backup user from step 1 is read-only, so restoring needs a user that can write
(**Read and write to any database**). See [Atlas Free tier backups](atlas-free-tier.md#restoring)
for restoring into a Free cluster, and [recovery recipes](recovery-recipes.md) for
common situations.

## When something goes wrong

| Symptom | Fix |
|---|---|
| The run fails with `MS_CONNECTION_FAILED` | the Network Access entry is missing, or the connection string has a typo. Check step 1 |
| `MS_AUTH_FAILED` | wrong password in `MONGODB_URI`. Update it with `gh secret set MONGODB_URI` |
| `MS_STORAGE_FORBIDDEN` about the Google Drive token | the token was revoked or expired. Run `npx mongoshield login gdrive` and `gh secret set MONGOSHIELD_GDRIVE_TOKEN` |
| `MS_STORAGE_INSUFFICIENT_SPACE` | the Google account is full; its 15 GB are shared with Gmail and Photos |
| The workflow never starts at night | GitHub pauses scheduled workflows in repositories without activity for 60 days. Re-enable it in the Actions tab |

More: [Google Drive](google-drive.md), [GitHub Actions](github-actions.md).

## Prefer to run backups on Netlify?

[`examples/netlify-scheduled-backup`](../../examples/netlify-scheduled-backup/) runs the
backup inside your Netlify site: a scheduled function that starts a background function.
Read its caveats first:

- It relies on **undocumented behaviour**: Netlify documents scheduled functions and
  background functions, but not one starting the other. It works today and may stop.
- A scheduled function stops after **30 seconds**, so it only starts the work; the
  background function then has **15 minutes**. That is enough for **small databases**
  only (roughly tens of megabytes on a Free cluster's throughput), with no automatic
  retry when it runs out of time.
- Netlify reports failures in function logs only; nobody is emailed.

For anything you'd be upset to lose, use the GitHub Actions setup above.
