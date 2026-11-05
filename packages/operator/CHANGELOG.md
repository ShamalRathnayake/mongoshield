# @mongoshield/operator

## 2.1.0

### Minor Changes

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Operator hardening:
  
  - Backup Jobs now default to the MongoShield image of the operator's own release
    (`ghcr.io/shamalrathnayake/mongoshield:<version>`, Helm: the chart's `appVersion`)
    instead of `:latest`.
  - New job policy: a plan's `spec.job.image` must come from an allowed repository (by
    default the default image's repository, any tag or digest) and
    `spec.job.serviceAccountName` from an allowed list (by default any). Configure with
    `MONGOSHIELD_ALLOWED_IMAGES` / `MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS` (Helm:
    `jobPolicy`). A plan outside the policy is `Ready=False`, reason `InvalidSpec`.
  - Restore, drill and delete Jobs pass the backup id after `--`, and the CRDs only accept
    `latest` or a real backup id in `spec.backup.id`, so an id can never be parsed as a flag.
  - `/metrics` can require a bearer token (`METRICS_TOKEN`); the Helm chart turns this on by
    default with a generated Secret and wires the ServiceMonitor to it. Optional
    NetworkPolicy (`networkPolicy.enabled`).
  - The HTTP endpoint listens on `::` (IPv4 and IPv6) and falls back to `0.0.0.0` on nodes
    without IPv6, so probes work in IPv6-only clusters.

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - Console: Azure storage locations with empty or `sig`-less credentials are refused
  when saved, and an unusable stored credential never falls back to the console's
  managed identity, so the endpoint guard can't be bypassed. Restores no longer plan
  twice before running.
  
  Operator: while job images are restricted, a plan's `spec.job.env` can't set
  code-loading variables (`NODE_OPTIONS` beyond heap and warning flags, `LD_*`,
  `DYLD_*`) or the operator's own connection variables, and `spec.job.envFrom` is
  refused unless `MONGOSHIELD_ALLOW_JOB_ENV_FROM` (Helm `jobPolicy.allowEnvFrom`) is
  set. Those names are also pinned last in every pod, so a referenced Secret can't
  inject them.

### Patch Changes

- [#71](https://github.com/ShamalRathnayake/mongoshield/pull/71) [`3d2105f`](https://github.com/ShamalRathnayake/mongoshield/commit/3d2105ffade653aa6f0fb0c5ba6fa3696807381c) Thanks [@ShamalRathnayake](https://github.com/ShamalRathnayake)! - The operator now states its real minimum Node.js version: 22.19 (was 22.12). Its HTTP
  client, undici 8 (also required by `@kubernetes/client-node` 2), crashes while loading
  on older Node.js. The published container image runs Node.js 24 and is not affected.
- Updated dependencies [[`3444b11`](https://github.com/ShamalRathnayake/mongoshield/commit/3444b115d7fba6e57eb591cd5148b501896881d3), [`dc25354`](https://github.com/ShamalRathnayake/mongoshield/commit/dc25354904ed9539c8a18e8c1d5ec32d793eda83), [`8a226be`](https://github.com/ShamalRathnayake/mongoshield/commit/8a226be565f66b3d75484cf586776307562c62b6), [`87357ce`](https://github.com/ShamalRathnayake/mongoshield/commit/87357ce06eafea4e5c39cd5086d84e6dde89625b), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f), [`5dde6c7`](https://github.com/ShamalRathnayake/mongoshield/commit/5dde6c797daa9db434226552d62f756ad964dd1f)]:
  - mongoshield@2.1.0

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
