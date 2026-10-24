/**
 * Applying a plan's retention policy through the API, against the real test
 * replica set and memory storage: the dry run, the confirmation that may never
 * delete more than the dry run showed, holds, the storage lock shared with backup
 * runs, and the audit trail. Another plan writes to the same storage throughout:
 * retention is scoped per plan (`mongoshield.plan` label + cluster), so neither the
 * on-demand prune nor the automatic one after a run ever touches its backups.
 */

import { resolveStorage, storageLock } from "mongoshield";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrunePlanView } from "../../src/shared/api.ts";
import {
  mongoUri,
  removeDataDir,
  seed,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  waitForJob,
} from "../helpers/console.ts";

let testConsole: TestConsole;
let admin: TestClient;
const db = uniqueDb("prune");
const storageUrl = `memory://${uniqueDb("prune-store")}`;
const ids = { connection: "", storage: "", plan: "", noRetention: "" };
const backups: string[] = [];
/** The backup of the other plan ("keep all") in the same storage. */
let otherPlanBackup = "";

/** A plan body writing `db` to the test storage. */
function planBody(name: string, retention?: object) {
  return {
    name,
    connectionId: ids.connection,
    storageId: ids.storage,
    include: [`${db}.*`],
    exclude: [],
    compression: "none",
    encryption: { kind: "none" },
    consistency: "auto",
    verify: "none",
    notify: [],
    ...(retention === undefined ? {} : { retention }),
  };
}

/**
 * Runs a plan once and returns the new backup's id. A backup run applies its
 * plan's retention itself afterwards (as `mongoshield run` does), so the setup
 * runs "keep two" before it has a retention policy.
 */
async function runBackup(planId = ids.plan): Promise<string> {
  const run = await admin.request("POST", `/api/plans/${planId}/run`);
  const job = await waitForJob(testConsole, run.body.id);
  expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
  return job.backupId ?? "";
}

async function dryRun(planId = ids.plan): Promise<PrunePlanView> {
  const response = await admin.request("POST", `/api/plans/${planId}/prune/plan`);
  expect(response.status, response.text).toBe(200);
  return response.body;
}

async function catalogIds(): Promise<string[]> {
  const response = await admin.request("GET", `/api/storage/${ids.storage}/backups`);
  return (response.body as { id: string }[]).map((backup) => backup.id);
}

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  await seed(db, "items", 5);
  ids.connection = (
    await admin.request("POST", "/api/connections", {
      name: "src",
      uri: mongoUri(),
      production: false,
    })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", { name: "mem", url: storageUrl })
  ).body.id;
  ids.plan = (await admin.request("POST", "/api/plans", planBody("keep two"))).body.id;
  ids.noRetention = (await admin.request("POST", "/api/plans", planBody("keep all"))).body.id;
  for (let index = 0; index < 3; index++) backups.push(await runBackup());
  // The other plan's backup is the OLDEST in the storage's newest-first order, so
  // an unscoped `last: 2` would delete it.
  otherPlanBackup = await runBackup(ids.noRetention);
  // Tighten the policy afterwards: the situation an on-demand prune is for.
  const updated = await admin.request(
    "PUT",
    `/api/plans/${ids.plan}`,
    planBody("keep two", { last: 2 }),
  );
  expect(updated.status, updated.text).toBe(200);
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("the prune dry run", () => {
  it("lists what the plan's retention keeps and removes, without deleting anything", async () => {
    const plan = await dryRun();
    expect(plan.planId).toBe(ids.plan);
    expect(plan.storageId).toBe(ids.storage);
    expect(plan.policy).toEqual({ last: 2 });
    expect(plan.remove.map((entry) => entry.id)).toEqual([backups[0]]);
    expect(plan.keep.map((entry) => entry.id).sort()).toEqual([backups[1], backups[2]].sort());
    expect(plan.keep[0]?.reasons.length).toBeGreaterThan(0);
    expect(await catalogIds()).toHaveLength(4);
  });

  it("leaves the backups of other plans in the same storage out of the plan, and counts them", async () => {
    const plan = await dryRun();
    const planned = [...plan.keep, ...plan.remove].map((entry) => entry.id);
    expect(planned).not.toContain(otherPlanBackup);
    expect(plan.outOfScope).toBe(1);
  });

  it("refuses plans without a retention policy", async () => {
    const response = await admin.request("POST", `/api/plans/${ids.noRetention}/prune/plan`);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/no retention policy/);
    const confirm = await admin.request("POST", `/api/plans/${ids.noRetention}/prune`, {
      remove: [backups[0]],
    });
    expect(confirm.status).toBe(400);
  });

  it("answers 404 for an unknown plan", async () => {
    expect((await admin.request("POST", "/api/plans/missing/prune/plan")).status).toBe(404);
  });
});

