/**
 * Tests for storage locations: URL schemes, the input checks that run before a
 * location is saved, local paths confined to the data directory, and the
 * adapter registry (caching, rebuilding on change, closing).
 *
 * Cloud adapters are only constructed, never used: their SDKs connect lazily,
 * so building one needs no network.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMongoShieldError } from "mongoshield";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageRecord } from "../state/types.ts";
import {
  azureAuthOf,
  checkStorageInput,
  localPathOf,
  StorageRegistry,
  storageSchemeOf,
} from "./storage.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-storage-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A storage record with the fields the registry reads. */
function record(url: string, updatedAt = "2026-01-01T00:00:00.000Z", id = "s1"): StorageRecord {
  return { id, name: id, url, createdAt: updatedAt, updatedAt };
}

/** A complete (signed) Azure SAS token credential. */
const SIGNED_SAS: Readonly<Record<string, string>> = {
  AZURE_STORAGE_SAS_TOKEN: "sv=2024-01-01&sp=rwdl&sig=c2VjcmV0",
};

/** Expects `action` to throw `MS_CONFIG_INVALID` with a message matching `pattern`. */
function expectConfigError(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(error instanceof Error ? error.message : "").toMatch(pattern);
    return;
  }
  throw new Error("expected a MS_CONFIG_INVALID error");
}

describe("storageSchemeOf", () => {
  it("recognises the supported schemes case-insensitively and treats bare paths as files", () => {
    expect(storageSchemeOf("s3://bucket/prefix")).toBe("s3");
    expect(storageSchemeOf("GS://bucket")).toBe("gs");
    expect(storageSchemeOf("memory://x")).toBe("memory");
    expect(storageSchemeOf("backups/nightly")).toBe("file");
    expect(storageSchemeOf("/data/backups")).toBe("file");
  });

  it("refuses an unknown scheme with a hint listing the supported ones", () => {
    expectConfigError(() => storageSchemeOf("ftp://host/x"), /Unsupported storage URL scheme/);
  });
});

