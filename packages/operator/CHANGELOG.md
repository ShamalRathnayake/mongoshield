# @mongoshield/operator

## 2.0.1

### Patch Changes

- Updated dependencies []:
  - mongoshield@2.0.1

## 2.0.0

### Minor Changes

- [#47](https://github.com/ShamalRathnayake/mongoshield/pull/47) [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - First release of the MongoShield Kubernetes operator (API `mongoshield.io/v1alpha1`):
  `MongoShieldBackupPlan` (source, storage, encryption, schedule, incremental cadence,
  retention, verify), `MongoShieldBackup` (one run, with the run report mirrored into its
  status, and `deletionPolicy: Delete` to delete the backup from storage with its record),
  `MongoShieldRestore` (declarative restores; overwriting modes need an explicit
  confirmation) and `MongoShieldDrill` (restore drills into a scratch deployment, with the
  measured RTO; plans can also `verify: drill`). Plans that share a storage location keep
  separate retention through a per-plan `mongoshield.plan` label. Plans become CronJobs running the MongoShield image; results are read from
  MongoShield's `--json` output. Finalizers, owner references, status conditions, Kubernetes
  Events, Prometheus metrics, health probes and Lease-based leader election. Ships as the
  `ghcr.io/shamalrathnayake/mongoshield-operator` image with a Helm chart
  (`deploy/helm/mongoshield-operator`) and plain manifests (`deploy/operator`).

### Patch Changes

- Updated dependencies [[`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`13a7f30`](https://github.com/ShamalRathnayake/mongoshield/commit/13a7f30b5eb8b52b784ecbea1efd5e3f5dcd2553), [`3562e4b`](https://github.com/ShamalRathnayake/mongoshield/commit/3562e4b609e710a27e414a2e9d8c01db8a3c86ad), [`f49712e`](https://github.com/ShamalRathnayake/mongoshield/commit/f49712ea1d356f78ab2f5f43bfdc37ae320dd888)]:
  - mongoshield@2.0.0
