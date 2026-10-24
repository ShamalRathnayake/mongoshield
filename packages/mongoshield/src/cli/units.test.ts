import { describe, expect, it } from "vitest";
import { parseByteSize, parseDuration } from "./units.ts";

describe("parseByteSize", () => {
  it("reads binary and decimal units, case-insensitively", () => {
    expect(parseByteSize("256MiB")).toBe(256 * 1024 * 1024);
    expect(parseByteSize("1gib")).toBe(1024 ** 3);
    expect(parseByteSize("50MB")).toBe(50_000_000);
    expect(parseByteSize("1.5KiB")).toBe(1536);
    expect(parseByteSize("4096")).toBe(4096);
    expect(parseByteSize("10 B")).toBe(10);
  });

  it("rejects anything else", () => {
    for (const text of ["", "MiB", "12 parsecs", "-1MiB", "0", "1e3"]) {
      expect(parseByteSize(text), text).toBeUndefined();
    }
  });
});

describe("parseDuration", () => {
  it("reads ms, s, m and h, also combined", () => {
    expect(parseDuration("14m")).toBe(14 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("1.5h")).toBe(90 * 60_000);
  });

  it("requires a unit and a positive length", () => {
    for (const text of ["15", "", "m", "0s", "14 minutes", "-5m"]) {
      expect(parseDuration(text), text).toBeUndefined();
    }
  });
});
