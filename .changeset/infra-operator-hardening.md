---
"@mongoshield/operator": minor
---

Operator hardening:

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
