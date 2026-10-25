# GitHub Actions: nightly backup

[`nightly-backup.yml`](./nightly-backup.yml) backs up MongoDB to S3 every night, verifies
the new backup and prunes old ones, using the [MongoShield action](../../action/).

1. Generate a key pair locally and keep the secret key somewhere safe and offline
   (a password manager, a hardware token, a printed copy in a safe):

   ```bash
   npx mongoshield@next keygen --output backup.key   # prints the public key (age1…)
   ```

2. In the repository settings, add the secret `MONGODB_URI` and the variables
   `BACKUP_PUBLIC_KEY`, `BACKUP_BUCKET` and `AWS_BACKUP_ROLE`.
3. Create the IAM role with a trust policy for GitHub's OIDC provider, limited to this
   repository, and allow `s3:ListBucket`, `s3:GetObject`, `s3:PutObject` and
   `s3:DeleteObject` on the bucket (delete is needed by `prune`).
4. Copy the workflow to `.github/workflows/` and run it once with **Run workflow**.

Prefer a config file? Commit a `mongoshield.config.json` (no secrets in it) with
`storage`, `retention` and `schedule`, and use `command: run`: one step then backs up,
verifies, prunes and sends notifications.

Not on AWS? Any S3-compatible store works with
`storage: s3://bucket/prefix?endpoint=https://…` and `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` set from secrets on the step. Atlas users must allow GitHub's
runner IPs (see [docs/guides/atlas.md](../../docs/guides/atlas.md)).

Full guide: [docs/guides/github-actions.md](../../docs/guides/github-actions.md).

## Atlas Free (M0) and Flex clusters

Two more templates back up an Atlas Free or Flex cluster, which has no (or only limited)
Atlas backups. Both are linted with actionlint in CI:

- [`atlas-free-tier-s3.yml`](./atlas-free-tier-s3.yml): to Amazon S3 or Cloudflare R2
  (access keys as secrets), with verify, prune and an optional temporary Atlas IP Access
  List entry for the runner.
- [`atlas-free-tier-artifact.yml`](./atlas-free-tier-artifact.yml): no cloud account at
  all; each night's encrypted backup is kept as a GitHub Actions artifact for 30 days.

The secrets and variables each one needs are listed at the top of the file. Guide:
[docs/guides/atlas-free-tier.md](../../docs/guides/atlas-free-tier.md).

