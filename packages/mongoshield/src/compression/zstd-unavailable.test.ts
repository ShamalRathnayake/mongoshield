/**
 * Simulates a Node.js runtime without zstd (older than 22.15 / 23.8) by mocking
 * `node:zlib` without the zstd factories. Kept in its own file because the mock
 * applies to the whole module graph of the test file. That also covers the places
 * that pick a compression for the user (config presets, `mongoshield init`), which
 * must fall back to gzip rather than write "zstd" into a config that cannot run.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("node:zlib", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:zlib")>();
  return { ...original, createZstdCompress: undefined, createZstdDecompress: undefined };
});

const { createCompressor, createDecompressor, defaultCompression, isZstdAvailable } = await import(
  "./index.ts"
);
const { CONFIG_PRESETS } = await import("../config/presets.ts");
const { validateConfig } = await import("../config/load.ts");
const { generateConfigText } = await import("../cli/commands/init-template.ts");

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

  it("gives the Atlas presets gzip instead of zstd", () => {
    expect(CONFIG_PRESETS["atlas-free"].compression).toBe("gzip");
    expect(CONFIG_PRESETS["atlas-flex"].compression).toBe("gzip");
    const config = validateConfig({ preset: "atlas-free", storage: "./backups" });
    expect(config.compression).toBe("gzip");
  });

  it("writes gzip into the config file that init generates", () => {
    for (const preset of [undefined, "atlas-free"] as const) {
      const text = generateConfigText({
        storage: "./backups",
        uriEnv: "MONGODB_URI",
        ...(preset === undefined ? {} : { preset }),
      });
      expect(text).toContain('compression: "gzip"');
      expect(text).not.toContain('compression: "zstd"');
    }
  });
});
