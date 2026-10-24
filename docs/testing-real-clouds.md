# Testing against real clouds

The normal test suite (`pnpm test`) checks every storage adapter and KMS adapter
against emulators: S3Mock, fake-gcs-server, Azurite, an OpenSSH container and an
in-memory fake KMS. Emulators are fast and free, but they are not the real thing.
They miss quirks (checksum rules, eventual listing, permission errors, clock
precision) that only a real service has.

So there is a second, **opt-in** suite that runs the same storage conformance tests
(`test/helpers/storage-conformance.ts`), a full encrypted backup → deep verify →
restore round trip, and KMS round trips against real services:

| Target | What runs |
|---|---|
| AWS S3 | conformance + encrypted round trip |
| AWS S3 with Object Lock | conformance with retention + round trip with `retainDays: 1` |
| AWS KMS | wrap/unwrap, tampered ciphertext refused, KMS backup restored via KMS and via recovery key |
| Cloudflare R2 | conformance + round trip (S3 adapter with R2's endpoint) |
| Google Cloud Storage | conformance + round trip |
| GCS with object retention | conformance with retention + round trip with `retainDays: 1` |
| Google Cloud KMS | as AWS KMS |
| Azure Blob Storage | conformance + round trip |
| Azure Blob with version-level immutability | conformance with retention + round trip with `retainDays: 1` |
| Azure Key Vault | as AWS KMS |
| SFTP (a remote server) | conformance + round trip |

The tests live in `packages/mongoshield/test/cloud/` (one file per provider) and
the workflow in `.github/workflows/cloud.yml`.

Every target is **enabled only by its own variables**. With none set, everything
skips and the output says what to set:

```
[cloud tests] AWS S3 (skipped: set MONGOSHIELD_TEST_S3_BUCKET)
```

`pnpm test` and `pnpm coverage` never run these tests (they are a separate Vitest
project, `cloud`), and nothing here runs on pull requests.

## How the tests keep buckets clean

- Every run writes under one unique prefix: `mongoshield-ci/<yyyymmdd>-<random>/`
  (change the `mongoshield-ci` part with `MONGOSHIELD_TEST_PREFIX`). Parallel runs
  never touch each other's objects.
- Every test deletes what it wrote when it finishes.
- Objects under retention (the Object Lock / retention / immutability targets) can't
  be deleted for one day. The tests leave them, and a **lifecycle rule** on the test
  bucket removes them afterwards. Each provider section below has that rule. Set it
  up on every test bucket anyway: it also catches leftovers from a run that was
  killed midway.
- Locked test objects use **governance** mode (S3 `GOVERNANCE`, GCS and Azure
  `Unlocked`), never compliance, so an administrator can still remove them early.
  The test credentials do not get the bypass permission.

## Cost

A run moves roughly 100 MB per storage target and makes a few thousand requests,
plus a handful of KMS calls. On all four clouds that is a few cents per run. Locked
objects are kept for one day, then removed by the lifecycle rules.

## Running locally

Set the variables for the targets you want, log in to the provider the usual way,
and run the suite (or one file):

```sh
export MONGOMS_SYSTEM_BINARY=$(which mongod)   # optional: skip the mongod download

# AWS: any credentials the AWS SDK finds (profile, SSO, env keys).
export AWS_PROFILE=mongoshield-tests
export MONGOSHIELD_TEST_S3_BUCKET=mongoshield-cloud-tests
export MONGOSHIELD_TEST_S3_REGION=eu-west-1

pnpm --filter mongoshield test:cloud                       # every configured target
pnpm --filter mongoshield test:cloud test/cloud/aws.test.ts  # one provider
```

Credentials are found by each SDK's normal chain, so locally you use your own login:
`aws sso login` / a profile, `gcloud auth application-default login`, `az login`.
R2 and SFTP take their keys from the variables below.

## Names

Variables are not secret (bucket names, key ids, URLs); in GitHub they are
**repository variables** (Settings → Secrets and variables → Actions → *Variables*).
Only R2 and SFTP need **secrets**. Locally, everything is an environment variable
with the same name.

The jobs in `cloud.yml` decide whether to run with a job-level `if:` on a variable.
GitHub evaluates that before the job's environment is loaded, so these variables
must be **repository** variables, not `cloud-tests` environment variables.

| Name | Kind | Target | Example / meaning |
|---|---|---|---|
| `MONGOSHIELD_CLOUD_AWS_ROLE_ARN` | variable (CI only) | AWS job | `arn:aws:iam::123456789012:role/mongoshield-cloud-tests`; enables the AWS job |
| `MONGOSHIELD_CLOUD_AWS_REGION` | variable (CI only) | AWS job | `eu-west-1` (region of the buckets and the key) |
| `MONGOSHIELD_TEST_S3_BUCKET` | variable | AWS S3 | plain bucket |
| `MONGOSHIELD_TEST_S3_LOCK_BUCKET` | variable | S3 Object Lock | bucket with Object Lock |
| `MONGOSHIELD_TEST_S3_REGION` | variable (local) | AWS S3 | optional; CI passes `MONGOSHIELD_CLOUD_AWS_REGION` |
| `MONGOSHIELD_TEST_AWS_KMS_KEY` | variable | AWS KMS | `arn:aws:kms:eu-west-1:123456789012:key/…` |
| `MONGOSHIELD_TEST_R2_ACCOUNT_ID` | variable | R2 | Cloudflare account id |
| `MONGOSHIELD_TEST_R2_BUCKET` | variable | R2 | bucket name; enables the R2 job |
| `MONGOSHIELD_TEST_R2_ACCESS_KEY_ID` | **secret** | R2 | R2 API token access key id |
| `MONGOSHIELD_TEST_R2_SECRET_ACCESS_KEY` | **secret** | R2 | R2 API token secret |
| `MONGOSHIELD_CLOUD_GCP_WORKLOAD_IDENTITY_PROVIDER` | variable (CI only) | GCP job | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github`; enables the GCP job |
| `MONGOSHIELD_CLOUD_GCP_SERVICE_ACCOUNT` | variable (CI only) | GCP job | `mongoshield-cloud-tests@PROJECT.iam.gserviceaccount.com` |
| `MONGOSHIELD_TEST_GCS_BUCKET` | variable | GCS | plain bucket |
| `MONGOSHIELD_TEST_GCS_LOCK_BUCKET` | variable | GCS retention | bucket with per-object retention |
| `MONGOSHIELD_TEST_GCP_KMS_KEY` | variable | Cloud KMS | `projects/P/locations/europe-west1/keyRings/mongoshield-tests/cryptoKeys/backups` |
| `MONGOSHIELD_CLOUD_AZURE_CLIENT_ID` | variable (CI only) | Azure job | app registration's application (client) id; enables the Azure job |
| `MONGOSHIELD_CLOUD_AZURE_TENANT_ID` | variable (CI only) | Azure job | directory (tenant) id |
| `MONGOSHIELD_TEST_AZURE_ACCOUNT_URL` | variable | Azure Blob | `https://mongoshieldtests.blob.core.windows.net` |
| `MONGOSHIELD_TEST_AZURE_CONTAINER` | variable | Azure Blob | plain container |
| `MONGOSHIELD_TEST_AZURE_LOCK_CONTAINER` | variable | Azure immutability | container with version-level WORM |
| `MONGOSHIELD_TEST_AZURE_KEY_URL` | variable | Key Vault | `https://mongoshield-tests.vault.azure.net/keys/backups` |
| `MONGOSHIELD_TEST_SFTP_HOST` | variable | SFTP | host name; enables the SFTP job |
| `MONGOSHIELD_TEST_SFTP_PORT` | variable | SFTP | optional, default 22 |
| `MONGOSHIELD_TEST_SFTP_USERNAME` | variable | SFTP | login user |
| `MONGOSHIELD_TEST_SFTP_HOST_FINGERPRINT` | variable | SFTP | `SHA256:…` of the host key (comma-separated for several) |
| `MONGOSHIELD_TEST_SFTP_PATH` | variable | SFTP | writable directory, e.g. `/upload` |
| `MONGOSHIELD_TEST_SFTP_PRIVATE_KEY` | **secret** | SFTP | the user's unencrypted private key (OpenSSH/PEM text) |
| `MONGOSHIELD_TEST_PREFIX` | variable (optional) | all | top-level prefix, default `mongoshield-ci` |

In the tables and commands below, replace `ShamalRathnayake/mongoshield` with your
fork if you run this elsewhere.

## GitHub setup (once)

1. **Environment.** Settings → Environments → *New environment* → `cloud-tests`.
   Every job in `cloud.yml` uses it, and the cloud trust policies below accept only
   tokens issued for it, so no other workflow (and no pull request) can assume the
   test roles. Optionally add a required reviewer or restrict it to `main`.
2. **Secrets** (R2 and SFTP only): add them as environment secrets of `cloud-tests`
   (or repository secrets).
3. **Variables:** add the repository variables from the table for the providers you
   set up. A provider without its gate variable shows up as *skipped*.
4. Run it: Actions → *Cloud* → *Run workflow*. It also runs every Monday. The run's
   summary page lists each provider's result.

GitHub OIDC tokens for these jobs have the subject
`repo:ShamalRathnayake/mongoshield:environment:cloud-tests`, which is what the trust
policies match.

## AWS: S3, S3 Object Lock and KMS

### Buckets

Plain bucket (default settings: versioning off, SSE-S3 encryption, public access
blocked):

```sh
aws s3api create-bucket --bucket mongoshield-cloud-tests --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1
aws s3api put-bucket-lifecycle-configuration --bucket mongoshield-cloud-tests \
  --lifecycle-configuration file://s3-lifecycle.json
```

`s3-lifecycle.json`: expire everything under the test prefix after two days, and
abandoned multipart uploads after one:

```json
{
  "Rules": [
    {
      "ID": "mongoshield-ci-expire",
      "Status": "Enabled",
      "Filter": { "Prefix": "mongoshield-ci/" },
      "Expiration": { "Days": 2 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

Object Lock bucket (Object Lock can only be switched on together with versioning;
**do not** set a default retention rule, MongoShield sets retention per object):

```sh
aws s3api create-bucket --bucket mongoshield-cloud-tests-lock --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1 \
  --object-lock-enabled-for-bucket
aws s3api put-bucket-lifecycle-configuration --bucket mongoshield-cloud-tests-lock \
  --lifecycle-configuration file://s3-lock-lifecycle.json
```

`s3-lock-lifecycle.json`: in a versioned bucket a delete only adds a delete marker,
so also expire old versions (once their one-day retention has ended) and the
leftover markers. S3 doesn't allow `Days` and `ExpiredObjectDeleteMarker` in one
rule, hence two rules:

```json
{
  "Rules": [
    {
      "ID": "mongoshield-ci-expire",
      "Status": "Enabled",
      "Filter": { "Prefix": "mongoshield-ci/" },
      "Expiration": { "Days": 2 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 2 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    },
    {
      "ID": "mongoshield-ci-markers",
      "Status": "Enabled",
      "Filter": { "Prefix": "mongoshield-ci/" },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    }
  ]
}
```

### KMS key

A symmetric encryption key (the default type) in the same region:

```sh
aws kms create-key --description "MongoShield cloud tests" --region eu-west-1
aws kms create-alias --alias-name alias/mongoshield-cloud-tests \
  --target-key-id <KeyId from the output> --region eu-west-1
```

Use the **key ARN** for `MONGOSHIELD_TEST_AWS_KMS_KEY`. The default key policy
delegates to IAM, so the role policy below is enough.

### GitHub OIDC role

1. Add the GitHub OIDC identity provider to the account (once per account): IAM →
   Identity providers → *Add provider* → OpenID Connect, URL
   `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. Create the role `mongoshield-cloud-tests` with this **trust policy**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:ShamalRathnayake/mongoshield:environment:cloud-tests"
        }
      }
    }
  ]
}
```

3. Attach this **permission policy** (inline). It allows exactly what the tests do,
   under the test prefix only. Notes on two of the actions:
   - `s3:GetBucketObjectLockConfiguration` lets the adapter detect a bucket without
     Object Lock before it reads any data. The conformance suite checks exactly that,
     so the test role needs it (production roles may omit it).
   - `s3:PutObjectRetention` is needed to write locked objects. There is deliberately
     no `s3:BypassGovernanceRetention`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTestPrefix",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": [
        "arn:aws:s3:::mongoshield-cloud-tests",
        "arn:aws:s3:::mongoshield-cloud-tests-lock"
      ],
      "Condition": { "StringLike": { "s3:prefix": "mongoshield-ci/*" } }
    },
    {
      "Sid": "ReadBucketLockSettings",
      "Effect": "Allow",
      "Action": "s3:GetBucketObjectLockConfiguration",
      "Resource": [
        "arn:aws:s3:::mongoshield-cloud-tests",
        "arn:aws:s3:::mongoshield-cloud-tests-lock"
      ]
    },
    {
      "Sid": "ReadWriteTestObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:PutObjectRetention"
      ],
      "Resource": [
        "arn:aws:s3:::mongoshield-cloud-tests/mongoshield-ci/*",
        "arn:aws:s3:::mongoshield-cloud-tests-lock/mongoshield-ci/*"
      ]
    },
    {
      "Sid": "WrapDataKeys",
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt"],
      "Resource": "arn:aws:kms:eu-west-1:123456789012:key/<key-id>"
    }
  ]
}
```

