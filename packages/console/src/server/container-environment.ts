/**
 * Where the console runs, detected for real: not in a container, Docker Desktop, Docker
 * Engine on Linux, Podman, Kubernetes, or a container on the host's network.
 *
 * It matters for one question users hit on their first connection: what do `localhost`
 * and `host.docker.internal` mean here? (See ContainerKind in src/shared/api.ts.)
 *
 *   - Docker and Podman: `localhost` is the console's own container. The machine it runs
 *     on is `host.docker.internal` (Podman: `host.containers.internal`), but on Linux
 *     Docker Engine that name exists only with `--add-host=…:host-gateway`, so the name
 *     is looked up in DNS before any page offers it.
 *   - Kubernetes and host networking: `localhost` means what it says; nothing to rewrite.
 *
 * How each kind is recognised (cheapest and most specific first):
 *
 *   kubernetes    KUBERNETES_SERVICE_HOST (set in every pod), or the service account
 *                 directory /var/run/secrets/kubernetes.io/serviceaccount
 *   (container)   /.dockerenv (Docker creates it), /run/.containerenv (Podman creates
 *                 it), or `container=podman` in the environment; none of them: "none"
 *   host-network  the container sees network interfaces only a host has (docker0,
 *                 br-…, veth…, cni…; for Docker also physical NICs such as enp0s3):
 *                 its network namespace is the host's. A bridged container sees only
 *                 lo and eth0.
 *   podman        /run/.containerenv or `container=podman`
 *   docker-desktop  the kernel is Docker Desktop's VM (linuxkit), OrbStack's, or WSL 2's
 *   docker-engine   any other Docker container
 *
 * Tests inject a {@link DetectionProbe}; container-environment.test.ts also runs the
 * real detection on the machine running the tests, which no injected flag can stand in for.
 */

import { promises as dns } from "node:dns";
import { existsSync } from "node:fs";
import { networkInterfaces, release } from "node:os";
import type { ContainerEnvironment, ContainerKind } from "../shared/api.ts";
import { hostAliasFor } from "../shared/container.ts";

/** What detection looks at; {@link realProbe} reads the real machine. */
export interface DetectionProbe {
  /** `process.platform`: only Linux runs containers that matter here. */
  readonly platform: NodeJS.Platform;
  /** Whether a file or directory exists. */
  readonly exists: (path: string) => boolean;
  /** The process environment. */
  readonly env: NodeJS.ProcessEnv;
  /** The kernel release (`os.release()`), e.g. `6.10.14-linuxkit` on Docker Desktop. */
  readonly kernelRelease: string;
  /** The names of the network interfaces this process can see. */
  readonly interfaceNames: readonly string[];
}

/** Looks a host name up the way the MongoDB driver will (getaddrinfo). */
export type NameLookup = (hostname: string) => Promise<unknown>;

/** The real machine, as seen by this process. */
export function realProbe(): DetectionProbe {
  return {
    platform: process.platform,
    exists: existsSync,
    env: process.env,
    kernelRelease: release(),
    interfaceNames: Object.keys(networkInterfaces()),
  };
}

/** The Kubernetes service account directory, mounted into pods by default. */
const KUBERNETES_SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * Kernels of the Linux VMs behind Docker Desktop (LinuxKit; WSL 2 on Windows) and
 * OrbStack: there `host.docker.internal` is provided by the runtime itself.
 */
const DESKTOP_KERNEL_PATTERN = /linuxkit|orbstack|microsoft|wsl/i;

/**
 * Network interfaces that exist on a host but never inside a bridged container (which
 * sees only `lo` and `eth0`): container bridges and veth pairs, CNI and other overlay
 * plugins, and libvirt.
 */
const HOST_BRIDGE_INTERFACE_PATTERN =
  /^(?:docker\d+|br-[0-9a-f]+|veth|podman\d+|cni|flannel|cali|cilium|weave|virbr)/;

/**
 * The predictable names of physical NICs (enp…, eno…, ens…, wl…). A bridged Docker
 * container never has them, but rootless Podman's default network (pasta) copies the
 * host's interface names into the container, so they only count for Docker.
 */
const PHYSICAL_INTERFACE_PATTERN = /^(?:en[ops]\d|wl)/;

