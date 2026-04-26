import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileSystemProvider } from "@mongoshield/provider-local";
import {
  MongoDBContainer,
  type StartedMongoDBContainer,
} from "@testcontainers/mongodb";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BackupConfig } from "../../src/config/index";
import { BackupEngine } from "../../src/core/BackupEngine";

describe("BackupEngine Integration", () => {
  let container: StartedMongoDBContainer;
  let connectionOpts: { host: string; port: number; directConnection: boolean };
  let client: MongoClient;
  const dbName = "testdb";
  const outPath = join(__dirname, "dump_test");

  beforeAll(async () => {
    container = await new MongoDBContainer("mongo:6.0.19")
      .withExposedPorts(27017)
      .start();

    // Explicitly use 127.0.0.1 instead of the auto-generated hostname which sometimes fails on Windows
    const mappedPort = container.getMappedPort(27017);
    connectionOpts = {
      host: "127.0.0.1",
      port: mappedPort,
      directConnection: true,
    };

    const uri = `mongodb://127.0.0.1:${mappedPort}/?directConnection=true`;
    client = new MongoClient(uri);
    await client.connect();

    // Clean up test artifact directory if it exists
    await rm(outPath, { recursive: true, force: true });

    // Seed some mock data
    const db = client.db(dbName);
    await db.dropDatabase();

    await db.collection("users").insertMany([
      { name: "Alice", role: "admin" },
      { name: "Bob", role: "user" },
      { name: "Charlie", role: "guest" },
    ]);
    await db.collection("orders").insertOne({
      id: "ORD-123",
      amount: 50.0,
      status: "completed",
    });
    await db.collection("sys.profile").insertOne({
      op: "query",
      ms: 120,
    });

    // Seed a View
    await db.command({
      create: "active_users",
      viewOn: "users",
      pipeline: [{ $match: { role: "admin" } }],
    });
  }, 120000);

  afterAll(async () => {
    if (client) await client.close();
    if (container) await container.stop();
    await rm(outPath, { recursive: true, force: true });
  });

  it("should stream data, compress via gzip, encrypt via AES, and save to directory structure", async () => {
    const config: BackupConfig = {
      connection: connectionOpts,
      target: { dbName },
      output: {
        outPath,
        gzip: true,
        encryptionKey:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", // 32 bytes hex
        numParallelCollections: 2,
        oplog: false,
      },
    };

    const provider = new FileSystemProvider(outPath, true);
    const engine = new BackupEngine(config, provider);

    await engine.run();

    // Validate output files
    const dbDumpDir = join(outPath, dbName);
    const files = await readdir(dbDumpDir);

    // Expect 6 files: 3 collections (users, orders, sys.profile) * (bson.gz + metadata.json.gz)
    // Views are skipped by default
    expect(files).toContain("users.bson.gz");
    expect(files).toContain("users.metadata.json.gz");
    expect(files).toContain("orders.bson.gz");
    expect(files).toContain("sys.profile.bson.gz");
    expect(files).not.toContain("active_users.bson.gz");

    const stats = await stat(join(dbDumpDir, "users.bson.gz"));
    expect(stats.size).toBeGreaterThan(0); // Ensure the AES+GZIP+BSON pipeline actually wrote data
  });

  it("should handle exclusions and specific queries", async () => {
    const customOutPath = join(__dirname, "dump_test_custom");

    const config: BackupConfig = {
      connection: connectionOpts,
      target: {
        dbName,
        excludeCollections: ["sys.profile"],
        query: { role: "admin" }, // Custom query
      },
      output: {
        outPath: customOutPath,
        gzip: false,
        numParallelCollections: 4,
        oplog: false,
      },
    };

    const provider = new FileSystemProvider(customOutPath, false);
    const engine = new BackupEngine(config, provider);

    await engine.run();

    // Validate output files
    const dbDumpDir = join(customOutPath, dbName);
    const files = await readdir(dbDumpDir);

    expect(files).toContain("users.bson");
    expect(files).toContain("orders.bson");
    expect(files).not.toContain("sys.profile.bson"); // successfully excluded

    // Clean up
    await rm(customOutPath, { recursive: true, force: true });
  });
});
