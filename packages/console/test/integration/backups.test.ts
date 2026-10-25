/**
 * The backup workflow end to end through the API, against the real test
 * replica set: plan → run → live progress over SSE → backup in the catalog →
 * browse documents → restore plan → restore (with the production rules) →
 * verify → drill → hold → audit trail.
 */

import { resolveStorage } from "mongoshield";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JobEvent, JobSummary } from "../../src/shared/api.ts";
import {
  countDocuments,
  removeDataDir,
  seed,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  uriWithPassword,
  userWithRole,
  waitForJob,
} from "../helpers/console.ts";

const PASSPHRASE = "backup-passphrase-for-integration-tests";
const DOCUMENTS = 30;

let testConsole: TestConsole;
let admin: TestClient;
let operator: TestClient;
let viewer: TestClient;
let mongoPassword: string;
const db = uniqueDb("src");
const ids = { scratch: "", production: "", storage: "", plan: "", backup: "" };
/** The storage location's URL: an in-process store the test can also write to. */
const storageUrl = `memory://${uniqueDb("store")}`;

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  operator = await userWithRole(testConsole, admin, "operator", "olga");
  viewer = await userWithRole(testConsole, admin, "viewer", "victor");
  await seed(db, "users", DOCUMENTS);
  const { uri, password } = await uriWithPassword();
  mongoPassword = password;

  ids.scratch = (
    await admin.request("POST", "/api/connections", { name: "scratch", uri, production: false })
  ).body.id;
  ids.production = (
    await admin.request("POST", "/api/connections", { name: "prod", uri, production: true })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", {
      name: "mem",
      url: storageUrl,
    })
  ).body.id;
  const plan = await admin.request("POST", "/api/plans", {
    name: "nightly",
    connectionId: ids.production,
    storageId: ids.storage,
    include: [`${db}.*`],
    exclude: [],
    compression: "zstd",
    encryption: { kind: "passphrase", passphrase: PASSPHRASE },
    consistency: "auto",
    verify: "fast",
    notify: [],
  });
  ids.plan = plan.body.id;
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("running a plan", () => {
  it("runs a backup job whose progress streams over SSE", async () => {
    const run = await operator.request("POST", `/api/plans/${ids.plan}/run`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ kind: "backup", planId: ids.plan, startedBy: "olga" });

    const events = (await viewer.events(`/api/jobs/${run.body.id}/events`)) as JobEvent[];
    const statuses = events.flatMap((event) => (event.type === "status" ? [event.job.status] : []));
    expect(statuses.at(-1)).toBe("succeeded");
    expect(statuses).toContain("running");
    expect(events.some((event) => event.type === "progress")).toBe(true);

    const job: JobSummary = (await viewer.request("GET", `/api/jobs/${run.body.id}`)).body;
    expect(job.status).toBe("succeeded");
    expect(job.backupId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(job.storageId).toBe(ids.storage);
    expect(job.summary).toContain("succeeded");
    ids.backup = job.backupId ?? "";
  });

  it("shows the new backup in the catalog, encrypted and verified", async () => {
    const list = await viewer.request("GET", `/api/storage/${ids.storage}/backups`);
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({
      id: ids.backup,
      status: "complete",
      namespaces: 1,
      documents: DOCUMENTS,
      encrypted: true,
      verification: { mode: "fast", ok: true },
    });
    const detail = await viewer.request("GET", `/api/storage/${ids.storage}/backups/${ids.backup}`);
    expect(detail.body.manifest.id).toBe(ids.backup);
    expect(detail.body.drills).toEqual([]);
  });

  it("reports the plan's last run", async () => {
    const plans = (await viewer.request("GET", "/api/plans")).body;
    expect(plans[0].lastRun.backupId).toBe(ids.backup);
  });

  it("returns 404 for a backup that does not exist", async () => {
    const response = await viewer.request(
      "GET",
      `/api/storage/${ids.storage}/backups/2020-01-01T00-00-00Z_abcdef`,
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("MS_BACKUP_NOT_FOUND");
  });
});

describe("browsing documents", () => {
  const path = () => `/api/storage/${ids.storage}/backups/${ids.backup}/documents`;

  it("pages through a collection with a stable cursor", async () => {
    const seen: number[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ ns: `${db}.users`, limit: "7" });
      if (after !== undefined) query.set("after", after);
      const page = await operator.request("GET", `${path()}?${query}`);
      expect(page.status).toBe(200);
      for (const text of page.body.documents) seen.push(JSON.parse(text)._id);
      after = page.body.next;
      pages++;
    } while (after !== undefined && pages < 20);
    expect(pages).toBe(Math.ceil(DOCUMENTS / 7));
    expect(seen).toEqual(Array.from({ length: DOCUMENTS }, (_, index) => index));
  });

  it("filters with Extended JSON", async () => {
    const query = new URLSearchParams({ ns: `${db}.users`, filter: '{"_id": {"$gte": 25}}' });
    const page = await operator.request("GET", `${path()}?${query}`);
    expect(page.body.documents.map((text: string) => JSON.parse(text)._id)).toEqual([
      25, 26, 27, 28, 29,
    ]);
    expect(page.body.next).toBeUndefined();
  });

  it("rejects bad filters, cursors and limits", async () => {
    const badFilter = await operator.request("GET", `${path()}?ns=${db}.users&filter=%7Bnope`);
    expect(badFilter.status).toBe(400);
    const badCursor = await operator.request("GET", `${path()}?ns=${db}.users&after=bm9wZQ`);
    expect(badCursor.status).toBe(400);
    const badLimit = await operator.request("GET", `${path()}?ns=${db}.users&limit=1000`);
    expect(badLimit.status).toBe(400);
  });
});

