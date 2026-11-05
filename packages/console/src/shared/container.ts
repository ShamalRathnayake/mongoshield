/**
 * What the console's container environment means for connection strings, shared by the
 * server (connection checks and error hints) and the pages (quick fill and hints).
 *
 * The server detects the environment (src/server/container-environment.ts) and sends it
 * in the session (`SessionInfo.container`). These pure functions answer the questions
 * both sides ask about it:
 *
 *   - does `localhost` mean the console's own container? ({@link localhostIsContainer})
 *   - which name reaches the machine the container runs on? ({@link hostAliasFor})
 *   - can that name be offered in one click, or must the user create it first?
 *     ({@link usableHostAlias}, {@link addHostFlag})
 *
 * No Node or browser APIs, so both sides run the same code.
 */

import type { ContainerEnvironment, ContainerKind } from "./api.ts";
import { CONTAINER_HOST, PODMAN_CONTAINER_HOST } from "./connection-string.ts";

/** Not in a container: `localhost` is this computer. */
export const NOT_IN_CONTAINER: ContainerEnvironment = { kind: "none" };

/**
 * True where `localhost` is the console's own container rather than the machine it
 * runs on: Docker (Desktop or Engine) and Podman with their default bridge networks.
 * False in Kubernetes (a sidecar in the same pod really is on `localhost`), with host
 * networking (`localhost` is the host) and outside containers.
 */
export function localhostIsContainer(kind: ContainerKind): boolean {
  return kind === "docker-desktop" || kind === "docker-engine" || kind === "podman";
}

/**
 * The name a container of this kind uses for the machine it runs on, or undefined
 * where there is none to suggest (see {@link localhostIsContainer}).
 */
export function hostAliasFor(kind: ContainerKind): string | undefined {
  if (kind === "podman") return PODMAN_CONTAINER_HOST;
  if (kind === "docker-desktop" || kind === "docker-engine") return CONTAINER_HOST;
  return undefined;
}

/**
 * The host alias when it is known to resolve inside the console, so it can be offered
 * in one click; undefined otherwise (no alias here, or the lookup failed or has not
 * finished: offering a name that does not resolve is exactly the bug this prevents).
 */
export function usableHostAlias(container: ContainerEnvironment | undefined): string | undefined {
  if (container?.hostAlias === undefined || container.hostAliasResolves !== true) return undefined;
  return container.hostAlias;
}

/**
 * True when the environment has a host alias that is known NOT to resolve: the console
 * then explains how to create it ({@link addHostFlag}) instead of suggesting it.
 */
export function hostAliasMissing(container: ContainerEnvironment | undefined): boolean {
  return container?.hostAlias !== undefined && container.hostAliasResolves === false;
}

/**
 * The `docker run` / `podman run` flag that creates the alias on Linux, where Docker
 * Engine does not provide it by itself. `host-gateway` is Docker's (and Podman's) word
 * for "the host's address on the container's network".
 */
export function addHostFlag(hostAlias: string): string {
  return `--add-host=${hostAlias}:host-gateway`;
}

/** The same setting for Docker Compose (`extra_hosts` under the console's service). */
export function composeExtraHosts(hostAlias: string): string {
  return `extra_hosts: ["${hostAlias}:host-gateway"]`;
}

/** A short name for the runtime, for messages ("The console runs in Docker"). */
export function runtimeName(kind: ContainerKind): string {
  switch (kind) {
    case "docker-desktop":
    case "docker-engine":
      return "Docker";
    case "podman":
      return "Podman";
    case "kubernetes":
      return "Kubernetes";
    case "host-network":
      return "a container on the host's network";
    case "none":
      return "no container";
  }
}
