# AWS Lambda

Run backups as a Lambda function on an EventBridge schedule, using the MongoShield
library. A ready-to-deploy SAM project is in
[`examples/aws-lambda`](../../examples/aws-lambda/).

```bash
npm install mongoshield mongodb @aws-sdk/client-s3 @aws-sdk/lib-storage
```

```js
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

export async function handler(_event, context) {
  const shield = new MongoShield({
    source: { uri: process.env.MONGODB_URI },
    storage: s3Storage({ bucket: process.env.BACKUP_BUCKET, prefix: "mongodb/" }),
    encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  });
  try {
    const backup = await shield.backup({
      exclude: ["*.sessions"],
      // Stop a minute before Lambda would kill the function.
      signal: AbortSignal.timeout(context.getRemainingTimeInMillis() - 60_000),
    });
    await shield.verify({ backup: backup.id, mode: "fast" });
    await shield.prune({ daily: 7, weekly: 4, monthly: 12 });
    return { id: backup.id };
  } finally {
    await shield.close();
  }
}
```

The example fetches `MONGODB_URI` from Secrets Manager rather than a plain environment
variable, so it is not visible in the Lambda console.

## Settings

| Setting | Recommended | Why |
|---|---|---|
| Runtime | `nodejs22.x` or `nodejs24.x` | MongoShield needs Node.js 22.12+ |
| Timeout | 900 s | Lambda's maximum; abort the backup ~60 s earlier |
| Memory | 1769 MB | memory buys CPU (1 vCPU at 1769 MB); memory use stays flat, at the level [below](#memory-use) |
| Architecture | `arm64` | cheaper per second, same throughput |
| Reserved concurrency | 1 | one run at a time |
| Async retries | 0 | a failed 15-minute run should alert, not repeat for 45 minutes |
| IAM | `s3:ListBucket`, `GetObject`, `PutObject`, `DeleteObject` on the bucket | delete is for retention |

## Memory use

Memory does not grow with the size of the database, but it has a floor set by the upload
buffers. Each collection being dumped uploads one file at a time, and an S3 upload buffers
up to `partSize × queueSize` bytes: 16 MiB × 4 = 64 MiB by default. With the default
`parallelism` of 4 collections at once, that is about **256 MiB of upload buffers**, plus
the Node.js runtime, the driver and the SDK (roughly 100-150 MiB more). At the
recommended 1769 MB this does not matter. On a 256 or 512 MB function (or Vercel/Netlify
functions, which have similar limits), shrink the buffers:

```js
const shield = new MongoShield({
  source: { uri: process.env.MONGODB_URI },
  // 8 MiB × 2 = 16 MiB per upload. The largest single file is partSize × 10,000
  // (80 GiB here), far beyond what a function can dump in 15 minutes.
  storage: s3Storage({ bucket: process.env.BACKUP_BUCKET, partSize: 8 * 1024 * 1024, queueSize: 2 }),
});
await shield.backup({ parallelism: 2 }); // 2 collections × 16 MiB ≈ 32 MiB of buffers
```

With a storage URL (CLI or config file) the same settings are
`s3://bucket/prefix?partSizeMiB=8&queueSize=2`. Google Cloud Storage takes
`gs://…?chunkSizeMiB=8` (default 16 MiB per upload), Azure
`az://…?blockSizeMiB=4&uploadConcurrency=2` (default 8 MiB × 4). Smaller parts mean more
requests, so keep the defaults wherever memory is not tight.

## The 15-minute limit

If a backup cannot finish in about 14 minutes, it is aborted cleanly: no manifest is
written, so the partial run is never listed as a complete backup. Options for larger
databases:

- split the work: several functions with different `include` patterns;
- run the [Docker image](./docker.md) as an ECS scheduled task or a
  [Kubernetes CronJob](./kubernetes.md), which have no time limit;
- resumable backups (MongoShield P4) will let a run continue across invocations.

## Networking

Lambda functions outside a VPC use AWS's shared, changing IP addresses. For Atlas, run
the function in a VPC with a NAT gateway and an Elastic IP (and allow that IP), or use
VPC peering / PrivateLink. See the [Atlas guide](./atlas.md#3-network-access).

## Monitoring

Add a CloudWatch alarm on the function's `Errors` metric with "treat missing data as
breaching", so it also fires when the function did not run (the example template
includes one). Or ping a dead man's switch (healthchecks.io, Cronitor) with `fetch` at the
end of a successful run.
