/**
 * Opt-in tests against a REAL Google Drive (a dedicated Google account): the storage
 * conformance suite and an encrypted backup/restore round trip through `gdrive://`,
 * plus the quota report. The unit tests run the same suite against an in-process fake
 * (src/storage/gdrive.test.ts); this adds Google's real behaviour, latency and rate
 * limits. Run with `pnpm --filter mongoshield test:cloud`; see docs/testing-real-clouds.md.
 *
 * Variables (all required):
 * - MONGOSHIELD_TEST_GDRIVE_CLIENT_ID       OAuth client id ("TVs and Limited Input devices")
 * - MONGOSHIELD_TEST_GDRIVE_CLIENT_SECRET   that client's secret
 * - MONGOSHIELD_TEST_GDRIVE_TOKEN           a refresh token from `mongoshield login gdrive`
 *                                           with that client
 *
 * Everything is written under `MongoShield/<CLOUD_RUN_PREFIX>/…` in that account's
 * drive. Objects are deleted afterwards; a few empty folders stay behind (the adapter
 * never removes the first folder level), which is why the account should be dedicated.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gdriveStorage } from "../../src/storage/gdrive.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const gdrive = cloudTarget("Google Drive", CLOUD_TARGET_VARIABLES.gdrive);

/** An adapter rooted at `MongoShield/<subPath>` in the test account's drive. */
function storageFor(subPath: string) {
  return gdriveStorage({
    folder: subPath,
    clientId: gdrive.get("MONGOSHIELD_TEST_GDRIVE_CLIENT_ID"),
    clientSecret: gdrive.get("MONGOSHIELD_TEST_GDRIVE_CLIENT_SECRET"),
    refreshToken: gdrive.get("MONGOSHIELD_TEST_GDRIVE_TOKEN"),
  });
}

describe.skipIf(!gdrive.configured)(gdrive.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  // No conditional writes and no object lock: the suite checks those are refused instead.
  describeStorageConformance("gdrive (real Google Drive)", async () =>
    cloudFixture(storageFor(`${CLOUD_RUN_PREFIX}/gdrive/conformance-${randomUUID()}`)),
  );
  describeEncryptedRoundTrip(
    "gdrive (real Google Drive)",
    (): StorageAdapter => storageFor(`${CLOUD_RUN_PREFIX}/gdrive/backups`),
  );

  it("reports the account's quota", async () => {
    const space = await storageFor(`${CLOUD_RUN_PREFIX}/gdrive/space`).space();
    expect(space?.used).toBeGreaterThanOrEqual(0);
    // Free accounts have a limit (15 GB shared with Gmail and Photos).
    if (space?.total !== undefined) expect(space.free).toBeLessThanOrEqual(space.total);
  });
});
