import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AbstractStorageProvider } from "../../../src/providers/AbstractStorageProvider";

class MockStorageProvider extends AbstractStorageProvider {
  public _initialize = vi.fn().mockResolvedValue(undefined);
  public _finalize = vi.fn().mockResolvedValue(undefined);
  public _createBsonWriteStream = vi
    .fn()
    .mockImplementation(() => new PassThrough());
  public _createMetadataWriteStream = vi
    .fn()
    .mockImplementation(() => new PassThrough());
}

describe("AbstractStorageProvider", () => {
  it("calls _initialize on initialize", async () => {
    const provider = new MockStorageProvider();
    await provider.initialize();
    expect(provider._initialize).toHaveBeenCalled();
  });

  it("calls _finalize on finalize", async () => {
    const provider = new MockStorageProvider();
    await provider.finalize();
    expect(provider._finalize).toHaveBeenCalled();
  });

  describe("sanitizePath", () => {
    const provider = new MockStorageProvider();

    it("throws on empty or null input", () => {
      expect(() => (provider as any).sanitizePath("")).toThrow(
        /Invalid path segment/,
      );
      expect(() => (provider as any).sanitizePath(null)).toThrow(
        /Invalid path segment/,
      );
    });

    it("throws on forward slash", () => {
      expect(() => (provider as any).sanitizePath("my/path")).toThrow(
        /Invalid path segment/,
      );
    });

    it("throws on backslash", () => {
      expect(() => (provider as any).sanitizePath("my\\path")).toThrow(
        /Invalid path segment/,
      );
    });

    it("throws on double dots", () => {
      expect(() => (provider as any).sanitizePath("..")).toThrow(
        /Invalid path segment/,
      );
      expect(() => (provider as any).sanitizePath("path/..")).toThrow(
        /Invalid path segment/,
      );
    });

    it("passes on valid segments", () => {
      expect(() => (provider as any).sanitizePath("valid-name")).not.toThrow();
      expect(() =>
        (provider as any).sanitizePath("collection_123"),
      ).not.toThrow();
    });
  });

  describe("Stream Creation & Telemetry", () => {
    it("sanitizes and wraps BSON write stream with telemetry", async () => {
      const provider = new MockStorageProvider();
      const stream = await provider.createBsonWriteStream("db", "col");

      expect(provider._createBsonWriteStream).toHaveBeenCalledWith("db", "col");
      expect(stream).toBeInstanceOf(PassThrough);

      let progressEmitted = 0;
      provider.on("progress", (bytes) => {
        progressEmitted += bytes;
      });

      stream.write(Buffer.from("hello"));
      expect(progressEmitted).toBe(5);
    });

    it("sanitizes and wraps Metadata write stream with telemetry", async () => {
      const provider = new MockStorageProvider();
      const stream = await provider.createMetadataWriteStream("db", "col");

      expect(provider._createMetadataWriteStream).toHaveBeenCalledWith(
        "db",
        "col",
      );

      let progressEmitted = 0;
      provider.on("progress", (bytes) => {
        progressEmitted += bytes;
      });

      stream.write(Buffer.from("metadata"));
      expect(progressEmitted).toBe(8);
    });

    it("emits error through telemetry wrapper", async () => {
      const provider = new MockStorageProvider();
      const stream = await provider.createBsonWriteStream("db", "col");

      const errorPromise = new Promise<Error>((resolve) => {
        provider.on("error", resolve);
      });

      stream.emit("error", new Error("test-error"));
      const error = await errorPromise;
      expect(error.message).toBe("test-error");
    });

    it("fails createBsonWriteStream on invalid names", async () => {
      const provider = new MockStorageProvider();
      await expect(
        provider.createBsonWriteStream("../", "col"),
      ).rejects.toThrow();
      await expect(
        provider.createBsonWriteStream("db", "/col"),
      ).rejects.toThrow();
    });
  });
});
