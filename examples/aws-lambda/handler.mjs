/**
 * AWS Lambda handler: a scheduled MongoDB backup to S3 with MongoShield.
 *
 * EventBridge invokes it on a schedule (see template.yaml). Each run:
 *   1. reads the MongoDB connection string from Secrets Manager (cached per container),
 *   2. backs up to S3, encrypted for a public age key,
 *   3. verifies the new backup's checksums,
 *   4. applies the retention policy.
 *
 * Lambda stops a function after at most 15 minutes. The backup is given a deadline
 * shortly before that, so it fails cleanly (no manifest is written, so a partial
 * backup never looks complete) instead of being killed mid-write. Databases that
 * take longer than ~14 minutes to back up need resumable backups (MongoShield P4)
 * or a container platform (ECS scheduled task, Kubernetes CronJob) instead.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

/** Time kept back from Lambda's own timeout for verify, prune and closing connections. */
const SAFETY_MARGIN_MS = 60_000;

const secrets = new SecretsManagerClient({});

/**
 * The connection string, fetched once per Lambda container. Warm invocations reuse it,
 * which saves a Secrets Manager call (and its cost) on every run.
 */
let cachedUri;
async function mongoUri() {
  if (cachedUri === undefined) {
    const response = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.MONGODB_URI_SECRET_ARN }),
    );
    cachedUri = response.SecretString;
  }
  return cachedUri;
}

/** EventBridge scheduled-event handler. Throws on failure so Lambda records an error. */
export async function handler(_event, context) {
  const shield = new MongoShield({
    source: { uri: await mongoUri() },
    storage: s3Storage({
      bucket: process.env.BACKUP_BUCKET,
      prefix: process.env.BACKUP_PREFIX ?? "mongodb/",
    }),
    // Public key only: this function can write backups but never read them.
    encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
  });

  try {
    // At least a minute, even if the function was configured with a very short timeout.
    const deadline = Math.max(60_000, context.getRemainingTimeInMillis() - SAFETY_MARGIN_MS);
    const backup = await shield.backup({
      exclude: ["*.sessions"],
      labels: { trigger: "lambda", requestId: context.awsRequestId },
      signal: AbortSignal.timeout(deadline),
    });
    console.log(
      JSON.stringify({ message: "backup complete", id: backup.id, totals: backup.manifest.totals }),
    );

    const report = await shield.verify({ backup: backup.id, mode: "fast" });
    if (!report.ok) {
      throw new Error(
        `Backup ${backup.id} failed verification: ${JSON.stringify(report.problems)}`,
      );
    }

    // Keep 7 daily, 4 weekly and 12 monthly backups.
    const pruned = await shield.prune({ daily: 7, weekly: 4, monthly: 12 });
    console.log(JSON.stringify({ message: "pruned", deletedBackups: pruned.deletedBackups }));

    return { id: backup.id };
  } finally {
    // Close the storage client. The MongoDB connection is opened and closed per operation.
    await shield.close();
  }
}
