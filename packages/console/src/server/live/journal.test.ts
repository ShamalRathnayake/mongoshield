/**
 * Unit tests for the live edit journal (sealed parts, locations), the journal index
 * (history.ts), the access rules (access.ts) and the client cache (clients.ts).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageRegistry } from "../../jobs/storage.ts";
import { sealConnectionUri } from "../../state/secrets.ts";
import { StateStore } from "../../state/store.ts";
import type { ConnectionRecord, LiveEditRecord, UserRecord } from "../../state/types.ts";
import { liveEditSettingsView, liveWriteRefusal } from "./access.ts";
import { inverseOf } from "./apply.ts";
import { LiveClients } from "./clients.ts";
import { addEntry, entryById, entryView, isUndoable, updateEntry } from "./history.ts";
import { LiveJournal, LOCAL_JOURNAL_DIR, partKey, partsOf } from "./journal.ts";

const SECRET = "journal-test-secret-0123456789abcdef0123";

let dataDir: string;
let store: StateStore;
let registry: StorageRegistry;
let journal: LiveJournal;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-live-"));
  store = await StateStore.open({ dataDir, secret: SECRET });
  registry = new StorageRegistry({ dataDir, credentialsOf: () => ({}) });
  journal = new LiveJournal({ store, storage: registry, dataDir });
});

afterEach(async () => {
  await journal.close();
  await registry.closeAll();
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A journal index entry with sensible defaults. */
function entry(overrides: Partial<LiveEditRecord> = {}): LiveEditRecord {
  return {
    id: "e1",
    connectionId: "c1",
    ns: "app.users",
    op: "update",
    by: "wanda",
    at: "2026-10-24T10:00:00.000Z",
    status: "applied",
    documents: 1,
    applied: 1,
    conflicts: 0,
    journal: { kind: "console" },
    parts: 1,
    ...overrides,
  };
}

describe("the journal", () => {
  it("seals parts in the data directory and reads them back", async () => {
    const record = { id: '{"$numberInt":"1"}', before: '{"_id":{"$numberInt":"1"},"name":"Ada"}' };
    await journal.writePart(entry(), 0, [record]);
    const file = join(dataDir, LOCAL_JOURNAL_DIR, partKey(entry(), 0));
    const sealed = await readFile(file, "utf8");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("Ada");
    expect(await journal.readPart(entry(), 0)).toEqual([record]);
    const all = [];
    for await (const part of journal.records(entry())) all.push(part);
    expect(all).toEqual([{ part: 0, records: [record] }]);
  });

  it("refuses a part moved to another entry or position", async () => {
    await journal.writePart(entry(), 0, [{ id: "1" }]);
    const sealed = await readFile(join(dataDir, LOCAL_JOURNAL_DIR, partKey(entry(), 0)), "utf8");
    // Same bytes under another entry's key: the additional data no longer matches.
    const other = entry({ id: "e2" });
    await journal.writePart(other, 0, []);
    await writeFile(join(dataDir, LOCAL_JOURNAL_DIR, partKey(other, 0)), sealed);
    await expect(journal.readPart(other, 0)).rejects.toThrow();
  });

  it("writes to a configured storage location, and falls back to the data directory", async () => {
    await store.update((state) => {
      state.storage = [
        {
          id: "s1",
          name: "journal",
          url: "memory://journal-unit",
          createdAt: "2026-10-24T10:00:00.000Z",
          updatedAt: "2026-10-24T10:00:00.000Z",
        },
      ];
    });
    expect(journal.locationFor("s1")).toEqual({ kind: "storage", storageId: "s1" });
    expect(journal.locationFor("deleted")).toEqual({ kind: "console" });
    expect(journal.locationFor(undefined)).toEqual({ kind: "console" });
    const stored = entry({ journal: { kind: "storage", storageId: "s1" } });
    await journal.writePart(stored, 0, [{ id: "1", after: "{}" }]);
    expect(await journal.readPart(stored, 0)).toEqual([{ id: "1", after: "{}" }]);
    const gone = entry({ journal: { kind: "storage", storageId: "deleted" } });
    await expect(journal.readPart(gone, 0)).rejects.toThrow("was deleted");
  });

  it("splits records into parts of 100", () => {
    expect(
      partsOf(Array.from({ length: 250 }, (_, index) => index)).map((part) => part.length),
    ).toEqual([100, 100, 50]);
    expect(partsOf([])).toEqual([]);
    expect(partKey(entry(), 12)).toBe("live-edits/c1/e1/part-000012.sealed");
  });
});

describe("undo of journaled records", () => {
  it("swaps before and after, and cannot undo a bulk update without its post-image", () => {
    expect(inverseOf("update", { id: "1", before: "A", after: "B" })).toEqual({
      id: "1",
      before: "B",
      after: "A",
    });
    expect(inverseOf("insert", { id: "1", after: "B" })).toEqual({ id: "1", before: "B" });
    expect(inverseOf("bulk-delete", { id: "1", before: "A" })).toEqual({ id: "1", after: "A" });
    expect(inverseOf("bulk-update", { id: "1", before: "A" })).toBeUndefined();
    expect(inverseOf("update", { id: "1" })).toBeUndefined();
  });
});

