import { PassThrough, Writable } from "node:stream";
import { Storage } from "@google-cloud/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleProvider } from "../src/GoogleProvider";

vi.mock("@google-cloud/storage", () => {
  const { Writable } = require("node:stream");
  const MockWriteStream = class extends Writable {
    constructor() {
      super({
        write(_chunk: any, _encoding: any, callback: any) {
          callback();
        },
      });
      // automatically finish when end is called
      setTimeout(() => this.emit("finish"), 10);
    }
  };

  const mockFile = {
    createWriteStream: vi.fn(() => new MockWriteStream()),
    delete: vi.fn().mockResolvedValue([{}]),
    metadata: { size: "100" },
  };

  const mockBucket = {
    exists: vi.fn().mockResolvedValue([true]),
    file: vi.fn(() => mockFile),
    getFiles: vi.fn().mockResolvedValue([
      [{ metadata: { size: "100" }, delete: vi.fn().mockResolvedValue([{}]) }], // files
      {}, // query
      { prefixes: [] }, // apiResponse
    ]),
    name: "test-bucket",
  };

  const mockStorage = {
    bucket: vi.fn(() => mockBucket),
  };

  const MockStorage = vi.fn(() => mockStorage);

  return {
    Storage: MockStorage,
  };
});

describe("GoogleProvider", () => {
  let provider: GoogleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GoogleProvider({ bucket: "test-bucket" });
  });

  describe("Initialization", () => {
    it("should successfully verify bucket access", async () => {
      await expect(provider.initialize()).resolves.toBeUndefined();
    });

    it("should throw an error if bucket does not exist", async () => {
      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance.bucket().exists.mockResolvedValueOnce([false]);

      await expect(provider.initialize()).rejects.toThrow(
        "GCS bucket 'test-bucket' does not exist.",
      );
    });

    it("should throw a friendly error if access is forbidden", async () => {
      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance
        .bucket()
        .exists.mockRejectedValueOnce({ code: 403, message: "Forbidden" });

      await expect(provider.initialize()).rejects.toThrow(
        "Access denied to GCS bucket 'test-bucket'",
      );
    });

    it("should rethrow unknown errors", async () => {
      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance
        .bucket()
        .exists.mockRejectedValueOnce(new Error("Unknown error"));

      await expect(provider.initialize()).rejects.toThrow("Unknown error");
    });

    it("should generate a timestamped prefix", async () => {
      await provider.initialize();
      const currentPrefix = (provider as any).currentRunPrefix;
      expect(currentPrefix).toMatch(
        /backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\//,
      );
    });
  });

  describe("Streaming Writes", () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it("should create a BSON write stream", async () => {
      const stream = await provider.createBsonWriteStream("db", "col");
      expect(stream).toBeInstanceOf(PassThrough);
      expect((provider as any).activeUploads.length).toBe(1);

      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      const fileCall = storageInstance.bucket().file.mock.calls[0][0];
      expect(fileCall).toMatch(/backups\/.*\/db\/col\.bson/);
    });

    it("should create a Metadata write stream", async () => {
      const stream = await provider.createMetadataWriteStream("db", "col");
      expect(stream).toBeInstanceOf(PassThrough);

      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      const fileCall = storageInstance.bucket().file.mock.calls[0][0];
      expect(fileCall).toMatch(/backups\/.*\/db\/col\.metadata\.json/);
    });

    it("should create an Archive write stream", async () => {
      const stream = await provider.createArchiveWriteStream("backup.msaf");
      expect(stream).toBeInstanceOf(PassThrough);

      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      const fileCall = storageInstance.bucket().file.mock.calls[0][0];
      expect(fileCall).toMatch(/backups\/.*\/backup\.msaf/);
    });

    it("should append .gz to Archive streams if compression is enabled", async () => {
      const compressedProvider = new GoogleProvider({
        bucket: "test-bucket",
        compress: true,
      });
      await compressedProvider.initialize();

      const stream =
        await compressedProvider.createArchiveWriteStream("backup.msaf");
      expect(stream).toBeInstanceOf(PassThrough);

      // Because we created a new provider, we need to look at the mock results for that instance
      // The vi.clearAllMocks() in beforeEach doesn't apply here, this test added a new call to Storage constructor
      const storageInstance = vi.mocked(Storage).mock.results[1].value;
      const fileCall = storageInstance.bucket().file.mock.calls[0][0];
      expect(fileCall).toMatch(/backups\/.*\/backup\.msaf\.gz/);
    });

    it("should append .gz to BSON streams if compression is enabled", async () => {
      const compressedProvider = new GoogleProvider({
        bucket: "test-bucket",
        compress: true,
      });
      await compressedProvider.initialize();

      const stream = await compressedProvider.createBsonWriteStream(
        "db",
        "col",
      );
      expect(stream).toBeInstanceOf(PassThrough);

      const storageInstance = vi.mocked(Storage).mock.results[1].value;
      const fileCall = storageInstance.bucket().file.mock.calls[0][0];
      expect(fileCall).toMatch(/backups\/.*\/db\/col\.bson\.gz/);
    });
  });

  describe("Finalize", () => {
    it("should await all active uploads on finalize", async () => {
      await provider.initialize();
      const stream = await provider.createArchiveWriteStream("backup.msaf");
      // End the stream to trigger finish event
      stream.end();

      // Should not throw and resolve
      await expect(provider.finalize()).resolves.toBeUndefined();
    });

    it("should reject finalize if a stream emits error", async () => {
      // Need a custom mock for this test to emit error
      const ErrorWriteStream = class extends Writable {
        constructor() {
          super({
            write(_c, _e, cb) {
              cb();
            },
          });
          setTimeout(() => this.emit("error", new Error("Upload failed")), 10);
        }
      };
      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance.bucket().file.mockReturnValueOnce({
        createWriteStream: () => new ErrorWriteStream(),
        delete: vi.fn(),
        metadata: {},
      });

      await provider.initialize();
      await provider.createArchiveWriteStream("backup.msaf");

      await expect(provider.finalize()).rejects.toThrow("Upload failed");
    });
  });

  describe("Pruning", () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it("should return early if policy has no maxCount or maxDays", async () => {
      const result = await provider.prune({});
      expect(result.deletedCount).toBe(0);
      expect(result.deletedPaths).toEqual([]);
    });

    it("should return early if no prefixes exist", async () => {
      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance
        .bucket()
        .getFiles.mockResolvedValueOnce([[], {}, { prefixes: [] }]);

      const result = await provider.prune({ maxCount: 1 });
      expect(result.deletedCount).toBe(0);
    });

    it("should prune correctly based on maxDays", async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldTimestamp = oldDate.toISOString().replace(/[:.]/g, "-");

      const newDate = new Date();
      const newTimestamp = newDate.toISOString().replace(/[:.]/g, "-");

      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance.bucket().getFiles.mockResolvedValueOnce([
        [],
        {},
        {
          prefixes: [`backups/${oldTimestamp}/`, `backups/${newTimestamp}/`],
        },
      ]);

      const mockDeletedFile = {
        name: "backups/old/file.txt",
        delete: vi.fn().mockResolvedValue([{}]),
      };
      storageInstance
        .bucket()
        .getFiles.mockResolvedValueOnce([[mockDeletedFile]]);

      const result = await provider.prune({ maxDays: 5 });

      expect(result.deletedCount).toBe(1);
      expect(result.deletedPaths).toEqual(["backups/old/file.txt"]);
      expect(mockDeletedFile.delete).toHaveBeenCalled();
    });

    it("should prune correctly based on maxCount", async () => {
      const dates = [1, 2, 3].map((daysAgo) => {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        return d.toISOString().replace(/[:.]/g, "-");
      });

      const storageInstance = vi.mocked(Storage).mock.results[0].value;
      storageInstance
        .bucket()
        .getFiles.mockResolvedValueOnce([
          [],
          {},
          { prefixes: dates.map((d) => `backups/${d}/`) },
        ]);

      const mockDeletedFile = {
        name: "backups/oldest/file.txt",
        delete: vi.fn().mockResolvedValue([{}]),
      };
      // maxCount is 2, and there are 3 runs, so 1 should be deleted. We need one getFiles mock for the deletion fetch
      storageInstance
        .bucket()
        .getFiles.mockResolvedValueOnce([[mockDeletedFile]]);

      const result = await provider.prune({ maxCount: 2 });

      expect(result.deletedCount).toBe(1);
      expect(result.deletedPaths).toEqual(["backups/oldest/file.txt"]);
      expect(mockDeletedFile.delete).toHaveBeenCalled();
    });
  });
});