describe("confirming a prune", () => {
  it("refuses an empty or malformed confirmation", async () => {
    for (const body of [{}, { remove: [] }, { remove: ["not-a-backup-id"] }, { remove: "x" }]) {
      const response = await admin.request("POST", `/api/plans/${ids.plan}/prune`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("fails without deleting when the plan would remove a backup the admin did not confirm", async () => {
    const response = await admin.request("POST", `/api/plans/${ids.plan}/prune`, {
      remove: ["2020-01-01T00-00-00Z_abcdef"],
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: "prune",
      planId: ids.plan,
      storageId: ids.storage,
    });
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("CONSOLE_PRUNE_PLAN_CHANGED");
    expect(await catalogIds()).toHaveLength(4);
  });

  it("fails while another runner holds the storage lock", async () => {
    const lease = await storageLock({
      storage: await resolveStorage(storageUrl),
      owner: { id: "other-runner", host: "elsewhere", pid: 1 },
      leaseMs: 60_000,
    }).tryAcquire();
    expect(lease.acquired).toBe(true);
    try {
      const response = await admin.request("POST", `/api/plans/${ids.plan}/prune`, {
        remove: [backups[0]],
      });
      const job = await waitForJob(testConsole, response.body.id);
      expect(job.status).toBe("failed");
      expect(job.error?.code).toBe("CONSOLE_STORAGE_BUSY");
    } finally {
      if (lease.acquired) await lease.lease.release();
    }
    expect(await catalogIds()).toHaveLength(4);
  });

  it("deletes exactly what the dry run listed, as an audited job", async () => {
    const plan = await dryRun();
    const response = await admin.request("POST", `/api/plans/${ids.plan}/prune`, {
      remove: plan.remove.map((entry) => entry.id),
    });
    const job = await waitForJob(testConsole, response.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    expect(job.summary).toMatch(/^Deleted 1 backups \(\d+\.\d MiB\), kept 2\.$/);
    expect((await catalogIds()).sort()).toEqual([backups[1], backups[2], otherPlanBackup].sort());

    const audit = (await admin.request("GET", "/api/audit?limit=5")).body;
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "plan.prune",
          target: "keep two",
          details: expect.objectContaining({ job: job.id, confirmed: 1 }),
        }),
      ]),
    );
  });

  it("keeps held backups whatever the policy says", async () => {
    const oldest = backups[1] ?? "";
    expect(
      (
        await admin.request("POST", `/api/storage/${ids.storage}/backups/${oldest}/hold`, {
          reason: "legal",
        })
      ).status,
    ).toBe(200);
    // The run prunes automatically (last 2) but must keep the held backup.
    backups.push(await runBackup());
    expect(await catalogIds()).toContain(oldest);
    const plan = await dryRun();
    expect(plan.remove.map((entry) => entry.id)).not.toContain(oldest);
    expect(plan.keep.find((entry) => entry.id === oldest)?.reasons).toContain("held");
  });
});

describe("pruning after a backup run", () => {
  it("applies the plan's retention to its own backups only, while other plans share its storage", async () => {
    // "keep two" has { last: 2 } and the hold from the test above; "keep all" writes
    // to the same storage. Before scoped retention this run deleted "keep all"'s backup.
    const run = await admin.request("POST", `/api/plans/${ids.plan}/run`);
    const job = await waitForJob(testConsole, run.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    const newest = job.backupId ?? "";
    const after = await catalogIds();
    expect(after).toContain(otherPlanBackup);
    expect(after).toContain(backups[1]); // held
    expect(after).toContain(newest);
    // Of the plan's unheld backups, only the newest two remain.
    const unheld = after.filter((id) => id !== otherPlanBackup && id !== backups[1]);
    expect(unheld).toHaveLength(2);
    expect(unheld).not.toContain(backups[2]);
  });

  it("labels every backup with the plan that wrote it", async () => {
    const response = await admin.request(
      "GET",
      `/api/storage/${ids.storage}/backups/${otherPlanBackup}`,
    );
    expect(response.status, response.text).toBe(200);
    expect(response.body.manifest.labels).toMatchObject({ "mongoshield.plan": ids.noRetention });
  });
});
