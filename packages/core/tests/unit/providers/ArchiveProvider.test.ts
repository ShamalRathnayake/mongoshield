import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveProvider,
  MSAF_MAGIC,
  MSAF_VERSION,
} from "../../../src/providers/ArchiveProvider";
import {
  CHUNK_TYPE_BSON,
  CHUNK_TYPE_EOF,
  CHUNK_TYPE_META,
  MultiplexWriteStream,
} from "../../../src/streams/MultiplexWriteStream";

vi.mock("node:fs");
vi.mock("node:fs/promises");

describe("ArchiveProvider", () => {
  const archivePath = "/path/to/archive.msaf";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes correctly: mkdir, createWriteStream, write header", async () => {
    const mockStream = new Writable({
      write(chunk, encoding, callback) {
        callback();
      },
    });
    // @ts-expect-error
    mockStream.write = vi.fn().mockImplementation((chunk, cb) => cb());

    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);

    const initPromise = provider.initialize();

    // Simulate 'open' event
    setTimeout(() => mockStream.emit("open"), 10);

    await initPromise;

    expect(mkdir).toHaveBeenCalledWith("/path/to", { recursive: true });
    expect(createWriteStream).toHaveBeenCalledWith(archivePath);

    const expectedHeader = Buffer.concat([MSAF_MAGIC, MSAF_VERSION]);
    expect(mockStream.write).toHaveBeenCalledWith(
      expectedHeader,
      expect.any(Function),
    );
  });

  it("fails initialization if stream emits error", async () => {
    const mockStream = new Writable();
    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);
    const initPromise = provider.initialize();

    setTimeout(() => mockStream.emit("error", new Error("disk-full")), 10);

    await expect(initPromise).rejects.toThrow("disk-full");
  });

  it("fails if global header write fails", async () => {
    const mockStream = new Writable();
    mockStream.write = vi
      .fn()
      .mockImplementation((chunk, cb) => cb(new Error("write-failed")));

    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);
    const initPromise = provider.initialize();

    setTimeout(() => mockStream.emit("open"), 10);

    await expect(initPromise).rejects.toThrow("write-failed");
  });

  it("fails initialization if archiveStream becomes null unexpectedly (defensive check)", async () => {
    (createWriteStream as any).mockReturnValue(null);
    (mkdir as any).mockResolvedValue(undefined);
    const provider = new ArchiveProvider(archivePath);
    await expect(provider.initialize()).rejects.toThrow(
      "Archive stream is null",
    );
  });

  it("creates BSON write stream after initialization", async () => {
    const mockStream = new Writable({
      write(c, e, cb) {
        cb();
      },
    });
    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);
    const initPromise = provider.initialize();
    setTimeout(() => mockStream.emit("open"), 0);
    await initPromise;

    const bsonStream = await provider.createBsonWriteStream("testdb", "users");
    expect(bsonStream).toBeInstanceOf(Writable);
    // Since it's wrapped in telemetry, we check the underlying behavior or type if possible
    // MultiplexWriteStream is internal to createBsonWriteStream
  });

  it("throws if createBsonWriteStream called before initialization", async () => {
    const provider = new ArchiveProvider(archivePath);
    await expect(provider.createBsonWriteStream("db", "col")).rejects.toThrow(
      "ArchiveProvider not initialized",
    );
  });

  it("throws if createMetadataWriteStream called before initialization", async () => {
    const provider = new ArchiveProvider(archivePath);
    await expect(
      provider.createMetadataWriteStream("db", "col"),
    ).rejects.toThrow("ArchiveProvider not initialized");
  });

  it("creates Metadata write stream after initialization", async () => {
    const mockStream = new Writable({
      write(c, e, cb) {
        cb();
      },
    });
    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);
    const initPromise = provider.initialize();
    setTimeout(() => mockStream.emit("open"), 0);
    await initPromise;

    const metaStream = await provider.createMetadataWriteStream(
      "testdb",
      "users",
    );
    expect(metaStream).toBeInstanceOf(Writable);
  });

  it("finalizes correctly: writes EOF and ends stream", async () => {
    const mockStream = new Writable({
      write(c, e, cb) {
        cb();
      },
    });
    mockStream.end = vi.fn().mockImplementation((chunk, cb) => cb());

    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new ArchiveProvider(archivePath);
    const initPromise = provider.initialize();
    setTimeout(() => mockStream.emit("open"), 0);
    await initPromise;

    await provider.finalize();

    // Verify EOF chunk
    const expectedEof = Buffer.alloc(7);
    expectedEof.writeUInt8(CHUNK_TYPE_EOF, 0);
    expectedEof.writeUInt16LE(0, 1);
    expectedEof.writeUInt32LE(0, 3);

    expect(mockStream.end).toHaveBeenCalledWith(
      expectedEof,
      expect.any(Function),
    );
  });

  it("throws if finalize called before initialization", async () => {
    const provider = new ArchiveProvider(archivePath);
    await expect(provider.finalize()).rejects.toThrow(
      "ArchiveProvider not initialized",
    );
  });
});
