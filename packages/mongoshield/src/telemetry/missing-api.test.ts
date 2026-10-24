/**
 * `@opentelemetry/api` is an optional peer dependency. This file simulates it being
 * absent (in its own module registry, so other tests keep the real package) and
 * checks that telemetry quietly turns itself off and every operation still works.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
  throw Object.assign(new Error("Cannot find package '@opentelemetry/api'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

describe("telemetry without @opentelemetry/api installed", () => {
  it("resolves the API to undefined instead of failing", async () => {
    const { loadOpenTelemetryApi } = await import("./load-api.ts");
    await expect(loadOpenTelemetryApi()).resolves.toBeUndefined();
  });

  it("runs traced functions and records metrics as no-ops", async () => {
    const { Telemetry } = await import("./telemetry.ts");
    const telemetry = new Telemetry({ includeNamespaces: true });
    await expect(telemetry.withSpan("mongoshield.test", { a: 1 }, async () => "ok")).resolves.toBe(
      "ok",
    );
    await expect(telemetry.count("documents", 1, {})).resolves.toBeUndefined();
    await expect(telemetry.recordDuration("restoreDuration", 10, {})).resolves.toBeUndefined();
  });

  it("leaves the MongoShield API working", async () => {
    const { MongoShield } = await import("../shield.ts");
    const { memoryStorage } = await import("../storage/memory.ts");
    const shield = new MongoShield({ storage: memoryStorage() });
    const result = await shield.prune({ last: 1 });
    expect(result.deletedBackups).toBe(0);
    await expect(shield.verify({ backup: "latest" })).rejects.toMatchObject({
      code: "MS_BACKUP_NOT_FOUND",
    });
  });
});
