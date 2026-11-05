/**
 * Opt-in tests against real Backblaze B2 through the `b2Storage` preset (the S3
 * adapter against `https://s3.<region>.backblazeb2.com`, path-style, WHEN_REQUIRED
 * checksums), the way `b2://` URLs configure it. Run with
 * `pnpm --filter mongoshield test:cloud`; see docs/testing-real-clouds.md.
 *
 * Variables (all required; B2 has no default credential chain):
 * - MONGOSHIELD_TEST_B2_BUCKET            the bucket name
 * - MONGOSHIELD_TEST_B2_REGION            its region, e.g. us-west-004
 * - MONGOSHIELD_TEST_B2_KEY_ID            an application key's keyID
 * - MONGOSHIELD_TEST_B2_APPLICATION_KEY   and its applicationKey
 *
 * The bucket is an ordinary one (no Object Lock), so retained writes must be refused.
 * Conditional writes go through the adapter's one-time probe, as for any S3-compatible
 * host other than AWS and R2: this suite is where a change in B2's support shows.
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { b2Storage } from "../../src/storage/s3.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const b2 = cloudTarget("Backblaze B2", CLOUD_TARGET_VARIABLES.b2);

/** An adapter for the B2 bucket under `prefix`. */
function storageFor(prefix: string): StorageAdapter {
  return b2Storage({
    bucket: b2.get("MONGOSHIELD_TEST_B2_BUCKET"),
    prefix,
    region: b2.get("MONGOSHIELD_TEST_B2_REGION"),
    // The application key: keyID as the access key id, applicationKey as the secret.
    credentials: {
      accessKeyId: b2.get("MONGOSHIELD_TEST_B2_KEY_ID"),
      secretAccessKey: b2.get("MONGOSHIELD_TEST_B2_APPLICATION_KEY"),
    },
    // 5 MiB parts (the minimum), so the >10 MiB conformance test is multipart.
    partSize: 5 * 1024 * 1024,
  });
}

describe.skipIf(!b2.configured)(b2.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeStorageConformance("s3 (Backblaze B2)", async () =>
    cloudFixture(storageFor(`${CLOUD_RUN_PREFIX}/b2/conformance-${randomUUID()}`), {
      objectLockConfigured: false,
    }),
  );
  describeEncryptedRoundTrip("s3 (Backblaze B2)", () =>
    storageFor(`${CLOUD_RUN_PREFIX}/b2/backups`),
  );
});
