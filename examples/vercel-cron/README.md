# Vercel Cron: daily backup from a Next.js app

[`app/api/backup/route.ts`](./app/api/backup/route.ts) backs up MongoDB to S3 (or R2, B2…)
when Vercel Cron calls it; [`vercel.json`](./vercel.json) schedules it daily at 03:15 UTC.

1. `npx mongoshield keygen --output backup.key` and keep `backup.key` offline.
2. Set these environment variables in the Vercel project:

   | Variable | Value |
   |---|---|
   | `CRON_SECRET` | a long random string; Vercel sends it with every cron request |
   | `MONGODB_URI` | connection string of a user with the `backup` role |
   | `BACKUP_BUCKET` | bucket name |
   | `BACKUP_PUBLIC_KEY` | the `age1…` public key from step 1 |
   | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | credentials limited to that bucket |
   | `BACKUP_S3_ENDPOINT` | only for S3-compatible stores, e.g. `https://<account>.r2.cloudflarestorage.com` |

3. Deploy. Test with `curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/backup`.

## Limits to know

- **`maxDuration`.** A function runs for at most 300 s on Hobby and 800 s on Pro (with
  Fluid compute; check Vercel's current limits). The route aborts the backup 30 s before
  its `maxDuration`, and an aborted backup is never marked complete. This suits small and
  medium databases; larger ones belong on a container platform
  ([Docker](../../docs/guides/docker.md), [Kubernetes](../../docs/guides/kubernetes.md)) or
  will use resumable backups (MongoShield P4).
- **Hobby crons run once a day**, at a time within the hour you choose.
- **Atlas IP access list.** Vercel functions have no fixed egress IPs unless you use
  Vercel's Secure Compute. See [docs/guides/atlas.md](../../docs/guides/atlas.md).

Full guide: [docs/guides/vercel.md](../../docs/guides/vercel.md).
