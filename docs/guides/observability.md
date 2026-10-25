# Observability: logs, progress, traces, metrics and alerts

A backup nobody watches fails without anyone noticing. This guide covers every
way MongoShield tells you what it is doing: log lines, progress events,
OpenTelemetry traces and metrics, restore drills that measure your real
recovery time, and exit codes to alert on.

None of this is on by default. MongoShield prints nothing, logs nothing and
loads no telemetry package until you ask it to.

## Logs

The library logs through a four-method `Logger` interface
(`debug`, `info`, `warn`, `error`, each taking a message and optional fields).
Pass one to `new MongoShield({ logger })`.

```ts
import { MongoShield, fromPino } from "mongoshield";
import pino from "pino";

const shield = new MongoShield({ storage, logger: fromPino(pino()) });
```

Other loggers fit in one line:

```ts
// console
const logger = {
  debug: (message, fields) => console.debug(message, fields ?? {}),
  info: (message, fields) => console.info(message, fields ?? {}),
  warn: (message, fields) => console.warn(message, fields ?? {}),
  error: (message, fields) => console.error(message, fields ?? {}),
};

// winston: its methods already take (message, meta)
const logger = winstonLogger;

// consola
const logger = {
  debug: (m, f) => consola.debug(m, f),
  info: (m, f) => consola.info(m, f),
  warn: (m, f) => consola.warn(m, f),
  error: (m, f) => consola.error(m, f),
};
```

Log fields carry ids, counts, sizes and namespace names. They never carry
connection-string passwords, keys or passphrases (MongoShield redacts URIs
before logging them).

On the CLI, warnings always reach stderr; `--verbose` adds the debug and info
lines, `--quiet` hides everything but warnings and errors.

## Progress events

`backup()`, `restore()`, `verify()` and `drill()` accept `onProgress`, called
with these events:

| `type` | Fields | When |
|---|---|---|
| `namespace:start` | `ns`, `estimatedDocuments` | a collection starts |
| `namespace:progress` | `ns`, `documents`, `bytes` | periodically while it runs |
| `namespace:done` | `ns`, `documents` | a collection finished |
| `overall` | `documents`, `estimatedDocuments`, `bytes`, `elapsedMs`, `etaMs` | periodically, for the whole run |

Scheduled runs (`mongoshield run`, `mongoshield schedule`, `runScheduledJob()`)
also produce a run report (status, backup id, verification, prune result,
attempts) that is sent to webhooks, Slack or Discord and printed with `--json`.
See [scheduling](./scheduling.md).

## OpenTelemetry

MongoShield creates spans and metrics through `@opentelemetry/api`, an
optional peer dependency. It records anything only when:

1. `@opentelemetry/api` is installed (otherwise MongoShield never notices it is
   missing: the one failed import is cached and every call runs normally), and
2. your application registered an SDK (a tracer and/or meter provider). Without
   one, no span objects are created at all.

Set `telemetry: { enabled: false }` to never load the API, even when installed.

### Setup with the Node SDK

```sh
npm install @opentelemetry/api @opentelemetry/sdk-node \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
```

```ts
// telemetry.ts: import this before anything else
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

const sdk = new NodeSDK({
  serviceName: "mongo-backups",
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown());
```

```ts
import "./telemetry.ts";
import { MongoShield } from "mongoshield";

const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI },
  storage,
  telemetry: { includeNamespaces: false }, // the default
});
```

The SDK's context manager makes spans nest: the MongoDB driver's and your
storage SDK's spans (if you enable their instrumentations) appear under
MongoShield's operation span. Short-lived processes (Lambda, `mongoshield run`
from a wrapper script) must call `sdk.shutdown()` before exiting, or the last
batch of spans and metrics is lost.

### What is never recorded

Spans and metrics carry ids, counts, sizes, durations, modes and error codes.
They never carry connection strings, credentials, keys, passphrases, document
contents or error messages (messages can quote host names, paths or namespace
names; the error *code* is recorded as `error.type` instead).

Namespace names (`app.users`) can reveal customers or products, so they are
recorded only with `telemetry: { includeNamespaces: true }`.

### Spans

One span per public operation, ending when the operation does. A thrown error
marks the span failed (`error.type` = the error code, status `ERROR`) and is
rethrown unchanged. A verification or drill that *finds problems* does not
throw, but its span is marked failed with `error.type: MS_INTEGRITY_FAILED`, so
alerts on failed spans catch damaged backups.

| Span | Attributes |
|---|---|
| `mongoshield.backup` | `mongoshield.backup.id`, `mongoshield.backup.status` (`complete` / `checkpointed`), `mongoshield.consistency`, `mongoshield.namespaces.count`, `mongoshield.documents`, `mongoshield.bytes.raw`, `mongoshield.bytes.stored`, `mongoshield.namespaces.names`¹ |
| `mongoshield.restore` | `mongoshield.mode`, `mongoshield.dry_run`, `mongoshield.backup.id`, `mongoshield.namespaces.count`, `mongoshield.documents`, `mongoshield.namespaces.names`¹ (targets) |
| `mongoshield.verify` | `mongoshield.mode`, `mongoshield.backup.id`, `mongoshield.ok`, `mongoshield.files.checked`, `mongoshield.bytes.checked`, `mongoshield.documents`, `mongoshield.problems` |
| `mongoshield.prune` | `mongoshield.dry_run`, `mongoshield.prune.deleted_backups`, `mongoshield.prune.deleted_bytes` |
| `mongoshield.drill` | `mongoshield.backup.id`, `mongoshield.ok`, `mongoshield.drill.rto_ms`, `mongoshield.namespaces.count`, `mongoshield.documents`, `mongoshield.problems` |

