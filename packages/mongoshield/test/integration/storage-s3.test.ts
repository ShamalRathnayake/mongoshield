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
import { Readable } from "node:stream";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
import { resolveStorage } from "../../src/storage/resolve.ts";
import { type S3StorageOptions, s3Storage } from "../../src/storage/s3.ts";
import type { ObjectInfo, StorageAdapter } from "../../src/storage/types.ts";
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
      // completion; real S3 does. "checksum modes" below pins that behaviour down. This
      // is the setting the adapter's docs recommend for such S3-compatible services.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }, 180_000);

  afterAll(async () => {
    client?.destroy();
    await container?.stop();
  });

  /** An adapter that builds its own client, like `s3://` URLs and most users do. */
  function ownClientStorage(options: Partial<S3StorageOptions> = {}): StorageAdapter {
    return s3Storage({
      bucket: BUCKET,
      prefix: `run-${randomUUID()}`,
      endpoint: `http://${container.getHost()}:${container.getMappedPort(S3MOCK_PORT)}`,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      partSize: 5 * 1024 * 1024,
      ...options,
    });
  }

  /** 11 MiB: three 5 MiB parts, so the upload is multipart. */
  const multipartBody = () => Readable.from([Buffer.alloc(11 * 1024 * 1024, 7)]);

  describe("checksum modes", () => {
    it("with the SDK default, S3Mock refuses multipart completions and the error says what to set", async () => {
      const storage = ownClientStorage();
      try {
        // Single-part uploads carry their checksum in the request and work.
        await storage.put("small", Buffer.from("x"));
        const error = await storage.put("big", multipartBody()).catch((reason: unknown) => reason);
        expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
        expect(String(error)).toMatch(/checksum for each part/);
        expect(isMongoShieldError(error) && error.hint).toContain("WHEN_REQUIRED");
        // The failed upload is aborted, so nothing is visible.
        expect(await storage.head("big")).toBeUndefined();
      } finally {
        await storage.close?.();
      }
    });

    it("with requestChecksumCalculation WHEN_REQUIRED, multipart uploads work without a custom client", async () => {
      const storage = ownClientStorage({ requestChecksumCalculation: "WHEN_REQUIRED" });
      try {
        const info = await storage.put("big", multipartBody());
        expect(info.size).toBe(11 * 1024 * 1024);
        expect(info.etag).toMatch(/-3$/);
        expect((await storage.head("big"))?.size).toBe(11 * 1024 * 1024);
      } finally {
        await storage.close?.();
      }
    });
  });

  describe("lastModified", () => {
    it("is the server's value in head() and list()", async () => {
      const storage = ownClientStorage();
      try {
        await storage.put("a", Buffer.from("x"));
        const headed = await storage.head("a");
        let listed: ObjectInfo | undefined;
        for await (const info of storage.list("")) listed = info;
        // HEAD carries an HTTP date (whole seconds). S3Mock's listing has milliseconds
        // (real S3 lists whole seconds too), so compare at the precision both share.
        expect(headed?.lastModified.getMilliseconds()).toBe(0);
        const listedSeconds = Math.floor((listed?.lastModified.getTime() ?? 0) / 1000);
        expect(listedSeconds * 1000).toBe(headed?.lastModified.getTime());
      } finally {
        await storage.close?.();
      }
    });

    it("comes from the server after put with exactLastModified, for single and multipart uploads", async () => {
      const storage = ownClientStorage({
        exactLastModified: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
      });
      try {
        const small = await storage.put("small", Buffer.from("x"));
        expect(small.lastModified).toEqual((await storage.head("small"))?.lastModified);
        const big = await storage.put("big", multipartBody());
        expect(big.lastModified).toEqual((await storage.head("big"))?.lastModified);
      } finally {
        await storage.close?.();
      }
    });
  });

  it("takes requestChecksumCalculation and exactLastModified from s3:// URLs", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3MOCK_PORT)}`;
    const storage = await resolveStorage(
      `s3://${BUCKET}/url-${randomUUID()}?endpoint=${encodeURIComponent(endpoint)}&forcePathStyle=true` +
        "&requestChecksumCalculation=WHEN_REQUIRED&exactLastModified=true",
    );
    try {
      const info = await storage.put("big", multipartBody(), { sizeHint: 11 * 1024 * 1024 });
      expect(info.lastModified).toEqual((await storage.head("big"))?.lastModified);
    } finally {
      await storage.close?.();
      vi.unstubAllEnvs();
    }
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
