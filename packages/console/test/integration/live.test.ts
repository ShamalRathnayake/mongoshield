/**
 * The live data browser end to end through the API, against the real test replica set:
 * browsing (filters, projections, sorts, paging, counts, stats, indexes), the live edit
 * settings and their production rules, the data:write permission, conditional writes and
 * conflicts, the pre-image journal (sealed, in the journal storage or the data directory),
 * undo and redo, bulk edits as jobs with caps and typed confirmations, and the audit trail.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { BSON, Double, Long, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LOCAL_JOURNAL_DIR } from "../../src/server/live/journal.ts";
import type {
  JobSummary,
  LiveDocument,
  LiveDocumentPage,
  LiveEditEntryView,
} from "../../src/shared/api.ts";
import {
  mongoUri,
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  userWithRole,
  waitForJob,
} from "../helpers/console.ts";

const db = uniqueDb("live");
const NS = `${db}.users`;
const DOCUMENTS = 30;

let testConsole: TestConsole;
let admin: TestClient;
let operator: TestClient;
let writer: TestClient;
let viewer: TestClient;
let mongo: MongoClient;
const ids = { scratch: "", production: "", storage: "" };

/** The raw collection, for checking what the console really wrote. */
function users() {
  return mongo.db(db).collection<{ _id: number; [key: string]: unknown }>("users");
}

/** Reads one page through the API. */
async function page(
  client: TestClient,
  query: Record<string, string>,
  connection = ids.scratch,
): Promise<LiveDocumentPage> {
  const search = new URLSearchParams({ ns: NS, ...query }).toString();
  const response = await client.request("GET", `/api/live/${connection}/documents?${search}`);
  expect(response.status, response.text).toBe(200);
  return response.body;
}

/** The live document with this `_id` (an integer in the seed data). */
async function documentById(id: number): Promise<LiveDocument> {
  const result = await page(writer, { filter: JSON.stringify({ _id: id }) });
  const document = result.documents[0];
  if (document === undefined) throw new Error(`No document ${id}`);
  return document;
}

/** Turns live edits on for the scratch connection, journaling to the test storage. */
async function enableScratch(extra: Record<string, unknown> = {}): Promise<void> {
  const response = await admin.request("PUT", `/api/connections/${ids.scratch}/live-edits`, {
    enabled: true,
    journalStorageId: ids.storage,
    ...extra,
  });
  expect(response.status, response.text).toBe(200);
}

/** Replaces document `id` through the API with `changes` applied to its relaxed JSON. */
async function edit(id: number, changes: Record<string, unknown>) {
  const document = await documentById(id);
  const edited = { ...JSON.parse(document.json), ...changes };
  return writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
    ns: NS,
    id: document.id,
    version: document.version,
    document: JSON.stringify(edited),
  });
}

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  operator = await userWithRole(testConsole, admin, "operator", "olga");
  writer = await userWithRole(testConsole, admin, "operator", "wanda", ["data:write"]);
  viewer = await userWithRole(testConsole, admin, "viewer", "victor");
  mongo = new MongoClient(mongoUri());
  await mongo.connect();
  await users().insertMany(
    Array.from({ length: DOCUMENTS }, (_, index) => ({
      _id: index,
      name: `user ${index}`,
      email: `user${index}@example.com`,
      group: index % 3,
    })),
  );
  await users().createIndex({ email: 1 }, { unique: true });
  ids.scratch = (
    await admin.request("POST", "/api/connections", {
      name: "scratch",
      uri: mongoUri(),
      production: false,
    })
  ).body.id;
  ids.production = (
    await admin.request("POST", "/api/connections", {
      name: "prod",
      uri: mongoUri(),
      production: true,
    })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", {
      name: "journal",
      url: `memory://${uniqueDb("journal")}`,
    })
  ).body.id;
});