describe("the journal index", () => {
  it("adds entries newest first, updates them and finds them", async () => {
    await addEntry(store, entry({ id: "a" }));
    await addEntry(store, entry({ id: "b" }));
    expect(store.current.liveEdits?.map((candidate) => candidate.id)).toEqual(["b", "a"]);
    const updated = await updateEntry(store, "a", { status: "partial", conflicts: 2 });
    expect(updated).toMatchObject({ id: "a", status: "partial", conflicts: 2 });
    expect(await updateEntry(store, "missing", { status: "failed" })).toBeUndefined();
    expect(entryById(store, "b").id).toBe("b");
    expect(() => entryById(store, "missing")).toThrow("was not found");
  });

  it("knows which entries can be undone", () => {
    expect(isUndoable(entry())).toBe(true);
    expect(isUndoable(entry({ status: "pending", applied: 0 }))).toBe(true);
    expect(isUndoable(entry({ status: "conflict", applied: 0 }))).toBe(false);
    expect(isUndoable(entry({ undoneBy: "x" }))).toBe(false);
  });

  it("shows the connection's name while it exists", async () => {
    expect(entryView(store, entry()).connectionName).toBeUndefined();
    await store.update((state) => {
      state.connections = [connection()];
    });
    const view = entryView(
      store,
      entry({ journal: { kind: "storage", storageId: "s1" }, undoOf: "z" }),
    );
    expect(view).toMatchObject({
      connectionName: "scratch",
      journal: { kind: "storage", storageId: "s1" },
      undoOf: "z",
      undoable: true,
    });
  });
});

/** A connection record (the URI is never opened in these tests). */
function connection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "c1",
    name: "scratch",
    uri: "sealed",
    uriPreview: "mongodb://localhost",
    production: false,
    createdAt: "2026-10-24T10:00:00.000Z",
    ...overrides,
  };
}

/** A user record. */
function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "u1",
    username: "wanda",
    role: "operator",
    passwordHash: "",
    createdAt: "2026-10-24T10:00:00.000Z",
    permissions: ["data:write"],
    ...overrides,
  };
}

describe("access", () => {
  const enabled = {
    enabled: true,
    changedBy: "admin",
    changedAt: "2026-10-24T10:00:00.000Z",
    productionConfirmed: false,
    maxBulkDocuments: 1000,
  };

  it("needs the permission, a role that may hold it, and live edits on", () => {
    const on = connection({ liveEdits: enabled });
    expect(liveWriteRefusal(user(), on)).toBeUndefined();
    expect(liveWriteRefusal(user({ permissions: [] }), on)?.code).toBe("CONSOLE_FORBIDDEN");
    expect(liveWriteRefusal(user({ role: "viewer" }), on)?.code).toBe("CONSOLE_FORBIDDEN");
    expect(liveWriteRefusal(user(), connection())?.code).toBe("CONSOLE_LIVE_EDITS_DISABLED");
    expect(
      liveWriteRefusal(user(), connection({ liveEdits: { ...enabled, enabled: false } }))?.code,
    ).toBe("CONSOLE_LIVE_EDITS_DISABLED");
  });

  it("needs the production confirmation on production connections", () => {
    const unconfirmed = connection({ production: true, liveEdits: enabled });
    expect(liveWriteRefusal(user(), unconfirmed)?.message).toContain("marked production");
    const confirmed = connection({
      production: true,
      liveEdits: { ...enabled, productionConfirmed: true },
    });
    expect(liveWriteRefusal(user(), confirmed)).toBeUndefined();
  });

  it("shows defaults for connections that never had settings", () => {
    expect(liveEditSettingsView(connection())).toEqual({
      enabled: false,
      productionConfirmed: false,
      maxBulkDocuments: 1000,
    });
    expect(
      liveEditSettingsView(
        connection({ liveEdits: { ...enabled, reason: "why", journalStorageId: "s1" } }),
      ),
    ).toMatchObject({ reason: "why", journalStorageId: "s1", changedBy: "admin" });
  });
});

describe("the client cache", () => {
  it("does not keep a client that failed to connect, and closes cleanly", async () => {
    const id = "c-unreachable";
    // Port 1 refuses connections; a short selection timeout makes the failure quick.
    const uri = "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200";
    const record = connection({ id, uri: sealConnectionUri(store, id, uri) });
    const clients = new LiveClients(store, 50);
    await expect(clients.clientFor(record)).rejects.toThrow();
    // A second attempt tries again (the failure was not cached).
    await expect(clients.clientFor(record)).rejects.toThrow();
    await clients.closeAll();
  });
});
