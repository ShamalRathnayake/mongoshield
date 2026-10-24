/**
 * Runs the shared storage conformance suite against the in-memory adapter, in
 * its normal and object lock test modes, plus the memory-only helpers
 * (`keys()`, `clear()`, `retainUntilOf()`) and retention expiry.
 */

import { describe, expect, it } from "vitest";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "./memory.ts";

describeStorageConformance("memory", async () => ({
  storage: memoryStorage(),
  cleanup: async () => {},
}));

describeStorageConformance("memory (object lock mode)", async () => ({
  storage: memoryStorage({ objectLock: true }),
  cleanup: async () => {},
}));

describe("memoryStorage", () => {
  it("shows its name in the location", () => {
    expect(memoryStorage({ name: "scratch" }).location).toBe("memory://scratch/");
    expect(memoryStorage().location).toBe("memory://default/");
  });

  it("exposes sorted keys and can be cleared", async () => {
    const storage = memoryStorage();
    await storage.put("b", Buffer.from("b"));
    await storage.put("a/c", Buffer.from("c"));
    expect(storage.keys()).toEqual(["a/c", "b"]);
    storage.clear();
    expect(storage.keys()).toEqual([]);
  });

  it("declares object lock only in object lock mode", () => {
    expect(memoryStorage().capabilities.objectLock).toBe(false);
    expect(memoryStorage({ objectLock: true }).capabilities.objectLock).toBe(true);
  });

  it("releases a locked object once its retention has passed", async () => {
    let now = new Date("2026-11-14T03:00:00Z");
    const storage = memoryStorage({ objectLock: true, now: () => now });
    const retainUntil = new Date("2026-11-21T03:00:00Z");
    await storage.put("a.bin", Buffer.from("x"), { retainUntil });
    expect(storage.retainUntilOf("a.bin")).toEqual(retainUntil);

    const refused = await storage.delete(["a.bin"]).catch((error: unknown) => error);
    expect(isMongoShieldError(refused, "MS_STORAGE_FORBIDDEN")).toBe(true);
    expect(String(refused)).toContain("immutable until 2026-11-21T03:00:00.000Z");

    now = new Date("2026-11-21T03:00:01Z");
    await storage.delete(["a.bin"]);
    expect(storage.keys()).toEqual([]);
  });

  it("refuses a whole delete call when any key is locked, deleting nothing", async () => {
    const storage = memoryStorage({ objectLock: true });
    await storage.put("free.bin", Buffer.from("x"));
    await storage.put("locked.bin", Buffer.from("y"), {
      retainUntil: new Date(Date.now() + 60_000),
    });
    await expect(storage.delete(["free.bin", "locked.bin"])).rejects.toMatchObject({
      code: "MS_STORAGE_FORBIDDEN",
    });
    expect(storage.keys()).toEqual(["free.bin", "locked.bin"]);
  });

  it("keeps the original retention when a conditional create loses the race", async () => {
    const storage = memoryStorage({ objectLock: true });
    const retainUntil = new Date(Date.now() + 60_000);
    await storage.put("m.json", Buffer.from("1"), { retainUntil, ifNoneMatch: "*" });
    await expect(
      storage.put("m.json", Buffer.from("2"), { ifNoneMatch: "*" }),
    ).rejects.toMatchObject({ code: "MS_STORAGE_PRECONDITION_FAILED" });
    expect(storage.retainUntilOf("m.json")).toEqual(retainUntil);
  });

  it("clear() removes locked objects too (it is a test helper)", async () => {
    const storage = memoryStorage({ objectLock: true });
    await storage.put("a", Buffer.from("a"), { retainUntil: new Date(Date.now() + 60_000) });
    storage.clear();
    expect(storage.keys()).toEqual([]);
  });
});