afterAll(async () => {
  await mongo.close();
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("browsing live data", () => {
  it("needs the operator role, like the backup document browser", async () => {
    const response = await viewer.request("GET", `/api/live/${ids.scratch}/documents?ns=${NS}`);
    expect(response.status).toBe(403);
  });

  it("pages through documents with an estimated count, in _id order by default", async () => {
    const first = await page(operator, { limit: "10", sort: '{"_id": 1}' });
    expect(first.documents).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(first.count).toEqual({ value: DOCUMENTS, kind: "estimated" });
    expect(JSON.parse(first.documents[0]?.json ?? "{}")).toMatchObject({ _id: 0, name: "user 0" });
    expect(first.documents[0]?.version).toMatch(/^[0-9a-f]{64}$/);
    const last = await page(operator, { limit: "10", skip: "20", sort: '{"_id": 1}' });
    expect(last.hasMore).toBe(false);
    expect(JSON.parse(last.documents[9]?.json ?? "{}")._id).toBe(29);
  });

  it("filters, sorts and counts exactly with a filter", async () => {
    const result = await page(operator, { filter: '{"group": 1}', sort: '{"_id": -1}' });
    expect(result.count).toEqual({ value: 10, kind: "exact" });
    expect(JSON.parse(result.documents[0]?.json ?? "{}")._id).toBe(28);
  });

  it("marks projected documents as partial: they carry no version and cannot be edited", async () => {
    const result = await page(operator, { projection: '{"email": 1}', limit: "1" });
    expect(result.projected).toBe(true);
    expect(result.documents[0]?.version).toBeUndefined();
    expect(Object.keys(JSON.parse(result.documents[0]?.json ?? "{}"))).toEqual(["_id", "email"]);
  });

  it("refuses server-side JavaScript, bad sorts and MongoDB's own databases", async () => {
    const where = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${NS}&filter=${encodeURIComponent('{"$where": "sleep(1000)"}')}`,
    );
    expect(where.status).toBe(400);
    expect(where.body.error.message).toContain("$where");
    const nested = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${NS}&filter=${encodeURIComponent('{"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}')}`,
    );
    expect(nested.status).toBe(400);
    const sort = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${NS}&sort=${encodeURIComponent('{"name": 2}')}`,
    );
    expect(sort.status).toBe(400);
    const system = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=admin.system.users`,
    );
    expect(system.status).toBe(400);
    expect(system.body.error.message).toContain("belongs to MongoDB itself");
  });

  it("describes MongoDB's refusals as a query error", async () => {
    const response = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${NS}&filter=${encodeURIComponent('{"name": {"$regex": "("}}')}`,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONSOLE_LIVE_QUERY");
  });

  it("shows stats and indexes, and why the caller cannot write", async () => {
    const response = await operator.request("GET", `/api/live/${ids.scratch}/collection?ns=${NS}`);
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({
      ns: NS,
      type: "collection",
      estimatedDocuments: DOCUMENTS,
      capped: false,
      writable: false,
    });
    expect(response.body.readOnlyReason).toContain("data:write");
    const names = response.body.indexes.map((index: { name: string }) => index.name);
    expect(names).toEqual(expect.arrayContaining(["_id_", "email_1"]));
    const email = response.body.indexes.find((index: { name: string }) => index.name === "email_1");
    expect(email).toMatchObject({ key: '{"email":1}', unique: true });

    const writerView = await writer.request("GET", `/api/live/${ids.scratch}/collection?ns=${NS}`);
    expect(writerView.body.readOnlyReason).toContain("turned off");
    const missing = await operator.request(
      "GET",
      `/api/live/${ids.scratch}/collection?ns=${db}.nothing`,
    );
    expect(missing.status).toBe(404);
  });

  it("audits who read which namespace, without the documents", async () => {
    const entries = (await admin.request("GET", "/api/audit?limit=200")).body as {
      action: string;
      actor: string;
      target?: string;
    }[];
    const browse = entries.find(
      (entry) => entry.action === "live.browse" && entry.actor === "olga",
    );
    expect(browse?.target).toBe(`scratch/${NS}`);
    expect(JSON.stringify(browse)).not.toContain("example.com");
  });
});

describe("live edit settings", () => {
  it("are off by default and only admins change them", async () => {
    const connection = (await operator.request("GET", "/api/connections")).body.find(
      (candidate: { id: string }) => candidate.id === ids.scratch,
    );
    expect(connection.liveEdits).toEqual({
      enabled: false,
      productionConfirmed: false,
      maxBulkDocuments: 1000,
    });
    const refused = await writer.request("PUT", `/api/connections/${ids.scratch}/live-edits`, {
      enabled: true,
    });
    expect(refused.status).toBe(403);
  });

  it("refuses writes while edits are off, even with data:write", async () => {
    const document = await documentById(1);
    const response = await writer.request("POST", `/api/live/${ids.scratch}/documents/delete`, {
      ns: NS,
      id: document.id,
      version: document.version,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("CONSOLE_LIVE_EDITS_DISABLED");
  });

  it("need the typed name and a reason for a production connection", async () => {
    const path = `/api/connections/${ids.production}/live-edits`;
    const noName = await admin.request("PUT", path, { enabled: true, reason: "fix a typo" });
    expect(noName.status).toBe(400);
    expect(noName.body.error.code).toBe("MS_CONFIRMATION_REQUIRED");
    const noReason = await admin.request("PUT", path, { enabled: true, confirmName: "prod" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.message).toContain("reason");
    const confirmed = await admin.request("PUT", path, {
      enabled: true,
      confirmName: "prod",
      reason: "INC-42: fix a customer's email",
      maxBulkDocuments: 50,
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body.liveEdits).toMatchObject({
      enabled: true,
      productionConfirmed: true,
      reason: "INC-42: fix a customer's email",
      changedBy: "admin",
      maxBulkDocuments: 50,
    });
    const audit = (await admin.request("GET", "/api/audit?limit=50")).body.find(
      (entry: { action: string }) => entry.action === "connection.live_edits",
    );
    expect(audit.details).toMatchObject({ production: true, productionConfirmed: true });
    expect(audit.details.reason).toContain("INC-42");
    // Turn it off again for the rest of the tests.
    await admin.request("PUT", path, { enabled: false });
  });

  it("validate the journal storage and the bulk cap", async () => {
    const path = `/api/connections/${ids.scratch}/live-edits`;
    const unknownStorage = await admin.request("PUT", path, {
      enabled: true,
      journalStorageId: "missing",
    });
    expect(unknownStorage.status).toBe(404);
    const tooLarge = await admin.request("PUT", path, { enabled: true, maxBulkDocuments: 10_001 });
    expect(tooLarge.status).toBe(400);
  });

  it("are turned off when a connection is marked production afterwards", async () => {
    const created = await admin.request("POST", "/api/connections", {
      name: "staging",
      uri: mongoUri(),
      production: false,
    });
    const id = created.body.id;
    await admin.request("PUT", `/api/connections/${id}/live-edits`, { enabled: true });
    const marked = await admin.request("PUT", `/api/connections/${id}`, {
      name: "staging",
      production: true,
    });
    expect(marked.status).toBe(200);
    expect(marked.body.liveEdits).toMatchObject({ enabled: false, productionConfirmed: false });
    await admin.request("DELETE", `/api/connections/${id}`);
  });

  it("protect the journal storage from deletion while a connection uses it", async () => {
    await enableScratch();
    const response = await admin.request("DELETE", `/api/storage/${ids.storage}`);
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("live edit journal");
  });
});

describe("the data:write permission", () => {
  it("is granted per user, never to viewers", async () => {
    const created = await admin.request("POST", "/api/users", {
      username: "vera",
      role: "viewer",
      password: "correct horse battery staple",
      permissions: ["data:write"],
    });
    expect(created.status).toBe(400);
    const unknown = await admin.request("POST", "/api/users", {
      username: "vera",
      role: "operator",
      password: "correct horse battery staple",
      permissions: ["data:delete"],
    });
    expect(unknown.status).toBe(400);
  });

  it("is dropped when a user becomes a viewer, and kept when omitted", async () => {
    const created = await admin.request("POST", "/api/users", {
      username: "otto",
      role: "operator",
      password: "correct horse battery staple",
      permissions: ["data:write"],
    });
    expect(created.body.permissions).toEqual(["data:write"]);
    const renamed = await admin.request("PUT", `/api/users/${created.body.id}`, {
      username: "otto2",
      role: "operator",
    });
    expect(renamed.body.permissions).toEqual(["data:write"]);
    const demoted = await admin.request("PUT", `/api/users/${created.body.id}`, {
      username: "otto2",
      role: "viewer",
    });
    expect(demoted.body.permissions).toEqual([]);
    await admin.request("DELETE", `/api/users/${created.body.id}`);
  });

  it("is required even for admins", async () => {
    const response = await admin.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: "{}",
    });
    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("data:write");
    // Operators without it are refused as well.
    const operatorResponse = await operator.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: "{}",
    });
    expect(operatorResponse.status).toBe(403);
  });
});

describe("editing documents", () => {
  beforeAll(async () => {
    await enableScratch();
  });

  it("replaces a document, reports the changed fields and returns its new version", async () => {
    const response = await edit(1, { name: "Ada" });
    expect(response.status, response.text).toBe(200);
    expect(response.body.changedFields).toEqual(["name"]);
    expect(response.body.entry).toMatchObject({
      op: "update",
      status: "applied",
      by: "wanda",
      documentId: "1",
      applied: 1,
      undoable: true,
      journal: { kind: "storage", storageId: ids.storage },
    });
    expect(await users().findOne({ _id: 1 })).toMatchObject({
      name: "Ada",
      email: "user1@example.com",
    });
    const fresh = await documentById(1);
    expect(response.body.document.version).toBe(fresh.version);
    expect(response.body.entry.afterHash).toBe(fresh.version);
  });

  it("keeps the BSON type of every field the user did not touch", async () => {
    await users().insertOne({
      _id: 100,
      price: new Double(1),
      big: Long.fromString("9007199254740993"),
      nested: { ratio: new Double(2), label: "x" },
      name: "typed",
      email: "typed@example.com",
    });
    const document = await documentById(100);
    const edited = JSON.parse(document.json);
    edited.nested.label = "y";
    const response = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      id: document.id,
      version: document.version,
      document: JSON.stringify(edited),
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.changedFields).toEqual(["nested.label"]);
    const stored = await users().findOne(
      { _id: 100 },
      { promoteValues: false, promoteLongs: false },
    );
    const canonical = BSON.EJSON.stringify(stored, { relaxed: false });
    expect(canonical).toContain('"price":{"$numberDouble":"1.0"}');
    expect(canonical).toContain('"big":{"$numberLong":"9007199254740993"}');
    expect(canonical).toContain('"ratio":{"$numberDouble":"2.0"}');
    expect(canonical).toContain('"label":"y"');
  });

  it("refuses an edit made from an old version and changes nothing", async () => {
    const document = await documentById(2);
    // Someone else changes the document after it was loaded.
    await users().updateOne({ _id: 2 }, { $set: { name: "changed elsewhere" } });
    const response = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      id: document.id,
      version: document.version,
      document: JSON.stringify({ ...JSON.parse(document.json), name: "mine" }),
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONSOLE_LIVE_CONFLICT");
    expect(response.body.error.message).toContain("changed after you loaded it");
    expect((await users().findOne({ _id: 2 }))?.name).toBe("changed elsewhere");
  });

  it("refuses changing _id, unchanged documents and $-fields", async () => {
    const document = await documentById(3);
    const base = { ns: NS, id: document.id, version: document.version };
    const newId = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ...base,
      document: JSON.stringify({ ...JSON.parse(document.json), _id: 999 }),
    });
    expect(newId.status).toBe(400);
    expect(newId.body.error.message).toContain("_id");
    const same = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ...base,
      document: document.json,
    });
    expect(same.status).toBe(400);
    const operatorField = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ...base,
      document: '{"_id": 3, "$set": {"a": 1}}',
    });
    expect(operatorField.status).toBe(400);
    const badVersion = await writer.request("PUT", `/api/live/${ids.scratch}/documents`, {
      ...base,
      version: "nope",
      document: document.json,
    });
    expect(badVersion.status).toBe(400);
  });

  it("describes a document MongoDB refuses (a unique index) as a query error", async () => {
    const response = await edit(4, { email: "user5@example.com" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONSOLE_LIVE_QUERY");
    expect(response.body.error.message).toContain("duplicate key");
    expect((await users().findOne({ _id: 4 }))?.email).toBe("user4@example.com");
  });

  it("inserts with a new ObjectId, and refuses an _id that exists", async () => {
    const inserted = await writer.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: '{"name": "new user", "email": "new@example.com"}',
    });
    expect(inserted.status, inserted.text).toBe(200);
    expect(inserted.body.entry).toMatchObject({ op: "insert", status: "applied" });
    expect(inserted.body.document.json).toMatch(
      /^\{"_id":\{"\$oid":"[0-9a-f]{24}"\},"name":"new user"/,
    );
    const duplicate = await writer.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: '{"_id": 5, "name": "clash"}',
    });
    expect(duplicate.status).toBe(409);
    expect((await users().findOne({ _id: 5 }))?.name).toBe("user 5");
  });

  it("deletes conditionally", async () => {
    const document = await documentById(6);
    await users().updateOne({ _id: 6 }, { $set: { touched: true } });
    const stale = await writer.request("POST", `/api/live/${ids.scratch}/documents/delete`, {
      ns: NS,
      id: document.id,
      version: document.version,
    });
    expect(stale.status).toBe(409);
    const fresh = await documentById(6);
    const deleted = await writer.request("POST", `/api/live/${ids.scratch}/documents/delete`, {
      ns: NS,
      id: fresh.id,
      version: fresh.version,
    });
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body.document).toBeUndefined();
    expect(await users().findOne({ _id: 6 })).toBeNull();
  });

  it("writes nothing when the pre-image cannot be journaled", async () => {
    const spy = vi
      .spyOn(testConsole.services.live.journal, "writePart")
      .mockRejectedValueOnce(new Error("storage down"));
    const response = await edit(7, { name: "never" });
    spy.mockRestore();
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("CONSOLE_LIVE_JOURNAL");
    expect(response.body.error.message).toContain("nothing was changed");
    expect((await users().findOne({ _id: 7 }))?.name).toBe("user 7");
  });

  it("detects a change that slips in between the check and the write", async () => {
    // The compare-and-swap filter is the real guard: simulate a writer that changes the
    // document right after the pre-image was journaled.
    const original = testConsole.services.live.journal.writePart.bind(
      testConsole.services.live.journal,
    );
    const spy = vi
      .spyOn(testConsole.services.live.journal, "writePart")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        await users().updateOne({ _id: 8 }, { $set: { name: "raced" } });
      });
    const response = await edit(8, { name: "mine" });
    spy.mockRestore();
    expect(response.status).toBe(409);
    expect((await users().findOne({ _id: 8 }))?.name).toBe("raced");
    const history = (await operator.request("GET", `/api/live-edits?connectionId=${ids.scratch}`))
      .body as LiveEditEntryView[];
    expect(history[0]).toMatchObject({ status: "conflict", conflicts: 1, undoable: false });
  });
});

describe("the journal and undo", () => {
  it("keeps sealed pre-images in the journal storage, and only hashes in the index and audit log", async () => {
    const storage = testConsole.services.store.current.storage.find(
      (record) => record.id === ids.storage,
    );
    if (storage === undefined) throw new Error("no storage");
    const adapter = await testConsole.services.storage.adapterFor(storage);
    const keys: string[] = [];
    for await (const object of adapter.list(`live-edits/${ids.scratch}/`)) keys.push(object.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => /\/part-\d{6}\.sealed$/.test(key))).toBe(true);
    for (const key of keys) {
      const body = await text(await adapter.get(key));
      expect(body.startsWith("v1.")).toBe(true);
      expect(body).not.toContain("example.com");
    }
    const state = await readFile(join(testConsole.dataDir, "console.json"), "utf8");
    expect(state).toContain('"liveEdits"');
    expect(state).not.toContain("user1@example.com");
    const audit = await readFile(join(testConsole.dataDir, "audit.jsonl"), "utf8");
    expect(audit).not.toContain("example.com");
    const update = audit
      .split("\n")
      .filter((line) => line.includes('"live.update"'))
      .map((line) => JSON.parse(line))
      .find((entry) => entry.outcome === "success");
    expect(update.details).toMatchObject({ connection: "scratch", id: "1" });
    expect(update.details.before).toMatch(/^[0-9a-f]{64}$/);
    expect(update.details.after).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows an entry's journaled documents to operators (audited)", async () => {
    const history = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    const entry = history.find(
      (candidate) => candidate.op === "update" && candidate.documentId === "1",
    );
    const detail = await operator.request("GET", `/api/live-edits/${entry?.id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(JSON.parse(detail.body.records[0].before)).toMatchObject({ _id: 1, name: "user 1" });
    expect(JSON.parse(detail.body.records[0].after)).toMatchObject({ _id: 1, name: "Ada" });
    const audit = (await admin.request("GET", "/api/audit?limit=20")).body;
    expect(audit.some((line: { action: string }) => line.action === "live.history_read")).toBe(
      true,
    );
  });

  it("undoes an edit, and undoing the undo redoes it", async () => {
    const response = await edit(9, { name: "edited" });
    const entry: LiveEditEntryView = response.body.entry;
    const undone = await writer.request("POST", `/api/live-edits/${entry.id}/undo`);
    expect(undone.status, undone.text).toBe(200);
    expect(undone.body).toMatchObject({ kind: "applied", entry: { op: "undo", undoOf: entry.id } });
    expect((await users().findOne({ _id: 9 }))?.name).toBe("user 9");
    const again = await writer.request("POST", `/api/live-edits/${entry.id}/undo`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("CONSOLE_LIVE_NOT_UNDOABLE");
    const redo = await writer.request("POST", `/api/live-edits/${undone.body.entry.id}/undo`);
    expect(redo.status, redo.text).toBe(200);
    expect((await users().findOne({ _id: 9 }))?.name).toBe("edited");
  });

  it("refuses to undo over newer changes", async () => {
    const response = await edit(10, { name: "edited" });
    await users().updateOne({ _id: 10 }, { $set: { name: "newer" } });
    const undone = await writer.request("POST", `/api/live-edits/${response.body.entry.id}/undo`);
    expect(undone.status).toBe(409);
    expect(undone.body.error.message).toContain("would overwrite newer changes");
    expect((await users().findOne({ _id: 10 }))?.name).toBe("newer");
  });

  it("undoes inserts and deletes", async () => {
    const inserted = await writer.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: '{"_id": 200, "name": "temporary", "email": "temporary@example.com"}',
    });
    expect(inserted.status, inserted.text).toBe(200);
    expect(
      (await writer.request("POST", `/api/live-edits/${inserted.body.entry.id}/undo`)).status,
    ).toBe(200);
    expect(await users().findOne({ _id: 200 })).toBeNull();

    const history = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    const deletion = history.find((entry) => entry.op === "delete" && entry.documentId === "6");
    const restored = await writer.request("POST", `/api/live-edits/${deletion?.id}/undo`);
    expect(restored.status, restored.text).toBe(200);
    expect(await users().findOne({ _id: 6 })).toMatchObject({ name: "user 6", touched: true });
  });

  it("needs data:write and live edits on to undo", async () => {
    const history = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    const undoable = history.find((entry) => entry.undoable);
    expect((await operator.request("POST", `/api/live-edits/${undoable?.id}/undo`)).status).toBe(
      403,
    );
  });

  it("pages the history and filters it by connection", async () => {
    const first = (await operator.request("GET", "/api/live-edits?limit=2"))
      .body as LiveEditEntryView[];
    expect(first).toHaveLength(2);
    const next = (await operator.request("GET", `/api/live-edits?limit=2&before=${first[1]?.id}`))
      .body as LiveEditEntryView[];
    expect(next[0]?.id).not.toBe(first[0]?.id);
    const other = await operator.request("GET", `/api/live-edits?connectionId=${ids.production}`);
    expect(other.body).toEqual([]);
    expect((await operator.request("GET", "/api/live-edits/missing")).status).toBe(404);
  });

  it("keeps the journal in the data directory when no journal storage is set", async () => {
    // No journalStorageId: the journal goes to <data>/live-journal.
    const local = await admin.request("PUT", `/api/connections/${ids.scratch}/live-edits`, {
      enabled: true,
    });
    expect(local.body.liveEdits.journalStorageId).toBeUndefined();
    const response = await edit(11, { name: "local journal" });
    expect(response.body.entry.journal).toEqual({ kind: "console" });
    const entries = await readdir(
      join(testConsole.dataDir, LOCAL_JOURNAL_DIR, "live-edits", ids.scratch),
    );
    expect(entries).toContain(response.body.entry.id);
    expect(
      (await writer.request("POST", `/api/live-edits/${response.body.entry.id}/undo`)).status,
    ).toBe(200);
    expect((await users().findOne({ _id: 11 }))?.name).toBe("user 11");
    await enableScratch();
  });
});

