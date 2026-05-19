import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { AzureProvider } from "../src/AzureProvider";
import { BlobServiceClient } from "@azure/storage-blob";

const mockUploadStream = vi.fn();
const mockDelete = vi.fn();
const mockExists = vi.fn();
const mockGetBlockBlobClient = vi.fn();
const mockListBlobsByHierarchy = vi.fn();
const mockListBlobsFlat = vi.fn();

vi.mock("@azure/storage-blob", () => {
  return {
    BlobServiceClient: {
      fromConnectionString: vi.fn(() => ({
        getContainerClient: vi.fn(() => ({
          exists: mockExists,
          getBlockBlobClient: mockGetBlockBlobClient,
          listBlobsByHierarchy: mockListBlobsByHierarchy,
          listBlobsFlat: mockListBlobsFlat,
        })),
      })),
    }
  };
});

describe("AzureProvider", () => {
  const defaultOptions = {
    connectionString: "DefaultEndpointsProtocol=https;AccountName=test;AccountKey=test;EndpointSuffix=core.windows.net",
    container: "test-container",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBlockBlobClient.mockReturnValue({
      uploadStream: mockUploadStream,
      delete: mockDelete,
    });
    mockUploadStream.mockResolvedValue(undefined);
    mockExists.mockResolvedValue(true);
    mockDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Initialization", () => {
    it("should initialize and verify container existence", async () => {
      const provider = new AzureProvider(defaultOptions);
      // @ts-ignore - calling protected method for testing
      await provider._initialize();

      expect(mockExists).toHaveBeenCalled();
    });

    it("should throw error if container does not exist", async () => {
      mockExists.mockResolvedValueOnce(false);
      const provider = new AzureProvider(defaultOptions);
      
      // @ts-ignore
      await expect(provider._initialize()).rejects.toThrow(/does not exist/);
    });

    it("should handle 403 Forbidden errors intelligently", async () => {
      const authError = new Error("AuthorizationFailure");
      (authError as any).statusCode = 403;
      mockExists.mockRejectedValueOnce(authError);
      
      const provider = new AzureProvider(defaultOptions);
      // @ts-ignore
      await expect(provider._initialize()).rejects.toThrow(/Access denied/);
    });

    it("should generate a timestamped prefix during initialization", async () => {
      const provider = new AzureProvider(defaultOptions);
      // @ts-ignore
      await provider._initialize();
      // @ts-ignore
      expect(provider.currentRunPrefix).toMatch(/^backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/$/);
    });
  });

  describe("Streaming Uploads", () => {
    let provider: AzureProvider;

    beforeEach(async () => {
      provider = new AzureProvider(defaultOptions);
      // @ts-ignore
      await provider._initialize();
    });

    it("should create a BSON write stream", async () => {
      // @ts-ignore
      const stream = await provider._createBsonWriteStream("db1", "col1");
      expect(stream).toBeInstanceOf(PassThrough);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(expect.stringContaining("db1/col1.bson"));
      expect(mockUploadStream).toHaveBeenCalledWith(stream);
    });

    it("should create a Metadata write stream", async () => {
      // @ts-ignore
      const stream = await provider._createMetadataWriteStream("db1", "col1");
      expect(stream).toBeInstanceOf(PassThrough);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(expect.stringContaining("db1/col1.metadata.json"));
      expect(mockUploadStream).toHaveBeenCalledWith(stream);
    });

    it("should create an Archive write stream", async () => {
      // @ts-ignore
      const stream = await provider._createArchiveWriteStream("archive.tar");
      expect(stream).toBeInstanceOf(PassThrough);
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(expect.stringContaining("archive.tar"));
      expect(mockUploadStream).toHaveBeenCalledWith(stream);
    });

    it("should apply gzip compression if compress is true", async () => {
      const gzipProvider = new AzureProvider({ ...defaultOptions, compress: true });
      // @ts-ignore
      await gzipProvider._initialize();
      
      // @ts-ignore
      const stream = await gzipProvider._createArchiveWriteStream("archive.tar");
      
      // Ensure the key has .gz appended
      expect(mockGetBlockBlobClient).toHaveBeenCalledWith(expect.stringContaining("archive.tar.gz"));
      // The returned stream should be a Gzip stream, which is a Transform stream, testing duck typing
      expect(typeof stream.pipe).toBe("function");
    });
  });

  describe("Finalization", () => {
    it("should await all active uploads in _finalize", async () => {
      const provider = new AzureProvider(defaultOptions);
      // @ts-ignore
      await provider._initialize();

      // Mock a pending upload promise
      let resolveUpload: Function;
      const uploadPromise = new Promise((res) => {
        resolveUpload = res;
      });
      mockUploadStream.mockReturnValueOnce(uploadPromise);

      // @ts-ignore
      await provider._createBsonWriteStream("test", "test");

      // _finalize should block until the promise resolves
      let finalized = false;
      // @ts-ignore
      provider._finalize().then(() => {
        finalized = true;
      });

      // Wait a microtask
      await new Promise((res) => setTimeout(res, 0));
      expect(finalized).toBe(false);

      // Resolve the upload
      resolveUpload!();
      
      await new Promise((res) => setTimeout(res, 0));
      expect(finalized).toBe(true);
    });
  });

  describe("Pruning", () => {
    let provider: AzureProvider;

    beforeEach(async () => {
      provider = new AzureProvider(defaultOptions);
      // @ts-ignore
      await provider._initialize();
    });

    const createMockHierarchicalIterator = (prefixes: string[]) => {
      return async function* () {
        for (const prefix of prefixes) {
          yield { kind: "prefix", name: prefix };
        }
      };
    };

    const createMockFlatIterator = (blobs: string[]) => {
      return async function* () {
        for (const blob of blobs) {
          yield { name: blob };
        }
      };
    };

    it("should prune based on maxCount", async () => {
      const currentPrefix = (provider as any).currentRunPrefix;
      const run1 = "backups/2020-01-01T00-00-00-000Z/";
      const run2 = "backups/2021-01-01T00-00-00-000Z/"; // Newer
      const run3 = "backups/2022-01-01T00-00-00-000Z/"; // Newest
      
      mockListBlobsByHierarchy.mockImplementation(createMockHierarchicalIterator([run1, run2, run3, currentPrefix]));
      mockListBlobsFlat.mockImplementation(createMockFlatIterator(["file1.bson", "file2.bson"]));

      // @ts-ignore
      const result = await provider._prune({ strategy: "count", maxCount: 1 });

      // Run3 is the newest, so run1 and run2 should be deleted.
      // currentRunPrefix should be ignored.
      // 2 prefixes * 2 files = 4 deletions.
      expect(result.deletedCount).toBe(4);
      
      // Called flat for run1 and run2
      expect(mockListBlobsFlat).toHaveBeenCalledTimes(2);
      expect(mockDelete).toHaveBeenCalledTimes(4);
    });

    it("should prune based on maxDays", async () => {
      const today = new Date();
      const yesterday = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000);
      const old = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000);

      const yesterdayStr = yesterday.toISOString().replace(/[:.]/g, "-");
      const oldStr = old.toISOString().replace(/[:.]/g, "-");

      const runYesterday = `backups/${yesterdayStr}/`;
      const runOld = `backups/${oldStr}/`;
      
      mockListBlobsByHierarchy.mockImplementation(createMockHierarchicalIterator([runYesterday, runOld]));
      mockListBlobsFlat.mockImplementation(createMockFlatIterator(["file1.bson"]));

      // @ts-ignore
      const result = await provider._prune({ strategy: "age", maxDays: 5 });

      // Only runOld should be deleted
      expect(result.deletedCount).toBe(1);
      expect(mockListBlobsFlat).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledTimes(1);
    });

    it("should return early if no runs are found", async () => {
      mockListBlobsByHierarchy.mockImplementation(createMockHierarchicalIterator([]));
      // @ts-ignore
      const result = await provider._prune({ strategy: "count", maxCount: 1 });
      expect(result.deletedCount).toBe(0);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });
});
