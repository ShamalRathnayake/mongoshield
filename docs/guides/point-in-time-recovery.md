# Point-in-time recovery

Nightly backups lose up to a day of data. With the **change journal**, MongoShield records
every change between backups, so you can restore to any second: just before the bad
deploy, the accidental `deleteMany`, or the ransomware.

```
 base backup (03:00)        journal: every change, in 5-minute segments           now
 ──────●────────────────────▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮──────▶
                                                    ▲ restore --at 14:31:59
```

A point-in-time restore loads the newest backup before the chosen time, then replays the
journaled changes up to that time. The format and the exact rules are in
[docs/specs/JOURNAL.md](../specs/JOURNAL.md).

## Requirements

- A **replica set or sharded cluster on MongoDB 6.0+** (Atlas included). The journal reads
  a deployment-wide change stream.
- A user allowed to open it: `changeStream` and `find` on every database, e.g. the
  `readAnyDatabase` role. (The built-in `backup` role alone is not enough.)
- **Base backups with a cluster time**: `consistency: "converge"` (what `auto` picks on a
  replica set) or `"snapshot"`. Keep scheduling them as before; they must include every
  namespace the journal records.
- Storage with conditional writes (file, S3, GCS, Azure) for the writer's lease.
- Encryption with **recipients or KMS keys**. Passphrases are refused for the journal:
  every segment is its own encrypted file, and a passphrase costs a second of scrypt per
  file.

## Setting up the journal writer

Run exactly **one** writer per storage location, next to your scheduled backups. A lease
in storage (`locks/journal/`) makes sure a second one cannot start by accident.

### Docker

```bash
docker run -d --name mongoshield-journal --restart unless-stopped --init \
  -e MONGODB_URI='mongodb+srv://journal:…@cluster0.example.mongodb.net/' \
  -e MONGOSHIELD_STORAGE='s3://acme-backups/prod?region=eu-west-1' \
  -e MONGOSHIELD_RECIPIENTS='age1…' \
  ghcr.io/shamalrathnayake/mongoshield:next \
  journal start --heartbeat https://hc-ping.com/<uuid> --wait-for-lease
```

`docker stop` sends SIGTERM: the writer commits the segment it is writing, releases the
lease and exits 0. `--wait-for-lease` lets a replacement container wait for the old one
instead of failing.

### Kubernetes

A Deployment with one replica (not a CronJob: the writer runs all the time):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mongoshield-journal
  namespace: backups
spec:
  replicas: 1                  # exactly one writer; the lease enforces it anyway
  strategy:
    type: Recreate             # or RollingUpdate together with --wait-for-lease
  selector:
    matchLabels: { app: mongoshield-journal }
  template:
    metadata:
      labels: { app: mongoshield-journal }
    spec:
      serviceAccountName: mongoshield          # workload identity for the bucket
      terminationGracePeriodSeconds: 60        # time to commit the last segment
      containers:
        - name: journal
          image: ghcr.io/shamalrathnayake/mongoshield:next
          args: ["journal", "start", "--wait-for-lease", "--heartbeat", "$(HEARTBEAT_URL)"]
          envFrom:
            - secretRef: { name: mongoshield }   # MONGODB_URI, HEARTBEAT_URL
          env:
            - { name: MONGOSHIELD_STORAGE, value: "s3://acme-backups/prod?region=eu-west-1" }
            - { name: MONGOSHIELD_RECIPIENTS, value: "age1…" }
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 512Mi }
```

Memory stays flat whatever the write load: segments are streamed to storage while they
are written.

### From your own code

```ts
import { startJournal } from "mongoshield";

