import { afterEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { createLockOwner, keepLeaseAlive, type Lease, noLock } from "./lock.ts";
import { storageLock } from "./lock-storage.ts";

const LEASE_MS = 60_000;

/** A controllable clock. */
function fakeClock(start = Date.parse("2026-10-20T03:00:00Z")) {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function lockOn(storage: StorageAdapter, now?: () => Date) {
  return storageLock({
    storage,
    owner: createLockOwner(),
    leaseMs: LEASE_MS,
    ...(now ? { now } : {}),
  });
}

/** Acquires and returns the lease, failing the test if the lock was busy. */
async function mustAcquire(lock: ReturnType<typeof lockOn>): Promise<Lease> {
  const result = await lock.tryAcquire();
  if (!result.acquired) throw new Error("expected to acquire the lock");
  return result.lease;
}

describe("storageLock", () => {
  it("lets exactly one of many concurrent runners acquire it", async () => {
    const storage = memoryStorage();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => lockOn(storage).tryAcquire()),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const losers = results.filter((result) => !result.acquired);
    expect(losers).toHaveLength(9);
  });

  it("reports the holder to a runner that finds it busy", async () => {
    const storage = memoryStorage();
    const first = await mustAcquire(lockOn(storage));
    const second = await lockOn(storage).tryAcquire();
    expect(second).toMatchObject({ acquired: false, holder: { owner: first.info.owner } });
  });

  it("can be taken again right after it is released", async () => {
    const storage = memoryStorage();
    const first = await mustAcquire(lockOn(storage));
    await first.release();
    const second = await lockOn(storage).tryAcquire();
    expect(second.acquired).toBe(true);
  });

  it("is taken over once the lease has expired, and the old holder learns it lost", async () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    const stale = await mustAcquire(lockOn(storage, clock.now));

    clock.advance(LEASE_MS - 1);
    expect((await lockOn(storage, clock.now).tryAcquire()).acquired).toBe(false);

    clock.advance(2);
    const fresh = await mustAcquire(lockOn(storage, clock.now));
    expect(fresh.info.owner).not.toBe(stale.info.owner);
    expect(await stale.renew()).toBe("lost");
    // The new holder keeps the lock.
    expect(await fresh.renew()).toBe("renewed");
  });

  it("lets only one runner take over an expired lease", async () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    await mustAcquire(lockOn(storage, clock.now));
    clock.advance(LEASE_MS + 1);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => lockOn(storage, clock.now).tryAcquire()),
    );
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
  });

  it("extends the lease on renewal", async () => {
    const storage = memoryStorage();
    const clock = fakeClock();
    const lease = await mustAcquire(lockOn(storage, clock.now));
    const firstExpiry = lease.info.expiresAt.getTime();
    clock.advance(LEASE_MS / 2);
    expect(await lease.renew()).toBe("renewed");
    expect(lease.info.expiresAt.getTime()).toBe(firstExpiry + LEASE_MS / 2);

    clock.advance(LEASE_MS - 1); // past the first expiry, before the renewed one
    expect((await lockOn(storage, clock.now).tryAcquire()).acquired).toBe(false);
  });

  it("backs off when it acted on a stale listing that missed the current lease", async () => {
    const storage = memoryStorage();
    // Generation 1 is taken, then taken over by a runner whose clock says it
    // expired: generation 2 is now the live lease, and generation 1 is deleted.
    await mustAcquire(lockOn(storage));
    await mustAcquire(
      storageLock({
        storage,
        owner: createLockOwner(),
        leaseMs: LEASE_MS,
        now: () => new Date(Date.now() + 10 * LEASE_MS),
      }),
    );

    let calls = 0;
    const staleOnce: StorageAdapter = {
      ...storage,
      list(prefix, options) {
        calls++;
        // First listing: stale and empty, as if the lock objects did not exist yet.
        return calls === 1 ? emptyAsync() : storage.list(prefix, options);
      },
    };
    const late = await lockOn(staleOnce).tryAcquire();
    expect(late.acquired).toBe(false);
    // It created generation 1 from the stale listing, saw generation 2 on the
    // second listing, and deleted its own object again.
    expect(storage.keys()).toEqual(["locks/backup/00000000000000000002.json"]);
  });

  it("refuses adapters without conditional writes", () => {
    const storage = {
      ...memoryStorage(),
      capabilities: { conditionalWrites: false, rangeReads: true, objectLock: false },
    };
    let caught: unknown;
    try {
      lockOn(storage);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_CONFIG_INVALID")).toBe(true);
  });

  it("never touches the backups prefix", async () => {
    const storage = memoryStorage();
    const lease = await mustAcquire(lockOn(storage));
    await lease.release();
    expect(storage.keys().every((key) => key.startsWith("locks/backup/"))).toBe(true);
  });
});

