/**
 * Tests for use leases (use-leases.ts): restores, verifies, drills and running backups
 * mark the backup as in use, and prune and delete leave such a backup alone (and,
 * for an incremental, the chain it depends on).
 */

import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import { manifestKey, resolveBackupKey } from "../format/layout.ts";
import { writeManifest } from "../format/manifest-io.ts";
import { memoryStorage } from "../storage/memory.ts";
import type { StorageAdapter } from "../storage/types.ts";
import { deleteBackupById } from "./delete.ts";
import { pruneBackups } from "./prune.ts";
import {
  idAt,
  makeChainBase,
  makeIncremental,
  putCompleteBackup,
  putIncompleteBackup,
} from "./test-fixtures.ts";
import {
  acquireUseLease,
  holdUseLease,
  liveUseLeases,
  liveUseLeasesByBackup,
  useLeasesPrefix,
  withUseLease,
} from "./use-leases.ts";

const OLD = idAt("2026-10-18T03:00:00Z");
const MIDDLE = idAt("2026-10-19T03:00:00Z");
const NEW = idAt("2026-10-20T03:00:00Z");

describe("withUseLease", () => {
  it("holds a lease while the task runs and removes it afterwards", async () => {
    const storage = memoryStorage();
    const seen = await withUseLease(storage, [OLD], "restore", {}, () =>
      liveUseLeases(storage, OLD),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ backupId: OLD, purpose: "restore" });
    expect(await liveUseLeases(storage, OLD)).toEqual([]);
    expect(storage.keys().filter((key) => key.startsWith(useLeasesPrefix(OLD)))).toEqual([]);
  });

  it("removes the lease when the task fails", async () => {
    const storage = memoryStorage();
    const failing = withUseLease(storage, [OLD], "verify", {}, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await liveUseLeases(storage, OLD)).toEqual([]);
  });

  it("still runs the task when the storage refuses writes", async () => {
    const inner = memoryStorage();
    const readOnly: StorageAdapter = {
      ...inner,
      put: async () => {
        throw new MongoShieldError("MS_STORAGE_FORBIDDEN", "read-only credentials");
      },
    };
    await expect(withUseLease(readOnly, [OLD], "restore", {}, async () => "done")).resolves.toBe(
      "done",
    );
  });
});

describe("liveUseLeases", () => {
  it("ignores expired leases", async () => {
    const storage = memoryStorage();
    const past = new Date(Date.now() - 60 * 60_000);
    await acquireUseLease(storage, OLD, "restore", { now: () => past, leaseMs: 1000 });
    expect(await liveUseLeases(storage, OLD)).toEqual([]);
  });

  it("counts a recently written unreadable lease as live", async () => {
    const storage = memoryStorage();
    await storage.put(`${useLeasesPrefix(OLD)}restore-garbage.json`, Buffer.from("{ nope"));
    expect(await liveUseLeases(storage, OLD)).toHaveLength(1);
  });
});

describe("prune and delete respect use leases", () => {
  it("keeps a backup a restore is reading, and says why", async () => {
    const storage = memoryStorage();
    for (const id of [OLD, NEW]) await putCompleteBackup(storage, id);
    const now = new Date("2026-10-20T12:00:00Z");

    const result = await withUseLease(storage, [OLD], "restore", {}, () =>
      pruneBackups(storage, { last: 1 }, { now }),
    );
    expect(result.plan.remove).toEqual([]);
    expect(result.plan.keep.find((kept) => kept.id === OLD)?.reasons).toEqual([
      expect.stringMatching(/^in use \(restore on /),
    ]);
    // Once the restore is done, the next prune removes it.
    const after = await pruneBackups(storage, { last: 1 }, { now });
    expect(after.plan.remove.map((removed) => removed.id)).toEqual([OLD]);
  });

  it("does not treat a long-running backup as abandoned while its heartbeat is alive", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, NEW);
    await putIncompleteBackup(storage, OLD);
    const heartbeat = await holdUseLease(storage, OLD, "backup");
    // Two days after its last visible write: far beyond the 24 hour grace period.
    const later = new Date(Date.now() + 2 * 24 * 60 * 60_000);
    try {
      const result = await pruneBackups(storage, { last: 1 }, { now: later, dryRun: true });
      expect(result.plan.remove.map((removed) => removed.id)).not.toContain(OLD);
    } finally {
      await heartbeat.release();
    }
    const after = await pruneBackups(storage, { last: 1 }, { now: later, dryRun: true });
    expect(after.plan.remove.map((removed) => removed.id)).toContain(OLD);
  });

  it("refuses to delete a backup in use", async () => {
    const storage = memoryStorage();
    await putCompleteBackup(storage, OLD);
    const error = await withUseLease(storage, [OLD], "drill", {}, () =>
      deleteBackupById(storage, OLD).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );
    expect(isMongoShieldError(error, "MS_BACKUP_PROTECTED")).toBe(true);
    expect(String(error)).toContain("in use (drill on ");
  });
});