const journal = await startJournal({
  client,                                   // a connected MongoClient
  storage,                                  // the same storage as the backups
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  takeBaseBackup: (signal) => shield.backup({ consistency: "converge", signal }),
  notify: { targets: [{ type: "slack", url: process.env.SLACK_WEBHOOK }], heartbeat: process.env.HEARTBEAT_URL },
});
process.once("SIGTERM", () => void journal.stop());
await journal.done;                         // rejects if the writer stops on an error
```

## Choosing segment sizes

| Setting | Default | What it decides |
|---|---|---|
| `--segment-seconds` / `segmentSeconds` | 300 | the normal worst-case RPO: changes are safe in storage once their segment is committed |
| `--segment-size` / `segmentBytes` | 64 MiB | a busy database closes segments early so each stays a manageable download |

The same settings can live in the config file, next to the backup settings; the flags
override them:

```ts
// mongoshield.config.ts
export default defineConfig({
  source: { uri: process.env.MONGODB_URI },
  storage: "s3://acme-backups/prod",
  encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  journal: {
    segmentSeconds: 60,         // --segment-seconds
    segmentBytes: 32 * 1024 ** 2, // --segment-size (at least 1 KiB)
    onGap: "backup",            // --on-gap: "backup" (default) or "fail"
  },
});
```

`journal start` prints the settings it uses when it starts.

Shorter segments mean a smaller RPO but more objects: 300 s is 288 segments a day,
60 s is 1,440. Each segment is one PUT (and one KMS call with KMS encryption). Restores
read only the segments after the chosen base backup, so frequent base backups keep
restores fast regardless of the segment size. Good starting points:

- most applications: 300 s (RPO about 5 minutes);
- strict RPO requirements: 60 s;
- write-heavy clusters: keep 300 s and let `--segment-size` split the busy periods.

The oplog must cover the longest time the writer may be down (a node upgrade, a
crashed pod waiting to be rescheduled). Check the window with
`rs.printReplicationInfo()` and grow it with `replSetResizeOplog` if needed. If the
writer is down for longer, the journal records a **gap** (below).

## Monitoring the RPO

- **Heartbeat.** `--heartbeat <url>` pings after every committed segment. Configure the
  check (healthchecks.io, Cronitor, Better Stack) with a period of the segment interval
  and a grace time of a few intervals: if the writer stops, you hear about it.
- **Status.** `mongoshield journal status` prints the recovery point, the RPO, the
  covered ranges and any gaps; `--json` for scripts. `--max-rpo 10m` exits 1 when the
  journal is further behind, ready for a cron job or a Kubernetes probe:

  ```
  $ mongoshield journal status
  Recovery point  2026-11-14 14:35:02 (12 seconds ago) (1763130902:3)
  RPO             12s
  Segments        2,316 (8.1 GiB)
  Last commit     2026-11-14 14:35:04 (10 seconds ago) by mongoshield-journal-7d9f
  Gaps            none

  COVERED FROM                         TO                                   SEGMENTS
  2026-11-06T03:00:12Z (1762398012:4)  2026-11-14T14:35:02Z (1763130902:3)     2,316
  ```

- **Gaps.** When the oplog no longer holds the changes since the last commit, the writer
  records a gap in `journal/gaps/`, sends a failure to the configured notification
  targets (and `/fail` to the heartbeat), takes a new base backup (`--on-gap backup`,
  the default) and keeps going. With `--on-gap fail` it stops instead. Times inside a
  gap cannot be restored; times after the next base backup can.
- **In code**, `journal.status()` returns the recovery point, RPO, events per second
  and the last segment's commit latency, for your metrics system.

## Retention

Segments older than the oldest kept base backup can never be replayed. Prune them after
pruning backups:

```ts
import { listBaseBackups, pruneJournal } from "mongoshield";

