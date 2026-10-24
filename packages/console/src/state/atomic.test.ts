/**
 * Tests for atomic file replacement: the new content replaces the old one with
 * mode 0600, and a failed rename leaves the old file and no temp file behind.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ms-atomic-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces a file's content and makes it readable only by its owner", async () => {
    const path = join(directory, "state.json");
    await writeFile(path, "old", { mode: 0o644 });
    await writeFileAtomic(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["state.json"]);
  });

  it("removes its temp file when the rename fails", async () => {
    // A non-empty directory cannot be replaced by a file.
    const path = join(directory, "occupied");
    await mkdir(path);
    await writeFile(join(path, "inside"), "x");
    await expect(writeFileAtomic(path, "content")).rejects.toThrow();
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails without leaving anything when the directory does not exist", async () => {
    await expect(writeFileAtomic(join(directory, "missing", "file"), "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
