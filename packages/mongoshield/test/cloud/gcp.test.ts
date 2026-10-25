/**
 * Opt-in tests against real Google Cloud: Cloud Storage (a plain bucket and,
 * optionally, a bucket with per-object retention) and Cloud KMS. Run with
 * `pnpm --filter mongoshield test:cloud`; see docs/testing-real-clouds.md for the
 * bucket, key ring and service account setup.
 *
 * Variables (each group enables its own suites; credentials come from Application
 * Default Credentials: Workload Identity Federation in CI, `gcloud auth
 * application-default login` locally):
 * - MONGOSHIELD_TEST_GCS_BUCKET        a bucket without object retention
 * - MONGOSHIELD_TEST_GCS_LOCK_BUCKET   a bucket created with --enable-per-object-retention
 * - MONGOSHIELD_TEST_GCP_KMS_KEY       projects/…/locations/…/keyRings/…/cryptoKeys/… (symmetric)
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { gcsStorage } from "../../src/storage/gcs.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, type CloudTarget, cloudTarget } from "./env.ts";
import {
  CLOUD_TEST_TIMEOUT_MS,
  cloudFixture,
  describeEncryptedRoundTrip,
  describeKmsRoundTrip,
} from "./helpers.ts";

const gcs = cloudTarget("Google Cloud Storage", CLOUD_TARGET_VARIABLES.gcs);
const gcsLock = cloudTarget(
  "Google Cloud Storage object retention",
  CLOUD_TARGET_VARIABLES.gcsRetention,
);
const gcpKms = cloudTarget("Google Cloud KMS", CLOUD_TARGET_VARIABLES.gcpKms);

/**
 * An adapter for the bucket in `variable` under `prefix`. 256 KiB chunks (the
 * minimum) so the >10 MiB conformance test is a multi-chunk resumable upload.
 * Retained writes use governance ("Unlocked") mode so an administrator can still
 * remove test objects early if ever needed.
 */
function storageFor(target: CloudTarget, variable: string, prefix: string): StorageAdapter {
  return gcsStorage({
    bucket: target.get(variable),
    prefix,
    chunkSize: 256 * 1024,
    retention: { mode: "governance" },
  });
}

describe.skipIf(!gcs.configured)(gcs.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const bucket = "MONGOSHIELD_TEST_GCS_BUCKET";
  describeStorageConformance("gcs (Google Cloud)", async () =>
    cloudFixture(storageFor(gcs, bucket, `${CLOUD_RUN_PREFIX}/gcs/conformance-${randomUUID()}`), {
      // Without per-object retention the adapter must refuse retained puts up front.
      objectLockConfigured: false,
    }),
  );
  describeEncryptedRoundTrip("gcs (Google Cloud)", () =>
    storageFor(gcs, bucket, `${CLOUD_RUN_PREFIX}/gcs/backups`),
  );
});

describe.skipIf(!gcsLock.configured)(gcsLock.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const bucket = "MONGOSHIELD_TEST_GCS_LOCK_BUCKET";
  describeStorageConformance("gcs (Google Cloud, object retention)", async () =>
    cloudFixture(
      storageFor(gcsLock, bucket, `${CLOUD_RUN_PREFIX}/gcs-lock/conformance-${randomUUID()}`),
      // GCS refuses deleting or overwriting a retained object (HTTP 403).
      { objectLockConfigured: true, lockedDeletes: "refused" },
    ),
  );
  describeEncryptedRoundTrip(
    "gcs (Google Cloud, object retention)",
    () => storageFor(gcsLock, bucket, `${CLOUD_RUN_PREFIX}/gcs-lock/backups`),
    { retainDays: 1 },
  );
});

describe.skipIf(!gcpKms.configured)(gcpKms.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeKmsRoundTrip("gcp kms", () => ({
    provider: "gcp",
    key: gcpKms.get("MONGOSHIELD_TEST_GCP_KMS_KEY"),
  }));
});