describe("bulk edits", () => {
  const bulk = (body: Record<string, unknown>) =>
    writer.request("POST", `/api/live/${ids.scratch}/bulk`, { ns: NS, ...body });
  const preview = (body: Record<string, unknown>) =>
    writer.request("POST", `/api/live/${ids.scratch}/bulk/preview`, { ns: NS, ...body });

  it("previews the count and the text to type", async () => {
    const response = await preview({
      op: "update",
      filter: '{"group": 2}',
      update: '{"$set": {"tier": "gold"}}',
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({
      matched: 10,
      max: 1000,
      allowed: true,
      confirmText: `update 10 documents in ${NS}`,
    });
  });

  it("refuses updates that are not plain operators", async () => {
    for (const update of ['{"name": "x"}', '{"$set": {"_id": 1}}', '{"$where": "1"}', "[]", "{}"]) {
      const response = await preview({ op: "update", filter: "{}", update });
      expect(response.status, update).toBe(400);
    }
  });

  it("requires the exact confirmation and the previewed count", async () => {
    const wrongText = await bulk({
      op: "delete",
      filter: '{"group": 2}',
      expectedCount: 10,
      confirm: "yes",
    });
    expect(wrongText.status).toBe(400);
    expect(wrongText.body.error.message).toContain(`delete 10 documents in ${NS}`);
    const changed = await bulk({
      op: "delete",
      filter: '{"group": 2}',
      expectedCount: 9,
      confirm: `delete 9 documents in ${NS}`,
    });
    expect(changed.status).toBe(200);
    const job = await waitForJob(testConsole, changed.body.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("CONSOLE_LIVE_COUNT_CHANGED");
    expect(await users().countDocuments({ group: 2 })).toBe(10);
  });

  it("caps the documents one bulk edit may touch", async () => {
    await enableScratch({ maxBulkDocuments: 5 });
    const response = await preview({ op: "delete", filter: '{"group": 2}' });
    expect(response.body).toMatchObject({ matched: 10, max: 5, allowed: false });
    const refused = await bulk({
      op: "delete",
      filter: '{"group": 2}',
      expectedCount: 10,
      confirm: `delete 10 documents in ${NS}`,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("CONSOLE_LIVE_BULK_TOO_LARGE");
    await enableScratch({ maxBulkDocuments: 1000 });
  });

  it("updates many documents as a journaled job, and undoes them as one", async () => {
    const started = await bulk({
      op: "update",
      filter: '{"group": 2}',
      update: '{"$set": {"tier": "gold"}, "$inc": {"visits": 1}}',
      expectedCount: 10,
      confirm: `update 10 documents in ${NS}`,
    });
    expect(started.status, started.text).toBe(200);
    expect(started.body).toMatchObject({ kind: "live-edit", startedBy: "wanda" });
    const job: JobSummary = await waitForJob(testConsole, started.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(job.summary).toBe(`updated 10 of 10 documents in ${NS}`);
    expect(await users().countDocuments({ tier: "gold", visits: 1 })).toBe(10);

    const history = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    const entry = history.find((candidate) => candidate.jobId === job.id);
    expect(entry).toMatchObject({
      op: "bulk-update",
      status: "applied",
      applied: 10,
      documents: 10,
    });

    // One document changes after the bulk edit: undo must skip it, not overwrite it.
    await users().updateOne({ group: 2, _id: 2 }, { $set: { tier: "platinum" } });
    const undo = await writer.request("POST", `/api/live-edits/${entry?.id}/undo`);
    expect(undo.status, undo.text).toBe(200);
    expect(undo.body.kind).toBe("job");
    const undoJob = await waitForJob(testConsole, undo.body.job.id);
    expect(undoJob.status, JSON.stringify(undoJob.error)).toBe("succeeded");
    expect(undoJob.summary).toContain("undid the edit of 9 documents");
    expect(undoJob.summary).toContain("1 skipped");
    expect(await users().countDocuments({ tier: "gold" })).toBe(0);
    expect(await users().countDocuments({ tier: "platinum" })).toBe(1);
    const after = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    expect(after.find((candidate) => candidate.id === entry?.id)?.undoneBy).toBeDefined();
    expect(after.find((candidate) => candidate.undoOf === entry?.id)?.status).toBe("partial");
  });

  it("deletes many documents and brings them back with undo", async () => {
    const started = await bulk({
      op: "delete",
      filter: '{"group": 0, "_id": {"$lt": 12}}',
      expectedCount: 4,
      confirm: `delete 4 documents in ${NS}`,
    });
    const job = await waitForJob(testConsole, started.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(await users().countDocuments({ group: 0, _id: { $lt: 12 } })).toBe(0);
    const entry = (
      (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[]
    ).find((candidate) => candidate.jobId === job.id);
    const undo = await writer.request("POST", `/api/live-edits/${entry?.id}/undo`);
    const undoJob = await waitForJob(testConsole, undo.body.job.id);
    expect(undoJob.status).toBe("succeeded");
    expect(await users().countDocuments({ group: 0, _id: { $lt: 12 } })).toBe(4);
    const audit = (await admin.request("GET", "/api/audit?limit=50")).body as { action: string }[];
    expect(audit.map((line) => line.action)).toEqual(
      expect.arrayContaining([
        "live.bulk_delete.start",
        "live.bulk_delete",
        "live.undo.start",
        "live.undo",
      ]),
    );
  });
});

describe("collection kinds and limits", () => {
  it("shows views and time series collections as read-only", async () => {
    const database = mongo.db(db);
    await database.createCollection("active", {
      viewOn: "users",
      pipeline: [{ $match: { group: 1 } }],
    });
    await database.createCollection("metrics", {
      timeseries: { timeField: "at", metaField: "host" },
    });
    await database.collection("metrics").insertOne({ at: new Date(), host: "a", value: 1 });

    const view = await writer.request("GET", `/api/live/${ids.scratch}/collection?ns=${db}.active`);
    expect(view.status, view.text).toBe(200);
    expect(view.body).toMatchObject({
      type: "view",
      writable: false,
      readOnlyReason: "Views are read-only.",
    });
    expect(view.body.indexes).toEqual([]);
    // A view can still be browsed.
    const documents = await page(writer, { limit: "1" }, ids.scratch);
    expect(documents.documents).toHaveLength(1);
    const viewPage = await writer.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${db}.active&limit=100`,
    );
    expect(viewPage.status, viewPage.text).toBe(200);
    expect(viewPage.body.documents.length).toBeGreaterThan(0);

    const series = await writer.request(
      "GET",
      `/api/live/${ids.scratch}/collection?ns=${db}.metrics`,
    );
    expect(series.body).toMatchObject({ type: "timeseries", writable: false });
    expect(series.body.readOnlyReason).toContain("Time series");
  });

  it("reports “at least” for counts over 10,000", async () => {
    const many = mongo.db(db).collection<{ _id: number; n: number }>("many");
    await many.insertMany(Array.from({ length: 10_050 }, (_, index) => ({ _id: index, n: 1 })));
    const result = await writer.request(
      "GET",
      `/api/live/${ids.scratch}/documents?ns=${db}.many&limit=5&filter=${encodeURIComponent('{"n": 1}')}`,
    );
    expect(result.status, result.text).toBe(200);
    expect(result.body.count).toEqual({ value: 10_000, kind: "at-least" });
  });

  it("accepts live documents larger than the usual 64 KiB body limit", async () => {
    const big = { _id: "big", email: "big@example.com", text: "x".repeat(200 * 1024) };
    const inserted = await writer.request("POST", `/api/live/${ids.scratch}/documents`, {
      ns: NS,
      document: JSON.stringify(big),
    });
    expect(inserted.status, inserted.text.slice(0, 200)).toBe(200);
    // Other routes keep the small limit.
    const users = await admin.request("POST", "/api/users", {
      username: "huge",
      role: "viewer",
      password: "x".repeat(100 * 1024),
    });
    expect(users.status).toBe(413);
  });

  it("refuses to undo entries that changed nothing", async () => {
    const history = (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[];
    const conflict = history.find((entry) => entry.status === "conflict");
    const refused = await writer.request("POST", `/api/live-edits/${conflict?.id}/undo`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("changed nothing");
  });
});

describe("read-only collection kinds", () => {
  it("refuses writes to views and time series collections on the server too", async () => {
    for (const ns of [`${db}.active`, `${db}.metrics`]) {
      const response = await writer.request("POST", `/api/live/${ids.scratch}/documents`, {
        ns,
        document: '{"a": 1}',
      });
      expect(response.status, ns).toBe(400);
      expect(response.body.error.message).toContain("read-only");
    }
  });
});

describe("bulk edits that fail midway", () => {
  it("record what was changed before the failure, so undo can still reverse it", async () => {
    const mixed = mongo.db(db).collection<{ _id: number; [key: string]: unknown }>("mixed");
    // $inc works on the first two documents and fails on the third (a string).
    await mixed.insertMany([
      { _id: 1, n: 1 },
      { _id: 2, n: 2 },
      { _id: 3, n: "three" },
      { _id: 4, n: 4 },
    ]);
    const started = await writer.request("POST", `/api/live/${ids.scratch}/bulk`, {
      ns: `${db}.mixed`,
      op: "update",
      filter: "{}",
      update: '{"$inc": {"n": 10}}',
      expectedCount: 4,
      confirm: `update 4 documents in ${db}.mixed`,
    });
    const job = await waitForJob(testConsole, started.body.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("CONSOLE_LIVE_QUERY");
    expect(job.error?.message).toContain("MongoDB refused a change");
    expect(await mixed.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
      { _id: 1, n: 11 },
      { _id: 2, n: 12 },
      { _id: 3, n: "three" },
      { _id: 4, n: 4 },
    ]);
    const entry = (
      (await operator.request("GET", "/api/live-edits")).body as LiveEditEntryView[]
    ).find((candidate) => candidate.jobId === job.id);
    expect(entry).toMatchObject({ status: "failed", applied: 2, documents: 2, undoable: true });

    const undo = await writer.request("POST", `/api/live-edits/${entry?.id}/undo`);
    const undoJob = await waitForJob(testConsole, undo.body.job.id);
    expect(undoJob.status, JSON.stringify(undoJob.error)).toBe("succeeded");
    expect(await mixed.find({}, { sort: { _id: 1 } }).toArray()).toEqual([
      { _id: 1, n: 1 },
      { _id: 2, n: 2 },
      { _id: 3, n: "three" },
      { _id: 4, n: 4 },
    ]);
  });

  it("fails a bulk edit whose journal cannot be written, before changing anything", async () => {
    const spy = vi
      .spyOn(testConsole.services.live.journal, "writePart")
      .mockRejectedValueOnce(new Error("storage down"));
    const started = await writer.request("POST", `/api/live/${ids.scratch}/bulk`, {
      ns: NS,
      op: "delete",
      filter: '{"_id": {"$in": [20, 21]}}',
      expectedCount: 2,
      confirm: `delete 2 documents in ${NS}`,
    });
    const job = await waitForJob(testConsole, started.body.id);
    spy.mockRestore();
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("CONSOLE_LIVE_JOURNAL");
    expect(await users().countDocuments({ _id: { $in: [20, 21] } })).toBe(2);
  });
});
