/**
 * Small decisions main.ts makes while the console starts, kept here so they can be
 * tested (main.ts itself runs on import):
 *
 *   - {@link listenHost}: which address to listen on. `::` by default, which on Linux,
 *     macOS and Windows accepts IPv6 and IPv4 alike (Node clears IPV6_V6ONLY), so the
 *     console works on IPv6-only Kubernetes clusters and Docker networks too; 0.0.0.0
 *     where the machine has no IPv6 at all (`ipv6.disable=1`, some minimal containers).
 *   - {@link setupLinkBase}: where the printed one-time setup link points. Only
 *     MONGOSHIELD_PUBLIC_URL knows the address people really use; without it the link
 *     names the console's own port, which `docker run -p 18080:8080` changes.
 *   - {@link dataDirAccessError}: a data directory the console may not write (a host
 *     folder bind-mounted into the image, which runs as UID 65532) becomes a message
 *     with the `chown` that fixes it, instead of a raw EACCES stack trace.
 */

import { createServer } from "node:net";

/** Every IPv6 and (dual stack) IPv4 address. */
export const DUAL_STACK_HOST = "::";

/** Every IPv4 address: the fallback without IPv6. */
export const IPV4_ANY_HOST = "0.0.0.0";

/**
 * True when this machine can listen on `::`. Tries it on a free port (port 0) and
 * closes again right away. Fails with EAFNOSUPPORT or EADDRNOTAVAIL without IPv6.
 */
export function canListenOnIpv6(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: DUAL_STACK_HOST, port: 0 }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * The address to listen on: HOST when set (always used as given), else `::`, or
 * 0.0.0.0 when IPv6 is unavailable here.
 */
export async function listenHost(
  requested: string | undefined,
  ipv6Available: () => Promise<boolean> = canListenOnIpv6,
): Promise<string> {
  if (requested !== undefined) return requested;
  return (await ipv6Available()) ? DUAL_STACK_HOST : IPV4_ANY_HOST;
}

/** Where the printed setup link points, and what to say about it. */
export interface SetupLinkBase {
  /** The link's origin, e.g. `https://backups.example.com` or `http://localhost:8080`. */
  readonly base: string;
  /** Lines to print after the link when the address is only a guess. */
  readonly note?: string;
}

/**
 * The origin for the setup link: MONGOSHIELD_PUBLIC_URL when set, otherwise
 * `http://localhost:<port>` with a note that the port is the console's own (inside a
 * container), which a port mapping or a remote server changes.
 */
export function setupLinkBase(publicUrl: string | undefined, port: number): SetupLinkBase {
  if (publicUrl !== undefined) return { base: publicUrl };
  return {
    base: `http://localhost:${port}`,
    note: [
      `  The link uses the console's own port (${port}) and localhost. If you published another`,
      `  port (for example docker run -p 18080:${port}), use that port instead, and the server's`,
      "  address when you open it from another computer. Set MONGOSHIELD_PUBLIC_URL to the address",
      "  people use (e.g. https://backups.example.com) to get the exact link.",
      "",
    ].join("\n"),
  };
}

/** A data directory the console may not create, read or write, explained. */
export class DataDirAccessError extends Error {
  override readonly name = "DataDirAccessError";
}

/** Error codes for "this user may not do that here". */
const ACCESS_DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** The image's non-root user and group (distroless `nonroot`). */
const IMAGE_USER_ID = 65532;

/** Who the console runs as, for the `chown` command; the image's user where unknown. */
export interface ConsoleUser {
  readonly uid: number;
  readonly gid: number;
}

/** This process's user and group (POSIX), else the image's. */
export function currentUser(): ConsoleUser {
  return {
    uid: process.getuid?.() ?? IMAGE_USER_ID,
    gid: process.getgid?.() ?? IMAGE_USER_ID,
  };
}

/**
 * A {@link DataDirAccessError} for a permission error while opening the data
 * directory, or undefined for any other error (which then keeps its stack trace).
 *
 * The usual cause: `docker run -v ./data:/data`. The host folder belongs to the user
 * who created it, while the image runs as UID 65532, so the console may not write
 * there. A named volume (`-v mongoshield-data:/data`) is initialised by Docker with the
 * image's ownership and works as it is.
 */
export function dataDirAccessError(
  error: unknown,
  dataDir: string,
  user: ConsoleUser = currentUser(),
): DataDirAccessError | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string" || !ACCESS_DENIED_CODES.has(code)) return undefined;
  const path: unknown = Reflect.get(error, "path");
  const where = typeof path === "string" ? path : dataDir;
  const owner = `${user.uid}:${user.gid}`;
  return new DataDirAccessError(
    [
      `The console may not write to its data directory ${dataDir} (${code} on ${where}).`,
      "",
      `It runs as user ${owner}, and that user cannot create files there. This happens when a`,
      `folder from the host is mounted at ${dataDir} (docker run -v ./data:${dataDir}): the folder`,
      "belongs to your user, not the console's. Fix it in one of these ways:",
      "",
      `  - give the folder to the console's user, on the host:  sudo chown -R ${owner} <host folder>`,
      `    (rootless Podman: podman unshare chown -R ${owner} <host folder>)`,
      `  - or use a named volume instead of a folder:            -v mongoshield-data:${dataDir}`,
      "",
      `On SELinux systems (Fedora, RHEL) also add :z to the volume (-v ./data:${dataDir}:z).`,
      `In Kubernetes, set the pod's securityContext.fsGroup to ${user.gid}.`,
    ].join("\n"),
  );
}