describe("restoring", () => {
  const request = (target: string, extra: Record<string, unknown> = {}) => ({
    storageId: ids.storage,
    backupId: ids.backup,
    targetConnectionId: target,
    rename: { [`${db}.*`]: `${db}_r.*` },
    mode: "fail-if-exists",
    ...extra,
  });

  it("plans a restore as a dry run", async () => {
    const plan = await operator.request("POST", "/api/restore/plan", request(ids.scratch));
    expect(plan.status).toBe(200);
    expect(plan.body.entries).toEqual([
      {
        from: `${db}.users`,
        to: `${db}_r.users`,
        documents: DOCUMENTS,
        existingDocuments: 0,
        action: "create",
      },
    ]);
  });

  it("restores into a non-production connection as an operator", async () => {
    const response = await operator.request("POST", "/api/restore", request(ids.scratch));
    expect(response.status).toBe(200);
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(await countDocuments(`${db}_r`, "users")).toBe(DOCUMENTS);
  });

  it("reports conflicts in the plan instead of overwriting", async () => {
    const plan = await operator.request("POST", "/api/restore/plan", request(ids.scratch));
    expect(plan.body.entries[0]).toMatchObject({
      action: "conflict",
      existingDocuments: DOCUMENTS,
    });
  });

  it("does not let operators restore into production", async () => {
    const plan = await operator.request("POST", "/api/restore/plan", request(ids.production));
    expect(plan.status).toBe(403);
    const restore = await operator.request(
      "POST",
      "/api/restore",
      request(ids.production, { confirmName: "prod" }),
    );
    expect(restore.status).toBe(403);
  });

  it("requires admins to type the production connection's name", async () => {
    const target = { rename: { [`${db}.*`]: `${db}_p.*` } };
    const missing = await admin.request("POST", "/api/restore", request(ids.production, target));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("MS_CONFIRMATION_REQUIRED");
    const wrong = await admin.request(
      "POST",
      "/api/restore",
      request(ids.production, { ...target, confirmName: "Prod" }),
    );
    expect(wrong.status).toBe(400);
    const confirmed = await admin.request(
      "POST",
      "/api/restore",
      request(ids.production, { ...target, confirmName: "prod" }),
    );
    expect(confirmed.status).toBe(200);
    const job = await waitForJob(testConsole, confirmed.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(await countDocuments(`${db}_p`, "users")).toBe(DOCUMENTS);
  });
});

describe("verify, drill and hold", () => {
  const base = () => `/api/storage/${ids.storage}/backups/${ids.backup}`;

  it("verifies deeply with the plan's stored passphrase", async () => {
    const response = await operator.request("POST", `${base()}/verify`, { mode: "deep" });
    expect(response.status).toBe(200);
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(job.summary).toContain(`${DOCUMENTS} documents`);
    const detail = await viewer.request("GET", base());
    expect(detail.body.verification).toMatchObject({ mode: "deep", ok: true });
  });

  it("drills into a scratch connection and records the RTO", async () => {
    const response = await operator.request("POST", `${base()}/drill`, {
      targetConnectionId: ids.scratch,
      sample: 5,
    });
    expect(response.status).toBe(200);
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const detail = await viewer.request("GET", base());
    expect(detail.body.drills).toHaveLength(1);
    expect(detail.body.drills[0]).toMatchObject({ ok: true, rtoMs: expect.any(Number) });
  });

  it("shows an upgrade rehearsal with the MongoDB version it proved", async () => {
    // Written by `mongoshield rehearse-upgrade` (the library); the console only reads it.
    const storage = await resolveStorage(storageUrl);
    const drilledAt = new Date().toISOString();
    const record = {
      backupId: ids.backup,
      drilledAt,
      ok: true,
      restored: true,
      restoreDurationMs: 1000,
      durationMs: 2000,
      namespaces: 1,
      documentsRestored: DOCUMENTS,
      problemCount: 0,
      tool: "mongoshield@test",
      targetVersion: "8.0.13",
      sourceVersion: "7.0.32",
      compatibility: { problems: 0, warnings: 1 },
    };
    const stamp = drilledAt.replaceAll(":", "-").replace(".", "-");
    await storage.put(
      `annotations/${ids.backup}/drills/${stamp}.json`,
      Buffer.from(JSON.stringify(record)),
      {},
    );
    const detail = await viewer.request("GET", base());
    expect(detail.body.drills).toContainEqual({
      drilledAt,
      ok: true,
      rtoMs: 1000,
      targetVersion: "8.0.13",
    });
    // Ordinary drills carry no version.
    expect(
      detail.body.drills.filter((drill: { targetVersion?: string }) => !drill.targetVersion),
    ).toHaveLength(1);
  });

  it("does not let operators drill into production", async () => {
    const response = await operator.request("POST", `${base()}/drill`, {
      targetConnectionId: ids.production,
    });
    expect(response.status).toBe(403);
  });

  it("holds a backup (operator) and releases it (admin only)", async () => {
    const hold = await operator.request("POST", `${base()}/hold`, { reason: "legal hold 4471" });
    expect(hold.status).toBe(200);
    const detail = await viewer.request("GET", base());
    expect(detail.body.hold).toMatchObject({ reason: "legal hold 4471" });
    expect((await operator.request("DELETE", `${base()}/hold`)).status).toBe(403);
    expect((await admin.request("DELETE", `${base()}/hold`)).status).toBe(200);
    expect((await viewer.request("GET", base())).body.hold).toBeUndefined();
  });

  it("returns a finished job unchanged when it is cancelled", async () => {
    const jobs: JobSummary[] = (await viewer.request("GET", "/api/jobs")).body;
    const finished = jobs[0];
    const response = await operator.request("POST", `/api/jobs/${finished?.id}/cancel`);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe(finished?.status);
  });
});

describe("audit and redaction", () => {
  it("records every action with its actor", async () => {
    const entries = (await viewer.request("GET", "/api/audit?limit=500")).body as {
      actor: string;
      action: string;
      outcome: string;
    }[];
    const actions = entries.map((entry) => `${entry.actor}:${entry.action}:${entry.outcome}`);
    for (const expected of [
      "olga:plan.run:success",
      "olga:backup.browse:success",
      "olga:restore.start:success",
      "admin:restore.start:failure",
      "admin:restore.start:success",
      "olga:backup.verify:success",
      "olga:backup.drill:success",
      "olga:backup.hold:success",
      "admin:backup.release:success",
      "admin:plan.create:success",
    ]) {
      expect(actions).toContain(expected);
    }
    // Newest first.
    expect(entries[0]?.action).toBe("job.cancel");
  });

  it("pages the audit log backwards", async () => {
    const firstPage = (await viewer.request("GET", "/api/audit?limit=3")).body;
    expect(firstPage).toHaveLength(3);
    const before = encodeURIComponent(firstPage[2].at);
    const next = (await viewer.request("GET", `/api/audit?limit=3&before=${before}`)).body;
    for (const entry of next)
      expect(Date.parse(entry.at)).toBeLessThan(Date.parse(firstPage[2].at));
  });

  it("never sent the MongoDB password or the passphrase in any response", () => {
    const everything = testConsole.transcript.join("\n");
    expect(everything).not.toContain(mongoPassword);
    expect(everything).not.toContain(PASSPHRASE);
  });
});

describe("restoring selected documents", () => {
  const selectedDb = uniqueDb("sel");
  let storageId = "";
  let backupId = "";

  beforeAll(async () => {
    await seed(selectedDb, "users", 100);
    storageId = (
      await admin.request("POST", "/api/storage", {
        name: "selection",
        url: `memory://${selectedDb}`,
      })
    ).body.id;
    const plan = await admin.request("POST", "/api/plans", {
      name: "selection",
      connectionId: ids.scratch,
      storageId,
      include: [`${selectedDb}.*`],
      exclude: [],
      compression: "gzip",
      encryption: { kind: "none" },
      consistency: "auto",
      verify: "none",
      notify: [],
    });
    const run = await operator.request("POST", `/api/plans/${plan.body.id}/run`);
    const job = await waitForJob(testConsole, run.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    backupId = job.backupId ?? "";
  });

  const request = (extra: Record<string, unknown> = {}) => ({
    storageId,
    backupId,
    targetConnectionId: ids.scratch,
    include: [`${selectedDb}.users`],
    rename: { [`${selectedDb}.*`]: `${selectedDb}_two.*` },
    mode: "upsert",
    filter: JSON.stringify({ _id: { $in: [3, 7] } }),
    ...extra,
  });

  it("plans with the counts of the matching documents only", async () => {
    const plan = await operator.request("POST", "/api/restore/plan", request());
    expect(plan.status, plan.text).toBe(200);
    expect(plan.body.entries).toEqual([
      expect.objectContaining({
        from: `${selectedDb}.users`,
        to: `${selectedDb}_two.users`,
        documents: 2,
        existingDocuments: 0,
        action: "create",
      }),
    ]);
  });

  it("restores 2 selected documents out of 100", async () => {
    const response = await operator.request("POST", "/api/restore", request());
    expect(response.status).toBe(200);
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(job.summary).toContain("2 of 2 matching documents");
    expect(await countDocuments(`${selectedDb}_two`, "users")).toBe(2);
  });

  it("reports the selected documents as existing on a second plan, and refuses an empty filter", async () => {
    const again = await operator.request("POST", "/api/restore/plan", request({ mode: "insert" }));
    expect(again.body.entries[0]).toMatchObject({
      documents: 2,
      existingDocuments: 2,
      action: "insert",
    });
    const empty = await operator.request("POST", "/api/restore/plan", request({ filter: "{}" }));
    expect(empty.status).toBe(400);
    const broken = await operator.request(
      "POST",
      "/api/restore/plan",
      request({ filter: "{nope" }),
    );
    expect(broken.status).toBe(400);
  });

  it("applies the same production rules to document restores", async () => {
    const response = await operator.request(
      "POST",
      "/api/restore",
      request({ targetConnectionId: ids.production, confirmName: "prod" }),
    );
    expect(response.status).toBe(403);
  });
});
