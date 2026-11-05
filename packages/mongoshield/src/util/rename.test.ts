/**
 * Tests for `renameWithRetry`: Windows' transient sharing violations (a file held
 * open by antivirus or the indexer) are retried, everything else fails at once.
 * `rename` is replaced with a scripted mock, so the Windows behaviour runs anywhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Errnos the next rename calls fail with, in order; an empty list lets calls succeed. */
const script = vi.hoisted(() => ({ failures: [] as string[], calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async () => {
      script.calls++;
      const code = script.failures.shift();
      if (code !== undefined) throw Object.assign(new Error(`${code}: rename`), { code });
    },
  };
});

const { isTransientRenameError, renameWithRetry } = await import("./rename.ts");

beforeEach(() => {
  script.failures = [];
  script.calls = 0;
});

describe("renameWithRetry", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])(
    "retries a %s on Windows until the other program lets go",
    async (code) => {
      script.failures = [code, code];
      await renameWithRetry("a.tmp", "a", { platform: "win32" });
      expect(script.calls).toBe(3);
    },
  );

  it("gives up on Windows after a few attempts and throws the last error", async () => {
    script.failures = Array.from({ length: 20 }, () => "EPERM");
    await expect(renameWithRetry("a.tmp", "a", { platform: "win32" })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(script.calls).toBe(7);
  }, 10_000);

  it("fails at once on other platforms, where EPERM is a real permission problem", async () => {
    script.failures = ["EPERM"];
    await expect(renameWithRetry("a.tmp", "a", { platform: "linux" })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(script.calls).toBe(1);
  });

  it("never retries other errors, even on Windows", async () => {
    script.failures = ["ENOENT"];
    await expect(renameWithRetry("a.tmp", "a", { platform: "win32" })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(script.calls).toBe(1);
  });

  it("stops retrying when the signal fires", async () => {
    script.failures = Array.from({ length: 20 }, () => "EBUSY");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(
      renameWithRetry("a.tmp", "a", { platform: "win32", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(script.calls).toBeLessThan(7);
  });
});

describe("isTransientRenameError", () => {
  it("only treats the Windows sharing codes as transient, and only on Windows", () => {
    expect(isTransientRenameError({ code: "EBUSY" }, "win32")).toBe(true);
    expect(isTransientRenameError({ code: "EBUSY" }, "darwin")).toBe(false);
    expect(isTransientRenameError({ code: "EXDEV" }, "win32")).toBe(false);
    expect(isTransientRenameError(new Error("no code"), "win32")).toBe(false);
  });
});
