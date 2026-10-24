import { afterEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import {
  backoffDelay,
  isTransientError,
  RetriesExhaustedError,
  sleep,
  withRetries,
} from "./retry.ts";

const FAST = { retries: 2, baseDelayMs: 1, maxDelayMs: 4 };

describe("backoffDelay", () => {
  const policy = { baseDelayMs: 1000, maxDelayMs: 5000 };

  it("doubles each retry, with a random half (equal jitter)", () => {
    expect(backoffDelay(1, policy, () => 0)).toBe(500);
    expect(backoffDelay(1, policy, () => 0.999_999)).toBe(1000);
    expect(backoffDelay(2, policy, () => 0)).toBe(1000);
    expect(backoffDelay(3, policy, () => 0)).toBe(2000);
  });

  it("never exceeds the maximum delay", () => {
    expect(backoffDelay(20, policy, () => 0.999_999)).toBe(5000);
  });
});

describe("isTransientError", () => {
  it("treats connection and storage I/O errors as transient, and nothing else", () => {
    expect(isTransientError(new MongoShieldError("MS_CONNECTION_FAILED"))).toBe(true);
    expect(isTransientError(new MongoShieldError("MS_STORAGE_IO"))).toBe(true);
    expect(isTransientError(new MongoShieldError("MS_CONFIG_INVALID"))).toBe(false);
    expect(isTransientError(new MongoShieldError("MS_INTEGRITY_FAILED"))).toBe(false);
    expect(isTransientError(new Error("plain"))).toBe(false);
  });
});

describe("withRetries", () => {
  it("retries transient failures and reports the attempts", async () => {
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new MongoShieldError("MS_STORAGE_IO");
        return "done";
      },
      { policy: FAST, step: "test" },
    );
    expect(result).toEqual({ value: "done", attempts: 3 });
  });

  it("gives up after the configured retries", async () => {
    const task = vi.fn(async () => {
      throw new MongoShieldError("MS_CONNECTION_FAILED");
    });
    const error = await withRetries(task, { policy: FAST, step: "test" }).catch((e: unknown) => e);
    expect(task).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(error instanceof RetriesExhaustedError && error.attempts).toBe(3);
  });

  it("never retries a config, integrity or guard failure", async () => {
    const task = vi.fn(async () => {
      throw new MongoShieldError("MS_INTEGRITY_FAILED");
    });
    const error = await withRetries(task, { policy: FAST, step: "test" }).catch((e: unknown) => e);
    expect(task).toHaveBeenCalledTimes(1);
    expect(
      error instanceof RetriesExhaustedError &&
        isMongoShieldError(error.cause, "MS_INTEGRITY_FAILED"),
    ).toBe(true);
  });

  it("stops waiting for the next attempt when aborted", async () => {
    const controller = new AbortController();
    const promise = withRetries(
      async () => {
        controller.abort();
        throw new MongoShieldError("MS_STORAGE_IO");
      },
      {
        policy: { retries: 5, baseDelayMs: 60_000, maxDelayMs: 60_000 },
        step: "test",
        signal: controller.signal,
      },
    );
    const error = await promise.catch((e: unknown) => e);
    expect(
      error instanceof RetriesExhaustedError && isMongoShieldError(error.cause, "MS_ABORTED"),
    ).toBe(true);
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleep(1000).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
  });

  it("rejects with a typed error when aborted", async () => {
    const controller = new AbortController();
    const promise = sleep(60_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "MS_ABORTED" });
  });
});
