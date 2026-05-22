import { PassThrough } from "node:stream";
import * as streamPromises from "node:stream/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackupEngine } from "../../../src/core/BackupEngine";
import { ConnectionManager } from "../../../src/db/ConnectionManager";
import type { StorageProvider } from "../../../src/providers/StorageProvider";
import { EncryptionTransform } from "../../../src/streams/EncryptionStream";

// Mock dependencies
vi.mock("../../../src/db/ConnectionManager");
vi.mock("../../../src/streams/BSONEncoderStream");
vi.mock("../../../src/streams/EncryptionStream");
vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

describe("BackupEngine", () => {
  let mockStorage: StorageProvider;
  let mockDb: any;
  let mockClient: any;
  let config: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStorage = {
      initialize: vi.fn().mockResolvedValue(undefined),
      finalize: vi.fn().mockResolvedValue(undefined),
      createBsonWriteStream: vi
        .fn()
        .mockImplementation(() => Promise.resolve(new PassThrough())),
      createMetadataWriteStream: vi
        .fn()
        .mockImplementation(() => Promise.resolve(new PassThrough())),
    } as any;

    mockDb = {
      admin: vi.fn().mockReturnValue({
        listDatabases: vi.fn().mockResolvedValue({
          databases: [
            { name: "admin", sizeOnDisk: 100 },
            { name: "testdb", sizeOnDisk: 1000 },
            { name: "otherdb", sizeOnDisk: 2000 },
          ],
        }),
      }),
      stats: vi.fn().mockResolvedValue({ dataSize: 500 }),
      listCollections: vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { name: "users", type: "collection" },
          { name: "logs", type: "collection" },
          { name: "temp_data", type: "collection" },
          { name: "user_view", type: "view" },
        ]),
      }),
      collection: vi.fn().mockReturnValue({
        indexes: vi.fn().mockResolvedValue([{ name: "_id_" }]),
        find: vi.fn().mockReturnValue({
          batchSize: vi.fn().mockReturnThis(),
          stream: vi.fn().mockReturnValue(new PassThrough()),
        }),
      }),
    };

    mockClient = {
      db: vi.fn().mockImplementation((_name?: string) => mockDb),
    };

    (ConnectionManager.prototype.connect as any).mockResolvedValue(mockClient);
    (ConnectionManager.prototype.disconnect as any).mockResolvedValue(
      undefined,
    );

    config = {
      connection: { host: "localhost", port: 27017 },
      target: { dbName: "testdb" },
      output: { outPath: "dump", numParallelCollections: 2 },
    };
  });

  describe("getTargetCollections", () => {
    it("filters views by default", async () => {
      const engine = new BackupEngine(config, mockStorage);
      const targets = await engine.getTargetCollections(mockDb);
      expect(targets).toHaveLength(3);
      expect(targets.find((t) => t.name === "user_view")).toBeUndefined();
    });

    it("includes views if viewsAsCollections is true", async () => {
      config.target.viewsAsCollections = true;
      const engine = new BackupEngine(config, mockStorage);
      const targets = await engine.getTargetCollections(mockDb);
      expect(targets).toHaveLength(4);
    });

    it("respects explicit collections inclusion", async () => {
      config.target.collections = ["users"];
      const engine = new BackupEngine(config, mockStorage);
      const targets = await engine.getTargetCollections(mockDb);
      expect(targets).toHaveLength(1);
      expect(targets[0].name).toBe("users");
    });

    it("respects explicit exclusions", async () => {
      config.target.excludeCollections = ["logs"];
      const engine = new BackupEngine(config, mockStorage);
      const targets = await engine.getTargetCollections(mockDb);
      expect(targets.find((t) => t.name === "logs")).toBeUndefined();
      expect(targets).toHaveLength(2);
    });

    it("respects prefix exclusions", async () => {
      config.target.excludeCollectionsWithPrefix = ["temp_"];
      const engine = new BackupEngine(config, mockStorage);
      const targets = await engine.getTargetCollections(mockDb);
      expect(targets.find((t) => t.name === "temp_data")).toBeUndefined();
    });
  });

  describe("run", () => {
    it("executes full cluster backup when dbName is missing", async () => {
      delete config.target.dbName;
      const engine = new BackupEngine(config, mockStorage);
      await engine.run();

      expect(mockStorage.initialize).toHaveBeenCalledWith(3000); // 1000 + 2000, skips admin
      expect(mockStorage.createMetadataWriteStream).toHaveBeenCalled();
    });

    it("executes full backup workflow", async () => {
      const engine = new BackupEngine(config, mockStorage);
      await engine.run();

      expect(ConnectionManager.prototype.connect).toHaveBeenCalled();
      expect(mockStorage.initialize).toHaveBeenCalled();
      expect(mockStorage.createMetadataWriteStream).toHaveBeenCalledTimes(3);
      expect(mockStorage.createBsonWriteStream).toHaveBeenCalledTimes(3);
      expect(mockStorage.finalize).toHaveBeenCalled();
      expect(ConnectionManager.prototype.disconnect).toHaveBeenCalled();
    });

    it("handles GZIP and Encryption options in pipeline", async () => {
      config.output.gzip = true;
      config.output.encryptionKey = "a".repeat(64);
      config.target.readPreference = "secondary";
      config.output.batchSize = 1000;

      const engine = new BackupEngine(config, mockStorage);
      await engine.run();

      expect(mockDb.collection().find).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          readPreference: "secondary",
        }),
      );

      // Verify pipeline was called with Gzip and Encryption transform
      const calls = (streamPromises.pipeline as any).mock.calls;
      expect(calls.length).toBe(3); // 3 collections

      // Each pipeline should have: readStream, bsonEncoder, gzip, encryption, writeStream
      expect(calls[0].length).toBe(5);
      expect(EncryptionTransform).toHaveBeenCalled();
    });

    it("handles metadata extraction failure gracefully (e.g. views)", async () => {
      mockDb.collection.mockReturnValueOnce({
        indexes: vi.fn().mockRejectedValue(new Error("No indexes for view")),
      });

      const engine = new BackupEngine(config, mockStorage);
      // We force only one collection to test the failure
      config.target.collections = ["users"];

      await expect(engine.run()).resolves.toBeUndefined();
    });

    it("calculates expectedSizeInBytes for single DB", async () => {
      config.target.dbName = "testdb";
      const engine = new BackupEngine(config, mockStorage);
      await engine.run();
      expect(mockStorage.initialize).toHaveBeenCalledWith(500);
    });

    it("falls back to 0 size if stats fails", async () => {
      mockDb.stats.mockRejectedValueOnce(new Error("Unauthorized"));
      config.target.dbName = "testdb";
      const engine = new BackupEngine(config, mockStorage);
      await engine.run();
      expect(mockStorage.initialize).toHaveBeenCalledWith(0);
    });

    it("uses default concurrency if numParallelCollections is missing", async () => {
      delete config.output.numParallelCollections;
      const engine = new BackupEngine(config, mockStorage);
      await engine.run();
      expect(mockStorage.finalize).toHaveBeenCalled();
    });

    it("handles missing collection type and options", async () => {
      mockDb.listCollections = vi.fn().mockReturnValue({
        toArray: vi.fn().mockResolvedValue([
          { name: "users" }, // type missing
        ]),
      });

      const engine = new BackupEngine(config, mockStorage);
      await engine.run();

      expect(mockDb.collection).toHaveBeenCalledWith("users");
    });

    it("handles empty listCollections for metadata", async () => {
      mockDb.listCollections = vi
        .fn()
        .mockReturnValueOnce({
          toArray: vi
            .fn()
            .mockResolvedValue([{ name: "users", type: "collection" }]),
        }) // for getTargetCollections
        .mockReturnValueOnce({ toArray: vi.fn().mockResolvedValue([]) }); // for metadata

      const engine = new BackupEngine(config, mockStorage);
      config.target.collections = ["users"];
      await engine.run();
      expect(mockStorage.finalize).toHaveBeenCalled();
    });

    it("handles missing options in metadata extraction", async () => {
      mockDb.listCollections = vi
        .fn()
        .mockReturnValueOnce({
          toArray: vi
            .fn()
            .mockResolvedValue([{ name: "users", type: "collection" }]),
        }) // for getTargetCollections
        .mockReturnValueOnce({
          toArray: vi.fn().mockResolvedValue([{ name: "users" }]),
        }); // for metadata, options missing

      const engine = new BackupEngine(config, mockStorage);
      config.target.collections = ["users"];
      await engine.run();
      expect(mockStorage.finalize).toHaveBeenCalled();
    });
  });
});
