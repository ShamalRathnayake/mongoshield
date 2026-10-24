/**
 * Failure paths of the filesystem adapter that a healthy local disk never
 * takes: permission errors in the middle of a listing, files deleted between
 * readdir and stat, temp-file directories pruned by a concurrent delete, and
 * errors while taking or checking the no-hard-link lock (see file.ts).
 *
 * `node:fs/promises` is wrapped (in this file's own module registry) so that a
 * test can make chosen calls fail with a chosen errno; every other call goes to
 * the real filesystem in a temp directory.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { StorageAdapter } from "./types.ts";

/** Calls the wrapper can fail. */
type FaultyCall = "open" | "mkdir" | "lstat" | "readdir" | "stat" | "statfs" | "link";

/**
 * Scripted failures: for each call, a function of its path that returns the errno
 * to fail with (or `undefined` to let the call through). `null` as an errno
 * throws an error without any code.
 */
const faults = vi.hoisted(() => new Map<string, (path: string) => string | null | undefined>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  /** Wraps one function so a scripted fault for `name` fires before the real call. */
  function faulty<Args extends unknown[], Result>(
    name: FaultyCall,
    real: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args: Args) => {
      const code = faults.get(name)?.(String(args[0]));
      if (code === null) throw new Error(`${name} failed without a code`);
      if (code !== undefined) {
        throw Object.assign(new Error(`${code}: ${name} ${String(args[0])}`), { code });
      }
      return real(...args);
    };
  }
  return {
    ...original,
    open: faulty("open", original.open),
    mkdir: faulty("mkdir", original.mkdir),
    lstat: faulty("lstat", original.lstat),
    readdir: faulty("readdir", original.readdir),
    stat: faulty("stat", original.stat),
    statfs: faulty("statfs", original.statfs),
    link: faulty("link", original.link),
  };
});

const { availableBytes, fileStorage } = await import("./file.ts");

/** Fails `call` with `code` for paths that pass `matches`, `times` times (default: always). */
function fail(
  call: FaultyCall,
  code: string | null,
  matches: (path: string) => boolean = () => true,
  times = Number.POSITIVE_INFINITY,
): void {
  let remaining = times;
  faults.set(call, (path) => {
    if (remaining <= 0 || !matches(path)) return undefined;
    remaining--;
    return code;
  });
}

const isTempFile = (path: string) => /\.[0-9a-f]{16}\.tmp$/.test(path);
const isLock = (path: string) => path.endsWith(".mongoshield-lock");

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

