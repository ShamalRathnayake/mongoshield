import { describe, expect, it } from "vitest";
import { abortError, ERROR_CODES, isMongoShieldError, MongoShieldError } from "./errors.ts";

describe("MongoShieldError", () => {
  it("falls back to the code's description when no message is given", () => {
    const error = new MongoShieldError("MS_BACKUP_NOT_FOUND");
    expect(error.message).toBe(ERROR_CODES.MS_BACKUP_NOT_FOUND.description);
    expect(error.exitCode).toBe(30);
    expect(error.docsUrl).toContain("#ms_backup_not_found");
  });

  it("keeps the hint and the original cause", () => {
    const cause = new Error("socket hang up");
    const error = new MongoShieldError("MS_STORAGE_IO", "Upload failed", { hint: "Retry", cause });
    expect(error.hint).toBe("Retry");
    expect(error.cause).toBe(cause);
  });

  it("can be recognised by code", () => {
    const error = new MongoShieldError("MS_ABORTED");
    expect(isMongoShieldError(error)).toBe(true);
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(false);
    expect(isMongoShieldError(new Error("plain"))).toBe(false);
  });

  it("uses unique exit codes", () => {
    const exitCodes = Object.values(ERROR_CODES).map((info) => info.exitCode);
    expect(new Set(exitCodes).size).toBe(exitCodes.length);
  });
});

describe("abortError", () => {
  it("maps a timeout signal to MS_TIMEOUT", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(abortError(signal).code).toBe("MS_TIMEOUT");
  });

  it("maps a manual abort to MS_ABORTED", () => {
    const controller = new AbortController();
    controller.abort();
    expect(abortError(controller.signal).code).toBe("MS_ABORTED");
  });
});
