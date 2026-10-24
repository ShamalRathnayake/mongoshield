/**
 * Tests for the console's state store: initialisation, atomic and serialized
 * updates, encryption bound to a context, refusing files it cannot trust
 * (corrupt JSON, unknown versions, a different secret) and the data directory lock.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

describe("StateStore edge cases", () => {
  /** A minimal valid state file with one field overridden. */
  async function stateFileWith(dataDir: string, override: Record<string, unknown>): Promise<void> {
    const store = await StateStore.open({ dataDir, secret: SECRET });
    await store.close();
    const saved = JSON.parse(await readFile(join(dataDir, STATE_FILE), "utf8"));
    await writeFile(join(dataDir, STATE_FILE), JSON.stringify({ ...saved, ...override }));
  }

  it("refuses a state file of a version it does not know instead of guessing", async () => {
    const dataDir = await tempDir();
    await stateFileWith(dataDir, { version: 2 });
    await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toThrow(
      /not a MongoShield console state file of version 1/,
    );
  });

  it("refuses a state file whose lists are missing or of the wrong type", async () => {
    const dataDir = await tempDir();
    await stateFileWith(dataDir, { users: "nobody" });
    await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toBeInstanceOf(
      StateOpenError,
    );
  });

  it("refuses JSON that is not an object", async () => {
    for (const content of ["null", "[]", '"text"']) {
      const dataDir = await tempDir();
      await writeFile(join(dataDir, STATE_FILE), content);
      await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toBeInstanceOf(
        StateOpenError,
      );
    }
  });

  it("passes on read errors other than a missing file and releases the lock", async () => {
    const dataDir = await tempDir();
    await mkdir(join(dataDir, STATE_FILE));
    await expect(StateStore.open({ dataDir, secret: SECRET })).rejects.toMatchObject({
      code: "EISDIR",
    });
    expect(await readdir(dataDir)).not.toContain(LOCK_FILE);
  });

  it("keeps the in-memory state when the file cannot be written, and recovers afterwards", async () => {
    const dataDir = await tempDir();
    const store = await open(dataDir);
    // A read-only directory makes the temp file impossible to create.
    await chmod(dataDir, 0o500);
    try {
      await expect(
        store.update((state) => {
          state.plans = [];
          state.jobs = [{ id: "lost", kind: "backup", status: "queued", startedBy: "t" }];
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(store.current.jobs).toEqual([]);
    } finally {
      await chmod(dataDir, 0o700);
    }
    await store.update((state) => {
      state.jobs = [{ id: "kept", kind: "backup", status: "queued", startedBy: "t" }];
    });
    const saved = JSON.parse(await readFile(join(dataDir, STATE_FILE), "utf8"));
    expect(saved.jobs.map((job: { id: string }) => job.id)).toEqual(["kept"]);
  });

  it("reopens a directory with the same secret and keeps the data", async () => {
    const dataDir = await tempDir();
    const store = await open(dataDir);
    await store.update((state) => {
      state.jobs = [{ id: "j1", kind: "verify", status: "succeeded", startedBy: "t" }];
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = await open(dataDir);
    expect(reopened.current.jobs[0]?.id).toBe("j1");
    expect(reopened.csrfKey).toHaveLength(32);
  });
});
