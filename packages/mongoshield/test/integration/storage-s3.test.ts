/**
 * Runs the storage conformance suite against an S3 API: Adobe S3Mock in Docker,
 * started with Testcontainers. Every test gets its own key prefix in one shared
 * bucket, so the container starts only once.
 *
 * Why S3Mock and not MinIO: MinIO stopped publishing its community images to
 * Docker Hub (pulls of `minio/minio` are denied), while S3Mock is a maintained,
 * widely used S3 emulator with a stable public image.
 *
 * Skipped (not failed) when no Docker runtime is reachable. The probe is
 * bounded by a timeout so a missing or wedged Docker never hangs the run.
 */

import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";
import { s3Storage } from "../../src/storage/s3.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";

/** Pinned so emulator upgrades never change test results unnoticed. */
const S3MOCK_IMAGE = "adobe/s3mock:5.2";
/** S3Mock's plain-HTTP port. */
const S3MOCK_PORT = 9090;
const BUCKET = "mongoshield-conformance";
/** How long to wait for Docker to answer before skipping the suite. */
const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/** True if a container runtime answers within the timeout. */
async function isDockerAvailable(): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), DOCKER_PROBE_TIMEOUT_MS).unref();
  });
  const probe = getContainerRuntimeClient().then(
    () => true,
    () => false,
  );
  return Promise.race([probe, timeout]);
}

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("s3Storage against S3Mock", () => {
  let container: StartedTestContainer;
  let client: S3Client;

  beforeAll(async () => {
    container = await new GenericContainer(S3MOCK_IMAGE)
      .withExposedPorts(S3MOCK_PORT)
      .withWaitStrategy(Wait.forHttp("/", S3MOCK_PORT).forStatusCodeMatching(() => true))
      .start();
    client = new S3Client({
      region: "us-east-1",
      endpoint: `http://${container.getHost()}:${container.getMappedPort(S3MOCK_PORT)}`,
      forcePathStyle: true,
      // S3Mock accepts any credentials.
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      // With the SDK's default ("WHEN_SUPPORTED"), multipart uploads are created with a
      // CRC32 checksum and lib-storage completes them with the per-part checksums from
      // the UploadPart responses. S3Mock doesn't return those, so it rejects the
      // completion; real S3 does. This is the setting the adapter's docs recommend for
      // S3-compatible services that differ in checksum handling.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }, 180_000);

  afterAll(async () => {
    client?.destroy();
    await container?.stop();
  });

  describeStorageConformance("s3 (S3Mock)", async () => ({
    // 5 MiB parts (the minimum) so the >10 MiB test exercises multipart uploads.
    storage: s3Storage({
      bucket: BUCKET,
      prefix: `run-${randomUUID()}`,
      client,
      partSize: 5 * 1024 * 1024,
    }),
    // Each test has its own prefix, so there is nothing to clean up.
    cleanup: async () => {},
    // The emulator bucket has no Object Lock: retained puts must fail with MS_CONFIG_INVALID.
    objectLockConfigured: false,
    // A single conditional create is refused correctly (tested), but S3Mock checks and
    // writes in two steps, so simultaneous creates can both succeed. Real S3 makes
    // If-None-Match atomic, which the scheduler's storage lock relies on.
    emulatorGaps: {
      racingConditionalCreates: "S3Mock does not apply If-None-Match atomically",
    },
  }));
});
