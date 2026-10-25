/**
 * The Azure SDK is an optional peer dependency. This file simulates it being
 * absent (in its own module registry, so other tests keep the real SDK) and
 * checks that users get MS_CONFIG_INVALID with the install command as the hint.
 */

import { describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";

vi.mock("@azure/storage-blob", () => {
  throw Object.assign(new Error("Cannot find package '@azure/storage-blob'"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
});

describe("azureStorage without the Azure SDK installed", () => {
  it("creates the adapter, then fails the first call with MS_CONFIG_INVALID and an install hint", async () => {
    const { azureStorage } = await import("./azure.ts");
    const storage = azureStorage({
      connectionString: "UseDevelopmentStorage=true",
      container: "backups",
    });
    const error = await storage.head("a").catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toBe("npm install @azure/storage-blob");
  });
});
