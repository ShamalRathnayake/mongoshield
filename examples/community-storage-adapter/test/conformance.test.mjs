/**
 * Proves the example adapter keeps the StorageAdapter contract: mongoshield's contract
 * test kit runs against it, plus a check that its scheme is registered.
 *
 * Run inside this folder with `npm test` (Vitest). In the MongoShield repository it
 * also runs as part of the mongoshield package's unit tests, where `mongoshield`
 * resolves to the package's source (packages/mongoshield/vitest.config.ts).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isStorageSchemeRegistered, resolveStorage } from "mongoshield";
import { describeStorageConformance } from "mongoshield/testing/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flatFolderStorage, SCHEME } from "../index.mjs";

// The kit registers its tests through the framework functions it is given.
describeStorageConformance(
  "flat-folder",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "flat-folder-"));
    return {
      storage: flatFolderStorage({ folder }),
      cleanup: () => rm(folder, { recursive: true, force: true }),
    };
  },
  { describe, it, beforeEach, afterEach },
);

describe("the flatdir:// scheme", () => {
  it("is registered by importing the package", () => {
    expect(isStorageSchemeRegistered(SCHEME)).toBe(true);
  });

  it("resolves a flatdir:// URL to the adapter", async () => {
    const folder = await mkdtemp(join(tmpdir(), "flat-folder-url-"));
    try {
      const url = pathToFileURL(folder).href.replace(/^file:/, `${SCHEME}:`);
      const storage = await resolveStorage(url);
      expect(storage.kind).toBe("flat-folder");
      await storage.put("backups/a/manifest.json", Buffer.from("{}"));
      expect((await storage.head("backups/a/manifest.json"))?.size).toBe(2);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
