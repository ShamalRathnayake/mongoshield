/**
 * Runs the storage conformance suite against a real OpenSSH sftp-server
 * (atmoz/sftp in Docker, started with Testcontainers). Unlike the in-process
 * ssh2 server used by the unit tests, OpenSSH advertises the
 * `posix-rename@openssh.com` and `fsync@openssh.com` extensions, so this
 * covers the adapter's atomic-replace and durability paths.
 *
 * The client key is generated per run and the host key fingerprints are read
 * from the container, so host key verification stays on.
 *
 * Skipped (not failed) when no Docker runtime is reachable.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";
import { sftpStorage } from "../../src/storage/sftp.ts";
import { isDockerAvailable } from "../helpers/docker.ts";
import { describeStorageConformance } from "../helpers/storage-conformance.ts";

const SFTP_IMAGE = "atmoz/sftp:alpine";
const USERNAME = "tester";

interface KeyPair {
  readonly private: string;
  readonly public: string;
}

// ssh2 ships no type declarations; this is the one helper the test needs.
const ssh2: { utils: { generateKeyPairSync(type: "ed25519"): KeyPair } } = createRequire(
  import.meta.url,
)("ssh2");

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("sftpStorage against OpenSSH", () => {
  const clientKey = ssh2.utils.generateKeyPairSync("ed25519");
  let container: StartedTestContainer;
  let hostFingerprints: string[];

  beforeAll(async () => {
    container = await new GenericContainer(SFTP_IMAGE)
      .withExposedPorts(22)
      // user:password:uid:gid:dirs. No password; "upload" is the writable
      // directory inside the user's chroot.
      .withCommand([`${USERNAME}::1001:1001:upload`])
      .withCopyContentToContainer([
        { content: clientKey.public, target: `/home/${USERNAME}/.ssh/keys/id_ed25519.pub` },
      ])
      .withWaitStrategy(Wait.forLogMessage(/Server listening on/))
      .start();
    const listing = await container.exec([
      "sh",
      "-c",
      'for key in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$key"; done',
    ]);
    hostFingerprints = [...listing.stdout.matchAll(/SHA256:[A-Za-z0-9+/]{43}/g)].map(
      (match) => match[0],
    );
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  describeStorageConformance("sftp (OpenSSH)", async () => {
    const storage = sftpStorage({
      host: container.getHost(),
      port: container.getMappedPort(22),
      username: USERNAME,
      privateKey: clientKey.private,
      hostFingerprint: hostFingerprints,
      path: `/upload/run-${randomUUID()}`,
    });
    return { storage, cleanup: async () => storage.close?.() };
  });
});
