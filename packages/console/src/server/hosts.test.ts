/**
 * Tests for the Host allow-list (DNS rebinding), trusted proxies and the base path.
 */

import { describe, expect, it } from "vitest";
import {
  basePathOf,
  forwardedClientAddress,
  hostnameOf,
  isAllowedHostname,
  isTrustedProxy,
  isValidAllowedHostEntry,
  parseTrustedProxies,
} from "./hosts.ts";

/** A trusted proxy list, failing the test when it does not parse. */
function proxies(...entries: string[]) {
  const parsed = parseTrustedProxies(entries);
  if (!parsed.ok) throw new Error(`bad entry ${parsed.bad}`);
  return parsed.list;
}

describe("hostnameOf", () => {
  it("drops the port, IPv6 brackets, a trailing dot and the case", () => {
    expect(hostnameOf("Backups.Example.com:8443")).toBe("backups.example.com");
    expect(hostnameOf("[::1]:8080")).toBe("::1");
    expect(hostnameOf("::1")).toBe("::1");
    expect(hostnameOf("localhost.")).toBe("localhost");
    expect(hostnameOf("")).toBeUndefined();
    expect(hostnameOf("bad host/")).toBeUndefined();
  });
});

describe("isAllowedHostname", () => {
  it("allows loopback names, IP literals, single labels and private top-level names", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "192.168.1.20",
      "::1",
      "fd00::5",
      "mongoshield",
      "console.default.svc.cluster.local",
      "console.ns.svc",
      "vm.us-east1.internal",
      "nas.lan",
      "box.home.arpa",
    ]) {
      expect(isAllowedHostname(host, {}), host).toBe(true);
    }
  });

  it("refuses public names that would let a DNS rebinding page in", () => {
    expect(isAllowedHostname("attacker.example", {})).toBe(false);
    expect(isAllowedHostname("127.0.0.1.nip.io", {})).toBe(false);
    expect(isAllowedHostname("backups.example.com", {})).toBe(false);
  });

  it("allows the public URL's host and MONGOSHIELD_ALLOWED_HOSTS entries", () => {
    const policy = {
      publicUrl: "https://backups.example.com/mongoshield",
      allowedHosts: ["ops.example.org", "*.corp.example.net"],
    };
    expect(isAllowedHostname("backups.example.com", policy)).toBe(true);
    expect(isAllowedHostname("ops.example.org", policy)).toBe(true);
    expect(isAllowedHostname("a.corp.example.net", policy)).toBe(true);
    expect(isAllowedHostname("corp.example.net", policy)).toBe(false);
    expect(isAllowedHostname("evilcorp.example.net", policy)).toBe(false);
    expect(isAllowedHostname("attacker.example", policy)).toBe(false);
    expect(isAllowedHostname("attacker.example", { allowedHosts: ["*"] })).toBe(true);
  });

  it("checks MONGOSHIELD_ALLOWED_HOSTS entries", () => {
    expect(isValidAllowedHostEntry("backups.example.com")).toBe(true);
    expect(isValidAllowedHostEntry("*.example.com")).toBe(true);
    expect(isValidAllowedHostEntry("*")).toBe(true);
    expect(isValidAllowedHostEntry("https://backups.example.com")).toBe(false);
    expect(isValidAllowedHostEntry("*example.com")).toBe(false);
  });
});

describe("trusted proxies", () => {
  it("parses addresses and CIDR ranges, and names a bad entry", () => {
    const list = proxies("10.0.0.0/8", "192.0.2.5", "fd00::/8");
    expect(isTrustedProxy("10.1.2.3", list)).toBe(true);
    expect(isTrustedProxy("::ffff:10.1.2.3", list)).toBe(true);
    expect(isTrustedProxy("192.0.2.5", list)).toBe(true);
    expect(isTrustedProxy("fd12::1", list)).toBe(true);
    expect(isTrustedProxy("192.0.2.6", list)).toBe(false);
    expect(parseTrustedProxies(["10.0.0.0/33"])).toEqual({ ok: false, bad: "10.0.0.0/33" });
    expect(parseTrustedProxies(["proxy.local"])).toEqual({ ok: false, bad: "proxy.local" });
  });

  it("takes the right-most forwarded address that is not a trusted proxy", () => {
    const list = proxies("10.0.0.0/8");
    // The client may prepend anything; only what the trusted proxies appended counts.
    expect(forwardedClientAddress("1.1.1.1, 198.51.100.7", "10.0.0.2", list)).toBe("198.51.100.7");
    expect(forwardedClientAddress("198.51.100.7, 10.0.0.9", "10.0.0.2", list)).toBe("198.51.100.7");
    expect(forwardedClientAddress(undefined, "10.0.0.2", list)).toBe("10.0.0.2");
    expect(forwardedClientAddress("not-an-ip", "10.0.0.2", list)).toBe("10.0.0.2");
  });
});

describe("basePathOf", () => {
  it("is the public URL's path without the trailing slash", () => {
    expect(basePathOf(undefined)).toBe("");
    expect(basePathOf("https://backups.example.com")).toBe("");
    expect(basePathOf("https://example.com/mongoshield/")).toBe("/mongoshield");
    expect(basePathOf("https://example.com/ops/mongoshield")).toBe("/ops/mongoshield");
  });
});