describe("releasing a lease while it is being renewed", () => {
  it("waits for the renewal in flight, so the deleted lease does not come back", async () => {
    const inner = memoryStorage();
    // The first write (acquiring) goes through; the next one (the first renewal) hangs
    // until the test lets it land.
    let writes = 0;
    let renewalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    let landRenewal: () => void = () => {};
    const landed = new Promise<void>((resolve) => {
      landRenewal = resolve;
    });
    const slow: StorageAdapter = {
      ...inner,
      put: async (key, body, options) => {
        writes++;
        if (writes === 2) {
          renewalStarted();
          await landed;
        }
        return inner.put(key, body, options);
      },
    };

    // Renewed every 10 ms.
    const held = await holdUseLease(slow, OLD, "restore", { leaseMs: 30 });
    await started;
    const releasing = held.release();
    // The release must not delete before the slow write has landed.
    landRenewal();
    await releasing;

    expect(inner.keys().filter((key) => key.startsWith(useLeasesPrefix(OLD)))).toEqual([]);
    // And no later renewal writes it again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(inner.keys().filter((key) => key.startsWith(useLeasesPrefix(OLD)))).toEqual([]);
  });

  it("writes nothing for a renewal after the release", async () => {
    const storage = memoryStorage();
    const lease = await acquireUseLease(storage, OLD, "verify");
    await lease.release();
    await lease.renew();
    expect(storage.keys().filter((key) => key.startsWith(useLeasesPrefix(OLD)))).toEqual([]);
  });
});

describe("liveUseLeasesByBackup", () => {
  it("groups every backup's live leases by backup id, from one listing", async () => {
    const storage = memoryStorage();
    await acquireUseLease(storage, OLD, "restore");
    await acquireUseLease(storage, OLD, "verify");
    await acquireUseLease(storage, NEW, "drill");
    // Expired, and not a lease at all: neither shows up.
    const past = new Date(Date.now() - 60 * 60_000);
    await acquireUseLease(storage, MIDDLE, "restore", { now: () => past, leaseMs: 1000 });
    await storage.put(`annotations/${NEW}/verification.json`, Buffer.from("{}"));

    const byBackup = await liveUseLeasesByBackup(storage);
    expect([...byBackup.keys()].sort()).toEqual([OLD, NEW].sort());
    expect(
      byBackup
        .get(OLD)
        ?.map((lease) => lease.purpose)
        .sort(),
    ).toEqual(["restore", "verify"]);
    expect(byBackup.get(NEW)?.map((lease) => lease.purpose)).toEqual(["drill"]);
  });

  it("is what prune plans with: no listing per backup", async () => {
    const inner = memoryStorage();
    for (const id of [OLD, MIDDLE, NEW]) await putCompleteBackup(inner, id);
    await acquireUseLease(inner, OLD, "restore");
    const listed: string[] = [];
    const storage: StorageAdapter = {
      ...inner,
      list: (prefix, options) => {
        listed.push(prefix);
        return inner.list(prefix, options);
      },
    };
    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: new Date("2026-10-20T12:00:00Z"), dryRun: true },
    );
    expect(listed.filter((prefix) => prefix.endsWith("/leases/"))).toEqual([]);
    expect(result.plan.remove.map((removed) => removed.id)).toEqual([MIDDLE]);
  });
});

describe("prune keeps the chain of a backup that comes into use while pruning", () => {
  it("skips the backup and every ancestor the plan meant to remove", async () => {
    const inner = memoryStorage();
    const base = makeChainBase(idAt("2026-10-17T03:00:00Z"), 1000);
    const first = makeIncremental(idAt("2026-10-18T03:00:00Z"), base, 2000);
    const second = makeIncremental(idAt("2026-10-19T03:00:00Z"), first, 3000);
    const newest = makeChainBase(idAt("2026-10-20T03:00:00Z"), 4000);
    for (const manifest of [base, first, second, newest]) {
      await inner.put(resolveBackupKey(manifest.id, "app/users.bson"), Buffer.from("data"));
      await writeManifest(inner, manifest);
    }
    // A restore of `second` (it reads the whole chain) starts after the plan was made:
    // the lease appears when prune re-checks `second` right before deleting it.
    let restoreStarted = false;
    const storage: StorageAdapter = {
      ...inner,
      list: (prefix, options) => {
        if (prefix === useLeasesPrefix(second.id) && !restoreStarted) {
          restoreStarted = true;
          return (async function* () {
            await acquireUseLease(inner, second.id, "restore");
            yield* inner.list(prefix, options);
          })();
        }
        return inner.list(prefix, options);
      },
    };

    const result = await pruneBackups(
      storage,
      { last: 1 },
      { now: new Date("2026-10-20T12:00:00Z") },
    );
    expect(result.plan.remove.map((removed) => removed.id)).toEqual([second.id, first.id, base.id]);
    expect(result.skipped).toEqual([second.id, first.id, base.id]);
    expect(result.deletedBackups).toBe(0);
    for (const manifest of [base, first, second]) {
      expect(inner.keys()).toContain(manifestKey(manifest.id));
    }
  });
});
