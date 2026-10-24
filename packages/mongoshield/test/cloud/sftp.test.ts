/**
 * Opt-in tests against a real, remote SFTP server (any OpenSSH or managed SFTP
 * service such as AWS Transfer Family, Hetzner Storage Box or rsync.net). The
 * Docker-based integration test (test/integration/storage-sftp.test.ts) already
 * covers a local OpenSSH server; this one adds real network latency, a real host
 * key and the provider's own server quirks. Run with
 * `pnpm --filter mongoshield test:cloud`; see docs/testing-real-clouds.md.
 *
 * Variables (all required except the port):
 * - MONGOSHIELD_TEST_SFTP_HOST               server host name
 * - MONGOSHIELD_TEST_SFTP_PORT               optional, default 22
 * - MONGOSHIELD_TEST_SFTP_USERNAME           login user
 * - MONGOSHIELD_TEST_SFTP_PRIVATE_KEY        the user's private key (PEM/OpenSSH text, unencrypted)
 * - MONGOSHIELD_TEST_SFTP_HOST_FINGERPRINT   SHA256:… of the server's host key (comma-separated for several)
 * - MONGOSHIELD_TEST_SFTP_PATH               a writable directory, e.g. /upload
 */

import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { sftpStorage } from "../../src/storage/sftp.ts";
import type { StorageAdapter } from "../../src/storage/types.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";
import { CLOUD_RUN_PREFIX, CLOUD_TARGET_VARIABLES, cloudTarget, optionalEnv } from "./env.ts";
import { CLOUD_TEST_TIMEOUT_MS, cloudFixture, describeEncryptedRoundTrip } from "./helpers.ts";

const sftp = cloudTarget("SFTP", CLOUD_TARGET_VARIABLES.sftp);

/**
 * An adapter rooted at `<MONGOSHIELD_TEST_SFTP_PATH>/<subPath>`. Host key
 * verification stays on: the fingerprint comes from the configuration, never from
 * trusting whatever key the server presents.
 */
function storageFor(subPath: string): StorageAdapter {
  const port = optionalEnv("MONGOSHIELD_TEST_SFTP_PORT");
  const basePath = sftp.get("MONGOSHIELD_TEST_SFTP_PATH").replace(/\/+$/, "");
  return sftpStorage({
    host: sftp.get("MONGOSHIELD_TEST_SFTP_HOST"),
    ...(port === undefined ? {} : { port: Number(port) }),
    username: sftp.get("MONGOSHIELD_TEST_SFTP_USERNAME"),
    privateKey: sftp.get("MONGOSHIELD_TEST_SFTP_PRIVATE_KEY"),
    hostFingerprint: sftp
      .get("MONGOSHIELD_TEST_SFTP_HOST_FINGERPRINT")
      .split(",")
      .map((fingerprint) => fingerprint.trim()),
    path: `${basePath}/${subPath}`,
  });
}

describe.skipIf(!sftp.configured)(sftp.title, { timeout: CLOUD_TEST_TIMEOUT_MS }, () => {
  // SFTP has no object lock: `capabilities.objectLock` is false, so the conformance
  // suite checks that retained puts are refused instead.
  describeStorageConformance("sftp (remote server)", async () =>
    cloudFixture(storageFor(`${CLOUD_RUN_PREFIX}/sftp/conformance-${randomUUID()}`)),
  );
  describeEncryptedRoundTrip("sftp (remote server)", () =>
    storageFor(`${CLOUD_RUN_PREFIX}/sftp/backups`),
  );
});