4. Repository variables: `MONGOSHIELD_CLOUD_AWS_ROLE_ARN`, `MONGOSHIELD_CLOUD_AWS_REGION`,
   `MONGOSHIELD_TEST_S3_BUCKET`, `MONGOSHIELD_TEST_S3_LOCK_BUCKET` (optional),
   `MONGOSHIELD_TEST_AWS_KMS_KEY` (optional).

## Cloudflare R2

1. R2 → *Create bucket* → `mongoshield-cloud-tests` (location: automatic).
2. Bucket → Settings → *Object lifecycle rules* → *Add rule*: prefix
   `mongoshield-ci/`, delete objects 2 days after upload, abort incomplete multipart
   uploads after 1 day.
3. R2 → *Manage R2 API tokens* → *Create API token*: permission **Object Read &
   Write**, *apply to specific buckets only* → the test bucket. Copy the access key
   id and secret (the secret is shown once).
4. Variables `MONGOSHIELD_TEST_R2_ACCOUNT_ID` (the account id from the R2 overview
   page) and `MONGOSHIELD_TEST_R2_BUCKET`; secrets
   `MONGOSHIELD_TEST_R2_ACCESS_KEY_ID` and `MONGOSHIELD_TEST_R2_SECRET_ACCESS_KEY`.

