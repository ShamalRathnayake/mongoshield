# Immutable backups

An attacker who gets into your infrastructure (ransomware, a leaked CI token, a
compromised admin account) usually goes for the backups first: delete them, then
encrypt the database. Encryption protects what is *in* a backup, but not the backup
itself. Anyone with write access to the bucket can still delete it.

Immutable backups close that gap. With `retainDays`, MongoShield asks the storage
provider to lock every file of the backup, so the provider itself refuses to delete
or overwrite them until the retention period ends. Your credentials can't do it, a
buggy prune can't do it, and in compliance mode not even the account owner can.

| Provider | Feature used | Bucket / container must have |
|---|---|---|
| Amazon S3 (and compatible stores that implement it) | Object Lock | Object Lock enabled |
| Google Cloud Storage | Object retention (per-object retention configuration) | Object retention enabled (only possible at bucket creation) |
| Azure Blob Storage | Blob immutability policy (version-level WORM) | Version-level immutability support |
| Local disk, SFTP | none | not supported |

## Using it

```ts
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI! },
  storage: s3Storage({ bucket: "acme-backups", prefix: "prod/" }),
});

await shield.backup({ retainDays: 30 }); // every file is locked for 30 days
```

From the CLI and config file, the same option is `--retain-days 30` /
`backup: { retainDays: 30 }`.

What happens:

1. Before reading anything from MongoDB, MongoShield checks that the storage can lock
   objects (`capabilities.objectLock`). Local disk and SFTP can't, so the backup fails
   straight away with `MS_CONFIG_INVALID` instead of producing files you think are
   protected but aren't.
2. One date is computed for the whole backup: `retainUntil = start of the run +
   retainDays`. Every data file, metadata file and finally the manifest is written
   with that date. On the first locked write, the adapter checks that the bucket is set
   up for retention and fails with `MS_CONFIG_INVALID` and a hint if it isn't.
3. The manifest records the date as `immutableUntil`.
4. `mongoshield list` and `inspect` show the date. `prune` keeps the backup until
   then, with the reason `immutable until 2026-12-14T03:00:04.000Z`, and never asks
   the storage to delete it early. Once the date has passed, the backup is subject
   to your normal retention rules again.

Restoring, verifying and copying are unaffected: locked objects can be read as usual.

Some small objects are deliberately *not* locked, because they must stay changeable:
verification results and holds (`annotations/`) and the scheduler's lock files
(`locks/`). They hold no backup data.

## Compliance or governance

Pick the mode per storage adapter with `retention: { mode }` (or `?retention=…` on a
storage URL). The default is `"compliance"`.

```ts
s3Storage({ bucket: "acme-backups", retention: { mode: "governance" } });
// or: storage: "s3://acme-backups/prod?retention=governance"
```

| | Compliance (default) | Governance |
|---|---|---|
| Protects against ransomware with normal credentials | yes | yes |
| Protects against a stolen admin / root account | **yes** | no |
| Can the lock be lifted or shortened? | never, by anyone | by principals with a special permission |
| S3 mode | `COMPLIANCE` | `GOVERNANCE` (lifted with `s3:BypassGovernanceRetention`) |
| GCS mode | `Locked` | `Unlocked` (lifted with `storage.objects.overrideUnlockedRetention`) |
| Azure policy mode | `Locked` | `Unlocked` (can be shortened or deleted by an authorized user) |
| Typical use | production, regulated data (SEC 17a-4, FINRA, …) | trying the feature, staging |

Compliance is the default because it is the only mode that still holds when the
attacker *is* an administrator. The flip side: a mistake can't be undone. Back up with
`retainDays: 3650` by accident and you will store, and pay for, that backup for ten
years. **Start with governance and a short `retainDays`, check the result, then switch
to compliance.**

Never grant the backup job's credentials the bypass permission for governance mode
(`s3:BypassGovernanceRetention`, `storage.objects.overrideUnlockedRetention`, or
Azure permissions to change immutability policies). Otherwise anyone who steals those
credentials can lift the lock.

