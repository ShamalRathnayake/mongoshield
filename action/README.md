# MongoShield GitHub Action

Back up, verify and restore MongoDB from a GitHub Actions workflow. It runs
`npx mongoshield@<version>`, so there is no image to pull and nothing to install first.

```yaml
- uses: ShamalRathnayake/mongoshield/action@main # pin to a release tag or commit SHA
  id: backup
  with:
    uri: ${{ secrets.MONGODB_URI }}
    storage: s3://acme-backups/prod?region=eu-west-1
    recipients: ${{ vars.BACKUP_PUBLIC_KEY }}
    args: --exclude *.sessions --label trigger=github-actions
- run: echo "Created ${{ steps.backup.outputs.backup-id }}"
```

A complete nightly workflow (with AWS OIDC, no stored AWS keys) is in
[`examples/github-actions`](../examples/github-actions/). The platform guide is
[`docs/guides/github-actions.md`](../docs/guides/github-actions.md).

## Inputs

| Input | Default | Description |
|---|---|---|
| `command` | `backup` | `backup`, `run` (backup + verify + prune + notify, from the config file), `verify` or `restore` |
| `uri` | | MongoDB connection string. Use a secret; it is masked, including the password on its own |
| `storage` | | `s3://bucket/prefix?region=…`, or a directory path |
| `recipients` | | Comma-separated age public keys (`age1…`) to encrypt for |
| `identity` | | age secret key (`AGE-SECRET-KEY-1…`) for `restore` and `verify --deep`. Use a secret |
| `config` | | Path to a `mongoshield.config.{ts,js,json}` |
| `args` | | Extra arguments, split on whitespace (values cannot contain spaces). Globs like `*.sessions` are passed literally |
| `packages` | | Extra npm packages to install. SDKs for `s3://`, `gs://`, `az://` and `sftp://` storage are added automatically |
| `version` | `next` | mongoshield npm version or dist-tag. Pin an exact version for reproducible runs |
| `node-version` | `24` | Node.js to set up (22.12+). `""` uses the runner's Node.js |
| `working-directory` | `.` | Where the config file and relative paths are resolved |

Anything not given here is read from the config file or from environment variables
(`MONGODB_URI`, `MONGOSHIELD_STORAGE`, `MONGOSHIELD_RECIPIENTS`, `MONGOSHIELD_IDENTITY`,
`MONGOSHIELD_IDENTITY_FILE`, `MONGOSHIELD_PASSPHRASE`, `MONGOSHIELD_COMPRESSION`) set on the step.

## Outputs

| Output | Description |
|---|---|
| `backup-id` | The id of the backup created, verified or restored, when the command reports one |
| `json` | The command's full `--json` output |

The step fails with MongoShield's exit code (see [docs/errors.md](../docs/errors.md)), and
the outputs are still set, so a later `if: failure()` step can report the error.

## Security notes

- Inputs reach the script as environment variables, never pasted into shell code, so a
  crafted value cannot run commands.
- Secrets travel as environment variables, not command-line arguments.
- Encrypt with **public** recipients. The runner then holds nothing that can read a
  backup; keep the secret key out of the backup workflow entirely.
- The action passes `--yes` because nobody can answer a prompt in CI. `restore` still
  refuses to overwrite existing data unless you pass `--mode drop|insert|upsert` in `args`.
- Cloud credentials come from the SDK's usual sources. For AWS, prefer
  `aws-actions/configure-aws-credentials` with OIDC over long-lived access keys.