¹ only with `includeNamespaces: true`.

Inside those, the engines open one span per unit of work, so a trace shows where
a slow operation spent its time. They are skipped entirely when telemetry is
disabled.

| Span | Inside | Attributes |
|---|---|---|
| `mongoshield.backup.namespace` | backup | `mongoshield.namespace`¹, `mongoshield.part` (split collections only: one span per part), `mongoshield.documents`, `mongoshield.bytes.raw`, `mongoshield.bytes.stored` |
| `mongoshield.restore.namespace` | restore, drill | `mongoshield.namespace`¹ (the target), `mongoshield.documents`. Converge backups get two per collection: documents, then indexes after the replay |
| `mongoshield.restore.replay` | restore, drill | `mongoshield.replay.events` (events applied): a converge backup's change window, or the journal of a point-in-time restore |
| `mongoshield.verify.namespace` | verify | `mongoshield.namespace`¹, `mongoshield.problems`; failed with `error.type: MS_INTEGRITY_FAILED` when that namespace has problems |

### Metrics

Instrumentation scope `mongoshield`. Durations are in seconds, as OpenTelemetry
recommends.

| Instrument | Kind | Unit | Attributes | Meaning |
|---|---|---|---|---|
| `mongoshield.backups` | counter | `{backup}` | `mongoshield.status` (`success`, `checkpointed`, `failure`), `error.type` | backup runs |
| `mongoshield.backup.duration` | histogram | `s` | `mongoshield.status`, `error.type` | how long backups took |
| `mongoshield.restore.duration` | histogram | `s` | `mongoshield.status`, `error.type`, `mongoshield.drill` | how long restores took; drill restores (your measured RTO) carry `mongoshield.drill=true` |
| `mongoshield.documents` | counter | `{document}` | `mongoshield.operation` (`backup`, `restore`, `verify`, `drill`) | documents written, restored, checked |
| `mongoshield.bytes` | counter | `By` | `mongoshield.operation`, `mongoshield.bytes.kind` (`raw`, `stored`) | bytes processed |

A resumable backup that stops at a checkpoint counts as `checkpointed`; its
documents and bytes are counted once, when the backup completes.

Useful alerts:

- **No successful backup in 26 hours:** `increase(mongoshield_backups_total{mongoshield_status="success"}[26h]) == 0`.
- **Backup failures:** any increase of `mongoshield_backups_total{mongoshield_status="failure"}`, grouped by `error_type`.
- **RTO budget:** the latest `mongoshield_restore_duration_seconds{mongoshield_drill="true"}` above your recovery-time objective.
- **Backups getting slower:** p95 of `mongoshield_backup_duration_seconds` over a week.

(Names shown as a Prometheus exporter writes them; other backends keep the dots.)

## Restore drills: measuring the RTO

A verification proves the files are intact; a drill proves the backup
*restores*, and measures how long that takes, which is your real recovery time.

```sh
mongoshield drill latest --target-uri "$SCRATCH_URI" --sample 100 --assertions ./drill.ts
# RTO 4m 12s  (restore of backup 2026-10-21T03-15-02Z_7f3a9c: 18,204,511 documents)
# …
# ✔ Drill passed: backup 2026-10-21T03-15-02Z_7f3a9c restores completely (5m 01s in total).
```

The drill restores into temporary databases (`msdrill_<run>_<db>`) on the
scratch deployment, checks every collection's document count and indexes,
compares `--sample` random documents byte for byte with the backup, runs your
assertions, and always drops the temporary databases (also when it fails or is
interrupted; `--keep` keeps them for inspection). It refuses to run against the
deployment the backup came from unless you pass `--allow-same-deployment`.

```ts
// drill.ts: one function per database in the backup (or one function for all)
import type { Db } from "mongodb";

export default {
  app: async (db: Db) => {
    const users = await db.collection("users").countDocuments({ active: true });
    if (users < 1000) throw new Error(`only ${users} active users`);
  },
};
```

From code: `await shield.drill({ backup: "latest", target: { uri: scratchUri }, sample: 100 })`.
Every drill is recorded next to the backup (`annotations/<id>/drills/`), and its
RTO is reported on the `mongoshield.drill` span and the restore-duration
histogram.

## Exit codes for alerting

Every CLI failure exits with the code of its error (the full list is in
[error codes](../errors.md)). The ones worth alerting on differently:

| Exit | Code | What to do |
|---|---|---|
| 0 | | Success (for `mongoshield run`: also "another runner held the lock") |
| 2 | `MS_CONFIG_INVALID` | Fix the config or flags; retrying will not help |
| 10–12 | connection, authentication, permissions | Check the deployment, credentials and roles |
| 20–24 | storage | Check bucket permissions, space and network |
| 33 | `MS_INTEGRITY_FAILED` | A verification or drill found problems: **do not rely on that backup** |
| 34 | `MS_GUARD_FAILED` | The backup guard thinks data was lost since the previous backup |
| 41–42 | decryption, missing key | The key given cannot open the backup |
| 60 / 61 | aborted, timed out | The run was interrupted or exceeded `timeoutMinutes` |

Pair exit codes with a heartbeat (`heartbeat:` in the config): an exit code
only alerts when the job runs at all.
