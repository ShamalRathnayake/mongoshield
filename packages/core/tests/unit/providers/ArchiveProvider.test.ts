import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveProvider,
  MSAF_MAGIC,
  MSAF_VERSION,
} from "../../../src/providers/ArchiveProvider";
import { CHUNK_TYPE_EOF } from "../../../src/streams/MultiplexWriteStream";

describe("ArchiveProvider", () => {
  let mockDownstream: any;
  let mockStream: Writable;

  beforeEach(() => {
    vi.clearAllMocks();

    mockStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    mockDownstream = {
      initialize: vi.fn().mockResolvedValue(undefined),
      createBsonWriteStream: vi.fn(),
      createMetadataWriteStream: vi.fn(),
      createArchiveWriteStream: vi.fn().mockResolvedValue(mockStream),
      finalize: vi.fn().mockResolvedValue(undefined),
      prune: vi.fn().mockResolvedValue({ deletedCount: 0, deletedPaths: [] }),
      on: vi.fn(),
    };
  });

  it("initializes correctly: calls downstream and writes header", async () => {
    mockStream.write = vi.fn().mockImplementation((_chunk, cb) => cb());

    const provider = new ArchiveProvider(mockDownstream, "my-backup.msaf");

    await provider.initialize(5000);

    expect(mockDownstream.initialize).toHaveBeenCalledWith(5000);
    expect(mockDownstream.createArchiveWriteStream).toHaveBeenCalledWith(
      "my-backup.msaf",
    );

    const expectedHeader = Buffer.concat([MSAF_MAGIC, MSAF_VERSION]);
    expect(mockStream.write).toHaveBeenCalledWith(
      expectedHeader,
      expect.any(Function),
    );
  });

  it("fails initialization if downstream lacks createArchiveWriteStream", async () => {
    delete mockDownstream.createArchiveWriteStream;
    const provider = new ArchiveProvider(mockDownstream);

    await expect(provider.initialize()).rejects.toThrow(
      "missing createArchiveWriteStream",
    );
  });

  it("fails if global header write fails", async () => {
    mockStream.write = vi
      .fn()
      .mockImplementation((_chunk, cb) => cb(new Error("write-failed")));

    const provider = new ArchiveProvider(mockDownstream);

    await expect(provider.initialize()).rejects.toThrow("write-failed");
  });

  it("fails initialization if archiveStream becomes null unexpectedly", async () => {
    mockDownstream.createArchiveWriteStream.mockResolvedValue(null);
    const provider = new ArchiveProvider(mockDownstream);
    await expect(provider.initialize()).rejects.toThrow(
      "Archive stream is null",
    );
  });

  it("creates BSON write stream after initialization", async () => {
    const provider = new ArchiveProvider(mockDownstream);
    await provider.initialize();

    const bsonStream = await provider.createBsonWriteStream("testdb", "users");
    expect(bsonStream).toBeInstanceOf(Writable);
  });

  it("throws if createBsonWriteStream called before initialization", async () => {
    const provider = new ArchiveProvider(mockDownstream);
    await expect(provider.createBsonWriteStream("db", "col")).rejects.toThrow(
      "ArchiveProvider not initialized",
    );
  });

  it("creates Metadata write stream after initialization", async () => {
    const provider = new ArchiveProvider(mockDownstream);
    await provider.initialize();

    const metaStream = await provider.createMetadataWriteStream(
      "testdb",
      "users",
    );
    expect(metaStream).toBeInstanceOf(Writable);
  });

  it("finalizes correctly: writes EOF, ends stream, calls downstream finalize", async () => {
    mockStream.end = vi.fn().mockImplementation((_chunk, cb) => cb());

    const provider = new ArchiveProvider(mockDownstream);
    await provider.initialize();
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
    expect(mockDownstream.finalize).toHaveBeenCalled();
  });

  it("delegates prune to downstream", async () => {
    const provider = new ArchiveProvider(mockDownstream);
    const policy = { strategy: "count" as const, maxCount: 5 };
    await provider.prune(policy);
    expect(mockDownstream.prune).toHaveBeenCalledWith(policy);
  });
});
