/**
 * Tests for the filesystem adapter on filesystems without hard links (FAT/exFAT,
 * some SMB and FUSE mounts). `link()` from `node:fs/promises` is replaced with a
 * mock that fails the way those filesystems do, so the lock-directory fallback
 * for conditional writes runs here on any machine. Kept in its own file because
 * the mock applies to the whole module graph of the test file.
 */

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeStorageConformance } from "../../test/helpers/storage-conformance.ts";
import { isMongoShieldError } from "../errors.ts";
import type { StorageAdapter } from "./types.ts";

/** The errno the mocked `link()` fails with; `undefined` lets it through to the real one. */
const linkFailure = vi.hoisted(() => ({ code: "EPERM" as string | undefined, calls: 0 }));

/** Fails the next `rename()` with this errno once, then behaves normally again. */
const renameFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    link: async (...args: Parameters<typeof original.link>) => {
      linkFailure.calls++;
      if (linkFailure.code === undefined) return original.link(...args);
      throw Object.assign(new Error(`${linkFailure.code}: operation not supported, link`), {
        code: linkFailure.code,
      });
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      const code = renameFailure.code;
      if (code === undefined) return original.rename(...args);
      renameFailure.code = undefined;
      throw Object.assign(new Error(`${code}: rename failed`), { code });
    },
  };
});

const { fileStorage } = await import("./file.ts");

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mongoshield-file-nolink-"));
}