## Amazon S3: Object Lock

Object Lock needs versioning. For a new bucket:

```sh
aws s3api create-bucket --bucket acme-backups --region eu-west-1 \
  --create-bucket-configuration LocationConstraint=eu-west-1 \
  --object-lock-enabled-for-bucket
```

For an existing bucket, enable versioning first, then Object Lock:

```sh
aws s3api put-bucket-versioning --bucket acme-backups \
  --versioning-configuration Status=Enabled
aws s3api put-object-lock-configuration --bucket acme-backups \
  --object-lock-configuration ObjectLockEnabled=Enabled
```

**Do not set a default retention rule on the bucket.** MongoShield sets retention on
each backup file itself. A bucket-wide default would also lock the scheduler's lock
files and the annotations, which must be deletable. Runs would then fail to release
their lock.

IAM permissions, in addition to the usual `s3:GetObject`, `s3:PutObject`,
`s3:DeleteObject` and `s3:ListBucket`:

- `s3:PutObjectRetention`: required to write locked objects.
- `s3:GetBucketObjectLockConfiguration`: optional. It lets MongoShield detect a bucket
  without Object Lock before uploading anything. Without it, the check is skipped and
  S3's own rejection is reported the same way.

Things to know:

- **Checksums.** S3 rejects Object Lock uploads that carry neither `Content-MD5` nor an
  `x-amz-checksum-*` header. MongoShield always requests a CRC32 checksum for locked
  uploads (also on every multipart part), so this works even if you pass your own
  client configured with `requestChecksumCalculation: "WHEN_REQUIRED"`.
- **Deletes become delete markers.** In a versioned bucket, deleting an object without
  a version id only hides it behind a delete marker. The locked version stays and is
  billed. MongoShield's prune waits for `immutableUntil`, but other tools may not.
- **Clean up old versions.** After pruning, the deleted backups' versions remain as
  *noncurrent* versions. Add a lifecycle rule that expires noncurrent versions after a
  few days and removes expired delete markers, plus `AbortIncompleteMultipartUpload`:

  ```json
  {
    "Rules": [
      {
        "ID": "mongoshield-cleanup",
        "Status": "Enabled",
        "Filter": { "Prefix": "prod/" },
        "NoncurrentVersionExpiration": { "NoncurrentDays": 3 },
        "Expiration": { "ExpiredObjectDeleteMarker": true },
        "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
      }
    ]
  }
  ```

  A lifecycle rule cannot remove a version that is still locked, so this is safe.
- **S3-compatible stores.** MinIO (buckets created with `--with-lock`) and Backblaze
  B2 implement Object Lock. Stores that don't, fail the first locked write with
  `MS_CONFIG_INVALID`. MongoShield never silently writes unlocked files.

## Google Cloud Storage: object retention

Per-object retention must be enabled **when the bucket is created**. It can't be
turned on later, so create a new bucket for immutable backups:

```sh
gcloud storage buckets create gs://acme-backups --location=europe-west1 \
  --enable-per-object-retention
```

MongoShield sets `retention: { mode, retainUntilTime }` in each object's upload
metadata, so an object is locked from the moment it exists.

Permissions: the service account needs `storage.objects.setRetention` (part of
`roles/storage.objectAdmin`) to write locked objects. Reading the bucket's settings for
the up-front check needs `storage.buckets.get`, which `objectAdmin` does not include;
without it the check is skipped and GCS's rejection is reported the same way.

Things to know:

- Deleting or overwriting a locked object fails with HTTP 403. MongoShield reports it
  as `MS_STORAGE_FORBIDDEN` and prune skips the backup.
- A bucket-wide retention policy ("Bucket Lock") would also protect backups, but it
  applies to every object, including lock files and annotations, and a locked policy
  can never be removed. Prefer per-object retention.
