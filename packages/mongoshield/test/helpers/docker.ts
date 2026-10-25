/**
 * Docker availability probe for integration tests that start containers with
 * Testcontainers. Suites use it to skip (not fail) cleanly without Docker:
 *
 *   const dockerAvailable = await isDockerAvailable();
 *   describe.skipIf(!dockerAvailable)("against Azurite", () => { … });
 */

import { createServer } from "node:net";
import { getContainerRuntimeClient } from "testcontainers";

/** How long to wait for Docker to answer before skipping the suite. */
const DOCKER_PROBE_TIMEOUT_MS = 5_000;

/** True if a container runtime answers within the timeout. Never hangs, never throws. */
export async function isDockerAvailable(): Promise<boolean> {
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
