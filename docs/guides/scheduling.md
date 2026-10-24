# Running backups unattended

A backup you have to remember to run is a backup that eventually stops
happening. This guide covers running MongoShield on a schedule, keeping
several runners from colliding, getting told when something breaks, and
noticing when backups silently stop.

Every scheduled run does the same job, in this order:

```
(jitter) → lock → backup (+ guard) → verify → prune → notify + heartbeat → unlock
```

A failed step stops the run: nothing is pruned after a backup that failed or
did not verify.

## The config

```ts
// mongoshield.config.ts
import { defineConfig } from "mongoshield";

export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "s3://acme-backups/prod",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  backup: { include: ["app.*"] },

  retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },

  schedule: {
    cron: "15 3 * * *",        // 03:15 every day (5 fields)
    timezone: "Europe/Berlin", // default UTC
    lock: "storage",           // "storage" (default) | "mongo" | "none"
    jitterSeconds: 300,        // start up to 5 minutes late, at random
    retries: 2,                // transient failures only (default 2)
    timeoutMinutes: 120,       // abort a run that takes longer (retries included)
    verify: "fast",            // "none" | "fast" (default) | "deep" | "drill"
    prune: true,               // apply `retention` after each good backup (default)
  },

  guard: { maxDocumentDropPercent: 50, maxSizeDropPercent: 30 },

  notify: [
    { type: "slack", url: process.env.SLACK_WEBHOOK_URL },                // failures only
    { type: "webhook", url: "https://ops.example.com/hooks/backups", on: ["success", "failure"] },
  ],
  heartbeat: process.env.HEARTBEAT_URL,
});
```

`verify: "deep"` decrypts every file, so it needs the private key on the
machine running backups (`decryption.identityFiles`). The default `"fast"`
check (sizes and SHA-256 of every file) needs no key, which is why it is the
right default for a machine that only holds public keys.

`verify: "drill"` goes furthest: it restores each new backup into temporary
databases on a scratch deployment, checks counts, indexes, a sample of documents
and your own assertions, drops the temporary databases, and reports how long the
restore took (your measured RTO) as `verify.rtoMs`. It needs a `drill` section
(the config is refused without one):

```ts
drill: {
  targetUri: process.env.SCRATCH_MONGODB_URI, // never the production source
  sample: 100,                                // documents per collection compared byte for byte
  assertions: "./drill-checks.ts",            // optional, relative to the working directory
},
```

A drill that finds problems fails the run with `MS_INTEGRITY_FAILED`, like a
failed verification. See the restore drills section of the
[observability guide](./observability.md).

## Where to run it

| Option | Command | Good for | Watch out for |
|---|---|---|---|
| In-process scheduler | `mongoshield schedule` | A container or systemd service that runs forever; a sidecar | It only runs while the process is up: pair it with a heartbeat |
| System cron | `mongoshield run` in a crontab | A VM you already manage | cron's environment is minimal; set `PATH` and secrets explicitly |
| Kubernetes CronJob | `mongoshield run` as the container command | Clusters | Set `concurrencyPolicy: Forbid` *and* keep the lock (pods can overlap during node failures) |
| GitHub Actions | `npx mongoshield run` on `schedule:` | Small projects without servers | Scheduled workflows can start late or be skipped under load; use a heartbeat |
| Lambda / Vercel cron | `runScheduledJob()` from your handler | Serverless apps | Execution time limits (15 min on Lambda, less on Vercel) bound the backup size |

### `mongoshield schedule`

```sh
mongoshield schedule
# Schedule: 15 3 * * * (Europe/Berlin). Next runs:
#   2026-10-21 03:15 (2026-10-21T01:15:00.000Z)
#   …
```

It prints the next run times, runs the job at each slot, and keeps going after
failures (each one is reported). Runs never overlap: a slot that passes while
the previous run is still busy is skipped and logged, not queued.

On `SIGTERM` or Ctrl-C it stops scheduling and gives a running backup
`--grace-seconds` (default 60) to finish. After that the backup is aborted:
its partial files are deleted, the lock released, the failure reported, and
the process exits 0. A second Ctrl-C exits immediately. Set your
orchestrator's termination grace period a little longer than `--grace-seconds`.

`--cron` and `--timezone` override the config; with `--json` every finished
run prints one JSON report.

### `mongoshield run`

Runs the job once and exits. Exit code 0 means success, *or* that another
runner held the lock (the run was skipped: that is the lock working). Any
other exit code is the error that stopped the run (see [errors](../errors.md));
a guard or verification failure is `33`.

```sh
# crontab: every night at 03:15
15 3 * * * cd /srv/backups && mongoshield run --quiet >> /var/log/mongoshield.log 2>&1
```

Flags: `--verify none|fast|deep` and `--no-prune` override the config,
`--jitter` waits a random 0–`jitterSeconds` first (useful when many cron
entries fire at the same minute), `--json` prints the run report.

