/** Tests for bounded object names. */

import { describe, expect, it } from "vitest";
import { boundedName, CRONJOB_NAME_MAX, labelValue } from "./names.ts";

describe("boundedName", () => {
  it("keeps short names as they are", () => {
    expect(boundedName("nightly")).toBe("nightly");
    expect(boundedName("a".repeat(63))).toBe("a".repeat(63));
  });

  it("shortens long names with a hash suffix that keeps them unique", () => {
    const one = boundedName(`${"x".repeat(70)}-one`);
    const two = boundedName(`${"x".repeat(70)}-two`);
    expect(one).toHaveLength(63);
    expect(one).not.toBe(two);
    expect(one).toMatch(/^x+-[0-9a-f]{8}$/);
    expect(boundedName("y".repeat(80), CRONJOB_NAME_MAX)).toHaveLength(52);
  });

  it("never leaves a dash or dot before the hash", () => {
    const name = boundedName(`${"a".repeat(53)}----${"b".repeat(20)}`);
    expect(name).toMatch(/^a+-[0-9a-f]{8}$/);
    expect(labelValue("short")).toBe("short");
  });
});
