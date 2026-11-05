/**
 * Tests for the private temp folder of `mongoshield copy` checkpoints
 * (`privateTempDirectory`): created with mode 0700, and an existing folder that
 * another user could have prepared (a symlink, a file, one others can write to) is
 * refused instead of trusted for --resume.
 */

import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../../errors.ts";
import { privateTempDirectory } from "./copy.ts";

/** POSIX permission bits do not exist on Windows. */
const onWindows = process.platform === "win32";

let parent: string;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), "ms-copy-checkpoint-"));
});

afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

/** Expects `action` to reject with `MS_CONFIG_INVALID` and a message matching `pattern`. */
async function expectRefused(action: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await action.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  expect(error instanceof Error ? error.message : "").toMatch(pattern);
  expect(isMongoShieldError(error) ? error.hint : "").toMatch(/--checkpoint <file>/);
}

describe("privateTempDirectory", () => {
  it("reports a missing folder without creating it, unless asked to", async () => {
    const directory = join(parent, "mongoshield-test");
    expect(await privateTempDirectory(directory, { create: false })).toBe(false);
    await expect(lstat(directory)).rejects.toThrow();
  });

  it("creates a missing folder that only its owner can use", async () => {
    const directory = join(parent, "mongoshield-test");
    expect(await privateTempDirectory(directory, { create: true })).toBe(true);
    const stats = await lstat(directory);
    expect(stats.isDirectory()).toBe(true);
    if (!onWindows) expect(stats.mode & 0o077).toBe(0);
  });

  it("refuses a symbolic link in its place, even to a private folder", async () => {
    const real = join(parent, "real");
    await mkdir(real, { mode: 0o700 });
    const directory = join(parent, "mongoshield-test");
    await symlink(real, directory, "dir");
    await expectRefused(privateTempDirectory(directory, { create: false }), /symbolic link/);
    await expectRefused(privateTempDirectory(directory, { create: true }), /symbolic link/);
  });

  it("refuses a file in its place", async () => {
    const directory = join(parent, "mongoshield-test");
    await writeFile(directory, "not a folder");
    await expectRefused(privateTempDirectory(directory, { create: true }), /not a directory/);
  });

  it.skipIf(onWindows)("refuses a folder that others can write to", async () => {
    const directory = join(parent, "mongoshield-test");
    await mkdir(directory);
    // chmod, not mkdir's mode: the umask would take the write bits away again.
    await chmod(directory, 0o777);
    await expectRefused(
      privateTempDirectory(directory, { create: false }),
      /other users can write to it \(mode 777\)/,
    );
    await chmod(directory, 0o770);
    await expectRefused(privateTempDirectory(directory, { create: true }), /mode 770/);
  });

  it.skipIf(onWindows)(
    "tightens an own folder that others could only read (as earlier versions made it)",
    async () => {
      const directory = join(parent, "mongoshield-test");
      await mkdir(directory);
      await chmod(directory, 0o755);
      expect(await privateTempDirectory(directory, { create: false })).toBe(true);
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    },
  );
});