describe("storageLock edge cases", () => {
  const FIRST = "locks/backup/00000000000000000001.json";
  const SECOND = "locks/backup/00000000000000000002.json";

  it("refuses a lock name that cannot be a storage key segment", () => {
    expect(() =>
      storageLock({
        storage: memoryStorage(),
        owner: createLockOwner(),
        leaseMs: LEASE_MS,
        name: "Backup Lock",
      }),
    ).toThrow(expect.objectContaining({ code: "MS_CONFIG_INVALID" }));
  });

  it("ignores objects under the lock prefix that are not generations", async () => {
    const storage = memoryStorage();
    await storage.put("locks/backup/README.txt", Buffer.from("hands off"));
    await mustAcquire(lockOn(storage));
    expect(storage.keys()).toContain(FIRST);
  });

  it("never takes over a lock object it cannot read", async () => {
    for (const body of ["{ not json", JSON.stringify({ formatVersion: 99 })]) {
      const storage = memoryStorage();
      await storage.put(FIRST, Buffer.from(body));
      await expect(lockOn(storage).tryAcquire()).rejects.toThrow(
        expect.objectContaining({
          code: "MS_CONFIG_INVALID",
          message: expect.stringMatching(/cannot be read/),
        }),
      );
    }
    // A lock object larger than any lock (the read refuses it) is unreadable too.
    const storage = memoryStorage();
    await storage.put(FIRST, Buffer.alloc(128 * 1024, 0x20));
    await expect(lockOn(storage).tryAcquire()).rejects.toThrow(/cannot be read/);
  });

  it("passes storage errors on while reading the lock", async () => {
    const storage = memoryStorage();
    await mustAcquire(lockOn(storage));
    const failing: StorageAdapter = {
      ...storage,
      get: async () => {
        throw new MongoShieldError("MS_STORAGE_IO", "storage is down");
      },
    };
    await expect(lockOn(failing).tryAcquire()).rejects.toThrow("storage is down");
  });

  it("treats a lock object that vanished after the listing as free", async () => {
    const storage = memoryStorage();
    await mustAcquire(lockOn(storage));
    // The listing still shows generation 1, but reading it finds nothing.
    const vanishing: StorageAdapter = {
      ...storage,
      get: async (key, options) => {
        if (key === FIRST) throw new MongoShieldError("MS_STORAGE_NOT_FOUND", "gone");
        return storage.get(key, options);
      },
    };
    await mustAcquire(lockOn(vanishing));
    expect(storage.keys()).toEqual([SECOND]);
  });

  it("passes on a failed write that is not a lost race", async () => {
    const storage = memoryStorage();
    const failing: StorageAdapter = {
      ...storage,
      put: async () => {
        throw new MongoShieldError("MS_STORAGE_IO", "disk full");
      },
    };
    await expect(lockOn(failing).tryAcquire()).rejects.toThrow("disk full");
  });

  it("names no holder when the newer lease it backs off from cannot be read", async () => {
    const storage = memoryStorage();
    await storage.put(SECOND, Buffer.from("{ not json"));
    let calls = 0;
    const staleOnce: StorageAdapter = {
      ...storage,
      list(prefix, options) {
        calls++;
        return calls === 1 ? emptyAsync() : storage.list(prefix, options);
      },
    };
    const late = await lockOn(staleOnce).tryAcquire();
    expect(late).toEqual({ acquired: false, holder: undefined });
    expect(storage.keys()).toEqual([SECOND]);
  });

  it("keeps the lease when old generations cannot be deleted", async () => {
    const storage = memoryStorage();
    const first = await mustAcquire(lockOn(storage));
    await first.release();
    const debug = vi.fn();
    const undeletable: StorageAdapter = {
      ...storage,
      delete: async () => {
        throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "retained");
      },
    };
    const result = await storageLock({
      storage: undeletable,
      owner: createLockOwner(),
      leaseMs: LEASE_MS,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }).tryAcquire();
    expect(result.acquired).toBe(true);
    expect(debug).toHaveBeenCalledWith("Could not delete old lock objects", expect.anything());
    expect(storage.keys()).toEqual([FIRST, SECOND]);
  });

  it("does not renew a lease that has already expired", async () => {
    const clock = fakeClock();
    const lease = await mustAcquire(lockOn(memoryStorage(), clock.now));
    clock.advance(LEASE_MS);
    expect(await lease.renew()).toBe("lost");
  });
});

