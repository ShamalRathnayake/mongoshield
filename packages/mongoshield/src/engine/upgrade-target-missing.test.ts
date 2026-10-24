// mongodb-memory-server is an optional dependency: without it, an ephemeral upgrade
// rehearsal fails with MS_CONFIG_INVALID and the install command as the hint. The
// package is simulated absent in this file's own module registry.

import { describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { silentLogger } from "../logger.ts";

vi.mock("mongodb-memory-server", () => {
  throw Object.assign(new Error("Cannot find package 'mongodb-memory-server'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

describe("startEphemeralServer without mongodb-memory-server", () => {
  it("fails with MS_CONFIG_INVALID and an install hint", async () => {
    const { startEphemeralServer, EPHEMERAL_INSTALL_HINT } = await import("./upgrade-target.ts");
    const { parseTargetVersion } = await import("./upgrade-versions.ts");
    const error = await startEphemeralServer({
      version: parseTargetVersion("8.0.13"),
      logger: silentLogger,
    }).catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBe(EPHEMERAL_INSTALL_HINT);
    expect((error as Error).message).toContain("needs an optional package");
  });
});