// The whole contract, including "exactly one of several racing conditional
// creates wins", must hold with the fallback as well.
describeStorageConformance("file without hard links", async () => {
  linkFailure.code = "EPERM";
  const root = await makeTempRoot();
  return {
    storage: fileStorage({ path: join(root, "store") }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe("fileStorage on a filesystem without hard links", () => {
  let root: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    linkFailure.code = "EPERM";
    linkFailure.calls = 0;
    renameFailure.code = undefined;
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

  async function readAll(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const piece of stream) chunks.push(Buffer.from(piece));
    return Buffer.concat(chunks).toString();
  }

  it.each(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"])(
    "falls back to the lock directory when link() fails with %s",
    async (code) => {
      linkFailure.code = code;
      const info = await storage.put("dir/claim", Buffer.from("mine"), { ifNoneMatch: "*" });
      expect(info.size).toBe(4);
      expect(await readAll(await storage.get("dir/claim"))).toBe("mine");
      await expect(
        storage.put("dir/claim", Buffer.from("theirs"), { ifNoneMatch: "*" }),
      ).rejects.toMatchObject({ code: "MS_STORAGE_PRECONDITION_FAILED" });
      expect(await readAll(await storage.get("dir/claim"))).toBe("mine");
      // No lock directory and no temp file stays behind, on success or on failure.
      expect(await treeOnDisk()).toEqual(["dir", "dir/claim"]);
    },
  );

  it("still reports other link() failures as storage errors", async () => {
    linkFailure.code = "EIO";
    const error = await storage
      .put("claim", Buffer.from("x"), { ifNoneMatch: "*" })
      .catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(String(error)).toContain("EIO");
    expect(await treeOnDisk()).toEqual([]);
  });

  it("remembers that hard links are unsupported and stops trying link()", async () => {
    await storage.put("a", Buffer.from("1"), { ifNoneMatch: "*" });
    await storage.put("b", Buffer.from("2"), { ifNoneMatch: "*" });
    await storage.put("c", Buffer.from("3"), { ifNoneMatch: "*" });
    expect(linkFailure.calls).toBe(1);
  });

  it("uses hard links when the filesystem has them", async () => {
    linkFailure.code = undefined;
    await storage.put("a", Buffer.from("1"), { ifNoneMatch: "*" });
    await expect(storage.put("a", Buffer.from("2"), { ifNoneMatch: "*" })).rejects.toMatchObject({
      code: "MS_STORAGE_PRECONDITION_FAILED",
    });
    expect(linkFailure.calls).toBe(2);
    expect(await treeOnDisk()).toEqual(["a"]);
  });

  it("lets exactly one of many racing conditional creates win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        storage.put("race/claim", Buffer.from(`writer ${index}`), { ifNoneMatch: "*" }),
      ),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "MS_STORAGE_PRECONDITION_FAILED" });
      }
    }
    expect(await treeOnDisk()).toEqual(["race", "race/claim"]);
  });

  it("removes the lock and the temp file when the final rename fails", async () => {
    await storage.put("dir/other", Buffer.from("keep"));
    // Prime the fallback, so the next conditional put renames exactly once.
    await storage.put("dir/primer", Buffer.from("p"), { ifNoneMatch: "*" });
    renameFailure.code = "EIO";
    const error = await storage
      .put("dir/claim", Buffer.from("x"), { ifNoneMatch: "*" })
      .catch((reason: unknown) => reason);
    expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    expect(await treeOnDisk()).toEqual(["dir", "dir/other", "dir/primer"]);
  });

  it("fails fast when the object appears while another writer holds the lock", async () => {
    await storage.put("dir/claim", Buffer.from("first"));
    await mkdir(join(root, "dir", ".claim.mongoshield-lock"));
    const started = Date.now();
    await expect(
      storage.put("dir/claim", Buffer.from("second"), { ifNoneMatch: "*" }),
    ).rejects.toMatchObject({ code: "MS_STORAGE_PRECONDITION_FAILED" });
    expect(Date.now() - started).toBeLessThan(1_000);
    // The lock belongs to the other writer, so it is left alone.
    expect(await treeOnDisk()).toContain("dir/.claim.mongoshield-lock");
  });

  it("waits for a busy lock and proceeds once its holder releases it", async () => {
    const lock = join(root, ".claim.mongoshield-lock");
    await mkdir(lock);
    const writing = storage.put("claim", Buffer.from("x"), { ifNoneMatch: "*" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await treeOnDisk()).not.toContain("claim");
    await rm(lock, { recursive: true });
    await writing;
    expect(await treeOnDisk()).toEqual(["claim"]);
  });

  it("breaks a lock left behind by a crashed writer", async () => {
    const lock = join(root, ".claim.mongoshield-lock");
    await mkdir(lock);
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    await utimes(lock, twoMinutesAgo, twoMinutesAgo);
    await storage.put("claim", Buffer.from("x"), { ifNoneMatch: "*" });
    expect(await treeOnDisk()).toEqual(["claim"]);
  });

  it("stops waiting for a busy lock with MS_ABORTED when the signal fires", async () => {
    await mkdir(join(root, ".claim.mongoshield-lock"));
    const controller = new AbortController();
    const writing = storage.put("claim", Buffer.from("x"), {
      ifNoneMatch: "*",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(writing).rejects.toMatchObject({ code: "MS_ABORTED" });
    expect(await treeOnDisk()).toEqual([".claim.mongoshield-lock"]);
  });

  it("never lists lock directories as objects or prefixes", async () => {
    await storage.put("visible", Buffer.from("x"));
    await mkdir(join(root, ".visible.mongoshield-lock"));
    await mkdir(join(root, "sub", ".x.mongoshield-lock"), { recursive: true });
    await writeFile(join(root, "sub", "x"), "x");
    const keys: string[] = [];
    for await (const info of storage.list("")) keys.push(info.key);
    expect(keys).toEqual(["sub/x", "visible"]);
    const prefixes: string[] = [];
    for await (const prefix of storage.listPrefixes("")) prefixes.push(prefix);
    expect(prefixes).toEqual(["sub/"]);
  });

  it("refuses keys with a segment shaped like a lock directory", async () => {
    await expect(storage.put("a/.b.mongoshield-lock", Buffer.from("x"))).rejects.toThrow(
      /reserved/,
    );
    await expect(storage.put(".b.mongoshield-lock/c", Buffer.from("x"))).rejects.toThrow(
      /reserved/,
    );
  });
});
