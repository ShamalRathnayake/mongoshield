/**
 * Unit tests for the shared write-once retention rules (`./retention.ts`).
 * Adapter behaviour is covered by each adapter's tests and the conformance suite.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import {
  assertValidRetainUntil,
  isObjectLockedError,
  objectLockedError,
  onceSuccessful,
  rejectRetention,
  resolveRetentionMode,
} from "./retention.ts";

describe("resolveRetentionMode", () => {
  it("defaults to compliance and accepts both modes", () => {
    expect(resolveRetentionMode(undefined, "S3")).toBe("compliance");
    expect(resolveRetentionMode({ mode: "governance" }, "S3")).toBe("governance");
    expect(resolveRetentionMode({ mode: "compliance" }, "S3")).toBe("compliance");
  });

  it("rejects anything else with MS_CONFIG_INVALID naming the adapter", () => {
    expect(() => resolveRetentionMode({ mode: "COMPLIANCE" as "compliance" }, "GCS")).toThrow(
      /Invalid GCS retention mode/,
    );
  });
});

describe("assertValidRetainUntil", () => {
  const now = new Date("2026-11-14T03:00:00Z");

  it("accepts a date after now", () => {
    assertValidRetainUntil(new Date("2026-11-14T03:00:01Z"), "x", now);
  });

  it.each([
    ["now itself", new Date("2026-11-14T03:00:00Z")],
    ["the past", new Date("2020-01-01T00:00:00Z")],
    ["an invalid date", new Date("nope")],
  ])("rejects %s with MS_CONFIG_INVALID", (_label, date) => {
    expect(() => assertValidRetainUntil(date, "x", now)).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });
});

describe("rejectRetention", () => {
  it("does nothing without retainUntil", () => {
    rejectRetention({}, Buffer.from("x"), "file", "file:///b/");
  });

  it("throws MS_CONFIG_INVALID and destroys (without reading) a stream body", () => {
    let read = false;
    const body = new Readable({
      read() {
        read = true;
        this.push(null);
      },
    });
    expect(() =>
      rejectRetention({ retainUntil: new Date(Date.now() + 1000) }, body, "file", "file:///b/"),
    ).toThrow(expect.objectContaining({ code: "MS_CONFIG_INVALID" }));
    expect(read).toBe(false);
    expect(body.destroyed).toBe(true);
  });
});

describe("objectLockedError", () => {
  it("is MS_STORAGE_FORBIDDEN flagged as objectLocked, keeping other details", () => {
    const error = objectLockedError("locked", { details: { httpStatus: 403 } });
    expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(error.details).toEqual({ httpStatus: 403, objectLocked: true });
    expect(error.hint).toContain("write-once retention");
    expect(isObjectLockedError(error)).toBe(true);
  });

  it("does not match ordinary permission errors", () => {
    expect(isObjectLockedError(new MongoShieldError("MS_STORAGE_FORBIDDEN", "denied"))).toBe(false);
    expect(isObjectLockedError(new Error("locked"))).toBe(false);
  });
});

describe("onceSuccessful", () => {
  it("runs a passing check once, but retries a failed one", async () => {
    let calls = 0;
    let fail = true;
    const check = onceSuccessful(async () => {
      calls++;
      if (fail) throw new Error("bucket not ready");
    });
    await expect(check()).rejects.toThrow("bucket not ready");
    fail = false;
    await check();
    await check();
    expect(calls).toBe(2);
  });

  it("shares one in-flight check between concurrent callers", async () => {
    let calls = 0;
    const check = onceSuccessful(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await Promise.all([check(), check(), check()]);
    expect(calls).toBe(1);
  });
});
