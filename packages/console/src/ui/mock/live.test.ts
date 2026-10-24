/**
 * Tests for the mock backend's live data routes (mock/live.ts), through the mock's
 * `fetch` like the UI uses it: the access rules, conditional writes, the journal and
 * undo, bulk confirmations and the settings rules. They keep the mock honest about the
 * server rules the UI relies on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createMockBackend, type MockBackend } from "./backend.ts";
import { bulkConfirmText, versionOf } from "./live.ts";

const backends: MockBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
});

/** A backend signed in as `username`, with a small JSON client. */
async function signedIn(username: string) {
  const backend = createMockBackend({ signedInAs: username, jobTickMs: 0 });
  backends.push(backend);
  const call = async (method: string, path: string, body?: unknown) => {
    const session = JSON.parse(
      await (
        await backend.fetch("/api/session", {
          method: "GET",
          headers: {},
          credentials: "same-origin",
        })
      ).text(),
    ) as { csrfToken?: string };
    const response = await backend.fetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(session.csrfToken === undefined ? {} : { "x-csrf-token": session.csrfToken }),
      },
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  };
  return { backend, call };
}

/** The first document of Staging's shop.users, as the browser gets it. */
async function firstDocument(call: Awaited<ReturnType<typeof signedIn>>["call"]) {
  const page = await call("GET", "/api/live/conn-staging/documents?ns=shop.users&limit=1");
  return page.body.documents[0] as { json: string; id: string; version: string };
}

