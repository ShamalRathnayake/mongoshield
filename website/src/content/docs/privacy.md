---
title: Privacy policy
description: What MongoShield and its Google Drive and Dropbox apps can access, and where your data and sign-in tokens go.
---

**Last updated:** 5 November 2026

MongoShield is open-source software that you run yourself: the CLI, the library, the
GitHub Action and the self-hosted console. The MongoShield project runs **no servers**.
We never receive your databases, your backups, your sign-in tokens or any information
about how you use MongoShield.

This policy covers MongoShield itself and the OAuth apps it uses to connect to
Google Drive and Dropbox, each named "MongoShield".

## What MongoShield collects

Nothing. MongoShield has no analytics, no crash reporting and no usage telemetry, and it
never contacts the MongoShield project.

MongoShield only connects to services you configure: your MongoDB deployment, the
storage you back up to, and any notification or monitoring endpoints you add (for
example a Slack webhook or an OpenTelemetry collector). Those services get what you send
them, under their own privacy policies.

## Google Drive and Dropbox

When you run `mongoshield login gdrive` or `dropbox`, you sign in on the
provider's own page and approve the access listed below. MongoShield never sees your
password.

| Provider | Access requested | What MongoShield can reach |
| --- | --- | --- |
| Google Drive | `drive.file` | Only files MongoShield created in your Drive. It cannot see your other files. |
| Dropbox | `files.metadata.read`, `files.content.read`, `files.content.write`, `account_info.read` | Only its own app folder (`Apps/MongoShield`), plus your account's storage usage so it can check there is room before a backup. |

MongoShield uses this access only to write, list, read, verify and delete **your own
backups**, as your configuration and commands direct. It does not use the data for
anything else, does not share it with anyone, and does not use it to train AI or machine
learning models.

MongoShield's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Where your sign-in tokens are kept

`mongoshield login` prints the refresh token once, in your terminal, or with `--gh` stores
it straight in your GitHub repository's Actions secrets. After that the token is wherever
you put it: an environment variable, a CI secret, or the console's own data volume on your
server. The MongoShield project never has a copy.

## Removing access

To revoke MongoShield's access, remove it in the provider's account settings:

- Google: [Third-party apps with account access](https://myaccount.google.com/connections)
- Dropbox: Settings → Connected apps

Revoking access makes any stored token useless. Your backups stay in your drive until you
delete them.

## Changes and contact

Changes to this policy are made in the public
[repository](https://github.com/ShamalRathnayake/mongoshield) and show in its history.
Questions go to [GitHub issues](https://github.com/ShamalRathnayake/mongoshield/issues).
Report security problems privately through
[GitHub security advisories](https://github.com/ShamalRathnayake/mongoshield/security/advisories/new).