const oldest = (await listBaseBackups(storage)).at(-1);
if (oldest) await pruneJournal(storage, { olderThan: oldest.clusterTime });
```

Your retention policy therefore also decides how far back point-in-time recovery
reaches. Gap records are never pruned.

## Runbook: "we just deleted production data"

1. **Stop the damage, not the journal.** Stop or roll back the deploy, revoke the leaked
   key. Leave the journal writer running: it must record past the moment of the
   disaster (it records the disaster too; the restore stops before it).

2. **Check the journal covers the time.**

   ```bash
   mongoshield journal status
   ```

   The recovery point must be after the disaster, with no gap between the last base
   backup before it and the disaster.

3. **Find the moment.** From your application logs (the wall-clock time) or, exactly,
   from the oplog: the cluster time of the first bad write.

   ```js
   // mongosh, on the primary
   db.getSiblingDB("local").oplog.rs
     .find({ ns: "app.users", op: "d", wall: { $gte: ISODate("2026-11-14T14:31:00Z") } }, { ts: 1, wall: 1 })
     .sort({ $natural: 1 }).limit(1)
   // → { ts: Timestamp({ t: 1763130719, i: 5 }), wall: ISODate("2026-11-14T14:31:59.412Z") }
   ```

   Restore to the cluster time right before it (`1763130719:4`), or to a wall-clock time
   (`2026-11-14T14:31:59Z`): a time is rounded down to its second and that second's
   writes are left out.

4. **Look before you leap.**

   ```bash
   mongoshield restore --at 1763130719:4 --rename 'app.*=app_recovered.*' --dry-run
   ```

   shows the base backup and the journal segments the restore will use.

5. **Restore next to production**, never over it:

   ```bash
   mongoshield restore --at 1763130719:4 --rename 'app.*=app_recovered.*' --identity-file backup.key
   ```

   The restore loads the base backup, replays the journal up to that cluster time, and
   reports the exact time it reached and how many changes it replayed.

6. **Verify and repair.** Compare `app_recovered` with production, then copy back what
   was lost (for example the deleted users with an aggregation ending in `$merge`), or
   switch the application to the recovered database. Drop `app_recovered` when done.

In code, the same restore is `planPointInTimeRestore` + a restore of the base backup +
`replayJournal`:

```ts
import { planPointInTimeRestore, replayJournal } from "mongoshield";

const plan = await planPointInTimeRestore(storage, { t: 1763130719, i: 4 });
const rename = { "app.*": "app_recovered.*" };
await shield.restore({ backup: plan.baseBackupId, rename });
const result = await replayJournal({
  client, storage, rename,
  from: plan.baseTime, to: plan.at, baseNamespaces: plan.baseNamespaces,
  decryption: { identities: [identity] },
});
console.log(`restored to ${result.restoredTo.t}:${result.restoredTo.i}, ${result.events} changes replayed`);
```

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `MS_STORAGE_PRECONDITION_FAILED` "Another journal writer is running" | the lease is held | stop the other writer, or start with `--wait-for-lease` |
| `MS_CHANGE_HISTORY_LOST` on `restore --at` | no base backup plus journal reaches that time | pick a time in one of the recoverable ranges the error lists |
| `MS_INTEGRITY_FAILED` "segment chain is broken" | a segment is missing or was modified | restore to a time before the damaged segment, or from a newer base backup |
| `MS_PERMISSION_DENIED` | the user cannot open a deployment-wide change stream | grant `readAnyDatabase` (or `changeStream` + `find` on all databases) |
| `MS_CONFIG_INVALID` "cannot be encrypted with a passphrase" | the journal needs recipients or KMS keys | add an `age1…` recipient (`mongoshield keygen`) |
| `MS_UNSUPPORTED_TOPOLOGY` "larger than MongoDB's 16 MiB limit" | a change produced an event the server cannot send (a document close to 16 MiB with a large `_id`); the writer stops | find the change by the cluster time in the message, shrink that document's `_id`, and take a new base backup once the writer runs again |

Brief network problems do not interrupt the journal: the writer reopens its change
stream where it left off and keeps writing the same segment (`journal.status()` shows no
error). Only when the server stays unreachable for a few seconds does it start again
from its last committed segment.

Index changes after the base backup (`createIndex`, `dropIndex`, and the indexes of
collections created after it) are replayed after the documents; `--skip-indexes` leaves
them out. Known limits (also in the spec): time series collections are not journaled;
collection option changes after the base backup (`collMod`, such as hiding an index or
changing a TTL) are not replayed.
