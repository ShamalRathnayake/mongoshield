/**
 * Tests for the network-target guard: metadata and link-local hosts, Azure's managed
 * identity with foreign endpoints, and connection strings using the workload identity.
 */

import { describe, expect, it } from "vitest";
import {
  unsafeConnectionUriReason,
  unsafeHostReason,
  unsafeManagedIdentityEndpointReason,
  unsafeWebhookReason,
} from "./network-targets.ts";

describe("unsafeHostReason", () => {
  it("refuses cloud metadata services and link-local addresses, in any spelling", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://0xA9FEA9FE/",
      "http://[fd00:ec2::254]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[fe80::1]/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.100.100.200/",
      "http://0.0.0.0:8080/",
    ]) {
      expect(unsafeHostReason(new URL(url).hostname), url).toBeDefined();
    }
  });

  it("allows ordinary hosts, private networks and loopback", () => {
    for (const host of [
      "hooks.slack.com",
      "10.0.0.5",
      "minio.internal",
      "localhost",
      "127.0.0.1",
    ]) {
      expect(unsafeHostReason(host), host).toBeUndefined();
    }
  });
});

describe("unsafeWebhookReason", () => {
  it("refuses metadata URLs unless unsafe targets are allowed", () => {
    expect(unsafeWebhookReason("http://169.254.169.254/", false)).toMatch(/metadata/);
    expect(unsafeWebhookReason("http://169.254.169.254/", true)).toBeUndefined();
    expect(unsafeWebhookReason("https://hooks.slack.com/services/x", false)).toBeUndefined();
  });
});

describe("unsafeManagedIdentityEndpointReason", () => {
  it("allows only Azure Storage domains for the console's own identity", () => {
    expect(unsafeManagedIdentityEndpointReason("acct.blob.core.windows.net")).toBeUndefined();
    expect(unsafeManagedIdentityEndpointReason("acct.blob.core.chinacloudapi.cn")).toBeUndefined();
    expect(unsafeManagedIdentityEndpointReason("attacker.example")).toMatch(/token/);
    expect(unsafeManagedIdentityEndpointReason("core.windows.net.attacker.example")).toBeDefined();
  });
});

describe("unsafeConnectionUriReason", () => {
  it("refuses MONGODB-OIDC with an ENVIRONMENT property, whatever the case", () => {
    const uri =
      "mongodb://attacker.example/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s";
    expect(unsafeConnectionUriReason(uri, false)).toMatch(/workload identity/);
    expect(
      unsafeConnectionUriReason(
        "mongodb+srv://x.example.net/?authmechanism=mongodb-oidc&AUTHMECHANISMPROPERTIES=TOKEN_RESOURCE:api%3A%2F%2Fx,ENVIRONMENT:azure",
        false,
      ),
    ).toBeDefined();
    expect(unsafeConnectionUriReason(uri, true)).toBeUndefined();
  });

  it("allows ordinary connection strings, including MONGODB-AWS and TLS files", () => {
    expect(
      unsafeConnectionUriReason("mongodb://user:pw@db.example.com/app", false),
    ).toBeUndefined();
    expect(
      unsafeConnectionUriReason(
        "mongodb://db.example.com/?authMechanism=MONGODB-AWS&tls=true&tlsCAFile=/ca.pem",
        false,
      ),
    ).toBeUndefined();
  });
});
