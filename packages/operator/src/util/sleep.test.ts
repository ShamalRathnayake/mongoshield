/** Tests for interruptible sleeping. */

import { describe, expect, it } from "vitest";
import { abortableSleep } from "./sleep.ts";

describe("abortableSleep", () => {
  it("waits, or returns early on abort", async () => {
    const started = Date.now();
    await abortableSleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);

    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();
    await sleeping;

    await abortableSleep(60_000, AbortSignal.abort());
  });
});
