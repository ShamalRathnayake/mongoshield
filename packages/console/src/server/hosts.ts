/**
 * Which `Host` names the console answers to, and which peers are trusted reverse
 * proxies. Pure functions; the middleware that uses them is in security.ts.
 *
 * Why a Host allow-list: the same-origin check compares a request's `Origin` with
 * its own `Host`. A page using DNS rebinding (attacker.example first resolving to the
 * attacker, then to 127.0.0.1 or the console's LAN address) sends both as
 * attacker.example, so that check alone passes, and during the token-less setup
 * window the page could create its own admin. Refusing unknown host NAMES closes this:
 *
 *   allowed always   IP literals (an IP cannot be rebound: a page served from that IP
 *                    IS the console), loopback names (`localhost`, `*.localhost`) and
 *                    single-label names (`mongoshield`, `console`: container and
 *                    service names a reverse proxy forwards to; a rebinding attacker
 *                    needs a public domain, which always has a dot), and names under
 *                    private top-level names (`.local`, `.internal`, `.svc`, …) that
 *                    cannot be registered in public DNS
 *   allowed too      the host of MONGOSHIELD_PUBLIC_URL and the names in
 *                    MONGOSHIELD_ALLOWED_HOSTS (`*.example.com` matches subdomains,
 *                    `*` turns the check off)
 *   refused          every other name
 *
 * Trusted proxies (MONGOSHIELD_TRUSTED_PROXIES): IP addresses or CIDR ranges of the
 * reverse proxies in front of the console. Only for requests whose socket peer is one
 * of them are `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` believed;
 * anyone can send those headers to a console reachable without the proxy.
 */

import { BlockList, isIP } from "node:net";

/** The parts of the settings these checks read. */
export interface HostPolicy {
  /** MONGOSHIELD_PUBLIC_URL. */
  readonly publicUrl?: string | undefined;
  /** MONGOSHIELD_ALLOWED_HOSTS entries: names, `*.example.com`, or `*` (anything). */
  readonly allowedHosts?: readonly string[] | undefined;
}

/**
 * The host name of a `Host` (or `X-Forwarded-Host`) value: lower case, without the
 * port, brackets of an IPv6 literal or a trailing dot. `undefined` when it is empty
 * or not a plausible host.
 */
export function hostnameOf(hostHeader: string): string | undefined {
  const value = hostHeader.trim().toLowerCase();
  if (value === "") return undefined;
  // "[::1]:8080" → "::1"; a bare IPv6 literal (no brackets) has no port to strip.
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/.exec(value);
  if (bracketed !== null) return bracketed[1];
  if (isIP(value) === 6) return value;
  const withoutPort = value.replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9_.-]+$/.test(withoutPort) && withoutPort !== "" ? withoutPort : undefined;
}

/** `localhost` and its subdomains (RFC 6761: always the loopback interface). */
function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * Top-level names nobody can register in public DNS (special-use and private-use names):
 * `.local` (mDNS, and Kubernetes' `cluster.local`), `.internal` (cloud VPC names),
 * `.svc` (Kubernetes short service names), `.lan` and `.home.arpa` (home networks).
 * A rebinding attacker needs a name whose DNS they control, so these are safe to allow,
 * and reverse proxies commonly forward with them as the upstream `Host`.
 */
const PRIVATE_SUFFIXES = [".local", ".internal", ".svc", ".lan", ".home.arpa"];

/** True when the console should answer requests for `hostname` (see the file header). */
export function isAllowedHostname(hostname: string, policy: HostPolicy): boolean {
  if (isIP(hostname) !== 0) return true;
  if (isLoopbackName(hostname)) return true;
  if (!hostname.includes(".")) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return true;
  if (policy.publicUrl !== undefined && hostname === publicHostname(policy.publicUrl)) return true;
  for (const entry of policy.allowedHosts ?? []) {
    if (entry === "*") return true;
    if (entry.startsWith("*.") ? hostname.endsWith(entry.slice(1)) : hostname === entry) {
      return true;
    }
  }
  return false;
}

/** The host name of the public URL, or `undefined` when it does not parse. */
function publicHostname(publicUrl: string): string | undefined {
  try {
    return hostnameOf(new URL(publicUrl).host);
  } catch {
    return undefined;
  }
}

/** A MONGOSHIELD_ALLOWED_HOSTS entry is a host name, `*.` plus one, or `*`. */
export function isValidAllowedHostEntry(entry: string): boolean {
  return entry === "*" || /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(entry);
}

/** `::ffff:10.0.0.1` (an IPv4 client on a dual-stack socket) → `10.0.0.1`. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address.toLowerCase();
}

/**
 * Parses MONGOSHIELD_TRUSTED_PROXIES entries (`10.0.0.5`, `10.0.0.0/8`, `fd00::/8`) into
 * a matcher. An entry that is not an address or range is returned as `bad`, so the
 * caller can name it.
 */
export function parseTrustedProxies(
  entries: readonly string[],
): { readonly ok: true; readonly list: BlockList } | { readonly ok: false; readonly bad: string } {
  const list = new BlockList();
  for (const entry of entries) {
    const [address = "", prefixText] = entry.split("/");
    const family = isIP(address);
    if (family === 0) return { ok: false, bad: entry };
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixText === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    const maxPrefix = family === 4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefixText) || prefix > maxPrefix) return { ok: false, bad: entry };
    list.addSubnet(address, prefix, type);
  }
  return { ok: true, list };
}

/** True when `address` (a socket peer) is in the trusted proxy list. */
export function isTrustedProxy(address: string, list: BlockList): boolean {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (family === 0) return false;
  return list.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The client address from `X-Forwarded-For` behind trusted proxies: the right-most
 * entry that is not itself a trusted proxy (entries further left were written by the
 * client or by proxies we do not know, and may be forged). Falls back to `peer`.
 */
export function forwardedClientAddress(
  forwardedFor: string | undefined,
  peer: string,
  list: BlockList,
): string {
  if (forwardedFor === undefined) return normalizeAddress(peer);
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop !== "");
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = normalizeAddress(hops[index] ?? "");
    if (isIP(hop) === 0) break;
    if (!isTrustedProxy(hop, list)) return hop;
  }
  return normalizeAddress(peer);
}

/**
 * The sub-path the console is served under, from the path of MONGOSHIELD_PUBLIC_URL:
 * `https://example.com/mongoshield/` → `/mongoshield`; no public URL, or one without a
 * path → `""`. Routes, redirects and the UI's API calls are all relative to it.
 */
export function basePathOf(publicUrl: string | undefined): string {
  if (publicUrl === undefined) return "";
  try {
    return new URL(publicUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** The right-most value of a comma-separated forwarding header (set by the nearest proxy). */
export function lastForwardedValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.at(-1);
}