The tests use the S3 adapter exactly as the docs recommend for R2:
`endpoint: https://<account>.r2.cloudflarestorage.com`, `region: "auto"`,
`requestChecksumCalculation: "WHEN_REQUIRED"`. R2's bucket locks are not the S3
Object Lock API, so the R2 target checks that retained writes are refused.

## Google Cloud: GCS, object retention and Cloud KMS

```sh
PROJECT=my-project
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')
SA=mongoshield-cloud-tests@$PROJECT.iam.gserviceaccount.com
```

### Buckets

Soft delete is turned off (it would keep and bill every deleted test object for a
week), and both buckets get the same lifecycle rule:

```sh
gcloud storage buckets create gs://mongoshield-cloud-tests --project=$PROJECT \
  --location=europe-west1 --uniform-bucket-level-access --soft-delete-duration=0
# Per-object retention can only be enabled when a bucket is created:
gcloud storage buckets create gs://mongoshield-cloud-tests-lock --project=$PROJECT \
  --location=europe-west1 --uniform-bucket-level-access --soft-delete-duration=0 \
  --enable-per-object-retention
gcloud storage buckets update gs://mongoshield-cloud-tests --lifecycle-file=gcs-lifecycle.json
gcloud storage buckets update gs://mongoshield-cloud-tests-lock --lifecycle-file=gcs-lifecycle.json
```

