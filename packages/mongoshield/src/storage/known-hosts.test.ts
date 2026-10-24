/**
 * Tests for known_hosts parsing and matching: plain, wildcard, negated, hashed
 * and `[host]:port` entries, several key types per host, `@revoked` and
 * `@cert-authority` markers, and malformed lines. Entries are generated here
 * from random key blobs, so no real keys are needed.
 */

import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkKnownHost,
  entriesForHost,
  hostKeyAlgorithmsFor,
  knownHostName,
  parseKnownHosts,
} from "./known-hosts.ts";

/** A fake public key blob of a given type: SSH string of the type, then random bytes. */
function keyBlob(type: string): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, randomBytes(32)]);
}

/** `<type> <base64>`: the key part of a known_hosts line. */
function keyField(type: string, blob: Buffer): string {
  return `${type} ${blob.toString("base64")}`;
}

/** A hashed host field as `ssh-keygen -H` writes it. */
function hashedHost(name: string, salt = randomBytes(20)): string {
  const hash = createHmac("sha1", salt).update(name).digest();
  return `|1|${salt.toString("base64")}|${hash.toString("base64")}`;
}

const ED25519 = keyBlob("ssh-ed25519");
const RSA = keyBlob("ssh-rsa");
const ECDSA = keyBlob("ecdsa-sha2-nistp256");
const OTHER = keyBlob("ssh-ed25519");

describe("parseKnownHosts", () => {
  it("skips blank lines, comments, unknown markers and malformed lines", () => {
    const entries = parseKnownHosts(
      [
        "",
        "# a comment",
        `backup.example.com ${keyField("ssh-ed25519", ED25519)} root@backup`,
        "only-a-host",
        "host ssh-ed25519",
        "host ssh-ed25519 not*base64",
        "host ssh-ed25519 ====",
        `@cert-authority *.example.com ${keyField("ssh-ed25519", OTHER)}`,
        `@unknown-marker host ${keyField("ssh-ed25519", OTHER)}`,
        `\tindented.example.com   ${keyField("ssh-rsa", RSA)}  `,
      ].join("\r\n"),
    );
    expect(entries.map((entry) => entry.hosts)).toEqual([
      "backup.example.com",
      "indented.example.com",
    ]);
    expect(entries[0]?.key).toEqual(ED25519);
    expect(entries[1]?.keyType).toBe("ssh-rsa");
  });

  it("keeps @revoked entries, marked as such", () => {
    const [entry] = parseKnownHosts(`@revoked * ${keyField("ssh-rsa", RSA)}`);
    expect(entry).toMatchObject({ marker: "revoked", hosts: "*", keyType: "ssh-rsa" });
  });
});

describe("knownHostName", () => {
  it("writes hosts on port 22 bare and others as [host]:port, lower-cased", () => {
    expect(knownHostName("Backup.Example.com", 22)).toBe("backup.example.com");
    expect(knownHostName("backup.example.com", 2222)).toBe("[backup.example.com]:2222");
    expect(knownHostName("::1", 2222)).toBe("[::1]:2222");
  });
});

