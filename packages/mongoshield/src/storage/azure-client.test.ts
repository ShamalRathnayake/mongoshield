/**
 * How `azureStorage` builds its `ContainerClient` for each way of connecting.
 * The SDK and `@azure/identity` are replaced by recording stubs (in this file's
 * own module registry), so no network or credentials are involved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed: { url: string; credential: unknown }[] = [];

vi.mock("@azure/storage-blob", () => ({
  ContainerClient: class {
    constructor(url: string, credential: unknown) {
      constructed.push({ url, credential });
    }
    getBlobClient() {
      return {
        getProperties: async () => ({ contentLength: 1, lastModified: new Date(0), etag: '"e"' }),
      };
    }
  },
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    readonly kind = "default-azure-credential";
  },
}));

const { azureStorage } = await import("./azure.ts");

describe("azureStorage client construction", () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it("passes a connection string and container name straight to the SDK", async () => {
    const connectionString = "UseDevelopmentStorage=true";
    await azureStorage({ connectionString, container: "backups" }).head("a");
    expect(constructed).toEqual([{ url: connectionString, credential: "backups" }]);
  });

  it("uses DefaultAzureCredential for an account URL without a credential", async () => {
    await azureStorage({
      accountUrl: "https://acct.blob.core.windows.net/",
      container: "backups",
    }).head("a");
    expect(constructed[0]?.url).toBe("https://acct.blob.core.windows.net/backups");
    expect(constructed[0]?.credential).toMatchObject({ kind: "default-azure-credential" });
  });

  it("keeps a SAS token after the container name and needs no credential", async () => {
    await azureStorage({
      accountUrl: "https://acct.blob.core.windows.net?sv=2024&sig=abc",
      container: "backups",
    }).head("a");
    expect(constructed[0]).toEqual({
      url: "https://acct.blob.core.windows.net/backups?sv=2024&sig=abc",
      credential: undefined,
    });
  });

  it("uses an explicit credential when given", async () => {
    const credential = { getToken: async () => null };
    await azureStorage({
      accountUrl: "http://127.0.0.1:10000/devstoreaccount1",
      container: "backups",
      credential,
    }).head("a");
    expect(constructed[0]).toEqual({
      url: "http://127.0.0.1:10000/devstoreaccount1/backups",
      credential,
    });
  });

  it("creates the client once and reuses it", async () => {
    const storage = azureStorage({
      connectionString: "UseDevelopmentStorage=true",
      container: "backups",
    });
    await storage.head("a");
    await storage.head("b");
    expect(constructed).toHaveLength(1);
  });
});
