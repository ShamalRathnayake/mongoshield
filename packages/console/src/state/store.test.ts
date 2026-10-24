import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DataDirLockedError, LOCK_FILE, STALE_AFTER_MS } from "./lock.ts";
import { STATE_FILE, StateOpenError, StateStore } from "./store.ts";

const SECRET = "store-test-secret-0123456789abcdef0123";
const directories: string[] = [];
const stores: StateStore[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ms-state-"));
  directories.push(directory);
  return directory;
}

async function open(dataDir: string, secret = SECRET): Promise<StateStore> {
  const store = await StateStore.open({ dataDir, secret });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("initialises an empty state with a random salt, readable only by its owner", async () => {
    const dataDir = await tempDir();
    const store = await open(dataDir);
    expect(store.current.users).toEqual([]);
    expect(Buffer.from(store.current.keySalt, "base64")).toHaveLength(32);
    const mode = (await stat(join(dataDir, STATE_FILE))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("refuses a short secret", async () => {
    await expect(
      StateStore.open({ dataDir: await tempDir(), secret: "short" }),
    ).rejects.toBeInstanceOf(StateOpenError);
  });

  it("saves updates atomically and leaves no temp files", async () => {
    const dataDir = await tempDir();
    const store = await open(dataDir);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.update((state) => {
          state.jobs = [
            { id: String(index), kind: "backup", status: "queued", startedBy: "t" },
            ...state.jobs,
          ];
        }),
      ),
    );
    const saved = JSON.parse(await readFile(join(dataDir, STATE_FILE), "utf8"));
    expect(saved.jobs).toHaveLength(20);
    expect((await readdir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the in-memory state unchanged when an update throws", async () => {
    const store = await open(await tempDir());
    await expect(
      store.update((state) => {
        state.users = [];
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(store.current.users).toEqual([]);
    // The queue keeps working afterwards.
    await store.update((state) => {
      state.plans = [];
    });
  });

  it("encrypts secrets bound to their context", async () => {
    const store = await open(await tempDir());
    const sealed = store.encrypt("hunter2", "a");
    expect(store.decrypt(sealed, "a")).toBe("hunter2");
    expect(() => store.decrypt(sealed, "b")).toThrow();
  });

  it("refuses to open with a different secret", async () => {
    const dataDir = await tempDir();
    const store = await open(dataDir);
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    await expect(
      StateStore.open({ dataDir, secret: "another-secret-0123456789abcdef0123" }),
    ).rejects.toThrow(/does not match/);
    // The failed attempt released the lock: the right secret still works.
    await open(dataDir);
  });

  it("refuses a corrupt state file", async () => {
    const dataDir = await tempDir();
    await writeFile(join(dataDir, STATE_FILE), "{ not json");
    await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toBeInstanceOf(
      StateOpenError,
    );
  });

  it("lets only one process own a data directory, but takes over an abandoned lock", async () => {
    const dataDir = await tempDir();
    await open(dataDir);
    await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toBeInstanceOf(
      DataDirLockedError,
    );

    const other = await tempDir();
    const stale = new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();
    await writeFile(
      join(other, LOCK_FILE),
      JSON.stringify({ owner: "gone", host: "old", pid: 1, heartbeatAt: stale }),
    );
    await open(other);
  });
});
