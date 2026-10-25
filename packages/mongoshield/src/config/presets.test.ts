// Unit tests for config presets (presets.ts, applied by validateConfig in load.ts):
// a preset fills in what nothing else sets, every other layer wins over it key by
// key, it may come from any layer, and an unknown name is reported with the valid ones.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { ATLAS_SHARED_TIER_TUNING } from "../mongo/atlas.ts";
import { loadConfig, validateConfig } from "./load.ts";
import { CONFIG_PRESET_NAMES, CONFIG_PRESETS, isConfigPresetName } from "./presets.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-presets-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("config presets", () => {
  it("fills in the Atlas Free defaults under a config that names the preset", () => {
    const config = validateConfig({ preset: "atlas-free", storage: "./backups" });
    expect(config.preset).toBe("atlas-free");
    expect(config.compression).toBe("zstd");
    expect(config.backup).toEqual({
      consistency: "auto",
      parallelism: ATLAS_SHARED_TIER_TUNING.parallelism,
      maxBytesPerSecond: ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond,
    });
    expect(config.retention).toEqual({ last: 7, weekly: 4, monthly: 6 });
  });

  it("reads Flex clusters twice as fast as Free ones", () => {
    const config = validateConfig({ preset: "atlas-flex", storage: "./backups" });
    expect(config.backup?.maxBytesPerSecond).toBe(2 * ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond);
  });

  it("lets every value the config sets win, key by key", () => {
    const config = validateConfig({
      preset: "atlas-free",
      storage: "./backups",
      compression: "gzip",
      backup: { maxBytesPerSecond: 1024, exclude: ["*.sessions"] },
      retention: { last: 2 },
    });
    expect(config.compression).toBe("gzip");
    // The preset's other backup settings stay; the config's own are added or win.
    expect(config.backup).toEqual({
      consistency: "auto",
      parallelism: 2,
      maxBytesPerSecond: 1024,
      exclude: ["*.sessions"],
    });
    // Retention merges key by key too: the preset's weekly/monthly stay.
    expect(config.retention).toEqual({ last: 2, weekly: 4, monthly: 6 });
  });

  it("changes nothing without a preset", () => {
    const config = validateConfig({ storage: "./backups" });
    expect(config.backup).toBeUndefined();
    expect(config.retention).toBeUndefined();
  });

  it("reports an unknown preset with the valid names", () => {
    let caught: unknown;
    try {
      validateConfig({ preset: "atlas-m10", storage: "./backups" });
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(caught)).toContain("preset");
    expect(String(caught)).toContain("atlas-free");
  });

  it("applies a preset named by a flag to a config file that does not name one", async () => {
    await writeFile(
      join(directory, "mongoshield.config.json"),
      JSON.stringify({ storage: "./backups", backup: { parallelism: 3 } }),
    );
    const { config } = await loadConfig({
      cwd: directory,
      env: {},
      overrides: { preset: "atlas-free" },
    });
    expect(config.backup?.parallelism).toBe(3);
    expect(config.backup?.maxBytesPerSecond).toBe(ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond);
  });

  it("never sets where data comes from or goes to", () => {
    for (const name of CONFIG_PRESET_NAMES) {
      expect(Object.keys(CONFIG_PRESETS[name])).not.toContain("source");
      expect(Object.keys(CONFIG_PRESETS[name])).not.toContain("storage");
      expect(Object.keys(CONFIG_PRESETS[name])).not.toContain("encryption");
    }
  });

  it("recognises preset names", () => {
    expect(isConfigPresetName("atlas-free")).toBe(true);
    expect(isConfigPresetName("atlas-flex")).toBe(true);
    expect(isConfigPresetName("atlas")).toBe(false);
    expect(isConfigPresetName(undefined)).toBe(false);
  });
});
