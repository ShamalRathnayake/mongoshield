/**
 * OpenSSH `known_hosts` support for the SFTP adapter: parsing the file and
 * deciding whether a host key presented by a server is trusted.
 *
 * The format is the one described in sshd(8), "SSH_KNOWN_HOSTS FILE FORMAT":
 *
 *     [@marker] <host patterns> <key type> <base64 key blob> [comment]
 *
 *     backup.example.com,10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…
 *     [backup.example.com]:2222 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTIt…
 *     |1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ssh-rsa AAAAB3Nza…
 *     @revoked * ssh-rsa AAAAB3NzaC1yc2EAAAA…
 *
 * - Host patterns are comma-separated. `*` and `?` are wildcards, a leading `!`
 *   negates (a matching negated pattern excludes the line). Hosts on a port
 *   other than 22 are written `[host]:port`, and only such patterns match them.
 * - Hashed entries (`HashKnownHosts yes`) are `|1|<base64 salt>|<base64 HMAC-SHA1
 *   of the host name, keyed with the salt>`, so the file does not reveal which
 *   hosts it lists. The hashed name is `host` or `[host]:port`, as above.
 * - A host may have several lines, one per key type (ed25519, ECDSA, RSA). Any
 *   of them may match the key the server presents.
 * - `@revoked` keys are refused for every host. `@cert-authority` lines are
 *   ignored: host certificates are not supported, so they can never vouch for a key.
 * - Blank lines, `#` comments and lines that do not parse are skipped, as
 *   OpenSSH does.
 *
 * Keys are compared as raw public key blobs, exactly what ssh2 hands to its
 * `hostVerifier`, so the key type is checked implicitly (the blob starts with it).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/** One usable line of a known_hosts file. */
export interface KnownHostEntry {
  /** `revoked` for `@revoked` lines; plain entries have no marker. */
  readonly marker?: "revoked";
  /** The comma-separated host patterns (or one `|1|…` hash), as written. */
  readonly hosts: string;
  /** The key type field, e.g. `ssh-ed25519`. */
  readonly keyType: string;
  /** The decoded public key blob. */
  readonly key: Buffer;
}

/** What known_hosts says about the key a host presented. */
export type KnownHostVerdict =
  /** A matching, non-revoked entry lists this exact key for this host. */
  | "trusted"
  /** The key is listed as `@revoked`. */
  | "revoked"
  /** The host is listed, but with other keys: its key changed, or someone is intercepting. */
  | "changed"
  /** The host is not listed at all. */
  | "unknown";

/**
 * `~` and `~/x` → the home directory (and `x` inside it), as a shell would, so
 * `knownHostsPath: "~/.ssh/known_hosts"` works as people write it.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** The default SSH port: hosts on it are written without brackets. */
const DEFAULT_SSH_PORT = 22;

/** Prefix of a hashed host entry, `|1|salt|hash` (1 = HMAC-SHA1). */
const HASHED_HOST_PREFIX = "|1|";

/** Parses known_hosts text into its usable entries, skipping anything else. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const entry = parseLine(rawLine.trim());
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function parseLine(line: string): KnownHostEntry | undefined {
  if (line === "" || line.startsWith("#")) return undefined;
  const fields = line.split(/\s+/);
  let marker: string | undefined;
  if (fields[0]?.startsWith("@")) marker = fields.shift();
  // Host certificates are not supported, and unknown markers mean nothing to us.
  if (marker !== undefined && marker !== "@revoked") return undefined;
  const [hosts, keyType, encodedKey] = fields;
  if (hosts === undefined || keyType === undefined || encodedKey === undefined) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey)) return undefined;
  const key = Buffer.from(encodedKey, "base64");
  if (key.length === 0) return undefined;
  return { ...(marker === undefined ? {} : { marker: "revoked" as const }), hosts, keyType, key };
}

/**
 * The name OpenSSH looks up for a connection: `host` on port 22, `[host]:port`
 * otherwise. Host names are compared case-insensitively, so it is lower-cased.
 */
export function knownHostName(host: string, port: number): string {
  const name = host.toLowerCase();
  return port === DEFAULT_SSH_PORT ? name : `[${name}]:${port}`;
}

/** Decides whether `presentedKey` (the raw blob ssh2 reports) is trusted for `host:port`. */
export function checkKnownHost(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
  presentedKey: Uint8Array,
): KnownHostVerdict {
  const presented = Buffer.from(presentedKey);
  // A revoked key is refused for every host, whatever else the file says.
  if (entries.some((entry) => entry.marker === "revoked" && sameKey(entry.key, presented))) {
    return "revoked";
  }
  const forHost = entriesForHost(entries, host, port);
  if (forHost.length === 0) return "unknown";
  return forHost.some((entry) => sameKey(entry.key, presented)) ? "trusted" : "changed";
}

/** The non-revoked entries whose host patterns match `host:port`. */
export function entriesForHost(
  entries: readonly KnownHostEntry[],
  host: string,
  port: number,
): KnownHostEntry[] {
  const name = knownHostName(host, port);
  return entries.filter((entry) => entry.marker === undefined && hostsMatch(entry.hosts, name));
}

/** True if the host field of a line (patterns or one hash) matches `name`. */
function hostsMatch(hosts: string, name: string): boolean {
  if (hosts.startsWith(HASHED_HOST_PREFIX)) return hashedHostMatches(hosts, name);
  let matched = false;
  for (const pattern of hosts.split(",")) {
    if (pattern.startsWith("!")) {
      // A matching negation excludes the line, even if another pattern matches.
      if (globMatches(pattern.slice(1), name)) return false;
    } else if (globMatches(pattern, name)) {
      matched = true;
    }
  }
  return matched;
}

/** `|1|<salt>|<hash>`: HMAC-SHA1 of the name, keyed with the salt, equals the hash. */
function hashedHostMatches(hosts: string, name: string): boolean {
  const [salt, hash] = hosts.slice(HASHED_HOST_PREFIX.length).split("|");
  if (salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** OpenSSH-style wildcard match (`*` = any run of characters, `?` = one), case-insensitive. */
function globMatches(pattern: string, name: string): boolean {
  let source = "";
  for (const character of pattern.toLowerCase()) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(name);
}

function sameKey(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}

/**
 * The host key algorithms (in ssh2's names) that can produce keys of the given
 * known_hosts key types. Offered first in the handshake, like OpenSSH does, so a
 * server with several host keys presents one that the file lists. An RSA key can
 * sign with SHA-2 or SHA-1; unknown types (security keys, DSA) add nothing.
 */
export function hostKeyAlgorithmsFor(keyTypes: readonly string[]): string[] {
  const algorithms: string[] = [];
  for (const keyType of keyTypes) {
    for (const algorithm of HOST_KEY_ALGORITHMS[keyType] ?? []) {
      if (!algorithms.includes(algorithm)) algorithms.push(algorithm);
    }
  }
  return algorithms;
}

/** known_hosts key type → host key algorithms ssh2 supports for it. */
const HOST_KEY_ALGORITHMS: Readonly<Record<string, readonly string[]>> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
};
