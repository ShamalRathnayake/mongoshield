/**
 * The restore preview through the API, against the real test replica set:
 * back up → change the live data → preview a restore (counts per mode, renames,
 * sampling, index and option differences) → drill down to one document's fields
 * (secrets redacted) → the bounds (cancel, timeout, expiry, listed ids only), the
 * role rules, the audit trail, and that the target was never written to.
 *
 * The console runs with small preview limits (`PREVIEW_LIMITS`) so that a 200-document
 * collection is sampled and the lists of ids are short.
 */

import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREVIEW_TTL_MS, previewJob } from "../../src/jobs/preview.ts";
import { connectionById, storageById } from "../../src/jobs/tasks.ts";
import type {
  PreviewLimits,
  PreviewNamespaceView,
  RestorePreviewView,
} from "../../src/shared/api.ts";
import {
  mongoUri,
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  uriWithPassword,
  userWithRole,
  waitForJob,
} from "../helpers/console.ts";

const PASSPHRASE = "preview-passphrase-for-integration-tests";
/** Values of `password` fields: they must never reach a response. */
const SECRET_PREFIX = "s3cr3t-value-";

/** Above 50 documents a namespace is sampled (20 documents); 5 ids listed per category. */
const PREVIEW_LIMITS: PreviewLimits = {
  sampleAbove: 50,
  sampleSize: 20,
  listedPerCategory: 5,
  timeoutMs: 60_000,
};

let testConsole: TestConsole;
let admin: TestClient;
let operator: TestClient;
let viewer: TestClient;
let mongoPassword: string;
let live: MongoClient;
const db = uniqueDb("prev");
const ids = { scratch: "", production: "", storage: "", plan: "", backup: "" };

beforeAll(async () => {
  testConsole = await startConsole({ app: { previewLimits: PREVIEW_LIMITS } });
  admin = await setupAdmin(testConsole);
  operator = await userWithRole(testConsole, admin, "operator", "olga");
  viewer = await userWithRole(testConsole, admin, "viewer", "victor");
  const { uri, password } = await uriWithPassword();
  mongoPassword = password;
  live = new MongoClient(mongoUri());

  // users: 30 documents (compared exactly); events: 200 (compared by a sample).
  await live
    .db(db)
    .collection<{ _id: number }>("users")
    .insertMany(
      Array.from({ length: 30 }, (_, id) => ({
        _id: id,
        name: `user ${id}`,
        password: `${SECRET_PREFIX}${id}`,
      })),
    );
  await live
    .db(db)
    .collection<{ _id: number }>("events")
    .insertMany(Array.from({ length: 200 }, (_, id) => ({ _id: id, kind: "click" })));
  // big: one document over 1 MiB as JSON, too large to send whole in a document diff.
  await live
    .db(db)
    .collection<{ _id: number; text: string; n: number }>("big")
    .insertOne({ _id: 1, text: "x".repeat(1_100_000), n: 1 });

  ids.scratch = (
    await admin.request("POST", "/api/connections", { name: "scratch", uri, production: false })
  ).body.id;
  ids.production = (
    await admin.request("POST", "/api/connections", { name: "prod", uri, production: true })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", { name: "mem", url: `memory://${uniqueDb("st")}` })
  ).body.id;
  ids.plan = (
    await admin.request("POST", "/api/plans", {
      name: "nightly",
      connectionId: ids.scratch,
      storageId: ids.storage,
      include: [`${db}.*`],
      exclude: [],
      compression: "zstd",
      encryption: { kind: "passphrase", passphrase: PASSPHRASE },
      consistency: "auto",
      verify: "none",
      notify: [],
    })
  ).body.id;
  const run = await operator.request("POST", `/api/plans/${ids.plan}/run`);
  const job = await waitForJob(testConsole, run.body.id);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  ids.backup = job.backupId ?? "";

  // What happened since the backup. users: 0-2 deleted, 3-6 changed (3 also its
  // password), 100-101 new, an index and a validator added.
  const users = live.db(db).collection<{ _id: number; name: string }>("users");
  await users.deleteMany({ _id: { $in: [0, 1, 2] } });
  await users.updateMany({ _id: { $in: [3, 4, 5, 6] } }, { $set: { name: "changed" } });
  await users.updateOne({ _id: 3 }, { $set: { password: `${SECRET_PREFIX}new` } });
  await users.insertMany([
    { _id: 100, name: "new" },
    { _id: 101, name: "new" },
  ]);
  await users.createIndex({ name: 1 });
  await live.db(db).command({ collMod: "users", validator: { name: { $type: "string" } } });
  // events: 0-4 deleted, 5-9 changed; the sample (the first 20 backed up) sees all of it.
  const events = live.db(db).collection<{ _id: number }>("events");
  await events.deleteMany({ _id: { $lt: 5 } });
  await events.updateMany({ _id: { $gte: 5, $lt: 10 } }, { $set: { kind: "view" } });
  await live
    .db(db)
    .collection<{ _id: number }>("big")
    .updateOne({ _id: 1 }, { $set: { n: 2 } });
});