describe("noLock", () => {
  it("is always acquired and never expires", async () => {
    const lock = noLock(createLockOwner());
    const [first, second] = await Promise.all([lock.tryAcquire(), lock.tryAcquire()]);
    expect(first.acquired && second.acquired).toBe(true);
    if (first.acquired) {
      expect(first.lease.info.expiresAt.getTime()).toBe(8.64e15);
      expect(await first.lease.renew()).toBe("renewed");
      await expect(first.lease.release()).resolves.toBeUndefined();
    }
  });
});

describe("keepLeaseAlive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A lease whose renew outcome the test controls. */
  function scriptedLease(outcomes: (() => Promise<"renewed" | "lost">)[], expiresAt: Date): Lease {
    return {
      info: { owner: "me", host: "h", acquiredAt: new Date(0), expiresAt },
      renew: () => (outcomes.shift() ?? (async () => "renewed" as const))(),
      release: async () => {},
    };
  }

  it("renews on an interval and aborts the run when the lease is lost", async () => {
    vi.useFakeTimers();
    const renewed = vi.fn(async () => "renewed" as const);
    const lease = scriptedLease([renewed, renewed, async () => "lost"], new Date(8.64e15));
    const keeper = keepLeaseAlive(lease, { renewEveryMs: 1000 });

    await vi.advanceTimersByTimeAsync(2500);
    expect(renewed).toHaveBeenCalledTimes(2);
    expect(keeper.lost.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(keeper.lost.aborted).toBe(true);
    expect(isMongoShieldError(keeper.lost.reason, "MS_ABORTED")).toBe(true);
    keeper.stop();
  });

  it("tolerates a failed renewal before expiry but aborts after it", async () => {
    vi.useFakeTimers({ now: 0 });
    const failing = async (): Promise<"renewed"> => {
      throw new Error("storage down");
    };
    const lease = scriptedLease([failing, failing, failing], new Date(2500));
    const keeper = keepLeaseAlive(lease, { renewEveryMs: 1000 });

    await vi.advanceTimersByTimeAsync(2000);
    expect(keeper.lost.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(keeper.lost.aborted).toBe(true);
    keeper.stop();
  });

  it("logs a renewal failure that is not an Error", async () => {
    vi.useFakeTimers({ now: 0 });
    const warn = vi.fn();
    const lease = scriptedLease([() => Promise.reject("network down")], new Date(8.64e15));
    const keeper = keepLeaseAlive(lease, {
      renewEveryMs: 1000,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalledWith("Renewing the backup lock failed; will retry", {
      error: "network down",
    });
    keeper.stop();
  });

  it("stops renewing when stopped", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => "renewed" as const);
    const keeper = keepLeaseAlive(scriptedLease([renew], new Date(8.64e15)), {
      renewEveryMs: 1000,
    });
    keeper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).not.toHaveBeenCalled();
  });
});

async function* emptyAsync(): AsyncGenerator<never> {}
