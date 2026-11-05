# Backblaze B2 and Cloudflare R2

Both services speak the S3 API, so MongoShield stores backups there through its S3
adapter. The `b2://` and `r2://` storage URLs (and the `b2Storage` / `r2Storage`
factories) fill in everything each service needs, so you only name your bucket.

| | Backblaze B2 | Cloudflare R2 |
|:--|:--|:--|
| Free tier | 10 GB | 10 GB-month, free egress |
| Payment card | not needed at sign-up | needed on the Cloudflare account |
| URL | `b2://<bucket>/<prefix>?region=<region>` | `r2://<accountId>/<bucket>/<prefix>` |
| Credentials | an application key | an R2 API token |
| Storage lock | after a one-time check (see below) | yes |
| Write-once backups | buckets with Object Lock enabled | no (R2's bucket locks are not S3 Object Lock) |

Install the S3 SDK next to MongoShield (the GitHub Action does this for you):

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

## Backblaze B2 (no card)

1. **Create a bucket.** Buckets → *Create a Bucket*, private. Its page shows an
   *Endpoint* such as `s3.us-west-004.backblazeb2.com`: the part between `s3.` and
   `.backblazeb2.com` (`us-west-004`) is the bucket's **region**.
2. **Create an application key.** Application Keys → *Add a New Application Key*:
   allow access to this bucket only, with **Read and Write** access. Backblaze shows the
   key once:
   - `keyID` → `AWS_ACCESS_KEY_ID`
   - `applicationKey` → `AWS_SECRET_ACCESS_KEY`

   The account's master application key does not work with the S3 API; use a bucket key.
3. **Write the config**:

   ```bash
   npx mongoshield init --storage "b2://acme-backups/prod?region=us-west-004" --keygen
   ```

   or run `npx mongoshield init` and pick *Backblaze B2* in the menu: it asks for the
   bucket, the region and a folder, and prints the steps above.
4. **Run a backup** with the key in the environment (repository secrets in GitHub Actions):

   ```bash
   export AWS_ACCESS_KEY_ID="<keyID>"
   export AWS_SECRET_ACCESS_KEY="<applicationKey>"
   export MONGODB_URI="mongodb+srv://…"
   npx mongoshield backup
   ```

What `b2://` sets up: the endpoint `https://s3.<region>.backblazeb2.com`, the bucket's
region, path-style requests (they work for every bucket name), and
`requestChecksumCalculation` / `responseChecksumValidation` `WHEN_REQUIRED`, because B2
does not reliably accept the AWS SDK's default per-part checksums on multipart uploads.
Backups are still checked end to end: every file's SHA-256 is in the manifest.

**The storage lock.** The scheduled-run lock and the manifest write use
"create only if absent" (`If-None-Match: *`). MongoShield trusts it on AWS and R2; on
B2 it checks once, at the first conditional write, by writing a small probe object
twice. If the check fails, the storage lock is refused with a hint (use
`schedule.lock: "mongo"`, or a workflow `concurrency` group in GitHub Actions) and the
manifest is written without the condition, with a warning.

**Write-once backups.** On a bucket created with *Object Lock* enabled, `retainDays`
works as on S3 (`?retention=governance` for governance mode). See
[immutable backups](./immutable-backups.md).

## Cloudflare R2 (needs a card)

1. **Create a bucket.** R2 → *Create bucket*. The R2 overview page shows your
   **account id** (32 hex characters) under *Account details*.
2. **Create an API token.** R2 → *Manage API tokens* → *Create API token*: permission
   **Object Read & Write**, applied to this bucket only. Copy the
   *Access Key ID* (`AWS_ACCESS_KEY_ID`) and *Secret Access Key* (`AWS_SECRET_ACCESS_KEY`).
3. **Write the config**:

   ```bash
   npx mongoshield init --storage "r2://0123456789abcdef0123456789abcdef/acme-backups/prod" --keygen
   ```

   or pick *Cloudflare R2* in the `init` menu.
4. **Run a backup** with the token's keys in `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY`.

What `r2://` sets up: the endpoint `https://<accountId>.r2.cloudflarestorage.com`
(`?jurisdiction=eu` or `fedramp` for buckets created in a jurisdiction, which have their
own endpoint), region `auto`, and the same `WHEN_REQUIRED` checksum settings. The account
id comes first in the URL because it, not the bucket, names the endpoint.

## URL parameters

Both schemes take the S3 adapter's own parameters (see the storage URL table in the
README): `partSizeMiB` and `queueSize` (upload memory), `requestChecksumCalculation`,
`responseChecksumValidation`, `exactLastModified`, `conditionalWrites=true|false|probe`
and `retention=compliance|governance`. `endpoint` and `forcePathStyle` are refused,
because the preset decides them, and so is `region` on `r2://`. `region` is required on
`b2://`.

## In code

```ts
import { b2Storage, r2Storage } from "mongoshield/storage/s3";

const b2 = b2Storage({ bucket: "acme-backups", prefix: "prod", region: "us-west-004" });
const r2 = r2Storage({ accountId: "0123…cdef", bucket: "acme-backups", prefix: "prod" });
```

Every `s3Storage` option except `endpoint`, `region` (B2 takes its own), `forcePathStyle`
and `client` is accepted, including `credentials` for keys that do not come from the
environment.

## Free space

Neither service has a fixed size, so the free-space check before each backup is skipped
for them; their bills, not a quota, are the limit.
