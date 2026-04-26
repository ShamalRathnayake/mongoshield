import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemProvider } from "../../src/FileSystemProvider";

vi.mock("node:fs");
vi.mock("node:fs/promises");

describe("FileSystemProvider", () => {
  const baseOutPath = "/dump";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes the base directory with secure permissions", async () => {
    const provider = new FileSystemProvider(baseOutPath);
    await provider.initialize();

    expect(mkdir).toHaveBeenCalledWith(baseOutPath, {
      recursive: true,
      mode: 0o700,
    });
  });

  it("creates a BSON write stream with atomic write logic", async () => {
    const mockStream = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });
    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new FileSystemProvider(baseOutPath);
    await provider.initialize();

    const stream = await provider.createBsonWriteStream("mydb", "mycol");

    // Check mkdir for DB dir
    expect(mkdir).toHaveBeenCalledWith(join(baseOutPath, "mydb"), {
      recursive: true,
      mode: 0o700,
    });

    // Check createWriteStream for temp file
    const expectedPath = join(baseOutPath, "mydb", "mycol.bson");
    expect(createWriteStream).toHaveBeenCalledWith(`${expectedPath}.tmp`, {
      mode: 0o600,
    });

    // Verify rename on finish
    const renamePromise = new Promise<void>((resolve) => {
      mockStream.on("finish", () => {
        // Give time for the rename async callback in the provider
        setTimeout(resolve, 10);
      });
    });

    mockStream.end();
    await renamePromise;

    expect(rename).toHaveBeenCalledWith(`${expectedPath}.tmp`, expectedPath);
  });

  it("handles metadata write streams similarly", async () => {
    const mockStream = new Writable({
      write(chunk, enc, cb) {
        cb();
      },
    });
    (createWriteStream as any).mockReturnValue(mockStream);
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new FileSystemProvider(baseOutPath);
    await provider.initialize();

    const expectedPath = join(baseOutPath, "mydb", "mycol.metadata.json");
    await provider.createMetadataWriteStream("mydb", "mycol");

    expect(createWriteStream).toHaveBeenCalledWith(`${expectedPath}.tmp`, {
      mode: 0o600,
    });
  });

  it("supports compression suffixes", async () => {
    (createWriteStream as any).mockReturnValue(new Writable());
    (mkdir as any).mockResolvedValue(undefined);

    const provider = new FileSystemProvider(baseOutPath, true);
    await provider.initialize();

    const expectedPath = join(baseOutPath, "mydb", "mycol.bson.gz");
    await provider.createBsonWriteStream("mydb", "mycol");

    expect(createWriteStream).toHaveBeenCalledWith(`${expectedPath}.tmp`, {
      mode: 0o600,
    });
  });
});
