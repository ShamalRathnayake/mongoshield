import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SftpProvider } from "../src/SftpProvider";

const mockConnect = vi.fn();
const mockOn = vi.fn();
const mockEnd = vi.fn();
const mockSftp = vi.fn();

const mockMkdir = vi.fn();
const mockStat = vi.fn();
const mockCreateWriteStream = vi.fn();
const mockReaddir = vi.fn();
const mockUnlink = vi.fn();
const mockRmdir = vi.fn();

vi.mock("ssh2", () => {
  class MockClient {
    connect = mockConnect;
    on = mockOn;
    end = mockEnd;
    sftp = mockSftp;
  }
  return {
    Client: MockClient,
  };
});

describe("SftpProvider", () => {
  const defaultOptions = {
    host: "127.0.0.1",
    port: 22,
    username: "testuser",
    password: "testpassword",
    basePath: "/backups",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockOn.mockImplementation((event, callback) => {
      if (event === "ready") {
        setTimeout(callback, 0); // Simulate asynchronous ready event
      }
    });

    mockSftp.mockImplementation((callback) => {
      callback(null, {
        mkdir: mockMkdir,
        stat: mockStat,
        createWriteStream: mockCreateWriteStream,
        readdir: mockReaddir,
        unlink: mockUnlink,
        rmdir: mockRmdir,
      });
    });

    mockMkdir.mockImplementation((_path, callback) => callback(null));
    mockStat.mockImplementation((_path, callback) =>
      callback(null, { isDirectory: () => true }),
    );
    mockCreateWriteStream.mockImplementation(() => {
      const pt = new PassThrough();
      // Simulate close event immediately on finish
      pt.on("finish", () => pt.emit("close"));
      return pt;
    });

    mockReaddir.mockImplementation((_path, callback) => callback(null, []));
    mockUnlink.mockImplementation((_path, callback) => callback(null));
    mockRmdir.mockImplementation((_path, callback) => callback(null));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Initialization", () => {
    it("should establish SSH connection and SFTP subsystem", async () => {
      const provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await provider._initialize();

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "127.0.0.1" }),
      );
      expect(mockSftp).toHaveBeenCalled();
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining("/backups"),
        expect.any(Function),
      );
    });

    it("should throw error if SSH connection fails", async () => {
      mockOn.mockImplementation((event, callback) => {
        if (event === "error") {
          setTimeout(() => callback(new Error("Connection timeout")), 0);
        }
      });

      const provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await expect(provider._initialize()).rejects.toThrow(
        /SSH connection failed/,
      );
    });

    it("should generate a timestamped prefix during initialization", async () => {
      const provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await provider._initialize();
      // @ts-expect-error
      expect(provider.currentRunPrefix).toMatch(
        /^\/backups\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/$/,
      );
    });
  });

  describe("Streaming Uploads", () => {
    let provider: SftpProvider;

    beforeEach(async () => {
      provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await provider._initialize();
    });

    it("should create a BSON write stream and nested directories", async () => {
      // @ts-expect-error
      const stream = await provider._createBsonWriteStream("db1", "col1");
      expect(stream).toBeInstanceOf(PassThrough);
      // It should create the database directory before the file
      expect(mockMkdir).toHaveBeenCalledWith(
        expect.stringContaining("db1/"),
        expect.any(Function),
      );
      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining("db1/col1.bson"),
      );
    });

    it("should apply gzip compression if compress is true", async () => {
      const gzipProvider = new SftpProvider({
        ...defaultOptions,
        compress: true,
      });
      // @ts-expect-error
      await gzipProvider._initialize();

      // @ts-expect-error
      const stream =
        await gzipProvider._createArchiveWriteStream("archive.tar");

      expect(mockCreateWriteStream).toHaveBeenCalledWith(
        expect.stringContaining("archive.tar.gz"),
      );
      expect(typeof stream.pipe).toBe("function");
    });
  });

  describe("Finalization", () => {
    it("should end SSH connection in _finalize", async () => {
      const provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await provider._initialize();
      // @ts-expect-error
      await provider._finalize();

      expect(mockEnd).toHaveBeenCalled();
    });
  });

  describe("Pruning", () => {
    let provider: SftpProvider;

    beforeEach(async () => {
      provider = new SftpProvider(defaultOptions);
      // @ts-expect-error
      await provider._initialize();
    });

    it("should prune based on maxCount by recursively deleting directories", async () => {
      const _currentPrefix = (provider as any).currentRunPrefix;
      const run1 = "2020-01-01T00-00-00-000Z";
      const run2 = "2021-01-01T00-00-00-000Z"; // Newer
      const run3 = "2022-01-01T00-00-00-000Z"; // Newest

      const mockDirItem = (name: string) => ({
        filename: name,
        attrs: { isDirectory: () => true },
      });
      const mockFileItem = (name: string) => ({
        filename: name,
        attrs: { isDirectory: () => false },
      });

      mockReaddir.mockImplementation((path, callback) => {
        if (path === "/backups/") {
          callback(null, [
            mockDirItem(run1),
            mockDirItem(run2),
            mockDirItem(run3),
          ]);
        } else if (path.includes(run1) || path.includes(run2)) {
          // Inside run directories, return a file to delete
          callback(null, [mockFileItem("file.bson")]);
        } else {
          callback(null, []);
        }
      });

      // @ts-expect-error
      const result = await provider._prune({ strategy: "count", maxCount: 1 });

      // Only run3 should be kept. run1 and run2 should be deleted.
      // For each run, it unlinks the file, then rmdirs the run directory.
      // Total 2 files + 2 directories = 4 deletions.
      expect(result.deletedCount).toBe(4);
      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockRmdir).toHaveBeenCalledTimes(2);
    });

    it("should return early if no runs are found", async () => {
      // @ts-expect-error
      const result = await provider._prune({ strategy: "count", maxCount: 1 });
      expect(result.deletedCount).toBe(0);
      expect(mockRmdir).not.toHaveBeenCalled();
    });
  });
});