`gcs-lifecycle.json` (a retained object is deleted once its retention has ended):

```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 2, "matchesPrefix": ["mongoshield-ci/"] }
    },
    {
      "action": { "type": "AbortIncompleteMultipartUpload" },
      "condition": { "age": 1, "matchesPrefix": ["mongoshield-ci/"] }
    }
  ]
}
```

### KMS key

```sh
gcloud kms keyrings create mongoshield-tests --location=europe-west1 --project=$PROJECT
gcloud kms keys create backups --keyring=mongoshield-tests --location=europe-west1 \
  --purpose=encryption --project=$PROJECT
```

`MONGOSHIELD_TEST_GCP_KMS_KEY` is the key's resource name (not a key version):
`projects/$PROJECT/locations/europe-west1/keyRings/mongoshield-tests/cryptoKeys/backups`.

### Service account and roles

```sh
gcloud iam service-accounts create mongoshield-cloud-tests --project=$PROJECT

for BUCKET in mongoshield-cloud-tests mongoshield-cloud-tests-lock; do
  # Read/write/delete objects, including setting retention on new objects.
  gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
    --member=serviceAccount:$SA --role=roles/storage.objectAdmin
  # storage.buckets.get: lets the adapter detect a bucket without object retention
  # before uploading (objectAdmin lacks it). The conformance suite checks that.
  gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
    --member=serviceAccount:$SA --role=roles/storage.legacyBucketReader
done

gcloud kms keys add-iam-policy-binding backups --keyring=mongoshield-tests \
  --location=europe-west1 --project=$PROJECT \
  --member=serviceAccount:$SA --role=roles/cloudkms.cryptoKeyEncrypterDecrypter
```