```yaml
# Kubernetes CronJob (abridged)
apiVersion: batch/v1
kind: CronJob
metadata: { name: mongo-backup }
spec:
  schedule: "15 3 * * *"
  timeZone: "Europe/Berlin"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 0           # MongoShield retries transient errors itself
      template:
        spec:
          restartPolicy: Never
          terminationGracePeriodSeconds: 60
          containers:
            - name: mongoshield
              image: node:24-slim
              command: ["npx", "-y", "mongoshield", "run"]
              envFrom: [{ secretRef: { name: mongo-backup } }]
```

```yaml
# GitHub Actions
on:
  schedule: [{ cron: "15 3 * * *" }]
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npx -y mongoshield run
        env:
          MONGODB_URI: ${{ secrets.MONGODB_URI }}
          MONGOSHIELD_WEBHOOK_SECRET: ${{ secrets.WEBHOOK_SECRET }}
```

### From code (Lambda, Vercel, your own worker)

```ts
import { MongoShield, runScheduledJob } from "mongoshield";

export async function handler() {
  const shield = new MongoShield({ source: { uri }, storage });
  const report = await runScheduledJob(shield, config, {
    signal: AbortSignal.timeout(14 * 60_000), // stay inside Lambda's 15 minutes
  });
  await shield.close();
  if (report.status === "failure") throw new Error(report.error?.message);
}
```

`runScheduledJob` never throws; it returns the run report described below.
`BackupScheduler` is the in-process scheduler behind `mongoshield schedule`,
if you want it inside an existing long-running service.

## Off-site copies (3-2-1)

Keep at least one copy of every backup somewhere else: another region, another
provider, or a write-once bucket that your everyday credentials cannot touch.

```ts
export default defineConfig({
  // …
  replicate: [
    { storage: "s3://acme-backups-offsite/prod", retainDays: 30 },
    { storage: "/mnt/nas/mongo-backups" },
  ],
});
```

After each successful backup, `mongoshield run` copies it to every target (streamed,
each file checked against its recorded SHA-256 and read back, manifest last; see
`mongoshield replicate --help`). A failing target is reported in the run report and does
not fail the backup or stop the other targets. `retainDays` makes the copies write-once
(the target must support object lock). To copy existing backups, or to catch up after a
target was unreachable, run `mongoshield replicate all --to <storage-url>`: backups that
are already there are skipped.

## Locks

Overlapping runs are easy to get by accident: three app replicas each start
the scheduler, or a CronJob starts a pod while the previous one still runs.
Each run therefore takes a **lease**: a lock with an owner and an expiry (5
minutes), renewed every 100 seconds while the run works and released at the
end. If the holder crashes, the lease expires and the next run takes over.
A run that finds the lock taken is **skipped**: it does nothing, sends no
alerts, and exits 0.

- **`lock: "storage"`** (default) keeps the lock next to the backups, under
  `locks/backup/`. It needs a storage adapter with conditional writes
  (create-if-absent); MongoShield refuses to start otherwise. Each lease is its
  own numbered object, so taking over an expired lease never deletes someone
  else's: of several runners racing for the next number, the store lets exactly
  one create it. Expiry compares the clocks of the machines involved, so keep
  them NTP-synced (the 5-minute lease absorbs any realistic drift).
- **`lock: "mongo"`** keeps a document in `mongoshield.locks` on the source
  deployment and uses the server's clock, so machine clocks do not matter.
  It **writes to the database you back up**: the user needs `readWrite` on the
  `mongoshield` database, and you may want `exclude: ["mongoshield.*"]`.
- **`lock: "none"`** for a single runner that cannot overlap with itself.

If a renewal finds that another runner has taken over (or renewals fail until
the lease expires), the run aborts instead of carrying on beside the new
holder.

## Retries and timeouts

Only transient failures are retried: lost connections (`MS_CONNECTION_FAILED`)
and storage I/O errors (`MS_STORAGE_IO`). Configuration, permission,
integrity and guard failures would fail the same way again, so they fail at
once. Each step retries on its own (a flaky verify never creates a second
backup), with exponential backoff (30 s, 60 s, … capped at 5 minutes) of which
a random half is dropped, so runners that failed together do not retry in
lockstep. `timeoutMinutes` bounds the whole run, retries included.

## The backup guard

The scary failure mode of unattended backups: a collection is dropped or
emptied by mistake, the nightly backup faithfully captures the damage, and
retention prunes the last good copies. The guard compares each new backup with
the previous one before committing it:

| Setting | Flags |
|---|---|
| `failOnMissingCollection` (default `true`) | a namespace in the previous backup is missing |
| `maxDocumentDropPercent` | a collection lost more than this share of its documents |
| `maxSizeDropPercent` | the total raw size dropped by more than this |
| `action: "fail"` (default) / `"warn"` | refuse to commit the backup / only report |

