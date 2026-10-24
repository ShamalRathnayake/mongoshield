import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { validateRunSettings } from "./backup-options.ts";
import { DEFAULT_PART_SIZE_BYTES } from "./backup-parts.ts";
import { batchSizeFor, resolveReadPreference, TARGET_BATCH_BYTES } from "./backup-reads.ts";

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return isMongoShieldError(error) ? error.code : "not a MongoShieldError";
  }
  return undefined;
}

describe("resolveReadPreference", () => {
  it("defaults to secondaryPreferred", () => {
    expect(resolveReadPreference({}, "none").mode).toBe("secondaryPreferred");
    expect(resolveReadPreference({}, "converge").mode).toBe("secondaryPreferred");
  });

  it("passes tag sets on", () => {
    const preference = resolveReadPreference(
      { readPreference: "secondary", readPreferenceTags: [{ use: "backup" }, {}] },
      "none",
    );
    expect(preference.mode).toBe("secondary");
    expect(preference.tags).toEqual([{ use: "backup" }, {}]);
  });

  it("always reads snapshots from the primary", () => {
    expect(resolveReadPreference({ readPreference: "secondary" }, "snapshot").mode).toBe("primary");
  });
});

describe("batchSizeFor", () => {
  it("aims at about 4 MiB per batch", () => {
    expect(batchSizeFor(1024)).toBe(TARGET_BATCH_BYTES / 1024);
  });

  it("stays within sane bounds and falls back to the driver default", () => {
    expect(batchSizeFor(10)).toBe(100_000);
    expect(batchSizeFor(10 * 1024 * 1024)).toBe(16);
    expect(batchSizeFor(undefined)).toBeUndefined();
    expect(batchSizeFor(0)).toBeUndefined();
  });
});

describe("validateRunSettings", () => {
  it("applies the defaults", () => {
    expect(validateRunSettings({})).toEqual({
      partSizeBytes: DEFAULT_PART_SIZE_BYTES,
      resumable: false,
    });
  });

  it("marks runs with maxDurationMs or resume as resumable", () => {
    expect(validateRunSettings({ maxDurationMs: 1000 }).resumable).toBe(true);
    expect(validateRunSettings({ resume: "latest" }).resumable).toBe(true);
    expect(validateRunSettings({ resume: "auto" }).resumable).toBe(true);
    expect(validateRunSettings({ resume: "2026-11-14T03-00-04Z_7f3a9c" }).resumable).toBe(true);
  });

  it("rejects malformed values", () => {
    const bad = [
      { partSizeBytes: 0 },
      { partSizeBytes: 1.5 },
      { maxDurationMs: -1 },
      { maxDocumentsPerSecond: 0 },
      { maxBytesPerSecond: Number.POSITIVE_INFINITY },
      { retainDays: 0.5 },
      { resume: "yesterday" },
      { readPreference: "fastest" as "primary" },
      { readPreference: "primary" as const, readPreferenceTags: [{ dc: "east" }] },
    ];
    for (const options of bad) {
      expect(
        codeOf(() => validateRunSettings(options)),
        JSON.stringify(options),
      ).toBe("MS_CONFIG_INVALID");
    }
  });

  it("refuses snapshot and converge for resumable runs", () => {
    expect(codeOf(() => validateRunSettings({ maxDurationMs: 1, consistency: "snapshot" }))).toBe(
      "MS_CONFIG_INVALID",
    );
    expect(codeOf(() => validateRunSettings({ resume: "latest", consistency: "converge" }))).toBe(
      "MS_CONFIG_INVALID",
    );
    expect(validateRunSettings({ maxDurationMs: 1, consistency: "none" }).resumable).toBe(true);
  });
});
