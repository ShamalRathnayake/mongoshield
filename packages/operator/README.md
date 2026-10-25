# @mongoshield/operator

A Kubernetes operator for [MongoShield](https://github.com/ShamalRathnayake/mongoshield):
MongoDB backups, restores and restore drills as custom resources (`mongoshield.io/v1alpha1`).

- **`MongoShieldBackupPlan`**: source, storage, encryption, schedule, retention, verification.
  Becomes a validated CronJob running the MongoShield image.
- **`MongoShieldBackup`**: one run, scheduled or on demand. Its status holds the backup id,
  sizes, duration and verification result. `deletionPolicy: Delete` also deletes the backup
  from storage when the object is deleted.
- **`MongoShieldRestore`**: a declarative restore. Overwriting needs an explicit confirmation.
- **`MongoShieldDrill`**: restore a backup into a scratch deployment, check it, measure the RTO.

Secrets never pass through the operator (it has no permission to read them), results come
from MongoShield's `--json` output, and it ships with Events, Prometheus metrics, health
probes and leader election.

## Install

The operator runs in the cluster as a container image. Install it with the Helm chart from
the repository:

```bash
git clone https://github.com/ShamalRathnayake/mongoshield && cd mongoshield
helm install mongoshield-operator ./deploy/helm/mongoshield-operator \
  --namespace mongoshield-system --create-namespace
```

Or apply the plain manifests: `deploy/operator/crds.yaml`, then `deploy/operator/operator.yaml`.

The npm package contains the operator's entry point (`mongoshield-operator`, which runs
against your current kubeconfig context). It is what the image runs; most people never
install it directly.

## Documentation

The full guide (every field, how results are read, RBAC, metrics, upgrades):
[docs/guides/kubernetes-operator.md](https://github.com/ShamalRathnayake/mongoshield/blob/main/docs/guides/kubernetes-operator.md).

The API is `v1alpha1` and may still change; the package follows a 0.x version line until it
is stable.

## License

MIT