afterAll(async () => {
  await live.db(db).dropDatabase();
  await live.close();
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

/** A preview request into a connection. */
function request(target: string, extra: Record<string, unknown> = {}) {
  return {
    storageId: ids.storage,
    backupId: ids.backup,
    targetConnectionId: target,
    mode: "upsert",
    ...extra,
  };
}

/** Starts a preview, waits for its job and returns the view. */
async function preview(
  client: TestClient,
  target: string,
  extra: Record<string, unknown> = {},
): Promise<RestorePreviewView> {
  const started = await client.request("POST", "/api/restore/preview", request(target, extra));
  expect(started.status, started.text).toBe(200);
  expect(started.body.kind).toBe("preview");
  const job = await waitForJob(testConsole, started.body.id);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  const view = await client.request("GET", `/api/restore/preview/${started.body.id}`);
  expect(view.status, view.text).toBe(200);
  return view.body;
}

function namespace(view: RestorePreviewView, ns: string): PreviewNamespaceView {
  const found = view.namespaces?.find((entry) => entry.from === `${db}.${ns}`);
  if (found === undefined) throw new Error(`No ${ns} in the preview`);
  return found;
}

describe("previewing a restore", () => {
  let upsert: RestorePreviewView;

  beforeAll(async () => {
    upsert = await preview(operator, ids.scratch);
  });

  it("counts documents only in the backup, only in the target, changed and identical", () => {
    expect(upsert).toMatchObject({ status: "succeeded", mode: "upsert", documentsVisible: true });
    expect(upsert.namespaces?.map((entry) => entry.from)).toEqual([
      `${db}.big`,
      `${db}.events`,
      `${db}.users`,
    ]);
    const users = namespace(upsert, "users");
    expect(users).toMatchObject({
      to: `${db}.users`,
      targetExists: true,
      action: "upsert",
      accuracy: "exact",
      identical: false,
    });
    expect(users.documents).toEqual({
      backup: 30,
      live: 29,
      backupOnly: 3,
      liveOnly: 2,
      changed: 4,
      identical: 23,
    });
    expect(users.listed).toEqual({ changed: 4, "backup-only": 3, "live-only": 2 });
  });

  it("reports index and collection option differences", () => {
    const users = namespace(upsert, "users");
    expect(users.indexes).toEqual({ backupOnly: [], liveOnly: ["name_1"], different: [] });
    // The server adds the validation defaults together with the validator.
    expect(users.options).toEqual(["validationAction", "validationLevel", "validator"]);
  });

  it("samples namespaces above the limit and says so", () => {
    const events = namespace(upsert, "events");
    expect(events.accuracy).toBe("sampled");
    expect(events.sample).toEqual({ documents: 20, of: 200 });
    // 5 missing and 5 changed of 20, scaled by 200 / 20.
    expect(events.documents).toMatchObject({ backup: 200, backupOnly: 50, changed: 50 });
    // A sample cannot list target-only documents.
    expect(events.listed["live-only"]).toBe(0);
  });

  it("describes what each restore mode would do", async () => {
    expect(namespace(upsert, "users").effect).toEqual({
      inserted: 3,
      replaced: 4,
      deleted: 0,
      kept: 25,
    });
    const drop = await preview(operator, ids.scratch, { mode: "drop" });
    expect(namespace(drop, "users")).toMatchObject({
      action: "drop-and-create",
      effect: { inserted: 3, replaced: 4, deleted: 2, kept: 23 },
    });
    const insert = await preview(operator, ids.scratch, { mode: "insert" });
    expect(namespace(insert, "users").effect).toEqual({
      inserted: 3,
      replaced: 0,
      deleted: 0,
      kept: 29,
    });
    const failIfExists = await preview(operator, ids.scratch, { mode: "fail-if-exists" });
    const blocked = namespace(failIfExists, "users");
    expect(blocked.action).toBe("conflict");
    expect(blocked.effect).toBeUndefined();
  });

  it("compares with the renamed targets, which may not exist yet", async () => {
    const renamed = await preview(operator, ids.scratch, {
      include: [`${db}.users`],
      rename: { [`${db}.*`]: `${db}_copy.*` },
    });
    expect(renamed.namespaces).toHaveLength(1);
    expect(namespace(renamed, "users")).toMatchObject({
      to: `${db}_copy.users`,
      targetExists: false,
      action: "create",
      documents: { backup: 30, live: 0, backupOnly: 30 },
      effect: { inserted: 30, replaced: 0, deleted: 0, kept: 0 },
      // A new target: the first backed-up ids are listed, to open them all the same.
      listed: { changed: 0, "backup-only": 5, "live-only": 0 },
    });
  });

  it("honours exclude patterns", async () => {
    const view = await preview(operator, ids.scratch, { exclude: [`${db}.events`, `${db}.big`] });
    expect(view.namespaces?.map((entry) => entry.from)).toEqual([`${db}.users`]);
  });

  it("ends as a failed job with its error when the restore cannot be planned", async () => {
    const started = await operator.request(
      "POST",
      "/api/restore/preview",
      request(ids.scratch, { rename: { [`${db}.*`]: "bad/name.*" } }),
    );
    const job = await waitForJob(testConsole, started.body.id);
    expect(job.status).toBe("failed");
    const view = await operator.request("GET", `/api/restore/preview/${started.body.id}`);
    expect(view.body).toMatchObject({ status: "failed", error: { code: "MS_CONFIG_INVALID" } });
    expect(view.body.namespaces).toBeUndefined();
  });

  it("refuses selected-document restores, which have no preview", async () => {
    const filtered = await operator.request(
      "POST",
      "/api/restore/preview",
      request(ids.scratch, { filter: '{"_id": 1}' }),
    );
    expect(filtered.status).toBe(400);
    expect(filtered.body.error.code).toBe("CONSOLE_VALIDATION");
  });

  it("never writes to the target", async () => {
    const names = (await live.db().admin().listDatabases()).databases.map((entry) => entry.name);
    expect(names).not.toContain(`${db}_copy`);
    expect(await live.db(db).collection("users").countDocuments()).toBe(29);
    expect(await live.db(db).collection("events").countDocuments()).toBe(195);
  });
});

describe("drilling down to documents", () => {
  let jobId: string;
  const base = () => `/api/restore/preview/${jobId}`;

  beforeAll(async () => {
    jobId = (await preview(operator, ids.scratch)).jobId;
  });

  it("pages through the listed ids of a category", async () => {
    const first = await operator.request(
      "GET",
      `${base()}/documents?ns=${db}.users&category=changed&limit=3`,
    );
    expect(first.status, first.text).toBe(200);
    expect(first.body.listed).toBe(4);
    expect(first.body.documents).toHaveLength(3);
    expect(first.body.next).toBe("3");
    const second = await operator.request(
      "GET",
      `${base()}/documents?ns=${db}.users&category=changed&limit=3&after=3`,
    );
    expect(second.body.documents).toHaveLength(1);
    expect(second.body.next).toBeUndefined();
    const labels = [...first.body.documents, ...second.body.documents].map(
      (entry: { label: string }) => Number(entry.label),
    );
    expect(labels.sort()).toEqual([3, 4, 5, 6]);
    // Canonical Extended JSON, to pass back as the id.
    expect(first.body.documents[0].id).toMatch(/^\{"\$numberInt":"\d"\}$/);
  });

  it("shows one document in both versions, field by field, with secrets hidden", async () => {
    const diff = await operator.request("POST", `${base()}/document`, {
      ns: `${db}.users`,
      id: '{"$numberInt":"3"}',
    });
    expect(diff.status, diff.text).toBe(200);
    expect(diff.body).toMatchObject({ ns: `${db}.users`, to: `${db}.users`, label: "3" });
    expect(diff.body.fields).toEqual([
      { path: "name", change: "changed", backup: '"user 3"', live: '"changed"' },
      { path: "password", change: "changed", backup: '"***"', live: '"***"', redacted: true },
    ]);
    expect(JSON.parse(diff.body.backup)).toEqual({ _id: 3, name: "user 3", password: "***" });
    expect(JSON.parse(diff.body.live)).toEqual({ _id: 3, name: "changed", password: "***" });
  });

  it("shows a document that only the backup has", async () => {
    const diff = await operator.request("POST", `${base()}/document`, {
      ns: `${db}.users`,
      id: '{"$numberInt":"0"}',
    });
    expect(diff.status, diff.text).toBe(200);
    expect(diff.body.live).toBeUndefined();
    expect(diff.body.fields.map((field: { path: string; change: string }) => field.change)).toEqual(
      ["added", "added", "added"],
    );
  });

  it("leaves out documents too large to send, but still lists their fields", async () => {
    const diff = await operator.request("POST", `${base()}/document`, {
      ns: `${db}.big`,
      id: '{"$numberInt":"1"}',
      // A typed passphrase works as well as the one the console stores.
      passphrase: PASSPHRASE,
    });
    expect(diff.status, diff.text).toBe(200);
    expect(diff.body.documentsOmitted).toBe(true);
    expect(diff.body.backup).toBeUndefined();
    expect(diff.body.fields).toEqual([{ path: "n", change: "changed", backup: "1", live: "2" }]);
  });

  it("opens only documents the preview listed", async () => {
    const unlisted = await operator.request("POST", `${base()}/document`, {
      ns: `${db}.users`,
      id: '{"$numberInt":"20"}',
    });
    expect(unlisted.status).toBe(404);
    const otherNamespace = await operator.request(
      "GET",
      `${base()}/documents?ns=${db}.nothing&category=changed`,
    );
    expect(otherNamespace.status).toBe(404);
    const badCategory = await operator.request(
      "GET",
      `${base()}/documents?ns=${db}.users&category=all`,
    );
    expect(badCategory.status).toBe(400);
    const badNamespace = await operator.request("GET", `${base()}/documents?category=changed`);
    expect(badNamespace.status).toBe(400);
  });
});

describe("bounds", () => {
  it("cancels a queued preview, which then has no result", async () => {
    // Previews of one target run one after another: the second waits for the first.
    const first = await operator.request("POST", "/api/restore/preview", request(ids.scratch));
    const second = await operator.request("POST", "/api/restore/preview", request(ids.scratch));
    const cancelled = await operator.request("POST", `/api/jobs/${second.body.id}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    await waitForJob(testConsole, first.body.id);
    const view = await operator.request("GET", `/api/restore/preview/${second.body.id}`);
    expect(view.body.status).toBe("cancelled");
    expect(view.body.namespaces).toBeUndefined();
    const page = await operator.request(
      "GET",
      `/api/restore/preview/${second.body.id}/documents?ns=${db}.users&category=changed`,
    );
    expect(page.status).toBe(409);
    expect(page.body.error.code).toBe("CONSOLE_PREVIEW_NOT_READY");
  });

  it("stops a preview that takes longer than its time limit", async () => {
    const { services } = testConsole;
    const { spec } = previewJob(
      services.tasks,
      {
        storage: storageById(services.store, ids.storage),
        backupId: ids.backup,
        target: connectionById(services.store, ids.scratch),
        mode: "upsert",
        keys: {},
      },
      "olga",
      { ...PREVIEW_LIMITS, timeoutMs: 1 },
    );
    const job = await waitForJob(testConsole, (await services.runner.start(spec)).id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("CONSOLE_PREVIEW_TIMEOUT");
  });

  it("forgets previews after a while", async () => {
    const view = await preview(operator, ids.scratch);
    testConsole.clock.advance(PREVIEW_TTL_MS);
    const gone = await operator.request("GET", `/api/restore/preview/${view.jobId}`);
    expect(gone.status).toBe(404);
  });
});

describe("who may preview", () => {
  it("refuses a preview whose target connection was deleted", async () => {
    const { uri } = await uriWithPassword();
    const temporary = await admin.request("POST", "/api/connections", {
      name: "temporary",
      uri,
      production: false,
    });
    const view = await preview(operator, temporary.body.id);
    expect((await admin.request("DELETE", `/api/connections/${temporary.body.id}`)).status).toBe(
      200,
    );
    const gone = await operator.request("GET", `/api/restore/preview/${view.jobId}`);
    expect(gone.status).toBe(404);
  });

  it("does not let viewers preview or read previews", async () => {
    const started = await viewer.request("POST", "/api/restore/preview", request(ids.scratch));
    expect(started.status).toBe(403);
    const view = await preview(operator, ids.scratch);
    expect((await viewer.request("GET", `/api/restore/preview/${view.jobId}`)).status).toBe(403);
    const page = await viewer.request(
      "GET",
      `/api/restore/preview/${view.jobId}/documents?ns=${db}.users&category=changed`,
    );
    expect(page.status).toBe(403);
  });

  it("keeps previews into production to admins, whoever asks for them", async () => {
    const refused = await operator.request("POST", "/api/restore/preview", request(ids.production));
    expect(refused.status).toBe(403);
    const view = await preview(admin, ids.production);
    expect(namespace(view, "users").documents.changed).toBe(4);
    const read = await operator.request("GET", `/api/restore/preview/${view.jobId}`);
    expect(read.status).toBe(403);
    const document = await operator.request("POST", `/api/restore/preview/${view.jobId}/document`, {
      ns: `${db}.users`,
      id: '{"$numberInt":"3"}',
    });
    expect(document.status).toBe(403);
  });

  it("audits previews and document reads without document ids", async () => {
    const entries = (await admin.request("GET", "/api/audit?limit=500")).body as {
      actor: string;
      action: string;
      target?: string;
      details?: Record<string, unknown>;
    }[];
    const actions = entries.map((entry) => `${entry.actor}:${entry.action}`);
    expect(actions).toContain("olga:restore.preview");
    expect(actions).toContain("admin:restore.preview");
    expect(actions).toContain("olga:restore.preview_documents");
    expect(actions).toContain("olga:restore.preview_document");
    const reads = entries.filter((entry) => entry.action === "restore.preview_document");
    for (const entry of reads) {
      expect(entry.target?.startsWith(`${ids.backup}/${db}.`)).toBe(true);
      expect(JSON.stringify(entry.details)).not.toContain("numberInt");
    }
  });

  it("never sent a password, the passphrase or a redacted value in any response", () => {
    const everything = testConsole.transcript.join("\n");
    expect(everything).not.toContain(mongoPassword);
    expect(everything).not.toContain(PASSPHRASE);
    expect(everything).not.toContain(SECRET_PREFIX);
  });
});