"Previous" is the newest complete backup that started earlier, comes from the
same deployment, and has the same **shape**: the same include/exclude patterns.
Scheduled runs record the shape in the `mongoshield.shape` label, so a backup
of `app.*` is never compared with one of `analytics.*`. A refused backup is
not committed, the run fails with `MS_INTEGRITY_FAILED` (exit code 33), and the
findings are in the report and notifications. If the change was intended, run
once with `action: "warn"` (or the thresholds raised) to accept the new baseline.

## Notifications

`notify` takes a list of targets. `on` chooses the outcomes (default: failures
only). Skipped runs never notify. Each request has a 10-second timeout and is
retried once (after network errors, 5xx and 429); a broken target is logged and
never fails the run. Messages contain no connection strings or secrets.

**Slack** (`type: "slack"`): an [incoming webhook](https://api.slack.com/messaging/webhooks)
URL; the message uses blocks (summary, backup id, sizes, verify, host, error and hint).

**Discord** (`type: "discord"`): a channel webhook URL; the message is an embed,
green or red, with mentions disabled.

**Webhook** (`type: "webhook"`): a JSON `POST`:

```http
POST /hooks/backups
Content-Type: application/json
X-MongoShield-Event: backup.failure
X-MongoShield-Timestamp: 1792555204
X-MongoShield-Signature: sha256=5f0c…

{ "event": "backup.failure", "report": { …run report… } }
```

When `MONGOSHIELD_WEBHOOK_SECRET` is set, requests are signed: the signature is
HMAC-SHA256, keyed with the secret, over `<timestamp>.<raw body>`. Verify it
before trusting the body, and reject timestamps older than a few minutes:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isAuthentic(rawBody, headers, secret) {
  const timestamp = headers["x-mongoshield-timestamp"];
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const given = String(headers["x-mongoshield-signature"]);
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

### The run report

`mongoshield run --json` prints it and webhooks send it (`version: 1`):

```json
{
  "version": 1,
  "runId": "3f9c1a2b7d4e",
  "status": "success",
  "startedAt": "2026-10-21T01:15:00.000Z",
  "finishedAt": "2026-10-21T01:17:31.000Z",
  "durationMs": 151000,
  "host": "backup-worker-1",
  "storage": "s3://acme-backups/prod/",
  "lock": { "kind": "storage" },
  "backup": { "id": "2026-10-21T01-15-00Z_7f3a9c", "namespaces": 12, "documents": 1840211,
              "bytesRaw": 2147483648, "bytesStored": 402653184, "durationMs": 140000, "attempts": 1 },
  "guard": { "ok": true, "action": "fail", "baselineId": "2026-10-20T01-15-02Z_19be04", "findings": [] },
  "verify": { "mode": "fast", "ok": true, "problems": [], "attempts": 1 },
  "prune": { "deletedBackups": 1, "deletedBytes": 398458880, "kept": 14 }
}
```

`status` is `success`, `failure`, `skipped` or `checkpointed` (the backup used up
`backup.maxDurationMs` and saved a checkpoint; the next run resumes it, verify is
skipped, notifications and the heartbeat treat it as a success, and webhooks get the
event `backup.checkpointed`; see docs/specs/PARTS-AND-RESUME.md). A failure adds
`"error": { "step": "backup" | "verify" | "prune" | "lock" | "setup", "code": "MS_…", "message": "…", "hint": "…", "attempts": 3 }`;
a drill adds the measured restore time to `verify` (`"mode": "drill", …, "rtoMs": 42000`);
a skipped run adds `lock.heldBy` (owner, host, expiry). Sections for steps that
did not run are absent.

## Heartbeats

Alerts only fire when a run fails. If the scheduler itself dies, or the
CronJob is deleted, nothing fails and nothing is sent. A heartbeat (dead man's
switch) service expects a ping every period and alerts you when one is late.

Set `heartbeat` to the ping URL. After every finished run MongoShield sends
`GET <url>` on success and `GET <url>/fail` on failure (skipped runs do not
ping; the runner holding the lock does).

- **[healthchecks.io](https://healthchecks.io)**: create a check with the same
  schedule (cron, your time zone) and a grace time longer than your longest
  backup; use its ping URL, e.g. `https://hc-ping.com/<uuid>`. `/fail` is native.
- **[Better Stack](https://betterstack.com/uptime)**: create a heartbeat with
  the period and grace; use `https://uptime.betterstack.com/api/v1/heartbeat/<token>`.
  It also understands `/fail`.
- **[Cronitor](https://cronitor.io)**: use the telemetry URL
  `https://cronitor.link/p/<api-key>/<monitor-key>`. For `cronitor.link`
  URLs MongoShield sends `?state=complete` or `?state=fail` instead of `/fail`.

The ping URL is a secret (anyone with it can mark your backups healthy), so
keep it in an environment variable, as in the example config.
