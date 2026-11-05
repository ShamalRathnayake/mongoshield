---
"@mongoshield/console": patch
"@mongoshield/operator": minor
---

Console: Azure storage locations with empty or `sig`-less credentials are refused
when saved, and an unusable stored credential never falls back to the console's
managed identity, so the endpoint guard can't be bypassed. Restores no longer plan
twice before running.

Operator: while job images are restricted, a plan's `spec.job.env` can't set
code-loading variables (`NODE_OPTIONS` beyond heap and warning flags, `LD_*`,
`DYLD_*`) or the operator's own connection variables, and `spec.job.envFrom` is
refused unless `MONGOSHIELD_ALLOW_JOB_ENV_FROM` (Helm `jobPolicy.allowEnvFrom`) is
set. Those names are also pinned last in every pod, so a referenced Secret can't
inject them.