describe("checkStorageInput", () => {
  it("accepts local directories inside the data directory and memory stores", () => {
    expect(() => checkStorageInput("backups", {}, dataDir)).not.toThrow();
    expect(() => checkStorageInput("memory://test", {}, dataDir)).not.toThrow();
  });

  it("refuses credentials inside a cloud URL", () => {
    expectConfigError(
      () => checkStorageInput("s3://key:secret@bucket/prefix", {}, dataDir),
      /must not contain credentials/,
    );
    expectConfigError(
      () => checkStorageInput("az://user@account/container", {}, dataDir),
      /must not contain credentials/,
    );
  });

  it("allows a user name, but not a password, in an sftp URL", () => {
    expect(() => checkStorageInput("sftp://backup@host/path", {}, dataDir)).not.toThrow();
    expectConfigError(
      () => checkStorageInput("sftp://backup:pw@host/path", {}, dataDir),
      /must not contain credentials/,
    );
  });

  it("refuses credential names the scheme does not use, with the allowed names as a hint", () => {
    expectConfigError(
      () => checkStorageInput("s3://bucket", { AWS_SECRET: "x" }, dataDir),
      /"AWS_SECRET" is not a credential for s3 storage/,
    );
    expectConfigError(
      () => checkStorageInput("memory://x", { ANYTHING: "x" }, dataDir),
      /not a credential for memory storage/,
    );
    expect(() =>
      checkStorageInput(
        "s3://bucket",
        { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" },
        dataDir,
      ),
    ).not.toThrow();
  });

  it("refuses a URL that cannot be parsed", () => {
    expectConfigError(() => checkStorageInput("s3://[broken", {}, dataDir), /Invalid storage URL/);
  });

  it("refuses a SAS token (or any query) in the endpoint, pointing to the credential instead", () => {
    const sas = encodeURIComponent("https://acct.blob.core.windows.net/?sv=2024&sig=abc");
    expectConfigError(
      () => checkStorageInput(`az://acct/container?endpoint=${sas}`, {}, dataDir),
      /must not contain credentials or a query string/,
    );
    try {
      checkStorageInput(`az://acct/container?endpoint=${sas}`, {}, dataDir);
    } catch (error) {
      expect(isMongoShieldError(error) ? error.hint : "").toMatch(/AZURE_STORAGE_SAS_TOKEN/);
    }
    // The token is a credential of its own now.
    checkStorageInput("az://acct/container", SIGNED_SAS, dataDir);
  });

  it("refuses metadata endpoints, unless unsafe targets are allowed", () => {
    const url = `s3://bucket?endpoint=${encodeURIComponent("http://169.254.169.254/")}`;
    expectConfigError(
      () => checkStorageInput(url, { AWS_ACCESS_KEY_ID: "AKIA" }, dataDir),
      /metadata/,
    );
    checkStorageInput(url, { AWS_ACCESS_KEY_ID: "AKIA" }, dataDir, { allowUnsafeTargets: true });
    // A private MinIO is fine.
    checkStorageInput(
      `s3://bucket?endpoint=${encodeURIComponent("http://10.0.0.5:9000")}`,
      {},
      dataDir,
    );
  });

  it("keeps Azure's managed identity on Azure endpoints", () => {
    const foreign = `az://acct/container?endpoint=${encodeURIComponent("https://attacker.example")}`;
    expectConfigError(() => checkStorageInput(foreign, {}, dataDir), /own Azure identity/);
    // With stored credentials no identity of the console is involved.
    checkStorageInput(foreign, SIGNED_SAS, dataDir);
    checkStorageInput(foreign, {}, dataDir, { allowUnsafeTargets: true });
    checkStorageInput(
      `az://acct/container?endpoint=${encodeURIComponent("https://acct.blob.core.windows.net")}`,
      {},
      dataDir,
    );
  });

  it("judges the managed-identity rule on usable credentials, not on stored names", () => {
    const foreign = `az://acct/container?endpoint=${encodeURIComponent("https://attacker.example")}`;
    // Each of these is stored under a real credential name but would not be used, so the
    // library would fall back to the console's identity and send its token to the host.
    const unusable: Readonly<Record<string, string>>[] = [
      { AZURE_STORAGE_SAS_TOKEN: "" },
      { AZURE_STORAGE_SAS_TOKEN: "   " },
      { AZURE_STORAGE_SAS_TOKEN: "sv=2024-01-01&sp=rwdl" },
      { AZURE_STORAGE_SAS_TOKEN: "?sv=2024-01-01&sig=" },
      { AZURE_STORAGE_CONNECTION_STRING: "" },
      { AZURE_STORAGE_CONNECTION_STRING: " ", AZURE_STORAGE_SAS_TOKEN: "sv=1" },
    ];
    for (const credentials of unusable) {
      expectConfigError(
        () => checkStorageInput(foreign, credentials, dataDir),
        /own Azure identity/,
      );
      // Even on an Azure endpoint (or with unsafe targets allowed) they are a mistake.
      expectConfigError(
        () => checkStorageInput("az://acct/container", credentials, dataDir),
        /stored Azure credentials cannot be used/,
      );
      expectConfigError(
        () => checkStorageInput(foreign, credentials, dataDir, { allowUnsafeTargets: true }),
        /stored Azure credentials cannot be used/,
      );
    }
    // A connection string, or a SAS token with a leading "?", is usable.
    checkStorageInput(foreign, { AZURE_STORAGE_CONNECTION_STRING: "AccountName=a" }, dataDir);
    checkStorageInput(foreign, { AZURE_STORAGE_SAS_TOKEN: "?sv=1&sig=abc" }, dataDir);
  });
});

describe("azureAuthOf", () => {
  it("prefers a connection string, then a signed SAS token, then the managed identity", () => {
    expect(azureAuthOf({ AZURE_STORAGE_CONNECTION_STRING: " cs ", ...SIGNED_SAS })).toEqual({
      kind: "connectionString",
      connectionString: "cs",
    });
    expect(azureAuthOf({ AZURE_STORAGE_SAS_TOKEN: " ?sv=1&sig=abc " })).toEqual({
      kind: "sas",
      sasToken: "sv=1&sig=abc",
    });
    expect(azureAuthOf({})).toEqual({ kind: "managedIdentity" });
    expect(azureAuthOf({ AZURE_STORAGE_SAS_TOKEN: "sv=1&se=2030" })).toEqual({
      kind: "managedIdentity",
    });
  });
});

describe("localPathOf", () => {
  it("resolves relative paths and file URLs inside the data directory", () => {
    expect(localPathOf("backups", dataDir)).toBe(join(dataDir, "backups"));
    expect(localPathOf(`file://${join(dataDir, "nightly")}`, dataDir)).toBe(
      join(dataDir, "nightly"),
    );
  });

  it("refuses the data directory itself and anything outside it", () => {
    expectConfigError(() => localPathOf(".", dataDir), /inside the data directory/);
    expectConfigError(() => localPathOf("../elsewhere", dataDir), /inside the data directory/);
    expectConfigError(() => localPathOf("/etc", dataDir), /inside the data directory/);
  });

  it("refuses a file URL with a remote host", () => {
    expectConfigError(() => localPathOf("file://server/share", dataDir), /Invalid file URL/);
  });

  it("refuses the console's own files and the live edit journal inside the data directory", () => {
    for (const path of [
      "live-journal",
      "live-journal/sub",
      "Live-Journal",
      "console.json",
      "audit.jsonl.1",
      "secret.key",
      "console.lock",
      `file://${join(dataDir, "live-journal")}`,
    ]) {
      expectConfigError(() => localPathOf(path, dataDir), /belongs to the console itself/);
    }
    expect(localPathOf("backups/live-journal", dataDir)).toBe(
      join(dataDir, "backups/live-journal"),
    );
    expect(localPathOf("console-backups", dataDir)).toBe(join(dataDir, "console-backups"));
  });
});

describe("StorageRegistry", () => {
  const noCredentials = (): Readonly<Record<string, string>> => ({});

  it("caches one adapter per location until the record changes", async () => {
    const registry = new StorageRegistry({ dataDir, credentialsOf: noCredentials });
    const first = await registry.adapterFor(record("backups"));
    expect(first.kind).toBe("file");
    expect(await registry.adapterFor(record("backups"))).toBe(first);

    const changed = await registry.adapterFor(record("other", "2026-02-01T00:00:00.000Z"));
    expect(changed).not.toBe(first);
    await registry.closeAll();
  });

  it("builds a fresh adapter after forget() and keeps memory stores' contents", async () => {
    const registry = new StorageRegistry({ dataDir, credentialsOf: noCredentials });
    const url = `memory://registry-${Date.now()}`;
    const memory = await registry.adapterFor(record(url));
    await memory.put("probe.txt", Buffer.from("kept"));
    await registry.forget("s1");
    // Forgetting an unknown id is harmless.
    await registry.forget("unknown");
    const again = await registry.adapterFor(record(url));
    expect(again.kind).toBe("memory");
    const chunks: Buffer[] = [];
    for await (const chunk of await again.get("probe.txt")) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("kept");
    await registry.closeAll();
  });

  it("passes stored credentials to the cloud adapters", async () => {
    const credentials: Record<string, Readonly<Record<string, string>>> = {
      s3: {
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "token",
      },
      gs: { GOOGLE_CREDENTIALS_JSON: JSON.stringify({ type: "service_account" }) },
      az: {
        AZURE_STORAGE_CONNECTION_STRING:
          "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;EndpointSuffix=core.windows.net",
      },
      sftp: { SFTP_PRIVATE_KEY: "-----BEGIN KEY-----", SFTP_PASSPHRASE: "pw" },
      memory: { UNUSED: "x" },
    };
    const registry = new StorageRegistry({
      dataDir,
      credentialsOf: (storage) => credentials[storageSchemeOf(storage.url)] ?? {},
    });
    // A query string turns "+" into a space; the registry turns it back (base64 uses "+").
    const fingerprint = `SHA256:${Buffer.alloc(32, 0xfb).toString("base64").replace(/=+$/, "")}`;
    const urls = [
      "s3://bucket/prefix?region=eu-west-1&endpoint=http://127.0.0.1:9&forcePathStyle=true",
      "gs://bucket/prefix?projectId=demo",
      "az://acct/container/some/prefix",
      `sftp://backup@[::1]:2222/~/backups?fingerprint=${fingerprint}&allowUnknownHostKey=true`,
      `memory://creds-${Date.now()}`,
    ];
    const kinds: string[] = [];
    for (const [index, url] of urls.entries()) {
      kinds.push((await registry.adapterFor(record(url, undefined, `s${index}`))).kind);
    }
    expect(kinds).toEqual(["s3", "gcs", "azure", "sftp", "memory"]);
    await registry.closeAll();
  });

  it("builds cloud adapters from the default credential chain when none are stored", async () => {
    const registry = new StorageRegistry({ dataDir, credentialsOf: noCredentials });
    expect((await registry.adapterFor(record("s3://bucket"))).kind).toBe("s3");
    await registry.closeAll();
  });

  it("uses the account URL for Azure when there is no connection string", async () => {
    const registry = new StorageRegistry({
      dataDir,
      // A signed SAS token takes the explicit-adapter path with the endpoint as account URL.
      credentialsOf: (storage) => (storage.url.startsWith("az:") ? SIGNED_SAS : { OTHER: "x" }),
    });
    const adapter = await registry.adapterFor(
      record("az://acct/container?endpoint=http://127.0.0.1:10000/acct"),
    );
    expect(adapter.kind).toBe("azure");
    const s3 = await registry.adapterFor(record("s3://bucket/p", undefined, "s2"));
    expect(s3.kind).toBe("s3");
    await registry.closeAll();
  });

  it("refuses stored Azure credentials that would fall back to the console's own identity", async () => {
    // Records saved before empty values were refused can still hold such credentials.
    for (const credentials of [
      { AZURE_STORAGE_SAS_TOKEN: "" },
      { AZURE_STORAGE_SAS_TOKEN: "sv=2024-01-01" },
      { AZURE_STORAGE_CONNECTION_STRING: "" },
      { OTHER: "x" },
    ]) {
      const registry = new StorageRegistry({ dataDir, credentialsOf: () => credentials });
      await expect(
        registry.adapterFor(record("az://acct/container?endpoint=https://attacker.example")),
      ).rejects.toThrow(/stored Azure credentials cannot be used/);
    }
  });

  it("passes an Azure SAS token credential on as the account URL's query string", async () => {
    const registry = new StorageRegistry({
      dataDir,
      credentialsOf: () => ({ AZURE_STORAGE_SAS_TOKEN: "?sv=2024-01-01&sig=c2VjcmV0" }),
    });
    const adapter = await registry.adapterFor(record("az://acct/container/prefix"));
    expect(adapter.kind).toBe("azure");
    // The location the adapter reports never shows the token.
    expect(adapter.location).not.toContain("sig=");
    await registry.closeAll();
  });

  it("explains a malformed Google service account key", async () => {
    const registry = new StorageRegistry({
      dataDir,
      credentialsOf: () => ({ GOOGLE_CREDENTIALS_JSON: "{ not json" }),
    });
    await expect(registry.adapterFor(record("gs://bucket"))).rejects.toThrow(
      /GOOGLE_CREDENTIALS_JSON is not valid JSON/,
    );
  });

  it("refuses local storage outside the data directory before the library sees it", async () => {
    const registry = new StorageRegistry({ dataDir, credentialsOf: noCredentials });
    await expect(registry.adapterFor(record("../outside"))).rejects.toThrow(
      /inside the data directory/,
    );
  });
});
