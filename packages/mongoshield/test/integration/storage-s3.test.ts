/**
 * Runs the storage conformance suite against a real S3 API: MinIO in Docker,
 * started with Testcontainers. Every test gets its own key prefix in one
 * shared bucket, so the container starts only once.
 *
 * Skipped (not failed) when no Docker runtime is reachable. The probe is
 * bounded by a timeout so a missing or wedged Docker never hangs the run.
 */

import { randomUUID } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { MinioContainer, type StartedMinioContainer } from "@testcontainers/minio";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";
import { s3Storage } from "../../src/storage/s3.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";

const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";
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

describe.skipIf(!dockerAvailable)("s3Storage against MinIO", () => {
  let container: StartedMinioContainer;
  let client: S3Client;

  beforeAll(async () => {
    container = await new MinioContainer(MINIO_IMAGE).start();
    client = new S3Client({
      region: "us-east-1",
      endpoint: container.getConnectionUrl(),
      forcePathStyle: true,
      credentials: {
        accessKeyId: container.getUsername(),
        secretAccessKey: container.getPassword(),
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }, 180_000);

  afterAll(async () => {
    client?.destroy();
    await container?.stop();
  });

  describeStorageConformance("s3 (MinIO)", async () => ({
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
  }));
});
