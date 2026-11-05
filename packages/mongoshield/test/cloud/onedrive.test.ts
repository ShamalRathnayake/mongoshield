/**
 * Opt-in tests against a real OneDrive (a personal Microsoft account) through Microsoft
 * Graph: the storage conformance suite, an encrypted backup/restore round trip, the
 * quota, and token rotation. Run with `pnpm --filter mongoshield test:cloud`; see
 * docs/guides/onedrive.md and docs/testing-real-clouds.md for the account setup.
 *
 * Variables:
 * - MONGOSHIELD_TEST_ONEDRIVE_TOKEN        required: what `mongoshield login onedrive`
 *                                          printed for the test account (a secret)
 * - MONGOSHIELD_TEST_ONEDRIVE_TOKEN_STATE  optional: the token state file, so the test
 *                                          account's sign-in rotates instead of expiring
 *                                          90 days after login (cloud.yml keeps it in the
 *                                          Actions cache, like the MongoShield Action)
 * - MONGOSHIELD_ONEDRIVE_CLIENT_ID         optional: the app the token belongs to, when
 *                                          the token does not record it
 *
 * Everything is written below `<app folder>/mongoshield-ci/<run>/` and removed after.
 * Deleted files go to the account's recycle bin (the app-folder permission cannot
 * delete permanently), which empties itself after 30 days.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type OneDriveStorage, onedriveStorage } from "../../src/storage/onedrive.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget, optionalEnv } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const onedrive = cloudTarget("OneDrive (personal)", CLOUD_TARGET_VARIABLES.onedrive);

/** An adapter for the test account under `folder` (inside the app folder). */
function storageFor(folder: string): OneDriveStorage {
  const statePath = optionalEnv("MONGOSHIELD_TEST_ONEDRIVE_TOKEN_STATE");
  const clientId = optionalEnv("MONGOSHIELD_ONEDRIVE_CLIENT_ID");
  return onedriveStorage({
    folder,
    token: onedrive.get("MONGOSHIELD_TEST_ONEDRIVE_TOKEN"),
    ...(statePath === undefined ? {} : { tokenStatePath: statePath }),
    ...(clientId === undefined ? {} : { clientId }),
    // 5 MiB fragments, so the >10 MiB conformance object takes several of them.
    fragmentSize: 16 * 320 * 1024,
  });
}

describe.skipIf(!onedrive.configured)(onedrive.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  describeStorageConformance("onedrive (real)", async () =>
    cloudFixture(storageFor(`${CLOUD_RUN_PREFIX}/onedrive/conformance-${randomUUID()}`)),
  );

  describeEncryptedRoundTrip("onedrive (real)", () =>
    storageFor(`${CLOUD_RUN_PREFIX}/onedrive/backups`),
  );

  it("reports the drive quota, or nothing when the app-folder permission does not cover it", async () => {
    const space = await storageFor(`${CLOUD_RUN_PREFIX}/onedrive/space`).space();
    if (space !== undefined) {
      expect(space.totalBytes).toBeGreaterThan(0);
      expect(space.freeBytes).toBeGreaterThanOrEqual(0);
    }
  });

  it("has no sign-in warning while the rotated token is kept", async () => {
    const storage = storageFor(`${CLOUD_RUN_PREFIX}/onedrive/warnings`);
    await storage.head("anything");
    if (optionalEnv("MONGOSHIELD_TEST_ONEDRIVE_TOKEN_STATE") !== undefined) {
      expect(storage.warnings()).toEqual([]);
    }
  });
});
