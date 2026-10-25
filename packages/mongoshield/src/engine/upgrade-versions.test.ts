// Server version parsing, ordering and the in-place upgrade path of rehearsals.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import {
  compareVersions,
  formatVersion,
  isAtLeast,
  parseServerVersion,
  parseTargetVersion,
  releaseName,
  upgradePath,
} from "./upgrade-versions.ts";

/** Parses a version that is known to be valid (test shorthand). */
function v(text: string) {
  const parsed = parseServerVersion(text);
  if (parsed === undefined) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe("parseServerVersion", () => {
  it("reads major.minor and an optional patch", () => {
    expect(parseServerVersion("8.0")).toEqual({ major: 8, minor: 0, patch: undefined });
    expect(parseServerVersion("7.0.32")).toEqual({ major: 7, minor: 0, patch: 32 });
    expect(parseServerVersion(" 6.0.20 ")).toEqual({ major: 6, minor: 0, patch: 20 });
  });

  it("accepts pre-release and build suffixes", () => {
    expect(parseServerVersion("8.0.0-rc1")).toEqual({ major: 8, minor: 0, patch: 0 });
    expect(parseServerVersion("7.0.2+build.5")).toEqual({ major: 7, minor: 0, patch: 2 });
  });

  it("rejects what is not a version, and the 0.0.0 placeholder", () => {
    for (const text of ["unknown", "", "8", "eight.0", "8.0.x", "0.0.0", "8.0.1.2"]) {
      expect(parseServerVersion(text)).toBeUndefined();
    }
  });
});

describe("parseTargetVersion", () => {
  it("returns the version", () => {
    expect(parseTargetVersion("8.0.13")).toEqual({ major: 8, minor: 0, patch: 13 });
  });

  it("throws MS_CONFIG_INVALID with an example for anything else", () => {
    const error = (() => {
      try {
        parseTargetVersion("latest");
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("--target-version 8.0");
  });
});

describe("compareVersions and isAtLeast", () => {
  it("orders by major, minor, then patch", () => {
    expect(compareVersions(v("7.0.1"), v("8.0.0"))).toBeLessThan(0);
    expect(compareVersions(v("8.2.0"), v("8.0.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("8.0.2"), v("8.0.10"))).toBeLessThan(0);
    expect(compareVersions(v("8.0.3"), v("8.0.3"))).toBe(0);
  });

  it("treats a missing patch as any patch of the release", () => {
    expect(compareVersions(v("8.0"), v("8.0.13"))).toBe(0);
    expect(compareVersions(v("8.0.13"), v("8.0"))).toBe(0);
  });

  it("compares with a release name", () => {
    expect(isAtLeast(v("6.0.4"), "5.1")).toBe(true);
    expect(isAtLeast(v("5.0.30"), "5.1")).toBe(false);
    expect(isAtLeast(v("8.0"), "8.0")).toBe(true);
  });
});

describe("releaseName and formatVersion", () => {
  it("names the release series and keeps the patch when given", () => {
    expect(releaseName(v("8.0.13"))).toBe("8.0");
    expect(formatVersion(v("8.0.13"))).toBe("8.0.13");
    expect(formatVersion(v("8.0"))).toBe("8.0");
  });
});

describe("upgradePath", () => {
  it("is one step between neighbouring releases", () => {
    expect(upgradePath(v("7.0.32"), v("8.0.13"))).toEqual(["8.0"]);
  });

  it("steps through every long-term release in between", () => {
    expect(upgradePath(v("5.0.30"), v("8.0"))).toEqual(["6.0", "7.0", "8.0"]);
    expect(upgradePath(v("4.2.25"), v("6.0"))).toEqual(["4.4", "5.0", "6.0"]);
  });

  it("goes from a Rapid Release straight to the next long-term release", () => {
    expect(upgradePath(v("7.3.4"), v("8.0"))).toEqual(["8.0"]);
  });

  it("ends with a Rapid Release target after the long-term releases before it", () => {
    expect(upgradePath(v("6.0.20"), v("8.2.1"))).toEqual(["7.0", "8.0", "8.2"]);
  });

  it("adds majors newer than the known list as x.0 releases", () => {
    expect(upgradePath(v("8.0.13"), v("10.0"))).toEqual(["9.0", "10.0"]);
  });

  it("is empty when the target is not newer", () => {
    expect(upgradePath(v("8.0.4"), v("8.0.13"))).toEqual([]);
    expect(upgradePath(v("8.0.4"), v("7.0"))).toEqual([]);
  });
});