Do not grant `storage.objects.overrideUnlockedRetention`.

### Workload Identity Federation (GitHub OIDC)

```sh
gcloud iam workload-identity-pools create github --project=$PROJECT \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github --project=$PROJECT \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.repository == 'ShamalRathnayake/mongoshield' && assertion.environment == 'cloud-tests'"

gcloud iam service-accounts add-iam-policy-binding $SA --project=$PROJECT \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/subject/repo:ShamalRathnayake/mongoshield:environment:cloud-tests"
```

Variables: `MONGOSHIELD_CLOUD_GCP_WORKLOAD_IDENTITY_PROVIDER` =
`projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github`,
`MONGOSHIELD_CLOUD_GCP_SERVICE_ACCOUNT` = `$SA`, plus `MONGOSHIELD_TEST_GCS_BUCKET`,
`MONGOSHIELD_TEST_GCS_LOCK_BUCKET` (optional) and `MONGOSHIELD_TEST_GCP_KMS_KEY`
(optional).

## Azure: Blob Storage, immutability and Key Vault

```sh
RG=mongoshield-tests
ACCOUNT=mongoshieldtests          # globally unique, lowercase
VAULT=mongoshield-tests           # globally unique
az group create --name $RG --location westeurope
```

### Storage account and containers

Blob versioning is required for version-level immutability; shared-key access is
switched off because the tests use Entra ID only:

```sh
az storage account create --name $ACCOUNT --resource-group $RG --location westeurope \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false --allow-shared-key-access false
az storage account blob-service-properties update --account-name $ACCOUNT \
  --resource-group $RG --enable-versioning true

az storage container-rm create --storage-account $ACCOUNT --resource-group $RG \
  --name cloud-tests
az storage container-rm create --storage-account $ACCOUNT --resource-group $RG \
  --name cloud-tests-lock --enable-vlw
```

Do not add a container-level time-based retention policy; MongoShield sets an
immutability policy per blob.

Lifecycle management (deletes test blobs and their old versions after two days; an
immutable version is deleted only after its policy expires):

```sh
az storage account management-policy create --account-name $ACCOUNT \
  --resource-group $RG --policy @azure-lifecycle.json
```

`azure-lifecycle.json`:

```json
{
  "rules": [
    {
      "enabled": true,
      "name": "mongoshield-ci-expire",
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["cloud-tests/mongoshield-ci/", "cloud-tests-lock/mongoshield-ci/"]
        },
        "actions": {
          "baseBlob": { "delete": { "daysAfterModificationGreaterThan": 2 } },
          "version": { "delete": { "daysAfterCreationGreaterThan": 2 } }
        }
      }
    }
  ]
}
```

### Key Vault key

An RBAC-mode vault and an RSA key (MongoShield wraps with `RSA-OAEP-256`):

```sh
az keyvault create --name $VAULT --resource-group $RG --location westeurope \
  --enable-rbac-authorization true
az keyvault key create --vault-name $VAULT --name backups --kty RSA --size 3072
```

`MONGOSHIELD_TEST_AZURE_KEY_URL` = `https://$VAULT.vault.azure.net/keys/backups`
(without a version: the tests record the version they used, as production does).
Creating the key needs *Key Vault Crypto Officer* for yourself on the vault.

### App registration, federated credential and roles

