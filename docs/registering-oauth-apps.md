# Registering MongoShield's OAuth apps

This is a maintainer guide. `gdrive://`, `onedrive://` and `dropbox://` storage sign users in
through OAuth apps that MongoShield registers once and ships the public client IDs for, so a
user only runs `mongoshield login <provider>` and never creates an app of their own.

Do this once per provider, then put the IDs in the source (last section). Until an ID is
filled in, that provider works only for people who register their own app and set
`MONGOSHIELD_<PROVIDER>_CLIENT_ID` (and, for Google, `MONGOSHIELD_GDRIVE_CLIENT_SECRET`).

| Provider | Time | Card needed | Review | Blocks launch? |
|:--|:--|:--|:--|:--|
| Google Drive | ~20 min + brand review (days) | no | brand verification only (`drive.file` is non-sensitive) | yes: tokens expire after 7 days until the app is published |
| Dropbox | ~10 min | no | production approval after 50 linked users | no, but apply in launch week |
| OneDrive | ~15 min | possibly, for the Microsoft tenant (see below) | none for personal accounts | no |

Use a shared project mailbox (not a personal address) as the support and developer contact
on every console: users see it on the consent screens.

## Before you start: a privacy policy and a home page

Google (and Dropbox's production review) require a public **home page** and **privacy
policy** on a domain you control. The docs site works:

- Home page: `https://shamalrathnayake.github.io/mongoshield/`
- Privacy policy: a page on the docs site stating MongoShield has no servers and no
  telemetry, that tokens stay on the user's machine or in their CI secrets, and that the app
  only reads and writes files it created in the user's own drive.

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

## OneDrive (Microsoft)

Console: [Microsoft Entra admin center](https://entra.microsoft.com) → Entra ID → App registrations.

**You need a tenant (directory).** Microsoft no longer lets a personal account create app
registrations outside a directory. Sign in with the project's Microsoft account. If the
admin centre has no directory, create one by signing up for a free Azure account, which
creates a *Default Directory*. Microsoft may ask for a card to verify identity; registering
apps is free. Users still sign in with ordinary personal accounts: the tenant is only where
the app's registration lives.

1. **New registration**: name `MongoShield`. Under *Supported account types*, choose
   **Personal accounts only**. Work and school accounts are experimental in MongoShield.
   Supporting them later means switching to *Any Entra ID tenant + Personal Microsoft
   accounts*, plus publisher verification (that needs a Microsoft partner account).
   Leave *Redirect URI* empty: the device-code flow needs none. Register.
2. Copy the **Application (client) ID** from the Overview page.
3. **Authentication** → Advanced settings → **Allow public client flows**: *Yes* → Save.
   Without this, device-code sign-in fails with `AADSTS7000218`.
4. **API permissions** → Add a permission → Microsoft Graph → *Delegated* → add
   `Files.ReadWrite.AppFolder` and `offline_access`. Keep or remove the default `User.Read`.
   No admin consent is needed, because personal accounts consent for themselves.
5. **Certificates & secrets**: create nothing. The CLI is a public client and ships no secret.

Users' files go to `Apps/MongoShield` in their OneDrive. Microsoft refresh tokens expire 90
days after they're issued, even when used. MongoShield rotates them through the Actions
cache and warns from day 75 (see `docs/guides/onedrive.md`).

## Shipping the IDs

1. Put the values in the shipped-apps file in `packages/mongoshield/src/storage/` (the file
   that holds the per-provider client IDs; it says where each value goes): the Google client
   ID and secret, the Dropbox App key and the Microsoft Application (client) ID.
2. Run `pnpm --filter mongoshield test`.
3. Add the real-account test variables from `docs/testing-real-clouds.md` and run the Cloud
   workflow once (Actions → Cloud → Run workflow).
4. Release as usual (`pnpm changeset`).

Rotating an ID later (say, a new Google client) logs everyone out of that provider: their
refresh tokens belong to the old client. Treat it as a breaking change and say so in the
changeset.
