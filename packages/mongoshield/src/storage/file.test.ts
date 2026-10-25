/**
 * Tests for the filesystem adapter: the shared conformance suite in a temp
 * directory, plus file-specific behaviour (temp files, directory pruning,
 * errno mapping, location format, free-space checks).
 */

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import { availableBytes, fileStorage } from "./file.ts";
import type { StorageAdapter } from "./types.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mongoshield-file-storage-"));
}

describeStorageConformance("file", async () => {
  const root = await makeTempRoot();
  return {
    storage: fileStorage({ path: join(root, "store") }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe("fileStorage", () => {
  let root: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    root = await makeTempRoot();
    storage = fileStorage({ path: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Every file and directory under the root, relative and sorted, including hidden ones. */
  async function treeOnDisk(): Promise<string[]> {
    const entries = await readdir(root, { recursive: true });
    return entries.map((entry) => entry.split("\\").join("/")).sort();
  }

  it("reports kind 'file' and a file:// location with a trailing slash", () => {
    expect(storage.kind).toBe("file");
    expect(storage.location).toBe(`${pathToFileURL(root).href}/`);
  });

  it("rejects an empty path with MS_CONFIG_INVALID", () => {
    expect(() => fileStorage({ path: "" })).toThrow(
      expect.objectContaining({ code: "MS_CONFIG_INVALID" }),
    );
  });

  it("stores keys as plain files under the root", async () => {
    await storage.put("backups/one/manifest.json", Buffer.from("{}"));
    expect(await treeOnDisk()).toEqual(["backups", "backups/one", "backups/one/manifest.json"]);
  });

  it("creates the root directory on the first write", async () => {
    const nested = fileStorage({ path: join(root, "does", "not", "exist") });
    await nested.put("x", Buffer.from("x"));
    expect((await stat(join(root, "does", "not", "exist", "x"))).isFile()).toBe(true);
  });

  it("leaves no temp files behind after successful plain and conditional writes", async () => {
    await storage.put("dir/plain", Readable.from([Buffer.from("a")]));
    await storage.put("dir/conditional", Buffer.from("b"), { ifNoneMatch: "*" });
    await expect(
      storage.put("dir/conditional", Buffer.from("c"), { ifNoneMatch: "*" }),
    ).rejects.toThrow();
    expect(await treeOnDisk()).toEqual(["dir", "dir/conditional", "dir/plain"]);
  });

  it("removes its temp file and created directories when the body fails", async () => {
    async function* failing() {
      yield Buffer.from("partial");
      throw new Error("boom");
    }
    await expect(storage.put("new/deep/object", Readable.from(failing()))).rejects.toThrow();
    expect(await treeOnDisk()).toEqual([]);
  });

  it("wraps a plain body-stream error in MS_STORAGE_IO naming the key", async () => {
    async function* failing() {
      yield Buffer.from("partial");
      throw new Error("cursor died");
    }
    await expect(storage.put("obj", Readable.from(failing()))).rejects.toMatchObject({
      code: "MS_STORAGE_IO",
      message: expect.stringContaining("obj: cursor died"),
    });
  });

  it("hides temp files from list() and listPrefixes()", async () => {
    await storage.put("visible", Buffer.from("x"));
    await mkdir(join(root, "only-temp"));
    await writeFile(join(root, ".visible.0123456789abcdef.tmp"), "partial");
    await writeFile(join(root, "only-temp", ".x.0123456789abcdef.tmp"), "partial");

    const keys: string[] = [];
    for await (const info of storage.list("")) keys.push(info.key);
    expect(keys).toEqual(["visible"]);
    const prefixes: string[] = [];
    for await (const prefix of storage.listPrefixes("")) prefixes.push(prefix);
    expect(prefixes).toEqual([]);
  });

  it("removes stale temp files older than a day while listing", async () => {
    const stale = join(root, ".old.0123456789abcdef.tmp");
    const fresh = join(root, ".new.fedcba9876543210.tmp");
    await writeFile(stale, "x");
    await writeFile(fresh, "x");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(stale, twoDaysAgo, twoDaysAgo);

    for await (const _ of storage.list("")) {
      // Listing is what triggers the cleanup.
    }
    expect(await treeOnDisk()).toEqual([".new.fedcba9876543210.tmp"]);
  });

  it("refuses keys shaped like temp files, because they could never be listed", async () => {
    await expect(storage.put("a/.b.0123456789abcdef.tmp", Buffer.from("x"))).rejects.toThrow(
      /reserved/,
    );
  });

  it("ignores empty directories in listPrefixes()", async () => {
    await mkdir(join(root, "empty", "nested"), { recursive: true });
    await storage.put("full/x", Buffer.from("x"));
    const prefixes: string[] = [];
    for await (const prefix of storage.listPrefixes("")) prefixes.push(prefix);
    expect(prefixes).toEqual(["full/"]);
  });

  it("prunes emptied parent directories on delete but never the root", async () => {
    await storage.put("a/b/c/object", Buffer.from("x"));
    await storage.put("a/sibling", Buffer.from("y"));
    await storage.delete(["a/b/c/object"]);
    expect(await treeOnDisk()).toEqual(["a", "a/sibling"]);
    await storage.delete(["a/sibling"]);
    expect(await treeOnDisk()).toEqual([]);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("does not treat a directory as an object in get(), head() or delete()", async () => {
    await storage.put("dir/inner", Buffer.from("x"));
    await expect(storage.get("dir")).rejects.toMatchObject({ code: "MS_STORAGE_NOT_FOUND" });
    expect(await storage.head("dir")).toBeUndefined();
    await storage.delete(["dir"]);
    expect(await storage.head("dir/inner")).toBeDefined();
  });

  it("reports NOT_FOUND with the key in the message", async () => {
    const error = await storage.get("missing/key.bin").catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    expect(String(error)).toContain("missing/key.bin");
  });

  it("rejects invalid byte ranges", async () => {
    await storage.put("range", Buffer.from("0123"));
    await expect(storage.get("range", { range: { start: 3, end: 1 } })).rejects.toThrow(
      /Invalid byte range/,
    );
    await expect(storage.get("range", { range: { start: -1 } })).rejects.toThrow(
      /Invalid byte range/,
    );
  });

  it("aborts a read stream when the signal fires", async () => {
    await storage.put("big", Buffer.alloc(1024 * 1024));
    const controller = new AbortController();
    const stream = await storage.get("big", { signal: controller.signal });
    controller.abort();
    await expect(async () => {
      for await (const _ of stream) {
        // Keep reading until the abort destroys the stream.
      }
    }).rejects.toMatchObject({ code: "MS_ABORTED" });
  });

  // Permission bits are not enforced for root, and Windows ignores chmod.
  const canTestPermissions =
    process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

  it.runIf(canTestPermissions)("maps EACCES to MS_STORAGE_FORBIDDEN with a hint", async () => {
    const { chmod } = await import("node:fs/promises");
    await storage.put("locked/existing", Buffer.from("x"));
    await chmod(join(root, "locked"), 0o500);
    try {
      const error = await storage
        .put("locked/object", Buffer.from("x"))
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "MS_STORAGE_FORBIDDEN" });
      expect(isMongoShieldError(error) && error.hint).toContain(root);
    } finally {
      await chmod(join(root, "locked"), 0o700);
    }
  });

  it("reports a write below an existing object as a storage error", async () => {
    await storage.put("file", Buffer.from("x"));
    await expect(storage.put("file/child", Buffer.from("y"))).rejects.toSatisfy((error: unknown) =>
      isMongoShieldError(error),
    );
  });
});

describe("availableBytes", () => {
  it("returns a positive number for an existing directory", async () => {
    expect(await availableBytes(tmpdir())).toBeGreaterThan(0);
  });

  it("falls back to the nearest existing parent for a path that does not exist yet", async () => {
    const free = await availableBytes(join(tmpdir(), "mongoshield-missing", "deeper"));
    expect(free).toBeGreaterThan(0);
  });
});
