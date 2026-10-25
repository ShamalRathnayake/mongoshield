/**
 * Runs the storage conformance suite against a real Blob API: Azurite in
 * Docker, started with Testcontainers. Every test gets its own blob prefix in
 * one shared container, so the Docker container starts only once.
 *
 * Skipped (not failed) when no Docker runtime is reachable.
 */

import { randomUUID } from "node:crypto";
import { ContainerClient } from "@azure/storage-blob";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";
import { azureStorage } from "../../src/storage/azure.ts";
import { isDockerAvailable } from "../helpers/docker.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";

const AZURITE_IMAGE = "mcr.microsoft.com/azure-storage/azurite:3.33.0";
const BLOB_PORT = 10_000;
const CONTAINER = "mongoshield-conformance";
/** Azurite's documented, public development account key (not a secret). */
const AZURITE_ACCOUNT_KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("azureStorage against Azurite", () => {
  let container: StartedTestContainer;
  let connectionString: string;

  beforeAll(async () => {
    container = await new GenericContainer(AZURITE_IMAGE)
      .withExposedPorts(BLOB_PORT)
      .withCommand([
        "azurite-blob",
        "--blobHost",
        "0.0.0.0",
        "--blobPort",
        String(BLOB_PORT),
        "--skipApiVersionCheck",
        "--loose",
      ])
      .withWaitStrategy(Wait.forLogMessage(/Azurite Blob service successfully listens/))
      .start();
    const endpoint = `http://${container.getHost()}:${container.getMappedPort(BLOB_PORT)}/devstoreaccount1`;
    connectionString =
      `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;` +
      `AccountKey=${AZURITE_ACCOUNT_KEY};BlobEndpoint=${endpoint};`;
    await new ContainerClient(connectionString, CONTAINER).createIfNotExists();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  describeStorageConformance("azure (Azurite)", async () => ({
    // 1 MiB blocks so the >10 MiB test commits a multi-block blob.
    storage: azureStorage({
      connectionString,
      container: CONTAINER,
      prefix: `run-${randomUUID()}`,
      blockSize: 1024 * 1024,
    }),
    // Each test has its own prefix, so there is nothing to clean up.
    cleanup: async () => {},
    // The emulator bucket has no version-level immutability: retained puts must fail with MS_CONFIG_INVALID.
    objectLockConfigured: false,
  }));
});