/** Which kind of environment the probe shows (see the file header for the rules). */
export function detectContainerKind(probe: DetectionProbe = realProbe()): ContainerKind {
  if (probe.platform !== "linux") return "none";
  if (probe.env.KUBERNETES_SERVICE_HOST !== undefined || probe.exists(KUBERNETES_SERVICE_ACCOUNT)) {
    return "kubernetes";
  }
  const podman = probe.exists("/run/.containerenv") || probe.env.container === "podman";
  const docker = probe.exists("/.dockerenv");
  if (!podman && !docker) return "none";
  const sharesHostNetwork = probe.interfaceNames.some(
    (name) =>
      HOST_BRIDGE_INTERFACE_PATTERN.test(name) ||
      (!podman && PHYSICAL_INTERFACE_PATTERN.test(name)),
  );
  if (sharesHostNetwork) return "host-network";
  if (podman) return "podman";
  return DESKTOP_KERNEL_PATTERN.test(probe.kernelRelease) ? "docker-desktop" : "docker-engine";
}

/** How long a name lookup may take before it counts as "does not resolve". */
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * True when `hostname` resolves to an address here. Any failure (ENOTFOUND, EAI_AGAIN,
 * a resolver timeout) is false: the driver would fail the same way.
 */
export async function nameResolves(
  hostname: string,
  lookup: NameLookup = (name) => dns.lookup(name),
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([lookup(hostname).then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Options for {@link createEnvironmentDetector}; tests replace the machine and DNS. */
export interface EnvironmentDetectorOptions {
  readonly probe?: DetectionProbe;
  readonly lookup?: NameLookup;
  /** Look the host alias up again after this long (default one minute). */
  readonly maxAgeMs?: number;
  /** The clock (milliseconds). */
  readonly now?: () => number;
}

/** The console's environment, detected once and kept fresh (see {@link createEnvironmentDetector}). */
export interface EnvironmentDetector {
  /**
   * The environment as known right now, without waiting: the kind and host alias, and
   * the last finished lookup of the alias (absent before the first one). Starts a new
   * lookup in the background when the last one is stale. For the session answer, which
   * is synchronous; main.ts runs {@link fresh} once at start so it is known early.
   */
  current(): ContainerEnvironment;
  /** The environment with a lookup of the host alias that is at most `maxAgeMs` old. */
  fresh(): Promise<ContainerEnvironment>;
}

/** Default for {@link EnvironmentDetectorOptions.maxAgeMs}. */
const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * Creates a detector. The kind cannot change while the process runs, so it is
 * detected once; whether the host alias resolves is looked up again when stale (a
 * hosts file or DNS server can change, and a lookup is cheap).
 */
export function createEnvironmentDetector(
  options: EnvironmentDetectorOptions = {},
): EnvironmentDetector {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let kind: ContainerKind | undefined;
  let resolves: boolean | undefined;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const kindNow = (): ContainerKind => {
    kind ??= detectContainerKind(options.probe ?? realProbe());
    return kind;
  };

  const snapshot = (): ContainerEnvironment => {
    const currentKind = kindNow();
    const hostAlias = hostAliasFor(currentKind);
    return {
      kind: currentKind,
      ...(hostAlias === undefined ? {} : { hostAlias }),
      ...(hostAlias === undefined || resolves === undefined ? {} : { hostAliasResolves: resolves }),
    };
  };

  /** Looks the alias up (one lookup at a time); nothing to do without an alias. */
  const check = (): Promise<void> => {
    const hostAlias = hostAliasFor(kindNow());
    if (hostAlias === undefined) return Promise.resolve();
    inFlight ??= nameResolves(hostAlias, options.lookup).then((answer) => {
      resolves = answer;
      checkedAt = now();
      inFlight = undefined;
    });
    return inFlight;
  };

  const stale = (): boolean => now() - checkedAt > maxAgeMs;

  return {
    current() {
      // nameResolves never rejects, so the background check needs no catch.
      if (stale()) void check();
      return snapshot();
    },
    async fresh() {
      if (stale()) await check();
      return snapshot();
    },
  };
}

/** The process-wide detector used by the server (tests pass their own environment). */
export const consoleEnvironment: EnvironmentDetector = createEnvironmentDetector();
