import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/index";

describe("Core Module", () => {
  it("should export a version string", () => {
    expect(VERSION).toBeDefined();
    expect(typeof VERSION).toBe("string");
  });
});
