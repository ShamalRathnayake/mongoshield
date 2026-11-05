/**
 * Docker availability probe for integration tests that start containers with
 * Testcontainers. Suites use it to skip (not fail) cleanly without Docker:
 *
 *   const dockerAvailable = await isDockerAvailable();
 *   describe.skipIf(!dockerAvailable)("against Azurite", () => { … });
 *
 * Suites must load Testcontainers itself lazily (`await import("testcontainers")`
 * inside `beforeAll`), never with a static import: Testcontainers 12 needs
 * Node.js 22.22+ and pulls in undici 8, which crashes while loading on older
 * Node.js (it binds `zlib.createZstdDecompress`, missing before 22.15). The package
 * supports Node.js 22.12+, so on those versions the suites skip instead.
 */

import { createServer } from "node:net";

/** How long to wait for Docker to answer before skipping the suite. */
const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/** The oldest Node.js Testcontainers 12 supports (its `engines` field: ">= 22.22"). */
const TESTCONTAINERS_MIN_NODE = { major: 22, minor: 22 } as const;

/**
 * True if this Node.js can load Testcontainers (22.22 or later). Below that,
 * importing it throws, so container suites skip as if Docker were missing.
 */
export function canLoadTestcontainers(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major !== TESTCONTAINERS_MIN_NODE.major) return major > TESTCONTAINERS_MIN_NODE.major;
  return minor >= TESTCONTAINERS_MIN_NODE.minor;
}

/**
 * True if Testcontainers can run here: this Node.js can load it (see
 * `canLoadTestcontainers`) and a container runtime answers within the timeout.
 * Never hangs, never throws.
 */
export async function isDockerAvailable(): Promise<boolean> {
  if (!canLoadTestcontainers()) return false;
  const { getContainerRuntimeClient } = await import("testcontainers");
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), DOCKER_PROBE_TIMEOUT_MS).unref();
  });
  const probe = getContainerRuntimeClient().then(
    () => true,
    () => false,
  );
  return Promise.race([probe, timeout]);
}

/**
 * A TCP port that is free on this machine right now. Needed for emulators that
 * must know their externally visible URL at start-up (fake-gcs-server puts it
 * in resumable upload session URLs), which rules out a random mapped port.
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port assigned");
  return address.port;
}
