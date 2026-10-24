/**
 * Opt-in tests against real Microsoft Azure: Blob Storage (a plain container and,
 * optionally, a container with version-level immutability) and Key Vault. Run with
 * `pnpm --filter mongoshield test:cloud`; see docs/testing-real-clouds.md for the
 * storage account, vault and role assignments.
 *
 * Variables (each group enables its own suites; credentials come from
 * DefaultAzureCredential: `azure/login` with OIDC in CI, `az login` locally):
 * - MONGOSHIELD_TEST_AZURE_ACCOUNT_URL      https://<account>.blob.core.windows.net
 * - MONGOSHIELD_TEST_AZURE_CONTAINER        a container without immutability support
 * - MONGOSHIELD_TEST_AZURE_LOCK_CONTAINER   a container created with version-level WORM
 * - MONGOSHIELD_TEST_AZURE_KEY_URL          https://<vault>.vault.azure.net/keys/<name> (RSA)
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { azureStorage } from "../../src/storage/azure.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, type CloudTarget, cloudTarget } from "./env.ts";
import {
  CLOUD_TEST_TIMEOUT_MS,
  cloudFixture,
  describeEncryptedRoundTrip,
  describeKmsRoundTrip,
} from "./helpers.ts";

const blob = cloudTarget("Azure Blob Storage", CLOUD_TARGET_VARIABLES.azureBlob);
const blobLock = cloudTarget(
  "Azure Blob Storage immutability",
  CLOUD_TARGET_VARIABLES.azureImmutable,
);
const keyVault = cloudTarget("Azure Key Vault", CLOUD_TARGET_VARIABLES.azureKeyVault);

/**
 * An adapter for the container in `variable` under `prefix`, authenticated with
 * DefaultAzureCredential (the adapter's default for `accountUrl`). 1 MiB blocks so
 * the >10 MiB conformance test commits a multi-block blob. Retained writes use
 * governance ("Unlocked") mode so an account owner can still remove test blobs early.
 */
function storageFor(target: CloudTarget, variable: string, prefix: string): StorageAdapter {
  return azureStorage({
    accountUrl: target.get("MONGOSHIELD_TEST_AZURE_ACCOUNT_URL"),
    container: target.get(variable),
    prefix,
    blockSize: 1024 * 1024,
    retention: { mode: "governance" },
  });
}

describe.skipIf(!blob.configured)(blob.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const container = "MONGOSHIELD_TEST_AZURE_CONTAINER";
  describeStorageConformance("azure (Azure Blob)", async () =>
    cloudFixture(
      storageFor(blob, container, `${CLOUD_RUN_PREFIX}/azure/conformance-${randomUUID()}`),
      // Without version-level immutability the adapter must refuse retained puts.
      { objectLockConfigured: false },
    ),
  );
  describeEncryptedRoundTrip("azure (Azure Blob)", () =>
    storageFor(blob, container, `${CLOUD_RUN_PREFIX}/azure/backups`),
  );
});

describe.skipIf(!blobLock.configured)(blobLock.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  const container = "MONGOSHIELD_TEST_AZURE_LOCK_CONTAINER";
  describeStorageConformance("azure (Azure Blob, immutability)", async () =>
    cloudFixture(
      storageFor(blobLock, container, `${CLOUD_RUN_PREFIX}/azure-lock/conformance-${randomUUID()}`),
      // Azure refuses deleting or overwriting an immutable blob (409).
      { objectLockConfigured: true, lockedDeletes: "refused" },
    ),
  );
  describeEncryptedRoundTrip(
    "azure (Azure Blob, immutability)",
    () => storageFor(blobLock, container, `${CLOUD_RUN_PREFIX}/azure-lock/backups`),
    { retainDays: 1 },
  );
});

describe.skipIf(!keyVault.configured)(keyVault.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeKmsRoundTrip("azure key vault", () => ({
    provider: "azure",
    key: keyVault.get("MONGOSHIELD_TEST_AZURE_KEY_URL"),
  }));
});
