import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MongoShieldError } from "../errors.ts";
import { manifestKey } from "../format/layout.ts";
import type { Logger } from "../logger.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { completedAtOf, immutableUntilOf, listBackups } from "./catalog.ts";
import {
  idAt,
  makeManifest,
  putCompleteBackup,
  putIncompleteBackup,
  putInvalidBackup,
} from "./test-fixtures.ts";

/** A logger whose methods are typed spies. */
function spyLogger() {
  return {
    debug: vi.fn<Logger["debug"]>(),
    info: vi.fn<Logger["info"]>(),
    warn: vi.fn<Logger["warn"]>(),
    error: vi.fn<Logger["error"]>(),
  } satisfies Logger;
}

describe("listBackups", () => {
  it("returns an empty list for empty storage", async () => {
    expect(await listBackups(memoryStorage())).toEqual([]);
  });

  it("classifies complete, incomplete and invalid backups, newest first", async () => {
    const storage = memoryStorage();
    const oldest = idAt("2026-10-18T03:00:00Z");
    const middle = idAt("2026-10-19T03:00:00Z");
    const newest = idAt("2026-10-20T03:00:00Z");
    await putCompleteBackup(storage, oldest);
    await putInvalidBackup(storage, middle);
    await putIncompleteBackup(storage, newest);

    const entries = await listBackups(storage);

    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      [newest, "incomplete"],
      [middle, "invalid"],
      [oldest, "complete"],
    ]);
    expect(entries[2]?.manifest?.id).toBe(oldest);
    expect(entries[1]?.error).toMatch(/not valid JSON/);
    expect(entries[0]?.manifest).toBeUndefined();
  });

  it("decodes the start time from the id", async () => {
    const storage = memoryStorage();
    await putIncompleteBackup(storage, idAt("2026-10-20T03:04:05Z"));
    const [entry] = await listBackups(storage);
    expect(entry?.startedAt).toEqual(new Date("2026-10-20T03:04:05Z"));
  });

  it("ignores directories that are not backup ids and logs them at debug level", async () => {
    const storage = memoryStorage();
    const logger = spyLogger();
    await storage.put("backups/notes/readme.txt", Buffer.from("hello"));
    await storage.put("backups/stray-file.txt", Buffer.from("hello"));
    await putCompleteBackup(storage, idAt("2026-10-20T03:00:00Z"));

    const entries = await listBackups(storage, { logger });

    expect(entries).toHaveLength(1);
    expect(logger.debug).toHaveBeenCalledWith("Ignoring a directory that is not a backup", {
      prefix: "backups/notes/",
    });
  });

  it("reports a manifest that does not match the schema as invalid", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-10-20T03:00:00Z");
    await putInvalidBackup(storage, id, JSON.stringify({ formatVersion: 1, id }));
    const [entry] = await listBackups(storage);
    expect(entry?.status).toBe("invalid");
    expect(entry?.error).toMatch(/does not match the manifest schema/);
  });

  it("reports a manifest from a newer format version as invalid", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-10-20T03:00:00Z");
    await putInvalidBackup(storage, id, JSON.stringify({ formatVersion: 99 }));
    const [entry] = await listBackups(storage);
    expect(entry?.status).toBe("invalid");
    expect(entry?.error).toMatch(/format version 99/);
  });

  it("reports a manifest that describes a different backup as invalid", async () => {
    const storage = memoryStorage();
    const id = idAt("2026-10-20T03:00:00Z");
    const other = idAt("2026-10-19T03:00:00Z");
    await putInvalidBackup(storage, id, JSON.stringify(makeManifest(other)));
    const [entry] = await listBackups(storage);
    expect(entry?.status).toBe("invalid");
    expect(entry?.error).toContain(`belongs to backup ${other}`);
  });

  it("fails on storage errors instead of hiding backups", async () => {
    const inner = memoryStorage();
    await putCompleteBackup(inner, idAt("2026-10-20T03:00:00Z"));
    const storage: StorageAdapter = {
      ...inner,
      get: async () => {
        throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "access denied");
      },
    };
    await expect(listBackups(storage)).rejects.toMatchObject({ code: "MS_STORAGE_FORBIDDEN" });
  });

  it("reads at most 8 manifests at a time", async () => {
    const inner = memoryStorage();
    for (let index = 0; index < 30; index++) {
      await putCompleteBackup(
        inner,
        idAt("2026-10-20T03:00:00Z", index.toString(16).padStart(6, "0")),
      );
    }
    let active = 0;
    let maxActive = 0;
    const storage: StorageAdapter = {
      ...inner,
      get: async (key, options): Promise<Readable> => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return inner.get(key, options);
      },
    };

    const entries = await listBackups(storage);

    expect(entries).toHaveLength(30);
    expect(entries.every((entry) => entry.status === "complete")).toBe(true);
    expect(maxActive).toBe(8);
  });

  it("stops when the signal is aborted", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-20T03:00:00Z"));
    const controller = new AbortController();
    controller.abort();
    await expect(listBackups(storage, { signal: controller.signal })).rejects.toMatchObject({
      code: "MS_ABORTED",
    });
  });
});

describe("completedAtOf", () => {
  it("returns the manifest's completion time for complete backups only", async () => {
    const storage = memoryStorage();
    const complete = idAt("2026-10-20T03:00:00Z");
    await putCompleteBackup(storage, complete, { completedAt: "2026-10-20T04:00:00Z" });
    await putIncompleteBackup(storage, idAt("2026-10-21T03:00:00Z"));
    const [incompleteEntry, completeEntry] = await listBackups(storage);
    expect(completeEntry && completedAtOf(completeEntry)).toEqual(new Date("2026-10-20T04:00:00Z"));
    expect(incompleteEntry && completedAtOf(incompleteEntry)).toBeUndefined();
    expect(await storage.head(manifestKey(complete))).toBeDefined();
  });
});

describe("immutableUntilOf", () => {
  it("returns the manifest's immutableUntil, or undefined without retention", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, idAt("2026-10-20T03:00:00Z"), {
      immutableUntil: "2026-11-20T03:01:00.000Z",
    });
    await putCompleteBackup(storage, idAt("2026-10-19T03:00:00Z"));
    await putIncompleteBackup(storage, idAt("2026-10-21T03:00:00Z"));
    const [incomplete, immutable, plain] = await listBackups(storage);
    expect(immutable && immutableUntilOf(immutable)).toEqual(new Date("2026-11-20T03:01:00Z"));
    expect(plain && immutableUntilOf(plain)).toBeUndefined();
    expect(incomplete && immutableUntilOf(incomplete)).toBeUndefined();
  });
});
