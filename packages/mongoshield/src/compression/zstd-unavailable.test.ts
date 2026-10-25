/**
 * Simulates a Node.js runtime without zstd (older than 22.15 / 23.8) by mocking
 * `node:zlib` without the zstd factories. Kept in its own file because the mock
 * applies to the whole module graph of the test file.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, createZstdCompress: undefined, createZstdDecompress: undefined };
});

const { createCompressor, createDecompressor, defaultCompression, isZstdAvailable } = await import(
  "./index.ts"
);

describe("on a Node.js runtime without zstd", () => {
  it("reports zstd as unavailable and defaults to gzip", () => {
    expect(isZstdAvailable()).toBe(false);
    expect(defaultCompression()).toBe("gzip");
  });

  it("refuses to compress with zstd as a configuration error", () => {
    expect(() => createCompressor("zstd")).toThrow(
      expect.objectContaining({
        code: "MS_CONFIG_INVALID",
        hint: expect.stringContaining("22.15"),
      }),
    );
  });

  it("refuses to decompress zstd as an unsupported format", () => {
    expect(() => createDecompressor("zstd")).toThrow(
      expect.objectContaining({ code: "MS_FORMAT_UNSUPPORTED" }),
    );
  });

  it("still supports gzip", () => {
    expect(() => createCompressor("gzip")).not.toThrow();
    expect(() => createDecompressor("gzip")).not.toThrow();
  });
});
