# Kubernetes

Run backups as a **CronJob** that executes `mongoshield run`: take a backup, verify it,
apply retention and send notifications, then exit. Kubernetes decides when; the config
file decides what.

Two ways to install:

- the Helm chart in [`deploy/helm/mongoshield`](../../deploy/helm/mongoshield/)
- a plain manifest, [`deploy/kubernetes/cronjob.yaml`](../../deploy/kubernetes/cronjob.yaml)

Both need Kubernetes 1.27+ (for the CronJob `timeZone` field).

Prefer backups and restores as Kubernetes objects, with results in `status`, events and
per-plan metrics? See the [Kubernetes operator](kubernetes-operator.md).

## 1. Secrets

The chart never creates Secrets, so credentials stay out of Helm's release history.

```bash
kubectl create namespace backups
kubectl -n backups create secret generic mongoshield \
  --from-literal=MONGODB_URI='mongodb+srv://backup:…@cluster0.example.mongodb.net/'
```

Generate an encryption key pair on your machine and keep the secret key **outside** the
cluster; only the public key goes into the values:

```bash
npx mongoshield@next keygen --output backup.key   # prints age1…
```

## 2. Storage credentials

Prefer workload identity, so no cloud keys are stored at all:

| Cloud | ServiceAccount annotation |
|---|---|
| AWS (IRSA) | `eks.amazonaws.com/role-arn: arn:aws:iam::<account>:role/mongoshield` |
| GKE | `iam.gke.io/gcp-service-account: mongoshield@<project>.iam.gserviceaccount.com` |
| Azure | `azure.workload.identity/client-id: <client-id>` plus pod label `azure.workload.identity/use: "true"` |

The role needs list, read, write and delete on the backup bucket/prefix (delete is used by
retention). For S3-compatible stores without workload identity, put `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` in a Secret and reference it with `extraEnvFrom`.

The published image contains the AWS SDK only. For GCS or Azure, build an image with
`--build-arg CLOUD_SDKS=gcs` (or `azure`, `all`) and set `image.repository`; see the
[Docker guide](./docker.md#image-variants-and-building-your-own).

## 3. Install with Helm

```yaml
# my-values.yaml
image:
  tag: "next" # pin a release in production, e.g. "2.0.0"
schedule: "15 3 * * *"
timeZone: Europe/Berlin
recipients:
  - age1…
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/mongoshield
config:
  storage: s3://acme-backups/prod?region=eu-central-1
  backup:
    exclude: ["*.sessions"]
  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 }
  schedule:
    lock: storage
    verify: fast
  heartbeat: https://hc-ping.com/your-uuid
```

```bash
helm install mongoshield ./deploy/helm/mongoshield -n backups -f my-values.yaml
```

`config` becomes `mongoshield.config.json` in a ConfigMap (no secrets in it). The chart
copies `schedule` and `timeZone` into `config.schedule`, so the time lives in one place.
Every value is documented in [`values.yaml`](../../deploy/helm/mongoshield/values.yaml).

`retention` is applied after every good run, to **this release's backups only**: those
of the same source deployment and the same `backup.include`/`exclude` selection. Several
releases (one per cluster or database, or an hourly CronJob next to a nightly one) can
therefore share one bucket and prefix without pruning each other's backups. To prune the
whole bucket on purpose, run a one-off `mongoshield prune --all-sources --yes` job.

## 4. Test it

```bash
kubectl -n backups create job --from=cronjob/mongoshield mongoshield-test
kubectl -n backups logs -f job/mongoshield-test
```

List backups from your laptop (or another pod) with the same storage URL:

```bash
npx mongoshield@next list --from s3://acme-backups/prod
```

## How the CronJob is set up, and why

| Setting | Default | Why |
|---|---|---|
| `concurrencyPolicy` | `Forbid` | never two backups at once (the storage lock also guards manual runs) |
| `backoffLimit` | `1` | MongoShield already retries inside the pod (`config.schedule.retries`) |
| `activeDeadlineSeconds` | 6 h | hard stop for a stuck run |
| `startingDeadlineSeconds` | 1 h | a missed slot (cluster down) still runs, but not hours late |
| security context | uid 65532, read-only root FS, no capabilities | the image needs none; `/tmp` is an `emptyDir` |
| `automountServiceAccountToken` | `false` | MongoShield never calls the Kubernetes API |
| resources | 250m CPU, 256Mi request; 1Gi memory limit | memory stays flat (streaming); CPU speeds up compression |

## Deep verification and restores in the cluster

`verify: deep` decrypts every file, so it needs the secret key. Only if you accept the key
being in the cluster:

```bash
kubectl -n backups create secret generic mongoshield-identity --from-file=identity.txt=backup.key
```

```yaml
identity:
  secretName: mongoshield-identity
config:
  schedule:
    verify: deep
```

For a restore, run a one-off pod with the image and `restore … --dry-run` first; see
`mongoshield restore --help`.

## Local storage

Object storage in another failure domain is strongly preferred. To use a volume anyway,
create a PVC, then set `persistence.enabled: true`, `persistence.existingClaim: <pvc>` and
`config.storage: /backups`.
