/**
 * Runs the storage conformance suite against a real OpenSSH sftp-server
 * (atmoz/sftp in Docker, started with Testcontainers). Unlike the in-process
 * ssh2 server used by the unit tests, OpenSSH advertises the
 * `posix-rename@openssh.com` and `fsync@openssh.com` extensions, so this
 * covers the adapter's atomic-replace and durability paths.
 *
 * The client key is generated per run and the host key fingerprints are read
 * from the container, so host key verification stays on. The container's
 * public host keys (ed25519, ECDSA and RSA) also make known_hosts files, to
 * check plain, hashed and per-key-type entries against a real sshd.
 *
 * Skipped (not failed) when no Docker runtime is reachable.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../src/errors.ts";
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
  /** `<type> <base64>` for each of the container's host keys. */
  let hostPublicKeys: string[];

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
    const publicKeys = await container.exec(["sh", "-c", "cat /etc/ssh/ssh_host_*_key.pub"]);
    hostPublicKeys = publicKeys.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).slice(0, 2).join(" "))
      .filter((line) => line.length > 0);
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

  describe("with known_hosts instead of fingerprints", () => {
    /** known_hosts names hosts on non-default ports `[host]:port`. */
    const hostName = () => `[${container.getHost()}]:${container.getMappedPort(22)}`;

    function storageWith(knownHosts: string) {
      return sftpStorage({
        host: container.getHost(),
        port: container.getMappedPort(22),
        username: USERNAME,
        privateKey: clientKey.private,
        knownHosts,
        path: `/upload/known-hosts-${randomUUID()}`,
      });
    }

    it("lists keys of several types; each one alone is enough", async () => {
      expect(hostPublicKeys.map((key) => key.split(" ")[0]).sort()).toEqual(
        expect.arrayContaining(["ssh-ed25519", "ssh-rsa"]),
      );
      for (const key of hostPublicKeys) {
        const storage = storageWith(`${hostName()} ${key}\n`);
        try {
          await storage.put("a.txt", Buffer.from(key));
          expect(await storage.head("a.txt")).toBeDefined();
        } finally {
          await storage.close?.();
        }
      }
    });

    it("accepts hashed entries", async () => {
      const salt = randomBytes(20);
      const hash = createHmac("sha1", salt).update(hostName()).digest("base64");
      const lines = hostPublicKeys.map((key) => `|1|${salt.toString("base64")}|${hash} ${key}`);
      const storage = storageWith(`${lines.join("\n")}\n`);
      try {
        expect(await storage.head("missing")).toBeUndefined();
      } finally {
        await storage.close?.();
      }
    });

    it("refuses the server when its keys are listed for another host", async () => {
      const lines = hostPublicKeys.map((key) => `[elsewhere.example]:22 ${key}`);
      const storage = storageWith(`${lines.join("\n")}\n`);
      try {
        const error = await storage.head("a.txt").catch((reason: unknown) => reason);
        expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      } finally {
        await storage.close?.();
      }
    });
  });
});