describe("mock live data routes", () => {
  it("computes stable 64-character versions and the server's confirmation text", () => {
    expect(versionOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(versionOf({ a: 1 })).toBe(versionOf({ a: 1 }));
    expect(versionOf({ a: 1 })).not.toBe(versionOf({ a: 2 }));
    expect(bulkConfirmText("delete", 1, "a.b")).toBe("delete 1 document in a.b");
    expect(bulkConfirmText("update", 2, "a.b")).toBe("update 2 documents in a.b");
  });

  it("refuses writes without data:write, with live edits off, and on unconfirmed production", async () => {
    const admin = await signedIn("admin");
    const document = await firstDocument(admin.call);
    const insert = { ns: "shop.users", document: "{}" };
    expect(
      (await admin.call("POST", "/api/live/conn-staging/documents", insert)).body.error.code,
    ).toBe("CONSOLE_FORBIDDEN");
    const maya = await signedIn("maya");
    expect(
      (
        await maya.call("POST", "/api/live/conn-local/documents", {
          ns: "test.fixtures",
          document: "{}",
        })
      ).body.error.code,
    ).toBe("CONSOLE_LIVE_EDITS_DISABLED");
    const prod = maya.backend.data.connections.find((connection) => connection.id === "conn-prod");
    if (prod === undefined) throw new Error("fixtures changed");
    prod.liveEdits = { enabled: true, productionConfirmed: false, maxBulkDocuments: 10 };
    const refused = await maya.call("POST", "/api/live/conn-prod/documents", {
      ns: "shop.users",
      document: "{}",
    });
    expect(refused.body.error.message).toMatch(/not confirmed for production/);
    expect(document.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers bad queries and missing collections with errors", async () => {
    const { call } = await signedIn("maya");
    expect((await call("GET", "/api/live/conn-staging/documents")).status).toBe(400);
    expect((await call("GET", "/api/live/conn-staging/documents?ns=shop.nope")).status).toBe(404);
    expect(
      (await call("GET", "/api/live/conn-staging/documents?ns=shop.users&filter=%7B")).status,
    ).toBe(400);
    expect(
      (
        await call(
          "GET",
          `/api/live/conn-staging/documents?ns=shop.users&filter=${encodeURIComponent('{"$where":"1"}')}`,
        )
      ).status,
    ).toBe(400);
  });

  it("filters, sorts and projects", async () => {
    const { call } = await signedIn("maya");
    const query = (params: Record<string, string>) =>
      call(
        "GET",
        `/api/live/conn-staging/documents?${new URLSearchParams({ ns: "shop.users", ...params })}`,
      );
    const filtered = await query({
      filter: '{"logins": {"$gte": 400}, "plan": {"$ne": "x"}}',
      sort: '{"logins": -1}',
    });
    const logins = filtered.body.documents.map(
      (document: { json: string }) => JSON.parse(document.json).logins,
    );
    expect(logins.length).toBeGreaterThan(0);
    expect([...logins].sort((a: number, b: number) => b - a)).toEqual(logins);
    expect(filtered.body.count.kind).toBe("exact");
    const projected = await query({ projection: '{"email": 1}' });
    expect(projected.body.projected).toBe(true);
    expect(Object.keys(JSON.parse(projected.body.documents[0].json))).toEqual(["_id", "email"]);
    expect(projected.body.documents[0].version).toBeUndefined();
    const ors = await query({
      filter: '{"$or": [{"plan": "pro"}, {"tags": {"$exists": false}}], "_id": {"$nin": []}}',
    });
    expect(ors.body.count.value).toBe(9);
  });

  it("describes views and time series as read-only", async () => {
    const { call } = await signedIn("maya");
    const view = await call("GET", "/api/live/conn-prod/collection?ns=analytics.funnel_view");
    expect(view.body).toMatchObject({
      type: "view",
      writable: false,
      readOnlyReason: "Views are read-only.",
    });
    const series = await call("GET", "/api/live/conn-prod/collection?ns=shop.events.2026");
    expect(series.body.readOnlyReason).toMatch(/Time series/);
  });

  it("writes conditionally and refuses no-op edits, _id changes and duplicates", async () => {
    const { call } = await signedIn("maya");
    const document = await firstDocument(call);
    const parsed = JSON.parse(document.json);
    const put = (body: Record<string, unknown>) =>
      call("PUT", "/api/live/conn-staging/documents", {
        ns: "shop.users",
        id: document.id,
        version: document.version,
        ...body,
      });
    expect((await put({ document: document.json })).body.error.message).toMatch(/nothing to save/);
    expect(
      (await put({ document: JSON.stringify({ ...parsed, _id: 1 }) })).body.error.message,
    ).toMatch(/_id/);
    expect((await put({ document: "[" })).status).toBe(400);
    expect((await put({ document: JSON.stringify({ ...parsed, plan: "x" }) })).status).toBe(200);
    // The old version no longer matches.
    expect(
      (await put({ document: JSON.stringify({ ...parsed, plan: "y" }) })).body.error.code,
    ).toBe("CONSOLE_LIVE_CONFLICT");
    const duplicate = await call("POST", "/api/live/conn-staging/documents", {
      ns: "shop.users",
      document: JSON.stringify({ _id: parsed._id }),
    });
    expect(duplicate.body.error.code).toBe("CONSOLE_LIVE_CONFLICT");
    const deleted = await call("POST", "/api/live/conn-staging/documents/delete", {
      ns: "shop.users",
      id: document.id,
      version: document.version,
    });
    expect(deleted.body.error.code).toBe("CONSOLE_LIVE_CONFLICT");
  });

  it("journals edits, undoes them once, and 404s unknown entries", async () => {
    const { call } = await signedIn("maya");
    const document = await firstDocument(call);
    await call("POST", "/api/live/conn-staging/documents/delete", {
      ns: "shop.users",
      id: document.id,
      version: document.version,
    });
    const [entry] = (await call("GET", "/api/live-edits?connectionId=conn-staging")).body;
    expect(entry).toMatchObject({
      op: "delete",
      undoable: true,
      journal: { kind: "storage", storageId: "st-s3" },
    });
    const detail = await call("GET", `/api/live-edits/${entry.id}`);
    expect(detail.body.records[0].before).toBe(document.json);
    expect((await call("POST", `/api/live-edits/${entry.id}/undo`)).body.kind).toBe("applied");
    expect((await call("POST", `/api/live-edits/${entry.id}/undo`)).body.error.code).toBe(
      "CONSOLE_LIVE_NOT_UNDOABLE",
    );
    expect((await call("GET", "/api/live-edits/missing")).status).toBe(404);
    expect((await call("GET", "/api/live-edits?connectionId=conn-prod")).body).toEqual([]);
  });

  it("checks bulk confirmations, the cap and the count", async () => {
    const { call, backend } = await signedIn("maya");
    const base = {
      ns: "shop.users",
      op: "update",
      filter: '{"plan": "pro"}',
      update: '{"$inc": {"logins": 1}, "$unset": {"tags": 1}}',
    };
    const preview = await call("POST", "/api/live/conn-staging/bulk/preview", base);
    expect(preview.body).toMatchObject({
      matched: 9,
      allowed: true,
      confirmText: "update 9 documents in shop.users",
    });
    expect(
      (
        await call("POST", "/api/live/conn-staging/bulk/preview", {
          ...base,
          update: '{"$rename": {"a": "b"}}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/live/conn-staging/bulk", {
          ...base,
          expectedCount: 9,
          confirm: "yes",
        })
      ).body.error.code,
    ).toBe("MS_CONFIRMATION_REQUIRED");
    expect(
      (
        await call("POST", "/api/live/conn-staging/bulk", {
          ...base,
          expectedCount: 8,
          confirm: bulkConfirmText("update", 8, "shop.users"),
        })
      ).body.error.code,
    ).toBe("CONSOLE_LIVE_COUNT_CHANGED");
    expect(
      (
        await call("POST", "/api/live/conn-staging/bulk", {
          ...base,
          expectedCount: 5000,
          confirm: "x",
        })
      ).body.error.code,
    ).toBe("CONSOLE_LIVE_BULK_TOO_LARGE");
    const job = await call("POST", "/api/live/conn-staging/bulk", {
      ...base,
      expectedCount: 9,
      confirm: preview.body.confirmText,
    });
    expect(job.body.kind).toBe("live-edit");
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    const updated = backend.live.documents("conn-staging", "shop.users")[0];
    expect(updated?.tags).toBeUndefined();
    expect(backend.live.entries()[0]).toMatchObject({ op: "bulk-update", documents: 9 });
  });

  it("validates live edit settings like the server", async () => {
    const { call, backend } = await signedIn("admin");
    const put = (id: string, body: Record<string, unknown>) =>
      call("PUT", `/api/connections/${id}/live-edits`, body);
    expect((await put("conn-prod", { enabled: true })).body.error.code).toBe(
      "MS_CONFIRMATION_REQUIRED",
    );
    expect(
      (await put("conn-prod", { enabled: true, confirmName: "Production cluster" })).status,
    ).toBe(400);
    expect((await put("conn-local", { enabled: true, maxBulkDocuments: 0 })).status).toBe(400);
    expect((await put("conn-local", { enabled: true, journalStorageId: "nope" })).status).toBe(404);
    const saved = await put("conn-local", { enabled: true });
    expect(saved.body.liveEdits).toMatchObject({
      enabled: true,
      productionConfirmed: false,
      changedBy: "admin",
    });
    expect((await put("conn-local", { enabled: false })).body.liveEdits.enabled).toBe(false);
    // Viewers cannot hold permissions.
    const sam = backend.data.users.find((user) => user.username === "sam");
    const refused = await call("PUT", `/api/users/${sam?.id}`, {
      username: "sam",
      role: "viewer",
      permissions: ["data:write"],
    });
    expect(refused.status).toBe(400);
  });

  it("knows the query operators the UI tests rely on", async () => {
    const { call } = await signedIn("maya");
    const count = async (filter: unknown) =>
      (
        await call(
          "GET",
          `/api/live/conn-staging/documents?${new URLSearchParams({ ns: "shop.users", filter: JSON.stringify(filter) })}`,
        )
      ).body.count.value as number;
    expect(await count({ $and: [{ plan: "pro" }, { logins: { $lt: 200 } }] })).toBeLessThan(9);
    expect(await count({ plan: { $in: ["pro", "free"] } })).toBe(45);
    expect(await count({ plan: { $nin: ["pro"] } })).toBe(36);
    expect(await count({ plan: { $eq: "pro" } })).toBe(9);
    expect(await count({ "address.city": "Colombo" })).toBe(23);
    expect(await count({ name: { $gt: 1 } })).toBe(0);
    expect(await count({ logins: { $lte: 0 }, tags: { $exists: true } })).toBe(1);
    const sorted = await call(
      "GET",
      `/api/live/conn-staging/documents?${new URLSearchParams({ ns: "shop.users", sort: '{"email": 1}', projection: '{"tags": 0}' })}`,
    );
    const first = JSON.parse(sorted.body.documents[0].json);
    expect(first.tags).toBeUndefined();
    expect(first.email).toBeDefined();
    expect(
      (
        await call(
          "GET",
          `/api/live/conn-staging/documents?ns=shop.users&filter=${encodeURIComponent("[1]")}`,
        )
      ).status,
    ).toBe(400);
  });

  it("describes collections with their indexes and the caller's access", async () => {
    const admin = await signedIn("admin");
    const users = await admin.call("GET", "/api/live/conn-staging/collection?ns=shop.users");
    expect(users.body.indexes.map((index: { name: string }) => index.name)).toEqual([
      "_id_",
      "email_1",
    ]);
    expect(users.body.readOnlyReason).toMatch(/data:write/);
    const sessions = await admin.call("GET", "/api/live/conn-prod/collection?ns=shop.sessions");
    expect(sessions.body.indexes[1]).toMatchObject({ expireAfterSeconds: 86_400 });
    expect((await admin.call("GET", "/api/live/conn-staging/collection")).status).toBe(400);
  });

  it("refuses writes without a document, and journals to the console without journal storage", async () => {
    const { call, backend } = await signedIn("maya");
    const local = backend.data.connections.find((connection) => connection.id === "conn-local");
    if (local === undefined) throw new Error("fixtures changed");
    local.liveEdits = { enabled: true, productionConfirmed: false, maxBulkDocuments: 100 };
    expect(
      (await call("POST", "/api/live/conn-local/documents", { ns: "test.fixtures", document: "" }))
        .status,
    ).toBe(400);
    const inserted = await call("POST", "/api/live/conn-local/documents", {
      ns: "test.fixtures",
      document: '{"a": 1}',
    });
    expect(inserted.body.entry.journal).toEqual({ kind: "console" });
    expect(inserted.body.document.version).toMatch(/^[0-9a-f]{64}$/);
    const document = inserted.body.document;
    expect(
      (
        await call("PUT", "/api/live/conn-local/documents", {
          ns: "test.fixtures",
          id: document.id,
          version: document.version,
          document: "",
        })
      ).status,
    ).toBe(400);
    expect(() => backend.live.touch("conn-local", "test.fixtures", '"missing"')).toThrow(
      /No document/,
    );
    // Undo the insert: the document is deleted again.
    const [entry] = backend.live.entries();
    expect((await call("POST", `/api/live-edits/${entry?.id}/undo`)).body.kind).toBe("applied");
    expect(backend.live.documents("conn-local", "test.fixtures")).toHaveLength(45);
  });

  it("undoes a bulk edit by a job, skipping documents that changed since", async () => {
    const { call, backend } = await signedIn("maya");
    const base = { ns: "shop.users", op: "delete", filter: '{"plan": "pro"}' };
    const preview = await call("POST", "/api/live/conn-staging/bulk/preview", base);
    await call("POST", "/api/live/conn-staging/bulk", {
      ...base,
      expectedCount: 9,
      confirm: preview.body.confirmText,
    });
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    const [bulk] = backend.live.entries();
    expect(bulk).toMatchObject({ op: "bulk-delete", documents: 9 });
    // Someone re-inserts one of the deleted documents meanwhile: its undo conflicts.
    const detail = await call("GET", `/api/live-edits/${bulk?.id}`);
    const before = JSON.parse(detail.body.records[0].before);
    await call("POST", "/api/live/conn-staging/documents", {
      ns: "shop.users",
      document: JSON.stringify(before),
    });
    const undo = await call("POST", `/api/live-edits/${bulk?.id}/undo`);
    expect(undo.body.kind).toBe("job");
    for (let step = 0; step < 12; step += 1) backend.tickJobs();
    expect(backend.live.entries()[0]).toMatchObject({ op: "undo", documents: 8, conflicts: 1 });
    expect(backend.live.documents("conn-staging", "shop.users")).toHaveLength(45);
  });
});