describe("checkKnownHost", () => {
  it("trusts a listed key for a plain host name, case-insensitively", () => {
    const entries = parseKnownHosts(`Backup.example.com ${keyField("ssh-ed25519", ED25519)}`);
    expect(checkKnownHost(entries, "backup.EXAMPLE.com", 22, ED25519)).toBe("trusted");
  });

  it("reports a listed host presenting another key as changed", () => {
    const entries = parseKnownHosts(`backup.example.com ${keyField("ssh-ed25519", ED25519)}`);
    expect(checkKnownHost(entries, "backup.example.com", 22, OTHER)).toBe("changed");
  });

  it("reports a host that is not listed as unknown", () => {
    const entries = parseKnownHosts(`backup.example.com ${keyField("ssh-ed25519", ED25519)}`);
    expect(checkKnownHost(entries, "other.example.com", 22, ED25519)).toBe("unknown");
    expect(checkKnownHost([], "backup.example.com", 22, ED25519)).toBe("unknown");
  });

  it("matches comma-separated host lists, e.g. a name and its address", () => {
    const entries = parseKnownHosts(
      `backup.example.com,10.0.0.5 ${keyField("ssh-ed25519", ED25519)}`,
    );
    expect(checkKnownHost(entries, "10.0.0.5", 22, ED25519)).toBe("trusted");
  });

  it("needs [host]:port entries for non-default ports, and ignores them on port 22", () => {
    const entries = parseKnownHosts(
      [
        `[backup.example.com]:2222 ${keyField("ssh-ed25519", ED25519)}`,
        `backup.example.com ${keyField("ssh-ed25519", OTHER)}`,
      ].join("\n"),
    );
    expect(checkKnownHost(entries, "backup.example.com", 2222, ED25519)).toBe("trusted");
    expect(checkKnownHost(entries, "backup.example.com", 2222, OTHER)).toBe("changed");
    expect(checkKnownHost(entries, "backup.example.com", 22, OTHER)).toBe("trusted");
    expect(checkKnownHost(entries, "backup.example.com", 22, ED25519)).toBe("changed");
    expect(checkKnownHost(entries, "backup.example.com", 2200, ED25519)).toBe("unknown");
  });

  it("matches hashed entries for port 22 and for [host]:port", () => {
    const entries = parseKnownHosts(
      [
        `${hashedHost("backup.example.com")} ${keyField("ssh-ed25519", ED25519)}`,
        `${hashedHost("[backup.example.com]:2222")} ${keyField("ssh-rsa", RSA)}`,
      ].join("\n"),
    );
    expect(checkKnownHost(entries, "Backup.example.com", 22, ED25519)).toBe("trusted");
    expect(checkKnownHost(entries, "backup.example.com", 2222, RSA)).toBe("trusted");
    expect(checkKnownHost(entries, "backup.example.com", 2222, ED25519)).toBe("changed");
    expect(checkKnownHost(entries, "other.example.com", 22, ED25519)).toBe("unknown");
  });

  it("ignores hashed entries that are malformed", () => {
    const entries = parseKnownHosts(
      [
        `|1|onlysalt ${keyField("ssh-ed25519", ED25519)}`,
        `|1|c2FsdA==|aGFzaA== ${keyField("ssh-ed25519", ED25519)}`,
      ].join("\n"),
    );
    expect(checkKnownHost(entries, "backup.example.com", 22, ED25519)).toBe("unknown");
  });

  it("accepts any of several key types listed for one host", () => {
    const entries = parseKnownHosts(
      [
        `backup.example.com ${keyField("ssh-ed25519", ED25519)}`,
        `backup.example.com ${keyField("ecdsa-sha2-nistp256", ECDSA)}`,
        `backup.example.com ${keyField("ssh-rsa", RSA)}`,
      ].join("\n"),
    );
    for (const key of [ED25519, ECDSA, RSA]) {
      expect(checkKnownHost(entries, "backup.example.com", 22, key)).toBe("trusted");
    }
    expect(checkKnownHost(entries, "backup.example.com", 22, OTHER)).toBe("changed");
  });

  it("supports * and ? wildcards and ! negations", () => {
    const entries = parseKnownHosts(
      `*.example.com,!evil.example.com,backup-?.internal ${keyField("ssh-ed25519", ED25519)}`,
    );
    expect(checkKnownHost(entries, "db1.example.com", 22, ED25519)).toBe("trusted");
    expect(checkKnownHost(entries, "backup-7.internal", 22, ED25519)).toBe("trusted");
    expect(checkKnownHost(entries, "backup-17.internal", 22, ED25519)).toBe("unknown");
    expect(checkKnownHost(entries, "evil.example.com", 22, ED25519)).toBe("unknown");
    // Regex metacharacters in patterns are literal: "." does not match any character.
    expect(checkKnownHost(entries, "db1Xexample.com", 22, ED25519)).toBe("unknown");
  });

  it("refuses a @revoked key even for a host that lists it", () => {
    const entries = parseKnownHosts(
      [
        `backup.example.com ${keyField("ssh-rsa", RSA)}`,
        `@revoked other.example.com ${keyField("ssh-rsa", RSA)}`,
      ].join("\n"),
    );
    expect(checkKnownHost(entries, "backup.example.com", 22, RSA)).toBe("revoked");
  });

  it("never lets @cert-authority lines vouch for a key", () => {
    const entries = parseKnownHosts(
      `@cert-authority backup.example.com ${keyField("ssh-ed25519", ED25519)}`,
    );
    expect(checkKnownHost(entries, "backup.example.com", 22, ED25519)).toBe("unknown");
  });
});

describe("entriesForHost and hostKeyAlgorithmsFor", () => {
  it("lists the key types known for a host as ssh2 host key algorithms", () => {
    const entries = parseKnownHosts(
      [
        `backup.example.com ${keyField("ssh-rsa", RSA)}`,
        `backup.example.com ${keyField("ecdsa-sha2-nistp256", ECDSA)}`,
        `backup.example.com ${keyField("ssh-rsa", OTHER)}`,
        `@revoked backup.example.com ${keyField("ssh-ed25519", ED25519)}`,
        `other.example.com ${keyField("ssh-ed25519", ED25519)}`,
      ].join("\n"),
    );
    const keyTypes = entriesForHost(entries, "backup.example.com", 22).map(
      (entry) => entry.keyType,
    );
    expect(keyTypes).toEqual(["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-rsa"]);
    expect(hostKeyAlgorithmsFor(keyTypes)).toEqual([
      "rsa-sha2-512",
      "rsa-sha2-256",
      "ssh-rsa",
      "ecdsa-sha2-nistp256",
    ]);
  });

  it("adds nothing for key types ssh2 cannot verify", () => {
    expect(hostKeyAlgorithmsFor(["sk-ssh-ed25519@openssh.com", "ssh-dss"])).toEqual([]);
  });
});