```sh
APP_ID=$(az ad app create --display-name mongoshield-cloud-tests --query appId -o tsv)
az ad sp create --id $APP_ID
SP_ID=$(az ad sp show --id $APP_ID --query id -o tsv)

az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-cloud-tests",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:ShamalRathnayake/mongoshield:environment:cloud-tests",
  "audiences": ["api://AzureADTokenExchange"]
}'

SCOPE=$(az storage account show --name $ACCOUNT --resource-group $RG --query id -o tsv)
# Plain container: read, write, delete blobs and use Blob Batch.
az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$SCOPE/blobServices/default/containers/cloud-tests"
# Lock container: setting immutability policies needs Storage Blob Data Owner.
az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Owner" \
  --scope "$SCOPE/blobServices/default/containers/cloud-tests-lock"
# Key Vault: get the key (to choose the algorithm), wrapKey and unwrapKey.
az role assignment create --assignee-object-id $SP_ID --assignee-principal-type ServicePrincipal \
  --role "Key Vault Crypto User" \
  --scope "$(az keyvault show --name $VAULT --query id -o tsv)/keys/backups"
```

The workflow logs in with `allow-no-subscriptions: true`: the tests only use data
plane permissions, so the app needs no subscription role.

Variables: `MONGOSHIELD_CLOUD_AZURE_CLIENT_ID` = `$APP_ID`,
`MONGOSHIELD_CLOUD_AZURE_TENANT_ID` = `az account show --query tenantId -o tsv`,
`MONGOSHIELD_TEST_AZURE_ACCOUNT_URL` = `https://$ACCOUNT.blob.core.windows.net`,
`MONGOSHIELD_TEST_AZURE_CONTAINER` = `cloud-tests`,
`MONGOSHIELD_TEST_AZURE_LOCK_CONTAINER` = `cloud-tests-lock` (optional),
`MONGOSHIELD_TEST_AZURE_KEY_URL` (optional).

Role assignments take a few minutes to apply. A run right after setup may fail with
`AuthorizationPermissionMismatch`; run it again later.

## SFTP

Any SFTP server reachable from GitHub's runners works: a small VM with OpenSSH, AWS
Transfer Family, a Hetzner Storage Box, rsync.net, …

1. Create a user whose only access is SFTP to one writable directory (with OpenSSH:
   `Match User mongoshield-ci` + `ForceCommand internal-sftp` + `ChrootDirectory`).
2. Generate a key pair without a passphrase and authorize its public key:

   ```sh
   ssh-keygen -t ed25519 -N "" -C mongoshield-cloud-tests -f mongoshield-ci
   ```

3. Read the server's host key fingerprint **from the server itself** (not over the
   network, which is what the check protects against):

   ```sh
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # → 256 SHA256:… (ED25519)
   ```

4. Variables `MONGOSHIELD_TEST_SFTP_HOST`, `MONGOSHIELD_TEST_SFTP_PORT` (optional),
   `MONGOSHIELD_TEST_SFTP_USERNAME`, `MONGOSHIELD_TEST_SFTP_HOST_FINGERPRINT`
   (the `SHA256:…` part), `MONGOSHIELD_TEST_SFTP_PATH` (e.g. `/upload`); secret
   `MONGOSHIELD_TEST_SFTP_PRIVATE_KEY` = the whole content of `mongoshield-ci`.

SFTP has no lifecycle rules. The tests delete every file they write, but the empty
per-run directories stay. Clean them up now and then, e.g. with a daily cron job on
the server:

```sh
find /srv/sftp/upload/mongoshield-ci -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rm -rf {} +
```

## When a cloud test fails

- **Configured but no credentials** (`CredentialsProviderError`,
  `Could not load the default credentials`, `DefaultAzureCredential failed`): the
  suite does not skip in this case on purpose. Log in, or check the OIDC step in the
  workflow log.
- **403 / AccessDenied / AuthorizationPermissionMismatch**: compare the role with the
  policies above. Missing `s3:GetBucketObjectLockConfiguration` or
  `storage.buckets.get` shows up as the "rejects retainUntil … before reading the
  body" test failing.
- **A real difference from the emulators**: that is what this suite is for. Fix the
  adapter, add a regression test that runs in the normal suite where possible, and
  never add `emulatorGaps` for a real service.
