/**
 * Runs the storage conformance suite against a real GCS JSON API emulator:
 * fake-gcs-server in Docker, started with Testcontainers. Every test gets its
 * own object prefix in one shared bucket, so the container starts only once.
 *
 * fake-gcs-server writes its own URL into resumable upload session URLs, so it
 * must know the host port up front: we pick a free port and bind it explicitly.
 *
 * Skipped (not failed) when no Docker runtime is reachable.
 */

import { randomUUID } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";
import { gcsStorage } from "../../src/storage/gcs.ts";
import { freePort, isDockerAvailable } from "../helpers/docker.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";

const FAKE_GCS_IMAGE = "fsouza/fake-gcs-server:1.50.2";
const BUCKET = "mongoshield-conformance";
const CONTAINER_PORT = 4443;

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("gcsStorage against fake-gcs-server", () => {
  let container: StartedTestContainer;
  let storage: Storage;

  beforeAll(async () => {
    const hostPort = await freePort();
    const endpoint = `http://127.0.0.1:${hostPort}`;
    container = await new GenericContainer(FAKE_GCS_IMAGE)
      .withExposedPorts({ container: CONTAINER_PORT, host: hostPort })
      .withCommand([
        "-scheme",
        "http",
        "-port",
        String(CONTAINER_PORT),
        "-backend",
        "memory",
        "-external-url",
        endpoint,
        "-public-host",
        `127.0.0.1:${hostPort}`,
      ])
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    storage = new Storage({ apiEndpoint: endpoint, projectId: "mongoshield-test" });
    await storage.createBucket(BUCKET);
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  describeStorageConformance("gcs (fake-gcs-server)", async () => ({
    // 256 KiB chunks (the minimum) so the >10 MiB test exercises multi-chunk resumable uploads.
    storage: gcsStorage({
      bucket: BUCKET,
      prefix: `run-${randomUUID()}`,
      storage,
      chunkSize: 256 * 1024,
    }),
    // Each test has its own prefix, so there is nothing to clean up.
    cleanup: async () => {},
    // The emulator bucket has no object retention: retained puts must fail with MS_CONFIG_INVALID.
    objectLockConfigured: false,
    // The adapter sends ifGenerationMatch: 0 on both upload paths. Real GCS enforces it
    // on resumable sessions too, and the in-process fake (src/storage/gcs.test.ts) tests
    // that path through the real SDK; fake-gcs-server only enforces it on single-request
    // uploads.
    emulatorGaps: {
      streamedConditionalCreates:
        "fake-gcs-server does not enforce ifGenerationMatch on resumable uploads",
    },
  }));
});
