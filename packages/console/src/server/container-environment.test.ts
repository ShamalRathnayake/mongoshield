/**
 * Tests for the container environment detection: each kind from the files, variables,
 * kernel and network interfaces a real environment of that kind shows, the DNS check
 * of the host alias, and (because injected flags are what hid the host.docker.internal
 * bug) the real detection and the real DNS lookup on the machine running the tests.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createEnvironmentDetector,
  type DetectionProbe,
  detectContainerKind,
  nameResolves,
} from "./container-environment.ts";

/** A Linux machine with nothing container-like about it; tests add what they need. */
function probe(overrides: Partial<DetectionProbe> & { files?: readonly string[] } = {}) {
  const files = new Set(overrides.files ?? []);
  return {
    platform: "linux" as const,
    exists: (path: string) => files.has(path),
    env: {},
    kernelRelease: "6.8.0-45-generic",
    interfaceNames: ["lo", "eth0"],
    ...overrides,
  };
}

describe("detectContainerKind", () => {
  it("sees no container on a plain machine, and none on macOS or Windows", () => {
    expect(detectContainerKind(probe())).toBe("none");
    expect(detectContainerKind(probe({ platform: "darwin", files: ["/.dockerenv"] }))).toBe("none");
  });

  it("tells Docker Desktop (LinuxKit, WSL 2, OrbStack) from Docker Engine on Linux", () => {
    const docker = { files: ["/.dockerenv"] };
    expect(detectContainerKind(probe({ ...docker, kernelRelease: "6.10.14-linuxkit" }))).toBe(
      "docker-desktop",
    );
    expect(
      detectContainerKind(
        probe({ ...docker, kernelRelease: "5.15.153.1-microsoft-standard-WSL2" }),
      ),
    ).toBe("docker-desktop");
    expect(detectContainerKind(probe({ ...docker, kernelRelease: "6.11.0-orbstack" }))).toBe(
      "docker-desktop",
    );
    expect(detectContainerKind(probe({ ...docker, kernelRelease: "6.8.0-45-generic" }))).toBe(
      "docker-engine",
    );
  });

  it("recognises Podman by /run/.containerenv or container=podman", () => {
    expect(detectContainerKind(probe({ files: ["/run/.containerenv"] }))).toBe("podman");
    expect(detectContainerKind(probe({ env: { container: "podman" } }))).toBe("podman");
    // Rootless Podman (pasta) copies the host's interface names: still Podman.
    expect(
      detectContainerKind(
        probe({ files: ["/run/.containerenv"], interfaceNames: ["lo", "enp0s3"] }),
      ),
    ).toBe("podman");
  });

  it("recognises Kubernetes by its variable or its service account", () => {
    expect(detectContainerKind(probe({ env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } }))).toBe(
      "kubernetes",
    );
    expect(
      detectContainerKind(probe({ files: ["/var/run/secrets/kubernetes.io/serviceaccount"] })),
    ).toBe("kubernetes");
    // Kubernetes wins over the container runtime's marker files.
    expect(
      detectContainerKind(
        probe({ files: ["/.dockerenv"], env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } }),
      ),
    ).toBe("kubernetes");
  });

  it("recognises --network host by interfaces only a host has", () => {
    for (const interfaceNames of [
      ["lo", "eth0", "docker0"],
      ["lo", "enp0s3", "br-3f2a1b4c5d6e"],
      ["lo", "wlp2s0"],
    ]) {
      expect(
        detectContainerKind(probe({ files: ["/.dockerenv"], interfaceNames })),
        interfaceNames.join(","),
      ).toBe("host-network");
    }
    expect(
      detectContainerKind(probe({ files: ["/run/.containerenv"], interfaceNames: ["podman0"] })),
    ).toBe("host-network");
  });

  it("runs for real on this machine and agrees with what the machine shows", () => {
    // No injection: the same call the server makes. On a CI runner or a laptop this is
    // "none"; inside a dev container it must say which container it is.
    const kind = detectContainerKind();
    const inContainer =
      process.platform === "linux" &&
      (existsSync("/.dockerenv") ||
        existsSync("/run/.containerenv") ||
        process.env.container === "podman" ||
        process.env.KUBERNETES_SERVICE_HOST !== undefined ||
        existsSync("/var/run/secrets/kubernetes.io/serviceaccount"));
    expect(kind === "none").toBe(!inContainer);
  });
});

describe("nameResolves", () => {
  it("looks names up for real: localhost resolves, a reserved .invalid name does not", async () => {
    expect(await nameResolves("localhost")).toBe(true);
    expect(await nameResolves("mongoshield-test.invalid")).toBe(false);
  });

  it("counts a lookup that never answers as not resolving", async () => {
    const never = () => new Promise<never>(() => {});
    expect(await nameResolves("host.docker.internal", never, 10)).toBe(false);
  });
});

describe("createEnvironmentDetector", () => {
  const engine = probe({ files: ["/.dockerenv"] });

  it("reports the alias and whether it resolves, once the lookup has finished", async () => {
    const looked: string[] = [];
    const detector = createEnvironmentDetector({
      probe: engine,
      lookup: async (name) => {
        looked.push(name);
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      },
    });
    // Before the first lookup: the kind and alias, but no answer yet.
    expect(detector.current()).toEqual({
      kind: "docker-engine",
      hostAlias: "host.docker.internal",
    });
    expect(await detector.fresh()).toEqual({
      kind: "docker-engine",
      hostAlias: "host.docker.internal",
      hostAliasResolves: false,
    });
    expect(detector.current().hostAliasResolves).toBe(false);
    expect(looked).toEqual(["host.docker.internal"]);
  });

  it("looks the alias up again only when the last answer is stale", async () => {
    let clock = 0;
    let lookups = 0;
    const detector = createEnvironmentDetector({
      probe: probe({ files: ["/run/.containerenv"] }),
      lookup: async () => {
        lookups += 1;
      },
      maxAgeMs: 1_000,
      now: () => clock,
    });
    expect(await detector.fresh()).toEqual({
      kind: "podman",
      hostAlias: "host.containers.internal",
      hostAliasResolves: true,
    });
    await detector.fresh();
    expect(lookups).toBe(1);
    clock = 5_000;
    await detector.fresh();
    expect(lookups).toBe(2);
  });

  it("does no lookup where there is no alias (Kubernetes, host network, no container)", async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
    };
    for (const machine of [
      probe({ env: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } }),
      probe({ files: ["/.dockerenv"], interfaceNames: ["docker0"] }),
      probe(),
    ]) {
      const environment = await createEnvironmentDetector({ probe: machine, lookup }).fresh();
      expect(environment.hostAlias).toBeUndefined();
    }
    expect(lookups).toBe(0);
  });
});