describe("fileStorage when filesystem calls fail", () => {
  let root: string;
  let storage: StorageAdapter;

  beforeEach(async () => {
    faults.clear();
    root = await mkdtemp(join(tmpdir(), "mongoshield-file-faults-"));
    storage = fileStorage({ path: root });
  });

  afterEach(async () => {
    faults.clear();
    await rm(root, { recursive: true, force: true });
  });

  describe("writes", () => {
    it("retries the temp file when a concurrent delete pruned its directory", async () => {
      fail("open", "ENOENT", isTempFile, 2);
      await storage.put("dir/a", Buffer.from("x"));
      expect(await storage.head("dir/a")).toMatchObject({ size: 1 });
    });

    it("gives up on the temp file after a few attempts", async () => {
      fail("open", "ENOENT", isTempFile);
      const error = await rejection(storage.put("dir/a", Buffer.from("x")));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });

    it("maps EROFS to MS_STORAGE_FORBIDDEN and a full disk to MS_STORAGE_INSUFFICIENT_SPACE", async () => {
      fail("open", "EROFS", isTempFile, 1);
      expect(
        isMongoShieldError(
          await rejection(storage.put("a", Buffer.from("x"))),
          "MS_STORAGE_FORBIDDEN",
        ),
      ).toBe(true);
      fail("open", "ENOSPC", isTempFile, 1);
      const full = await rejection(storage.put("a", Buffer.from("x")));
      expect(isMongoShieldError(full, "MS_STORAGE_INSUFFICIENT_SPACE")).toBe(true);
      expect(isMongoShieldError(full) && full.hint).toContain(root);
    });

    it("reports a link() failure without an errno as MS_STORAGE_IO", async () => {
      fail("link", null);
      const error = await rejection(storage.put("a", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("fails a conditional write when the lock directory cannot be created", async () => {
      fail("link", "EPERM");
      fail("mkdir", "EACCES", isLock);
      const error = await rejection(storage.put("a", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("fails a conditional write when the target cannot be checked", async () => {
      fail("link", "EPERM");
      fail("lstat", "EACCES", (path) => path.endsWith(`${join(root, "a")}`));
      const error = await rejection(storage.put("a", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("fails a conditional write when a busy lock cannot be inspected", async () => {
      fail("link", "EPERM");
      await mkdir(join(root, ".a.mongoshield-lock"));
      fail("lstat", "EACCES", isLock);
      const error = await rejection(storage.put("a", Buffer.from("x"), { ifNoneMatch: "*" }));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("takes the lock at once when its holder released it while we looked", async () => {
      fail("link", "EPERM");
      // mkdir reports the lock as taken, but by the time it is inspected it is gone.
      fail("mkdir", "EEXIST", isLock, 1);
      const started = Date.now();
      await storage.put("a", Buffer.from("x"), { ifNoneMatch: "*" });
      // No retry delay was needed.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await storage.head("a")).toBeDefined();
    });
  });

  describe("reads and listings", () => {
    it("maps a stat failure in head() that is not 'missing'", async () => {
      fail("stat", "EACCES");
      const error = await rejection(storage.head("a"));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("maps a readdir failure while listing", async () => {
      await storage.put("dir/a", Buffer.from("x"));
      fail("readdir", "EACCES");
      const error = await rejection(collect(storage.list("dir/")));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
      expect(String(error)).toContain("dir/");
    });

    it("skips files deleted between readdir and stat, and fails on other stat errors", async () => {
      await storage.put("a", Buffer.from("1"));
      await storage.put("b", Buffer.from("2"));
      fail("stat", "ENOENT", (path) => path.endsWith(`${join(root, "a")}`));
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual(["b"]);
      fail("stat", "EIO", (path) => path.endsWith(`${join(root, "a")}`));
      const error = await rejection(collect(storage.list("")));
      expect(isMongoShieldError(error, "MS_STORAGE_IO")).toBe(true);
    });

    it("never lists or follows symlinks", async () => {
      await storage.put("real", Buffer.from("x"));
      await symlink(join(root, "real"), join(root, "link"));
      expect((await collect(storage.list(""))).map((info) => info.key)).toEqual(["real"]);
    });

    it("treats an unreadable sub-directory as holding no objects in listPrefixes()", async () => {
      await storage.put("a/deep/x", Buffer.from("x"));
      await storage.put("b/y", Buffer.from("y"));
      fail("readdir", "EACCES", (path) => path.endsWith(join(root, "a")));
      expect(await collect(storage.listPrefixes(""))).toEqual(["b/"]);
    });

    it("finds objects nested below empty directories in listPrefixes()", async () => {
      await mkdir(join(root, "a", "empty"), { recursive: true });
      await storage.put("a/deeper/x", Buffer.from("x"));
      expect(await collect(storage.listPrefixes(""))).toEqual(["a/"]);
    });
  });

  describe("deletes and free space", () => {
    it("maps an lstat failure while deleting", async () => {
      await writeFile(join(root, "a"), "x");
      fail("lstat", "EACCES");
      const error = await rejection(storage.delete(["a"]));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("reports a statfs failure other than a missing path", async () => {
      fail("statfs", "EACCES");
      const error = await rejection(availableBytes(root));
      expect(isMongoShieldError(error, "MS_STORAGE_FORBIDDEN")).toBe(true);
    });

    it("gives up when not even the filesystem root exists", async () => {
      fail("statfs", "ENOENT");
      const error = await rejection(availableBytes(join(root, "x")));
      expect(isMongoShieldError(error, "MS_STORAGE_NOT_FOUND")).toBe(true);
    });
  });
});
