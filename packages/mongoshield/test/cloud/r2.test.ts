/**
 * Opt-in tests against real Cloudflare R2 through the S3 adapter, the way users
 * configure it: `endpoint: https://<account>.r2.cloudflarestorage.com`, region
 * `auto`. Run with `pnpm --filter mongoshield test:cloud`; see
 * docs/testing-real-clouds.md for the bucket and API token setup.
 *
 * Variables (all required; R2 has no default credential chain):
 * - MONGOSHIELD_TEST_R2_ACCOUNT_ID          the Cloudflare account id (part of the endpoint)
 * - MONGOSHIELD_TEST_R2_BUCKET              the bucket name
 * - MONGOSHIELD_TEST_R2_ACCESS_KEY_ID       an R2 API token's access key id
 * - MONGOSHIELD_TEST_R2_SECRET_ACCESS_KEY   and its secret
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { s3Storage } from "../../src/storage/s3.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const r2 = cloudTarget("Cloudflare R2", CLOUD_TARGET_VARIABLES.r2);

/** An adapter for the R2 bucket under `prefix`. */
function storageFor(prefix: string): StorageAdapter {
  return s3Storage({
    bucket: r2.get("MONGOSHIELD_TEST_R2_BUCKET"),
    prefix,
    endpoint: `https://${r2.get("MONGOSHIELD_TEST_R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    // R2 ignores the region but the SDK needs one; "auto" is what Cloudflare documents.
    region: "auto",
    credentials: {
      accessKeyId: r2.get("MONGOSHIELD_TEST_R2_ACCESS_KEY_ID"),
      secretAccessKey: r2.get("MONGOSHIELD_TEST_R2_SECRET_ACCESS_KEY"),
    },
    // The setting the adapter's docs recommend for S3-compatible services: send
    // upload checksums only where S3 requires them. Running R2 this way here proves
    // that recommendation works against the real service.
    requestChecksumCalculation: "WHEN_REQUIRED",
    // 5 MiB parts (the minimum), so the >10 MiB conformance test is multipart.
    partSize: 5 * 1024 * 1024,
  });
}

describe.skipIf(!r2.configured)(r2.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeStorageConformance("s3 (Cloudflare R2)", async () =>
    cloudFixture(storageFor(`${CLOUD_RUN_PREFIX}/r2/conformance-${randomUUID()}`), {
      // R2 has bucket-wide lock rules, not the S3 Object Lock API, so the adapter
      // must detect it cannot lock individual objects and refuse retained puts.
      objectLockConfigured: false,
    }),
  );
  describeEncryptedRoundTrip("s3 (Cloudflare R2)", () =>
    storageFor(`${CLOUD_RUN_PREFIX}/r2/backups`),
  );
});
