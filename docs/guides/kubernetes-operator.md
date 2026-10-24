# Kubernetes operator

The MongoShield operator manages backups and restores as Kubernetes objects. You describe
*what* to back up, *where* to and *when* in a `MongoShieldBackupPlan`; every run shows up as
a `MongoShieldBackup` with the backup id, sizes and verification result in its status; a
restore is a `MongoShieldRestore` you can `kubectl apply`, review and audit like anything else;
and a `MongoShieldDrill` proves a backup restores, and measures how long it takes.

```console
$ kubectl get msplan,msbackup
NAME                                           SCHEDULE     SUSPENDED   READY   LAST SUCCESS   AGE
mongoshieldbackupplan.mongoshield.io/nightly   15 3 * * *   false       True    7h             12d

NAME                                                PLAN      PHASE       BACKUP ID                     STORED     VERIFIED   AGE
mongoshieldbackup.mongoshield.io/nightly-29330595   nightly   Succeeded   2026-10-24T03-15-04Z_9f2c1a   48213110   true       7h
mongoshieldbackup.mongoshield.io/nightly-29332035   nightly   Succeeded   2026-10-25T03-15-03Z_1b7e40   48390202   true       3m
```

If a CronJob running `mongoshield run` is all you need, the plain
[Kubernetes guide](kubernetes.md) (Helm chart `deploy/helm/mongoshield`) is simpler. The
operator adds validation before anything runs, results in `status`, Kubernetes Events,
per-plan Prometheus metrics, declarative restores with a confirmation rule, and run history.

Requirements: Kubernetes 1.27+ (CronJob `timeZone`); the CRDs' CEL validation rules need
1.25+ and are generally available from 1.29.

## How it works

```
MongoShieldBackupPlan ──▶ ConfigMap   mongoshield.config.json (no secrets)
          │          └──▶ CronJob     `mongoshield run --json` on spec.schedule
          │                  └──▶ Job ──▶ MongoShieldBackup (one per run; status = run report)
          │
MongoShieldBackup (manual) ──▶ Job    `mongoshield run --json --no-prune`
MongoShieldRestore         ──▶ Job    `mongoshield restore <id> --json`, MONGODB_URI = the target
MongoShieldDrill           ──▶ Job    `mongoshield drill <id> --json`, MONGOSHIELD_DRILL_URI = the scratch target
MongoShieldBackup deleted, deletionPolicy: Delete
                           ──▶ Job    `mongoshield delete <id> --yes --json`, then the object goes
```

- **Plans become CronJobs.** Kubernetes runs the schedule, so backups keep happening while
  the operator is down or being upgraded, and `kubectl create job --from=cronjob/nightly`
  works as usual. The operator records each Job the CronJob starts as a `MongoShieldBackup`.
- **Every run is the official MongoShield image** (`docker/Dockerfile`) running the CLI.
  The operator itself never connects to MongoDB or storage.
- **Results come from MongoShield's `--json` output.** When a Job finishes, the operator
  reads the run report (or restore result, or error) from the pod's log and copies it into
  the object's status: backup id, namespaces, documents, raw and stored bytes, duration,
  verification problems, prune counts, MongoShield's error code and hint. The exit code and
  the pod's termination message (`FallbackToLogsOnError`) are fallbacks when the log is gone.
  After that the Job can be garbage-collected (`ttlSecondsAfterFinished`, 1 day by default)
  without losing anything.
- **Secrets never pass through the operator.** Pods reference Secrets by name and the
  kubelet injects them (`MONGODB_URI`, `MONGOSHIELD_PASSPHRASE`, the age identity file,
  cloud credentials). The operator has no permission to read Secrets at all.
- **Plans are validated with MongoShield's own config schema** before anything is created,
  so a typo shows up as `Ready=False, reason InvalidSpec` with the exact problem, not as a
  failed pod at 3 a.m.

## Install

