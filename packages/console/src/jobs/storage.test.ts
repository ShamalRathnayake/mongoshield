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
import { checkStorageInput, localPathOf, StorageRegistry, storageSchemeOf } from "./storage.ts";

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
    expect(() => checkStorageInput("backups", [], dataDir)).not.toThrow();
    expect(() => checkStorageInput("memory://test", [], dataDir)).not.toThrow();
  });

  it("refuses credentials inside a cloud URL", () => {
    expectConfigError(
      () => checkStorageInput("s3://key:secret@bucket/prefix", [], dataDir),
      /must not contain credentials/,
    );
    expectConfigError(
      () => checkStorageInput("az://user@account/container", [], dataDir),
      /must not contain credentials/,
    );
  });

  it("allows a user name, but not a password, in an sftp URL", () => {
    expect(() => checkStorageInput("sftp://backup@host/path", [], dataDir)).not.toThrow();
    expectConfigError(
      () => checkStorageInput("sftp://backup:pw@host/path", [], dataDir),
      /must not contain credentials/,
    );
  });

  it("refuses credential names the scheme does not use, with the allowed names as a hint", () => {
    expectConfigError(
      () => checkStorageInput("s3://bucket", ["AWS_SECRET"], dataDir),
      /"AWS_SECRET" is not a credential for s3 storage/,
    );
    expectConfigError(
      () => checkStorageInput("memory://x", ["ANYTHING"], dataDir),
      /not a credential for memory storage/,
    );
    expect(() =>
      checkStorageInput("s3://bucket", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], dataDir),
    ).not.toThrow();
  });

  it("refuses a URL that cannot be parsed", () => {
    expectConfigError(() => checkStorageInput("s3://[broken", [], dataDir), /Invalid storage URL/);
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
      // A credential is needed to take the explicit-adapter path at all.
      credentialsOf: () => ({ OTHER: "x" }),
    });
    const adapter = await registry.adapterFor(
      record("az://acct/container?endpoint=http://127.0.0.1:10000/acct"),
    );
    expect(adapter.kind).toBe("azure");
    const s3 = await registry.adapterFor(record("s3://bucket/p", undefined, "s2"));
    expect(s3.kind).toBe("s3");
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
