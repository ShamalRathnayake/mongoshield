/**
 * Tests for the request validators: each helper accepts what it documents and
 * refuses everything else with a `400 CONSOLE_VALIDATION` naming the field.
 */

import { describe, expect, it } from "vitest";
import { ConsoleError } from "./errors.ts";
import {
  asObject,
  backupIdParam,
  oneOf,
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  optionalStringMap,
  queryInt,
  requiredBoolean,
  requiredString,
} from "./validate.ts";

/** Expects a validation error whose message matches `pattern`. */
function expectInvalid(action: () => unknown, pattern: RegExp): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleError);
    if (error instanceof ConsoleError) {
      expect(error.status).toBe(400);
      expect(error.code).toBe("CONSOLE_VALIDATION");
      expect(error.message).toMatch(pattern);
    }
    return;
  }
  throw new Error("expected a validation error");
}

describe("asObject", () => {
  it("accepts objects and refuses null, arrays and primitives", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    for (const value of [null, [], "x", 3, undefined]) {
      expectInvalid(() => asObject(value, '"plan"'), /"plan" must be a JSON object/);
    }
  });
});

describe("requiredString", () => {
  it("trims the value and enforces presence, length and no control characters", () => {
    expect(requiredString({ name: "  prod  " }, "name")).toBe("prod");
    expectInvalid(() => requiredString({}, "name"), /"name" is required/);
    expectInvalid(() => requiredString({ name: "   " }, "name"), /"name" is required/);
    expectInvalid(() => requiredString({ name: 3 }, "name"), /"name" is required/);
    expectInvalid(() => requiredString({ name: "abcdef" }, "name", 5), /at most 5 characters/);
    expectInvalid(() => requiredString({ name: "a\nb" }, "name"), /control characters/);
    expectInvalid(() => requiredString({ name: "a\u007fb" }, "name"), /control characters/);
  });
});

describe("optionalString", () => {
  it("keeps the exact value and treats null like absent", () => {
    expect(optionalString({ secret: " x " }, "secret")).toBe(" x ");
    expect(optionalString({ secret: null }, "secret")).toBeUndefined();
    expect(optionalString({}, "secret")).toBeUndefined();
    expectInvalid(() => optionalString({ secret: 1 }, "secret"), /must be a string/);
    expectInvalid(() => optionalString({ secret: "long" }, "secret", 3), /at most 3/);
  });
});

describe("requiredBoolean and oneOf", () => {
  it("accept only their allowed values", () => {
    expect(requiredBoolean({ production: false }, "production")).toBe(false);
    expectInvalid(() => requiredBoolean({ production: "yes" }, "production"), /true or false/);
    expect(oneOf({ mode: "deep" }, "mode", ["fast", "deep"])).toBe("deep");
    expectInvalid(() => oneOf({ mode: "slow" }, "mode", ["fast", "deep"]), /one of fast, deep/);
  });
});

describe("optionalPositiveInt", () => {
  it("accepts whole numbers from 0 to the maximum", () => {
    expect(optionalPositiveInt({ count: 0 }, "count", 10)).toBe(0);
    expect(optionalPositiveInt({ count: null }, "count", 10)).toBeUndefined();
    for (const count of [-1, 11, 1.5, "3"]) {
      expectInvalid(() => optionalPositiveInt({ count }, "count", 10), /between 0 and 10/);
    }
  });
});

describe("optionalStringArray", () => {
  it("trims entries and enforces item count, type, length and control characters", () => {
    expect(optionalStringArray({ list: [" a ", "b"] }, "list")).toEqual(["a", "b"]);
    expect(optionalStringArray({ list: null }, "list")).toBeUndefined();
    expectInvalid(() => optionalStringArray({ list: "a" }, "list"), /list of at most 100/);
    expectInvalid(
      () => optionalStringArray({ list: ["a", "b"] }, "list", { maxItems: 1 }),
      /at most 1 strings/,
    );
    for (const item of [1, "", "  ", "x".repeat(201), "a\tb"]) {
      expectInvalid(() => optionalStringArray({ list: [item] }, "list"), /Every entry of "list"/);
    }
  });
});

describe("optionalStringMap", () => {
  it("accepts string values and enforces entry count and lengths", () => {
    expect(optionalStringMap({ map: { a: "1" } }, "map")).toEqual({ a: "1" });
    expect(optionalStringMap({ map: undefined }, "map")).toBeUndefined();
    expectInvalid(() => optionalStringMap({ map: [] }, "map"), /must be a JSON object/);
    expectInvalid(
      () => optionalStringMap({ map: { a: "1", b: "2" } }, "map", { maxEntries: 1 }),
      /more than 1 entries/,
    );
    expectInvalid(() => optionalStringMap({ map: { a: 1 } }, "map"), /Every value of "map"/);
    expectInvalid(
      () => optionalStringMap({ map: { a: "long" } }, "map", { maxLength: 2 }),
      /at most 2 characters/,
    );
    expectInvalid(
      () => optionalStringMap({ map: { ["k".repeat(201)]: "v" } }, "map"),
      /Every value of "map"/,
    );
  });
});

describe("queryInt", () => {
  it("falls back when absent and refuses values outside the range", () => {
    const range = { min: 1, max: 100, fallback: 20 };
    expect(queryInt(undefined, "limit", range)).toBe(20);
    expect(queryInt("", "limit", range)).toBe(20);
    expect(queryInt("7", "limit", range)).toBe(7);
    for (const raw of ["0", "101", "2.5", "ten"]) {
      expectInvalid(() => queryInt(raw, "limit", range), /between 1 and 100/);
    }
  });
});

describe("backupIdParam", () => {
  it("accepts backup ids and refuses anything else, quoting at most 64 characters", () => {
    expect(backupIdParam("2026-11-14T03-00-04Z_7f3a9c")).toBe("2026-11-14T03-00-04Z_7f3a9c");
    expectInvalid(() => backupIdParam("../../etc/passwd"), /is not a backup id/);
    try {
      backupIdParam("x".repeat(500));
    } catch (error) {
      expect(error instanceof Error ? error.message.length : 0).toBeLessThan(100);
    }
  });
});
