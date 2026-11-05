/**
 * Opt-in tests against a real Dropbox account through the `dropbox://` adapter,
 * the way users run it: an "App folder" app and a refresh token from
 * `mongoshield login dropbox`. Run with `pnpm --filter mongoshield test:cloud`; see
 * docs/testing-real-clouds.md for the app and token setup.
 *
 * Variables (both required; Dropbox has no default credential chain):
 * - MONGOSHIELD_TEST_DROPBOX_CLIENT_ID   the test app's app key
 * - MONGOSHIELD_TEST_DROPBOX_TOKEN       a refresh token issued to that app
 *
 * Everything is written under `<CLOUD_RUN_PREFIX>/dropbox/` in the app folder. The
 * adapter deletes files but (by design) leaves their folders, so `afterAll` removes
 * this run's top folder directly. Deleted files sit in the account's "deleted files"
 * for 30 days and do not count against its quota.
 */

import { randomUUID } from "node:crypto";
import { afterAll, describe } from "vitest";
import { dropboxStorage } from "../../src/storage/dropbox.ts";
import { refreshDropboxAccessToken } from "../../src/storage/dropbox-auth.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const dropbox = cloudTarget("Dropbox", CLOUD_TARGET_VARIABLES.dropbox);

/** An adapter for `<run prefix>/dropbox/<subFolder>` in the app folder. */
function storageFor(subFolder: string): StorageAdapter {
  return dropboxStorage({
    folder: `${CLOUD_RUN_PREFIX}/dropbox/${subFolder}`,
    clientId: dropbox.get("MONGOSHIELD_TEST_DROPBOX_CLIENT_ID"),
    refreshToken: dropbox.get("MONGOSHIELD_TEST_DROPBOX_TOKEN"),
    // 4 MiB chunks, so the >10 MiB conformance test uses a three-request upload session.
    chunkSize: 4 * 1024 * 1024,
  });
}

/** Deletes this run's folder (and the empty folders the adapter leaves behind). */
async function deleteRunFolder(): Promise<void> {
  const { accessToken } = await refreshDropboxAccessToken({
    clientId: dropbox.get("MONGOSHIELD_TEST_DROPBOX_CLIENT_ID"),
    refreshToken: dropbox.get("MONGOSHIELD_TEST_DROPBOX_TOKEN"),
  });
  const response = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: `/${CLOUD_RUN_PREFIX}` }),
  });
  // 409 path_lookup/not_found: nothing was written (every suite skipped or failed early).
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cleaning up the Dropbox run folder failed with HTTP ${response.status}`);
  }
}

describe.skipIf(!dropbox.configured)(dropbox.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  afterAll(deleteRunFolder);

  describeStorageConformance("dropbox", async () =>
    cloudFixture(storageFor(`conformance-${randomUUID()}`)),
  );
  describeEncryptedRoundTrip("dropbox", () => storageFor("backups"));
});
