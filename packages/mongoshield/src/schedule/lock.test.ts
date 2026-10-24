import { afterEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
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

describe("noLock", () => {
  it("is always acquired and never expires", async () => {
    const lock = noLock(createLockOwner());
    const [first, second] = await Promise.all([lock.tryAcquire(), lock.tryAcquire()]);
    expect(first.acquired && second.acquired).toBe(true);
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
