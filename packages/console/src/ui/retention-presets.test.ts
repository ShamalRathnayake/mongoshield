/**
 * Tests for the plan editor's retention presets: the counts each one fills in, and
 * which form values read back as a preset (anything else is "custom").
 */

import { describe, expect, it } from "vitest";
import { retentionPresetOf, retentionTextFor } from "./retention-presets.ts";

/** Empty buckets, changed where a test says. */
const text = (changes: Partial<Record<string, string>>) => ({
  last: "",
  daily: "",
  weekly: "",
  monthly: "",
  yearly: "",
  ...changes,
});

describe("retention presets", () => {
  it("fills in each preset's counts and leaves the other buckets empty", () => {
    expect(retentionTextFor("recommended")).toEqual(
      text({ daily: "7", weekly: "4", monthly: "12" }),
    );
    expect(retentionTextFor("last7")).toEqual(text({ last: "7" }));
    expect(retentionTextFor("last30")).toEqual(text({ last: "30" }));
    expect(retentionTextFor("forever")).toEqual(text({}));
  });

  it("reads matching counts back as their preset", () => {
    expect(retentionPresetOf(text({ daily: "7", weekly: "4", monthly: "12" }))).toBe("recommended");
    expect(retentionPresetOf(text({ last: " 30 " }))).toBe("last30");
    expect(retentionPresetOf(text({}))).toBe("forever");
  });

  it("calls anything else custom", () => {
    expect(retentionPresetOf(text({ last: "3", daily: "7", weekly: "4", monthly: "12" }))).toBe(
      "custom",
    );
    expect(retentionPresetOf(text({ last: "24" }))).toBe("custom");
    // "0" is not the same as an empty bucket.
    expect(retentionPresetOf(text({ last: "7", yearly: "0" }))).toBe("custom");
  });
});
