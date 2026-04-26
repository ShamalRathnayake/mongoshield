import { MongoClient } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../../src/db/ConnectionManager";

const { mockConnect, mockClose } = vi.hoisted(() => ({
  mockConnect: vi.fn().mockResolvedValue(undefined),
  mockClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("mongodb", () => {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: Mock implementation needs any for constructor binding
    MongoClient: vi.fn().mockImplementation(function (this: any) {
      return {
        connect: mockConnect,
        close: mockClose,
        db: vi.fn().mockReturnValue({}),
      };
    }),
  };
});

describe("ConnectionManager", () => {
  const defaultConfig = { host: "localhost", port: 27017 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects to localhost by default", async () => {
    const manager = new ConnectionManager(defaultConfig);
    const client = await manager.connect();

    expect(MongoClient).toHaveBeenCalledWith("mongodb://localhost:27017", {});
    expect(client.connect).toHaveBeenCalled();
  });

  it("constructs URI with credentials correctly", async () => {
    const config = {
      ...defaultConfig,
      username: "admin",
      password: "password123",
    };
    const manager = new ConnectionManager(config);
    await manager.connect();

    expect(MongoClient).toHaveBeenCalledWith(
      "mongodb://admin:password123@localhost:27017",
      expect.any(Object),
    );
  });

  it("encodes credentials in URI", async () => {
    const config = {
      ...defaultConfig,
      username: "user@name",
      password: "pass/word",
    };
    const manager = new ConnectionManager(config);
    await manager.connect();

    expect(MongoClient).toHaveBeenCalledWith(
      "mongodb://user%40name:pass%2Fword@localhost:27017",
      expect.any(Object),
    );
  });

  it("adds authentication parameters to query string", async () => {
    const config = {
      ...defaultConfig,
      authenticationDatabase: "admin",
      authenticationMechanism: "SCRAM-SHA-256" as const,
    };
    const manager = new ConnectionManager(config);
    await manager.connect();

    // biome-ignore lint/suspicious/noExplicitAny: Mock inspection
    const uri = (MongoClient as any).mock.calls[0][0];
    expect(uri).toContain("authSource=admin");
    expect(uri).toContain("authMechanism=SCRAM-SHA-256");
  });

  it("passes TLS and connection options correctly", async () => {
    const config = {
      ...defaultConfig,
      tls: true,
      tlsCAFile: "/ca.pem",
      tlsCertificateKeyFile: "/cert.pem",
      tlsAllowInvalidCertificates: true,
      directConnection: true,
    };
    const manager = new ConnectionManager(config);
    await manager.connect();

    // biome-ignore lint/suspicious/noExplicitAny: Mock inspection
    const options = (MongoClient as any).mock.calls[0][1];
    expect(options.tls).toBe(true);
    expect(options.tlsCAFile).toBe("/ca.pem");
    expect(options.tlsCertificateKeyFile).toBe("/cert.pem");
    expect(options.tlsAllowInvalidCertificates).toBe(true);
    expect(options.directConnection).toBe(true);
  });

  it("passes tlsCertificateKeyFilePassword correctly", async () => {
    const config = {
      ...defaultConfig,
      tlsCertificateKeyFilePassword: "secretpassword",
    };
    const manager = new ConnectionManager(config);
    await manager.connect();

    // biome-ignore lint/suspicious/noExplicitAny: Mock inspection
    const options = (MongoClient as any).mock.calls[0][1];
    expect(options.tlsCertificateKeyFilePassword).toBe("secretpassword");
  });

  it("reuses the same client on multiple connect() calls", async () => {
    const manager = new ConnectionManager(defaultConfig);
    const client1 = await manager.connect();
    const client2 = await manager.connect();

    expect(client1).toBe(client2);
    expect(MongoClient).toHaveBeenCalledTimes(1);
  });

  it("getClient() throws if not connected", () => {
    const manager = new ConnectionManager(defaultConfig);
    expect(() => manager.getClient()).toThrow("Call connect() first");
  });

  it("getClient() returns client after connection", async () => {
    const manager = new ConnectionManager(defaultConfig);
    const client = await manager.connect();
    expect(manager.getClient()).toBe(client);
  });

  it("disconnects and clears the client", async () => {
    const manager = new ConnectionManager(defaultConfig);
    const client = await manager.connect();

    await manager.disconnect();
    expect(client.close).toHaveBeenCalled();
    expect(() => manager.getClient()).toThrow();
  });

  it("disconnect() is safe to call when not connected", async () => {
    const manager = new ConnectionManager(defaultConfig);
    await expect(manager.disconnect()).resolves.toBeUndefined();
  });
});