- Soft delete (on by default, 7 days) keeps deleted objects for a while after prune.
  That is extra protection, but it is billed. Set it to 0 if you don't need it on top
  of object retention.

## Azure Blob Storage: version-level immutability

Version-level immutability needs blob versioning on the storage account and
immutability support on the container:

```sh
az storage account blob-service-properties update \
  --account-name acmebackups --resource-group backups --enable-versioning true

# new container
az storage container-rm create --storage-account acmebackups \
  --resource-group backups --name prod --enable-vlw

# or migrate an existing container
az storage container-rm migrate-vlw --storage-account acmebackups \
  --resource-group backups --name prod
```

MongoShield sends the immutability policy (expiry date, mode `Locked` or `Unlocked`)
with the upload itself: on Put Blob for small files, on the final Put Block List for
streamed ones. A blob is locked from the moment it becomes visible.

Permissions: besides the role you already use for backups, the identity must be
allowed to set immutability policies. Reading the container's properties for the
up-front check is optional; without it Azure's rejection is reported the same way.

Things to know:

- Deleting or overwriting a locked blob fails with `409 BlobImmutableDueToPolicy`.
  MongoShield reports it as `MS_STORAGE_FORBIDDEN` and prune skips the backup.
- Don't configure a default container-level time-based retention policy. As with S3,
  it would lock the lock files and annotations too.
- Versioning keeps previous versions. Add a lifecycle management rule that deletes
  previous versions after a few days.

## Cost

- **You pay for the whole retention period.** A locked backup can't be deleted early,
  so `retainDays` sets the minimum time you pay for each backup. With daily backups
  and `retainDays: 30`, you always store at least 30 backups, whatever `retention`
  says.
- Choose `retainDays` to match the time an intrusion could go unnoticed (30 to 90
  days is common), not your longest retention. Monthly or yearly backups kept by
  `retention` stay deletable after their lock expires, so you can still prune them.
- Versioned buckets (S3, Azure) keep deleted versions until a lifecycle rule removes
  them. Without that rule, prune frees nothing.
- Cold storage classes (S3 Glacier, GCS Archive, Azure Cool/Archive) have minimum
  storage durations. That rarely matters for locked backups, which you keep at least
  that long anyway.
- Compliance mistakes are permanent. A wrong `retainDays` in compliance mode can't be
  fixed, only waited out.

## Testing locally

`memoryStorage({ objectLock: true })` behaves like a prepared bucket: it accepts
`retainUntil` and refuses to delete or overwrite locked objects. Pass `now` to
control its clock:

```ts
import { memoryStorage } from "mongoshield/storage/memory";

let now = new Date("2026-11-14T00:00:00Z");
const storage = memoryStorage({ objectLock: true, now: () => now });
await backup({ uri, storage, retainDays: 7 });
// … prune keeps it …
now = new Date("2026-11-22T00:00:00Z"); // retention over: prune may delete it now
```

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `MS_CONFIG_INVALID` "cannot make objects immutable" | The storage (disk, SFTP) has no object lock | Use S3, GCS or Azure, or drop `retainDays` |
| `MS_CONFIG_INVALID` "Object Lock is not enabled" | S3 bucket without Object Lock | Enable it (see above) |
| `MS_CONFIG_INVALID` "object retention is not enabled" | GCS bucket created without `--enable-per-object-retention` | Create a new bucket with it |
| `MS_CONFIG_INVALID` "version-level immutability is not enabled" | Azure container without version-level WORM | Enable or migrate the container |
| `MS_CONFIG_INVALID` "retainUntil … is not in the future" | `retainDays` is 0, or the clock is wrong | Use a positive `retainDays` and check NTP |
| `MS_STORAGE_FORBIDDEN` only when `retainDays` is set | Missing permission to set retention | Grant `s3:PutObjectRetention` / `storage.objects.setRetention` / the Azure immutability permission |
| prune reports a backup as *skipped* | The storage still locks it (clock skew, or an aborted run whose files were locked) | Nothing. It will be pruned once its lock expires |
