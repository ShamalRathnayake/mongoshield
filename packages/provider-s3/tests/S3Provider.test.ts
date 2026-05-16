import { PassThrough, Writable } from "node:stream";
import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { S3Provider } from "../src/S3Provider";

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  
  class MockS3Client {
    send = vi.fn();
  }

  return {
    ...actual,
    S3Client: MockS3Client,
  };
});

vi.mock("@aws-sdk/lib-storage", () => {
  const mockUploadInstances: any[] = [];
  
  class MockUpload {
    params: any;
    constructor(options: any) {
      this.params = options.params;
      mockUploadInstances.push(this);
    }
    done = vi.fn().mockResolvedValue(true);
  }
  
  return {
    Upload: MockUpload,
    __getMockUploadInstances: () => mockUploadInstances,
    __clearMockUploadInstances: () => { mockUploadInstances.length = 0; }
  };
});

describe("S3Provider", () => {
  let mockSend: any;
  let provider: S3Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3Provider({
      bucket: "test-bucket",
      region: "us-east-1",
      prefix: "backups/",
    });
    mockSend = (provider as any).client.send;
    mockSend.mockResolvedValue({});
  });

  describe("Initialization", () => {
    it("should successfully verify bucket access via HeadBucketCommand", async () => {
      await provider.initialize();
      expect(mockSend).toHaveBeenCalledTimes(1);
      const callArgs = mockSend.mock.calls[0][0];
      expect(callArgs).toBeInstanceOf(HeadBucketCommand);
      expect(callArgs.input.Bucket).toBe("test-bucket");
    });

    it("should throw a friendly error if bucket is not found", async () => {
      const notFoundError = new Error("Not Found");
      notFoundError.name = "NotFound";
      mockSend.mockRejectedValueOnce(notFoundError);

      await expect(provider.initialize()).rejects.toThrow(
        'S3Provider: Bucket "test-bucket" does not exist.'
      );
    });

    it("should throw a friendly error if access is forbidden", async () => {
      const forbiddenError = new Error("Forbidden");
      forbiddenError.name = "Forbidden";
      mockSend.mockRejectedValueOnce(forbiddenError);

      await expect(provider.initialize()).rejects.toThrow(
        'S3Provider: Access denied to bucket "test-bucket". Check your credentials.'
      );
    });

    it("should rethrow unknown errors", async () => {
      const unknownError = new Error("Network Error");
      mockSend.mockRejectedValueOnce(unknownError);

      await expect(provider.initialize()).rejects.toThrow("Network Error");
    });

    it("should generate a timestamped prefix", async () => {
      await provider.initialize();
      const currentRunPrefix = (provider as any).currentRunPrefix;
      expect(currentRunPrefix).toMatch(/^backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/$/);
    });
  });

  describe("Streaming Writes", () => {
    beforeEach(async () => {
      // @ts-expect-error
      const { __clearMockUploadInstances } = await import("@aws-sdk/lib-storage");
      __clearMockUploadInstances();
      await provider.initialize();
    });

    it("should create a BSON write stream and push an upload promise", async () => {
      const stream = await provider.createBsonWriteStream("db", "col");
      expect(stream).toBeInstanceOf(PassThrough);
      expect((provider as any).activeUploads.length).toBe(1);

      // @ts-expect-error
      const { __getMockUploadInstances } = await import("@aws-sdk/lib-storage");
      const instances = __getMockUploadInstances();
      const uploadCall = instances[0];
      
      expect(uploadCall.params.Bucket).toBe("test-bucket");
      expect(uploadCall.params.Key).toMatch(/backups\/.*\/db\/col\.bson/);
      expect(uploadCall.params.Body).toBeInstanceOf(PassThrough);
    });

    it("should create a Metadata write stream", async () => {
      const stream = await provider.createMetadataWriteStream("db", "col");
      expect(stream).toBeInstanceOf(PassThrough);
      // @ts-expect-error
      const { __getMockUploadInstances } = await import("@aws-sdk/lib-storage");
      const uploadCall = __getMockUploadInstances()[0];
      expect(uploadCall.params.Key).toMatch(/backups\/.*\/db\/col\.metadata\.json/);
    });

    it("should create an Archive write stream", async () => {
      const stream = await provider.createArchiveWriteStream("backup.msaf");
      expect(stream).toBeInstanceOf(PassThrough);
      // @ts-expect-error
      const { __getMockUploadInstances } = await import("@aws-sdk/lib-storage");
      const uploadCall = __getMockUploadInstances()[0];
      expect(uploadCall.params.Key).toMatch(/backups\/.*\/backup\.msaf/);
    });

    it("should append .gz to Archive streams if compression is enabled", async () => {
      const compressedProvider = new S3Provider({
        bucket: "test-bucket",
        compress: true,
      });
      await compressedProvider.initialize();

      const stream = await compressedProvider.createArchiveWriteStream("backup.msaf");
      expect(stream).toBeInstanceOf(Writable); // Gzip instance
      
      // @ts-expect-error
      const { __getMockUploadInstances } = await import("@aws-sdk/lib-storage");
      const uploadCall = __getMockUploadInstances()[0];
      expect(uploadCall.params.Key).toMatch(/backups\/.*\/backup\.msaf\.gz/);
    });
    
    it("should append .gz to BSON streams if compression is enabled", async () => {
      const compressedProvider = new S3Provider({
        bucket: "test-bucket",
        compress: true,
      });
      await compressedProvider.initialize();

      const stream = await compressedProvider.createBsonWriteStream("db", "col");
      expect(stream).toBeInstanceOf(PassThrough); // Telemetry wrapper around passthrough
      
      // @ts-expect-error
      const { __getMockUploadInstances } = await import("@aws-sdk/lib-storage");
      const uploadCall = __getMockUploadInstances()[0];
      expect(uploadCall.params.Key).toMatch(/backups\/.*\/db\/col\.bson\.gz/);
    });
  });

  describe("Finalize", () => {
    it("should await all active uploads on finalize", async () => {
      await provider.initialize();
      await provider.createBsonWriteStream("db", "col");
      await provider.createArchiveWriteStream("backup.msaf");

      expect((provider as any).activeUploads.length).toBe(2);
      await provider.finalize();
      expect((provider as any).activeUploads.length).toBe(0);
    });
  });

  describe("Pruning", () => {
    beforeEach(async () => {
      await provider.initialize();
      mockSend.mockClear();
    });

    it("should immediately return if maxCount is 0", async () => {
      const res = await provider.prune({ strategy: "count", maxCount: 0 });
      expect(res.deletedCount).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it("should return early if no prefixes exist", async () => {
      mockSend.mockResolvedValueOnce({ CommonPrefixes: [] });
      const res = await provider.prune({ strategy: "count", maxCount: 5 });
      expect(res.deletedCount).toBe(0);
    });

    it("should correctly prune by age (maxDays)", async () => {
      // Create some fake old prefixes
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldPrefix = `backups/${oldDate.toISOString().replace(/[:.]/g, "-")}/`;
      
      const newDate = new Date();
      const newPrefix = `backups/${newDate.toISOString().replace(/[:.]/g, "-")}/`;

      mockSend.mockImplementation((command: any) => {
        if (command instanceof ListObjectsV2Command) {
          if (command.input.Delimiter === "/") {
            return Promise.resolve({ CommonPrefixes: [{ Prefix: oldPrefix }, { Prefix: newPrefix }] });
          }
          return Promise.resolve({ Contents: [{ Key: `${command.input.Prefix}file1.bson` }, { Key: `${command.input.Prefix}file2.bson` }] });
        }
        return Promise.resolve({});
      });

      const res = await provider.prune({ strategy: "age", maxDays: 5 });
      
      expect(res.deletedCount).toBe(1);
      expect(res.deletedPaths[0]).toBe(`s3://test-bucket/${oldPrefix}`);

      // Should have called ListObjectsV2(Prefixes) -> ListObjectsV2(Keys) -> DeleteObjects
      const deleteCall = mockSend.mock.calls.find((c: any) => c[0] instanceof DeleteObjectsCommand);
      expect(deleteCall).toBeDefined();
      expect(deleteCall[0].input.Delete.Objects.length).toBe(2);
    });

    it("should correctly prune by count (maxCount)", async () => {
      const p1 = "backups/2026-01-01T00-00-00-000Z/";
      const p2 = "backups/2026-01-02T00-00-00-000Z/";
      const p3 = "backups/2026-01-03T00-00-00-000Z/";
      
      mockSend.mockImplementation((command: any) => {
        if (command instanceof ListObjectsV2Command) {
          if (command.input.Delimiter === "/") {
            return Promise.resolve({ CommonPrefixes: [{ Prefix: p1 }, { Prefix: p2 }, { Prefix: p3 }] });
          }
          return Promise.resolve({ Contents: [{ Key: `${command.input.Prefix}file1` }] });
        }
        return Promise.resolve({});
      });

      // We only want to keep the latest 2 backups. 
      // Current active run is ignored. p1, p2, p3 are existing.
      const res = await provider.prune({ strategy: "count", maxCount: 2 });
      
      expect(res.deletedCount).toBe(1);
      expect(res.deletedPaths).toContain(`s3://test-bucket/${p1}`);
    });
    
    it("should implement 'both' strategy correctly", async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const pOld = `backups/${oldDate.toISOString().replace(/[:.]/g, "-")}/`;
      
      const d1 = new Date(); d1.setDate(d1.getDate() - 4);
      const p1 = `backups/${d1.toISOString().replace(/[:.]/g, "-")}/`;
      const d2 = new Date(); d2.setDate(d2.getDate() - 3);
      const p2 = `backups/${d2.toISOString().replace(/[:.]/g, "-")}/`;
      const d3 = new Date(); d3.setDate(d3.getDate() - 2);
      const p3 = `backups/${d3.toISOString().replace(/[:.]/g, "-")}/`;
      
      mockSend.mockImplementation((command: any) => {
        if (command instanceof ListObjectsV2Command) {
          if (command.input.Delimiter === "/") {
            return Promise.resolve({ CommonPrefixes: [{ Prefix: pOld }, { Prefix: p1 }, { Prefix: p2 }, { Prefix: p3 }] });
          }
          return Promise.resolve({ Contents: [{ Key: `${command.input.Prefix}file1` }] });
        }
        return Promise.resolve({});
      });

      const res = await provider.prune({ strategy: "both", maxCount: 2, maxDays: 5 });
      
      // Should delete pOld (age) and p1 (excess count)
      expect(res.deletedCount).toBe(2);
      expect(res.deletedPaths).toContain(`s3://test-bucket/${pOld}`);
      expect(res.deletedPaths).toContain(`s3://test-bucket/${p1}`);
    });
  });
});
