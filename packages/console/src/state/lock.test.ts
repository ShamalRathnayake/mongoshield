/**
 * Tests for the data directory lock: one live holder at a time, takeover of
 * abandoned or unreadable locks, the heartbeat, and a release that never
 * deletes a lock someone else has taken over.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, DataDirLockedError, LOCK_FILE, STALE_AFTER_MS } from "./lock.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-lock-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function readLockFile(): Promise<{ owner: string; heartbeatAt: string }> {
  return JSON.parse(await readFile(join(dataDir, LOCK_FILE), "utf8"));
}

async function lockExists(): Promise<boolean> {
  try {
    await readFile(join(dataDir, LOCK_FILE));
    return true;
  } catch {
    return false;
  }
}

describe("acquireDataDirLock", () => {
  it("refuses a second holder while the first is alive, naming the holder", async () => {
    const lock = await acquireDataDirLock(dataDir);
    await expect(acquireDataDirLock(dataDir)).rejects.toThrow(new RegExp(`pid ${process.pid}`));
    await expect(acquireDataDirLock(dataDir)).rejects.toBeInstanceOf(DataDirLockedError);
    await lock.release();
    expect(await lockExists()).toBe(false);
    // Free again after release.
    await (await acquireDataDirLock(dataDir)).release();
  });

  it("takes over a lock file that is not valid JSON or lacks its fields", async () => {
    await writeFile(join(dataDir, LOCK_FILE), "garbage");
    const first = await acquireDataDirLock(dataDir);
    await first.release();

    await writeFile(join(dataDir, LOCK_FILE), JSON.stringify({ pid: 3 }));
    const second = await acquireDataDirLock(dataDir);
    expect((await readLockFile()).owner).toMatch(/^[0-9a-f]{16}$/);
    await second.release();
  });

  it("does not delete the lock on release when another process has taken it over", async () => {
    // The first holder's clock is far in the past, so its heartbeat looks abandoned.
    const old = await acquireDataDirLock(dataDir, {
      now: () => new Date(Date.now() - STALE_AFTER_MS - 60_000),
    });
    const current = await acquireDataDirLock(dataDir);
    const takenOver = await readLockFile();

    await old.release();
    expect((await readLockFile()).owner).toBe(takenOver.owner);
    await current.release();
    // Releasing twice is harmless.
    await current.release();
    expect(await lockExists()).toBe(false);
  });

  it("refreshes its heartbeat while held", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const lock = await acquireDataDirLock(dataDir, { now: () => new Date(now), heartbeatMs: 5 });
    const first = (await readLockFile()).heartbeatAt;
    now += 60_000;
    let refreshed = first;
    for (let attempt = 0; attempt < 100 && refreshed === first; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      refreshed = (await readLockFile().catch(() => ({ heartbeatAt: first }))).heartbeatAt;
    }
    expect(refreshed).toBe("2026-01-01T00:01:00.000Z");
    await lock.release();
  });

  describe("waiting for a predecessor (a replaced container)", () => {
    /** Writes a lock file as a console that stopped without releasing it would leave. */
    async function leftBehind(heartbeatAt: Date): Promise<void> {
      const content = { owner: "0123456789abcdef", host: "old-box", pid: 1, heartbeatAt };
      await writeFile(join(dataDir, LOCK_FILE), JSON.stringify(content));
    }

    it("takes over a fresh lock whose heartbeat stops, once it goes stale", async () => {
      // Refreshed "just now", 100 ms before it counts as abandoned.
      await leftBehind(new Date(Date.now() - STALE_AFTER_MS + 100));
      const messages: string[] = [];
      const lock = await acquireDataDirLock(dataDir, {
        waitForPrevious: { onWait: (message) => messages.push(message), pollMs: 20 },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/pid 1 on old-box.*Waiting up to 30 s/);
      expect((await readLockFile()).owner).not.toBe("0123456789abcdef");
      await lock.release();
    });

    it("starts as soon as the previous console releases the lock", async () => {
      await leftBehind(new Date());
      setTimeout(() => void rm(join(dataDir, LOCK_FILE), { force: true }), 50);
      const lock = await acquireDataDirLock(dataDir, { waitForPrevious: { pollMs: 10 } });
      expect(await lockExists()).toBe(true);
      await lock.release();
    });

    it("still refuses a live console: its heartbeat moves while we wait", async () => {
      const live = await acquireDataDirLock(dataDir, { heartbeatMs: 15 });
      await expect(
        acquireDataDirLock(dataDir, { waitForPrevious: { pollMs: 10 } }),
      ).rejects.toBeInstanceOf(DataDirLockedError);
      await live.release();
    });

    it("gives up after the stale period on a heartbeat that never ages", async () => {
      // A heartbeat from the future (a skewed clock) stays fresh forever.
      await leftBehind(new Date(Date.now() + 3_600_000));
      // Each reading of the clock moves it 10 s on, so the deadline passes quickly.
      let clock = Date.now();
      const now = () => {
        clock += 10_000;
        return new Date(clock);
      };
      await expect(
        acquireDataDirLock(dataDir, { now, waitForPrevious: { pollMs: 1 } }),
      ).rejects.toThrow(/pid 1 on old-box/);
    });
  });

  it("reports a missing data directory instead of pretending to hold the lock", async () => {
    await expect(acquireDataDirLock(join(dataDir, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails when the lock path cannot be read as a file", async () => {
    await mkdir(join(dataDir, LOCK_FILE));
    await expect(acquireDataDirLock(dataDir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
