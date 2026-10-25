import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { openConnection } from "./connection.ts";

// Nothing listens on port 1, so the driver keeps looking for a server until its
// selection timeout (set long here). Only the signal can end the wait early.
const UNREACHABLE = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=30000&connectTimeoutMS=30000";

describe("openConnection cancellation", () => {
  it("stops connecting as soon as the signal aborts", async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 100);

    const error = await openConnection({ uri: UNREACHABLE }, { signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );

    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
    // Far below the 30 s selection timeout: the abort, not the driver, ended the wait.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("refuses to start with an already aborted signal", async () => {
    const error = await openConnection({ uri: UNREACHABLE }, { signal: AbortSignal.abort() }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_ABORTED")).toBe(true);
  });

  it("reports a timeout signal as MS_TIMEOUT", async () => {
    const error = await openConnection(
      { uri: UNREACHABLE },
      { signal: AbortSignal.timeout(100) },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_TIMEOUT")).toBe(true);
  });
});
