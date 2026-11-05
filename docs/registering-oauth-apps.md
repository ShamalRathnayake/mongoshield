# Registering MongoShield's OAuth apps

This is a maintainer guide. `gdrive://` and `dropbox://` storage sign users in
through OAuth apps that MongoShield registers once and ships the public client IDs for, so a
user only runs `mongoshield login <provider>` and never creates an app of their own.

Do this once per provider, then put the IDs in the source (last section). Until an ID is
filled in, that provider works only for people who register their own app and set
`MONGOSHIELD_<PROVIDER>_CLIENT_ID` (and, for Google, `MONGOSHIELD_GDRIVE_CLIENT_SECRET`).

| Provider | Time | Card needed | Review | Blocks launch? |
|:--|:--|:--|:--|:--|
| Google Drive | ~20 min + brand review (days) | no | brand verification only (`drive.file` is non-sensitive) | yes: tokens expire after 7 days until the app is published |
| Dropbox | ~10 min | no | production approval after 50 linked users | no, but apply in launch week |

Use a shared project mailbox (not a personal address) as the support and developer contact
on every console: users see it on the consent screens.

## Before you start: a privacy policy and a home page

Google (and Dropbox's production review) require a public **home page** and **privacy
policy** on a domain you control. The docs site works:

- Home page: `https://shamalrathnayake.github.io/mongoshield/`
- Privacy policy: `https://shamalrathnayake.github.io/mongoshield/privacy/`
  (`website/src/content/docs/privacy.md`, linked from every page's footer). It says
  MongoShield has no servers and no telemetry, that tokens stay on the user's machine or
  in their CI secrets, and what each provider's scopes let the app reach.

Google must be able to verify the domain in [Google Search Console](https://search.google.com/search-console).
`shamalrathnayake.github.io` is its own registrable domain (github.io is on the public
suffix list), so verify it there with the HTML-file method by adding the file to the site's
`public/` folder. A custom domain works the same way with a DNS TXT record.

## Google Drive

Console: [Google Cloud console → Google Auth Platform](https://console.cloud.google.com/auth/overview).

1. **Create a project** named `MongoShield` (top bar → project picker → New project). No
   billing account is needed.
2. **Enable the Google Drive API**: APIs & Services → Library → "Google Drive API" → Enable.
3. **Branding**: app name `MongoShield`, the support email, the logo (optional; a logo
   triggers extra review, so you may skip it), the home page and privacy policy URLs above,
   authorized domain `shamalrathnayake.github.io`, and the developer contact email.
4. **Audience**: user type **External**. It starts in *Testing*; leave it there until the
   client works (step 7), and add your own Google account as a test user.
5. **Data Access** → Add or remove scopes → add `https://www.googleapis.com/auth/drive.file`
   ("See, edit, create and delete only the specific Google Drive files you use with this
   app"). Add nothing else. `drive.file` is non-sensitive, so no security assessment is needed.
6. **Clients** → Create client → application type **TVs and Limited Input devices** (this is
   the device-code flow `mongoshield login gdrive` uses; it is one of the few client types
   allowed `drive.file`). Name it `MongoShield CLI`. Copy the **client ID** and **client
   secret**. For this client type the secret is not confidential: Google's device flow sends
   it from the user's machine, so it ships in the source like the ID.
7. **Test it**: set `MONGOSHIELD_GDRIVE_CLIENT_ID` / `MONGOSHIELD_GDRIVE_CLIENT_SECRET`, run
   `mongoshield login gdrive`, and back up to `gdrive://test`.
8. **Publish**: Audience → **Publish app** → confirm. Then go to the verification centre
   → *Prepare for verification* → *Submit*. With only non-sensitive scopes this is brand
   verification: Google checks the name, logo, home page, privacy policy and domain
   ownership. It usually takes a few business days, and Google emails the contact address.

Why publishing matters: while the app is in *Testing*, refresh tokens expire after **7 days**,
so nightly backups would stop after a week. Also note that Google allows 100 live refresh
tokens per Google account per client. Older ones are revoked silently, which only matters
if one person logs in more than 100 times.

## Dropbox

Console: [Dropbox App Console](https://www.dropbox.com/developers/apps).

1. **Create app** → **Scoped access** → **App folder** (not *Full Dropbox*: least privilege)
   → name it `MongoShield`. Users see the folder as `Apps/MongoShield` in their Dropbox, and
   the name must be unique across Dropbox.
2. **Permissions** tab: tick exactly these four, then **Submit**:
   `files.metadata.read` (list, head), `files.content.read` (download),
   `files.content.write` (upload, delete) and `account_info.read` (the free-space check).
   `files.metadata.write` is not needed. Changing permissions later makes every user log in
   again, so get them right before launch.
3. **Settings** tab → OAuth 2:
   - **Allow public clients (Implicit Grant & PKCE)**: *Allow*. `mongoshield login dropbox`
     uses PKCE and ships no secret.
   - **Redirect URIs**: add both, exactly as written (Dropbox matches the port too):
     `http://127.0.0.1:53917/callback` and `http://127.0.0.1:53918/callback`. The login
     command tries 53917, then 53918, then the copy-the-code flow, which needs no redirect URI
     and is what it uses over SSH and in Codespaces. If the console refuses `127.0.0.1`
     (it allows plain http only for local addresses), tell the maintainer of `dropbox-auth.ts`
     to switch to `http://localhost:…`.
4. Copy the **App key**. That is the client ID. Do **not** ship the App secret.
5. **Production**: the app starts in *Development*, which allows up to 500 users. Once
   **50** users have linked it, you have two weeks to apply, or new users can't link.
   Apply during launch week: Settings → **Apply for production**. The form asks what the
   app does and for the privacy policy URL.

## Shipping the IDs

1. Put the values in `packages/mongoshield/src/storage/oauth/apps.ts` (`OAUTH_APPS`): the
   Google client ID and secret and the Dropbox App key. Every adapter and
   `mongoshield login` read them from there. Both are filled in: the Google client
   `MongoShield CLI` in the Cloud project `mongoshield`, and the Dropbox app
   `MongoShield` (app key `4eztt2dgf90i279`).
2. Run `pnpm --filter mongoshield test`.
3. Add the real-account test variables from `docs/testing-real-clouds.md` and run the Cloud
   workflow once (Actions → Cloud → Run workflow).
4. Release as usual (`pnpm changeset`).

Rotating an ID later (say, a new Google client) logs everyone out of that provider: their
refresh tokens belong to the old client. Treat it as a breaking change and say so in the
changeset.
