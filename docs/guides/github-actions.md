# GitHub Actions

Back up on a schedule from a workflow, with nothing to host. Good for small and medium
databases; GitHub-hosted jobs can run for up to 6 hours.

## With the MongoShield action

```yaml
# .github/workflows/backup.yml
name: Backup
on:
  schedule:
    - cron: "15 3 * * *" # UTC; GitHub may start it some minutes late
  workflow_dispatch:

concurrency:
  group: mongodb-backup
  cancel-in-progress: false

permissions:
  contents: read
  id-token: write # for AWS OIDC

jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_BACKUP_ROLE }}
          aws-region: eu-west-1
      - uses: ShamalRathnayake/mongoshield/action@v2 # pin to a release tag or SHA
        id: backup
        with:
          uri: ${{ secrets.MONGODB_URI }}
          storage: s3://acme-backups/prod?region=eu-west-1
          recipients: ${{ vars.BACKUP_PUBLIC_KEY }}
          args: --exclude *.sessions --label trigger=github-actions
      - run: echo "Created ${{ steps.backup.outputs.backup-id }}"
```

The action runs `npx mongoshield@<version>` and installs the SDK the storage URL needs.
Inputs: `command` (`backup`, `run`, `verify`, `restore`), `uri`, `storage`, `recipients`,
`identity`, `config`, `args`, `packages`, `version` (default `latest`), `node-version`
(default `24`), `working-directory`. Outputs: `backup-id` and `json`. Details in
[`action/README.md`](../../action/README.md).

A complete workflow that also verifies and prunes is in
[`examples/github-actions`](../../examples/github-actions/).

### With a config file

Commit a `mongoshield.config.json` without secrets, and let `run` do backup, verification,
retention and notifications in one step:

```json
{
  "storage": "s3://acme-backups/prod?region=eu-west-1",
  "retention": { "last": 3, "daily": 7, "weekly": 4, "monthly": 12 },
  "schedule": { "cron": "15 3 * * *", "verify": "fast" },
  "notify": [{ "type": "slack", "url": "https://hooks.slack.com/services/…", "on": ["failure"] }]
}
```

```yaml
      - uses: actions/checkout@v5
      - uses: ShamalRathnayake/mongoshield/action@v2
        with:
          command: run
          uri: ${{ secrets.MONGODB_URI }}
          recipients: ${{ vars.BACKUP_PUBLIC_KEY }}
```

(`schedule.cron` is required by the config schema; in Actions the workflow's own `cron`
decides when it runs.) Keep webhook URLs out of git: they are credentials. Put the config
in a secret and write it to a file in a step, or use the `heartbeat` option with a URL
whose leak is harmless.

## Without the action

```yaml
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: >-
          npx --yes --package=mongoshield
          --package=@aws-sdk/client-s3@^3 --package=@aws-sdk/lib-storage@^3
          -- mongoshield backup --to "s3://acme-backups/prod?region=eu-west-1" --exclude '*.sessions'
        env:
          MONGODB_URI: ${{ secrets.MONGODB_URI }}
          MONGOSHIELD_RECIPIENTS: ${{ vars.BACKUP_PUBLIC_KEY }}
```

## Security

- **Encrypt for a public key.** CI then holds nothing that can read a backup. Generate
  the pair locally with `npx mongoshield keygen --output backup.key` and keep the
  secret key offline.
- **OIDC for cloud credentials** instead of stored access keys. Scope the IAM role's trust
  policy to this repository (and branch).
- **Least-privilege MongoDB user**: read-only (`backup` or `readAnyDatabase` role).
- **Pin the action and the version** (`version: 2.0.0`) for reproducible runs.
- **Scheduled workflows are disabled** after 60 days without repository activity on public
  repos; GitHub emails you first. Use a `heartbeat` URL to notice.
- **Atlas**: GitHub-hosted runners have no fixed IP addresses. See the
  [Atlas guide](./atlas.md#3-network-access).