With Helm (CRDs are in the chart's `crds/` folder and installed first):

```bash
helm install mongoshield-operator ./deploy/helm/mongoshield-operator \
  --namespace mongoshield-system --create-namespace \
  --set image.tag=0.1.0 --set jobImage.tag=2.0.0
```

Or with plain manifests:

```bash
kubectl apply --server-side -f deploy/operator/crds.yaml
kubectl apply -f deploy/operator/operator.yaml   # edit the two image tags first
```

Useful values ([`values.yaml`](../../deploy/helm/mongoshield-operator/values.yaml) documents
all of them):

| Value | Default | Meaning |
|---|---|---|
| `jobImage.repository` / `.tag` | `ghcr.io/shamalrathnayake/mongoshield:latest` | Image the backup and restore Jobs run. Pin a version. Use a `CLOUD_SDKS=all` build for GCS/Azure. |
| `watchNamespaces` | `[]` (all) | Only manage these namespaces (RoleBindings instead of a ClusterRoleBinding). |
| `replicaCount` | `1` | `2` for fast failover; leader election keeps one active. |
| `rbac.aggregateToDefaultRoles` | `true` | Grant the MongoShield kinds to the built-in `view`/`edit`/`admin` roles. |
| `metrics.serviceMonitor.enabled` | `false` | Create a Prometheus Operator ServiceMonitor. |

## Back up

Put the connection string (a user with the built-in `backup` role) and, unless you use
workload identity, the storage credentials in Secrets next to the plan:

```bash
kubectl create secret generic prod-mongodb \
  --from-literal=MONGODB_URI='mongodb+srv://backup:PASSWORD@cluster0.example.net/'
kubectl create secret generic s3-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=… --from-literal=AWS_SECRET_ACCESS_KEY=…
```

```yaml
apiVersion: mongoshield.io/v1alpha1
kind: MongoShieldBackupPlan
metadata:
  name: nightly
spec:
  source:
    uriSecretRef: { name: prod-mongodb }          # key defaults to MONGODB_URI
  storage:
    url: s3://acme-backups/prod?region=eu-west-1  # or gs://, azure://, sftp://, /path
    credentialsSecretRef: { name: s3-credentials } # its keys become environment variables
  encryption:
    recipients: [age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq]
  schedule:
    cron: "15 3 * * *"
    timeZone: Europe/Berlin
  backup:
    exclude: ["*.sessions"]
  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 }
  verify: fast
```

`kubectl describe msplan nightly` shows the conditions (`Ready`, `LastBackupSucceeded`),
the next and last run, and events such as `CronJobCreated` or `InvalidSpec`.

### The plan spec

| Field | Meaning |
|---|---|
| `source.uriSecretRef` | Secret (and key, default `MONGODB_URI`) with the connection string. |
| `storage.url` | A storage URL or an absolute path. |
| `storage.credentialsSecretRef` | A Secret exposed as environment variables (cloud credentials). |
| `storage.persistentVolumeClaim` | `{ claimName, mountPath }` to mount for path storage (mountPath defaults to `/backups`). |
| `encryption.recipients` / `.kms` | Public age keys / cloud KMS keys to encrypt for. |
| `encryption.passphraseSecretRef` | A passphrase instead (cannot be combined with recipients or KMS). |
| `encryption.identitySecretRef` | The age secret key, for `verify: deep` and restores. Leave it out of the cluster when you can. |
| `schedule` | `cron`, `timeZone`, `suspend`, `startingDeadlineSeconds`. Without it the plan only runs manual backups. |
| `backup` | `include`, `exclude`, `consistency`, `compression`, `parallelism`, `readPreference`, `labels`, `retainDays`, `usersAndRoles`. |
| `incremental` | `{ fullEveryDays, maxChainLength }`: incremental backups (see below). |
| `retention` | `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `minVerified`; applied after each scheduled run. |
| `verify` | `none`, `fast` (default: checksums, no key), `deep`, or `drill` (restore every new backup into `spec.drill`'s scratch deployment and check it; the RTO lands in `status.verification.rtoMs`). |
| `drill` | `{ targetUriSecretRef, sample, prefix }`: the scratch deployment for `verify: drill`. Its URI stays in the Secret (`MONGOSHIELD_DRILL_URI` in the pod), never in the ConfigMap. |
| `retries`, `lock` | Retries inside a run (default 2); the overlap lock (`storage` by default). |
| `extraConfig` | Any other `mongoshield.config.json` settings (notify, heartbeat, guard, replicate…), merged under the generated ones. Stored in a ConfigMap: **no secrets**. |
| `history` | `successfulLimit` (10) and `failedLimit` (5) finished run records to keep. |
| `job` | Pod settings: `image`, `serviceAccountName` (workload identity), `resources`, `nodeSelector`, `tolerations`, `affinity`, `podLabels`, `env`, `envFrom`, `activeDeadlineSeconds` (6 h), `backoffLimit` (0), `ttlSecondsAfterFinished` (1 day). |

Storage retention (`spec.retention`, which deletes backups from storage) and run history
(`spec.history`, which deletes `MongoShieldBackup` objects) are separate on purpose:
deleting a record never deletes a backup (unless you ask for it with `deletionPolicy`).

**Plans that share a storage location never prune each other.** Every backup a plan writes
carries the label `mongoshield.plan=kubernetes/<namespace>/<name>` (MongoShield's
`retention.scopeLabels`), and its retention only covers backups with that label, from the
same source. Two plans for the same database and selection (a daily and a monthly one, say)
can therefore write to one bucket. The label also keeps incremental chains per plan.

### Incremental backups

"Full weekly, incremental hourly" is an hourly schedule plus `incremental.fullEveryDays: 7`:

```yaml
spec:
  schedule: { cron: "0 * * * *" }
  incremental: { fullEveryDays: 7 }
```

Each run's status says what it took: `kind: incremental` with `parentBackupId` and
`changes`, or `kind: full` with `fullBackupReason`. Incrementals need a replica set or
sharded cluster (MongoDB 6.0+); see [Incremental backups](incremental-backups.md).

### On-demand backups

```yaml
apiVersion: mongoshield.io/v1alpha1
kind: MongoShieldBackup
metadata:
  generateName: nightly-manual-
spec:
  planRef: { name: nightly }
  verify: deep     # optional: overrides the plan for this run
  prune: false     # default: a manual run leaves retention to the schedule
```

```bash
kubectl create -f backup.yaml
kubectl wait --for=condition=Complete msbackup/nightly-manual-x7k2p --timeout=1h
kubectl get msbackup nightly-manual-x7k2p -o jsonpath='{.status.backupId}'
```

Phases: `Pending` (waiting for the plan), `Running`, then `Succeeded`, `Checkpointed` (the
run hit its time budget and the next one resumes), `Skipped` (another run held the lock;
not an error) or `Failed`. The conditions are the authoritative state: `Complete`,
`Failed` and `Verified`. A pod that cannot start (missing Secret, image pull error) is
reported while the run is still `Running`, as `Complete=False, reason PodStuck`.

Deleting a running `MongoShieldBackup` stops its Job first (finalizer
`mongoshield.io/job-cleanup`); finished runs delete instantly.

### Deleting the backup with its record: `deletionPolicy`

By default (`deletionPolicy: Retain`) deleting a `MongoShieldBackup` deletes only the
record. With `deletionPolicy: Delete`, a finished backup carries the finalizer
`mongoshield.io/delete-backup-data`, and deleting the object first runs
`mongoshield delete <backupId>` in a Job with the plan's storage settings:

- the manifest is deleted first, so nothing ever sees a half-deleted backup, then its files;
- backups on hold, still write-once (`retainDays` / object lock) or needed by an
  incremental are **refused** (`MS_BACKUP_PROTECTED`): the object stays, the `DataDeleted`
  condition and a Warning event say why, and the operator tries again every 5 minutes (a
  hold may be released, a lock may expire). Set `deletionPolicy: Retain` to give up and
  delete only the record;
- a backup that is already gone counts as deleted.

`deletionPolicy` may be changed after the run (patch an old record to `Delete`, then delete
it). Deleting a plan waits for its records that are deleting their data, since they need
the plan's storage settings.

## Restore

```yaml
apiVersion: mongoshield.io/v1alpha1
kind: MongoShieldRestore
metadata:
  name: staging-refresh
spec:
  planRef: { name: nightly }            # storage and decryption key
  backup: { name: nightly-29332035 }    # a MongoShieldBackup, or { id: <backup id> }, or { id: latest } (default)
  target:
    uriSecretRef: { name: staging-mongodb }  # required: there is no default target
  rename:
    - { from: "app.*", to: "app_restored.*" }
  # include, exclude, mode, dryRun, at (point in time), skipIndexes, usersAndRoles
```

The default mode, `fail-if-exists`, never overwrites anything. The modes that can (`drop`,
`insert`, `upsert`) need **`spec.confirm` set to the target Secret's name**: the declarative
version of "type the name to confirm". The API server refuses the object otherwise (a CEL
rule in the CRD), and the operator checks again. A `dryRun: true` restore needs no
confirmation and writes nothing; its status shows how many namespaces would be restored.

A restore runs once: its spec is immutable and its Job does not retry (`backoffLimit: 0`).
To restore again, create a new object. Deleting a running restore stops its pod before the
object goes away, so once `kubectl delete` returns nothing is writing to the target.

The restore Job gets the restore's target as `MONGODB_URI` and the plan's storage
credentials and identity. Whoever can create a `MongoShieldRestore` in a namespace can
therefore restore into any database whose Secret lives there: grant the kind accordingly
(`rbac.aggregateToDefaultRoles` gives it to `edit` and `admin`).

## Restore drills

A drill restores a backup into temporary databases on a **scratch** deployment, checks
document counts, indexes and (with `sample`) documents byte for byte, drops the temporary
databases, and reports the measured restore time: your real RTO.

```yaml
apiVersion: mongoshield.io/v1alpha1
kind: MongoShieldDrill
metadata:
  generateName: nightly-drill-
spec:
  planRef: { name: nightly }
  backup: { id: latest }                    # or { name: <MongoShieldBackup> }
  target:
    uriSecretRef: { name: scratch-mongodb }  # never the source: MongoShield refuses that
  sample: 100
```

```console
$ kubectl get msdrill
NAME                 PLAN      BACKUP ID                     PHASE       OK     RTO (MS)   AGE
nightly-drill-k2x7p  nightly   2026-10-25T03-15-03Z_1b7e40   Succeeded   true   48211      2m
```

The scratch URI reaches the Job only as `MONGOSHIELD_DRILL_URI` from the Secret; the Job
gets no `MONGODB_URI` at all. `Failed` with reason `DrillFoundProblems` means the drill ran
and found problems (`status.problems`). To drill every backup as it is taken, use
`verify: drill` with `spec.drill` on the plan instead.

## Observability

**Events** on every object: `CronJobCreated`, `Started`, `BackupSucceeded`, `BackupFailed`,
`VerificationFailed`, `LockHeld`, `PodStuck`, `RestoreSucceeded`, `ConfirmationRequired`,
`DrillPassed`, `DrillFoundProblems`, `DeletingBackupData`, `BackupDataDeleted`,
`BackupDataDeletionRefused`, `Cancelled`, …

**Metrics** on `:8080/metrics` (Service `mongoshield-operator`, port `http-metrics`):

| Metric | Meaning |
|---|---|
| `mongoshield_backup_last_success_timestamp_seconds{namespace,plan}` | Newest successful backup. Alert on `time() - … > 26*3600` for daily plans. |
| `mongoshield_backup_last_failure_timestamp_seconds{namespace,plan}` | Newest failed backup. |
| `mongoshield_backup_last_size_bytes{namespace,plan}` | Bytes stored by the newest successful backup. |
| `mongoshield_backup_last_duration_seconds{namespace,plan}` | How long it took. |
| `mongoshield_backups{namespace,plan,phase}` / `mongoshield_restores{namespace,phase}` / `mongoshield_drills{namespace,plan,phase}` | Objects by phase. |
| `mongoshield_drill_last_rto_seconds{namespace,plan}` | Restore time measured by the newest drill of each plan. |
| `mongoshield_operator_runs_finished_total{kind,phase}` | Runs the operator saw finish. |
| `mongoshield_operator_reconcile_total{controller,result}` | Reconciles: success, requeue, conflict, error. |
| `mongoshield_operator_reconcile_duration_seconds` | Reconcile latency histogram. |
| `mongoshield_operator_workqueue_depth{controller}` | Work waiting. |
| `mongoshield_operator_leader` | 1 on the replica that holds the Lease. |

**Probes:** `/healthz` (liveness) and `/readyz` (ready once its caches are synced, or while
standing by). Logs are JSON lines.

## Operating the operator

- **High availability:** with `replicaCount: 2`, one replica holds the
  `coordination.k8s.io` Lease and reconciles; the other keeps warm caches and takes over
  within seconds. A leader that cannot renew its Lease exits rather than risk two leaders.
  On `SIGTERM` the operator finishes running reconciles, releases the Lease and exits.
- **Upgrades:** Helm installs the chart's CRDs on the first install only and never
  upgrades them, so apply the new ones first:
  `kubectl apply --server-side --force-conflicts -f deploy/operator/crds.yaml`, then
  `helm upgrade`. Scheduled backups are CronJobs and keep running while the operator is
  replaced; runs that finish meanwhile are picked up when it is back (within the Job TTL).
- **Uninstalling:** `helm uninstall` leaves the CRDs (and so your plans) in place; Helm
  never deletes CRDs. Deleting a CRD deletes every object of that kind.
- **RBAC** ([`templates/rbac.yaml`](../../deploy/helm/mongoshield-operator/templates/rbac.yaml)):
  the MongoShield kinds and their status; CronJobs; Jobs; ConfigMaps (get/create/update);
  pods (list) and pods/log (get) to read results; events; one Lease in its own namespace.
  No Secrets. Creating Jobs that mount Secrets is still powerful, which is what
  `watchNamespaces` is for.

## Design notes

- **API group `mongoshield.io`, version `v1alpha1`.** One group for all kinds keeps RBAC
  rules short; `v1alpha1` says the schema may still change. It moves to `v1beta1` (with a
  conversion webhook if needed) once it has settled in real use.
- **Kinds prefixed `MongoShield…`** because Velero, CloudNativePG and others also define a
  `Backup` kind; short names `msplan`, `msbackup`, `msrestore`, `msdrill`; category
  `mongoshield` (`kubectl get mongoshield`).
- **Why pod logs, not the storage catalog, for results:** reading the catalog would need
  the operator to hold every plan's storage credentials and the cloud SDKs, and to read
  Secrets. MongoShield's `--json` output already has everything, and `pods/log` is a far
  smaller permission.

## Roadmap

- A schedule on `MongoShieldDrill` itself (today: `verify: drill` on the plan, or a CronJob
  that creates drills).
- `v1beta1`, once the API has settled in real use.

## Development

```bash
pnpm --filter @mongoshield/operator test       # unit tests (fake API server)
pnpm --filter @mongoshield/operator coverage
pnpm --filter @mongoshield/operator test:e2e   # kind cluster, real images, Helm chart
pnpm --filter @mongoshield/operator crds       # regenerate the CRD YAML from src/api/crds.ts
pnpm --filter @mongoshield/operator manifests  # regenerate deploy/operator/operator.yaml
```

The e2e runner downloads kind and helm into `packages/operator/.tools/bin` when they are
missing. `E2E_KUBE_CONTEXT=orbstack` runs it against OrbStack's Kubernetes instead
(`orb start k8s`), `E2E_KEEP_CLUSTER=1` keeps the kind cluster between runs.
