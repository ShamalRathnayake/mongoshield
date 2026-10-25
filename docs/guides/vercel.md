# Vercel

Back up from a Next.js app with a **Vercel Cron Job** calling a route handler. A complete
example is in [`examples/vercel-cron`](../../examples/vercel-cron/).

```json
// vercel.json
{ "crons": [{ "path": "/api/backup", "schedule": "15 3 * * *" }] }
```

```ts
// app/api/backup/route.ts
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

export const runtime = "nodejs"; // not Edge: needs streams, zlib and TCP
export const dynamic = "force-dynamic";
export const maxDuration = 300; // seconds; see limits below

export async function GET(request: Request) {
  // Vercel sends this header on cron requests. Reject everything else.
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const shield = new MongoShield({
    source: { uri: process.env.MONGODB_URI! },
    storage: s3Storage({ bucket: process.env.BACKUP_BUCKET!, prefix: "mongodb/" }),
    encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY!] },
  });
  try {
    const backup = await shield.backup({
      exclude: ["*.sessions"],
      signal: AbortSignal.timeout((maxDuration - 30) * 1000),
    });
    await shield.verify({ backup: backup.id, mode: "fast" });
    await shield.prune({ daily: 7, weekly: 4, monthly: 12 });
    return Response.json({ id: backup.id });
  } finally {
    await shield.close();
  }
}
```

(The example uses a constant-time comparison for the secret.)

```js
// next.config.mjs: load these from node_modules instead of bundling them
export default { serverExternalPackages: ["mongoshield", "mongodb"] };
```

Install: `npm install mongoshield mongodb @aws-sdk/client-s3 @aws-sdk/lib-storage`.

## Environment variables

| Variable | Value |
|---|---|
| `CRON_SECRET` | random string (`openssl rand -hex 32`); Vercel adds it to cron requests |
| `MONGODB_URI` | a user with a read-only role |
| `BACKUP_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | storage, with credentials limited to the bucket |
| `BACKUP_PUBLIC_KEY` | `age1…` from `npx mongoshield keygen --output backup.key` (keep the key file offline) |

S3-compatible stores (Cloudflare R2, Backblaze B2…) work with `s3Storage({ endpoint })`.

## Limits

- **Duration.** `maxDuration` is capped by your plan: with Fluid compute, 300 s on Hobby
  and 800 s on Pro/Enterprise at the time of writing (check Vercel's current limits). The
  backup aborts 30 s before `maxDuration`; an aborted backup never gets a manifest, so it
  is never mistaken for a complete one. Bigger databases belong on
  [Docker](./docker.md)/[Kubernetes](./kubernetes.md), or will use resumable backups (P4).
- **Cron frequency.** Hobby projects can run cron jobs once a day, at a time within the
  chosen hour.
- **Cron runs only on production deployments.**
- **Network.** Vercel functions have no fixed egress IPs unless you use Secure Compute /
  static IPs. See the [Atlas guide](./atlas.md#3-network-access).
