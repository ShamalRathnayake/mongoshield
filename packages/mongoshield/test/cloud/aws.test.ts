/**
 * Opt-in tests against real AWS: S3 (a plain bucket and, optionally, an Object Lock
 * bucket) and AWS KMS. Run with `pnpm --filter mongoshield test:cloud`; see
 * docs/testing-real-clouds.md for the bucket, key and IAM setup.
 *
 * Variables (each group enables its own suites; credentials come from the AWS SDK's
 * default chain: OIDC role in CI, a profile or env keys locally):
 * - MONGOSHIELD_TEST_S3_BUCKET            a versioning-off bucket for conformance + round trip
 * - MONGOSHIELD_TEST_S3_LOCK_BUCKET       a bucket with Object Lock enabled (no default retention)
 * - MONGOSHIELD_TEST_S3_REGION            optional; the buckets' region (else AWS_REGION)
 * - MONGOSHIELD_TEST_AWS_KMS_KEY          a symmetric KMS key ARN (or alias ARN)
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { s3Storage } from "../../src/storage/s3.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import {
  CLOUD_RUN_PREFIX,
  CLOUD_TARGET_VARIABLES,
  type CloudTarget,
  cloudTarget,
  optionalEnv,
} from "./env.ts";
import {
  CLOUD_TEST_TIMEOUT_MS,
  cloudFixture,
  describeEncryptedRoundTrip,
  describeKmsRoundTrip,
} from "./helpers.ts";

const s3 = cloudTarget("AWS S3", CLOUD_TARGET_VARIABLES.s3);
const s3Lock = cloudTarget("AWS S3 Object Lock", CLOUD_TARGET_VARIABLES.s3ObjectLock);
const awsKms = cloudTarget("AWS KMS", CLOUD_TARGET_VARIABLES.awsKms);

/** 5 MiB parts (the S3 minimum), so the >10 MiB conformance test is multipart. */
const PART_SIZE = 5 * 1024 * 1024;

/**
 * An adapter for `bucket` under `prefix`, building its own client from the default
 * credential chain, like `s3://` URLs and most users do. Locked writes use governance
 * mode so an administrator can still remove test objects early if ever needed.
 */
function storageFor(target: CloudTarget, variable: string, prefix: string): StorageAdapter {
  const region = optionalEnv("MONGOSHIELD_TEST_S3_REGION");
  return s3Storage({
    bucket: target.get(variable),
    prefix,
    partSize: PART_SIZE,
    retention: { mode: "governance" },
    ...(region === undefined ? {} : { region }),
  });
}

describe.skipIf(!s3.configured)(s3.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const bucket = "MONGOSHIELD_TEST_S3_BUCKET";
  describeStorageConformance("s3 (AWS)", async () =>
    cloudFixture(storageFor(s3, bucket, `${CLOUD_RUN_PREFIX}/s3/conformance-${randomUUID()}`), {
      // Without Object Lock the adapter must refuse retained puts up front.
      objectLockConfigured: false,
    }),
  );
  describeEncryptedRoundTrip("s3 (AWS)", () =>
    storageFor(s3, bucket, `${CLOUD_RUN_PREFIX}/s3/backups`),
  );
});

describe.skipIf(!s3Lock.configured)(s3Lock.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const bucket = "MONGOSHIELD_TEST_S3_LOCK_BUCKET";
  describeStorageConformance("s3 (AWS, Object Lock)", async () =>
    cloudFixture(
      storageFor(s3Lock, bucket, `${CLOUD_RUN_PREFIX}/s3-lock/conformance-${randomUUID()}`),
      {
        objectLockConfigured: true,
        // In a versioned bucket a delete without a version id only adds a delete
        // marker: the locked version stays (and the lifecycle rule removes it later).
        lockedDeletes: "hidden",
      },
    ),
  );
  describeEncryptedRoundTrip(
    "s3 (AWS, Object Lock)",
    () => storageFor(s3Lock, bucket, `${CLOUD_RUN_PREFIX}/s3-lock/backups`),
    { retainDays: 1 },
  );
});

describe.skipIf(!awsKms.configured)(awsKms.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeKmsRoundTrip("aws kms", () => ({
    provider: "aws",
    key: awsKms.get("MONGOSHIELD_TEST_AWS_KMS_KEY"),
  }));
});
