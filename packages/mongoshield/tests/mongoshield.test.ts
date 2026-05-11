import { describe, expect, it } from "vitest";
import { MongoShield, VERSION } from "../src/index";

describe("mongoshield wrapper package", () => {
  const mockStorage = {
    initialize: async () => { },
    createBsonWriteStream: async () => ({} as any),
    createMetadataWriteStream: async () => ({} as any),
    finalize: async () => { },
    prune: async () => ({ deletedCount: 0, deletedPaths: [] }),
    on: () => mockStorage as any,
  };

  describe("MongoShield class", () => {
    it("should instantiate successfully with valid options", () => {
      const shield = new MongoShield({
        config: {
          connection: { host: "localhost", port: 27017 },
          target: { dbName: "test" },
          output: { outPath: "dump", gzip: false, numParallelCollections: 4, oplog: false }
        },
        storage: mockStorage as any
      });
      expect(shield).toBeDefined();
      expect(shield).toBeInstanceOf(MongoShield);
    });

    it("should throw an error with invalid configuration", () => {
      expect(() => new MongoShield({
        // @ts-ignore
        config: { connection: { host: 123 } },
        storage: mockStorage as any
      })).toThrow("MongoShield Configuration Error");
    });
  });

  describe("re-exports from @mongoshield/core", () => {
    it("should re-export the VERSION constant from core", () => {
      expect(VERSION).toBeDefined();
      expect(typeof VERSION).toBe("string");
    });
  });
});
