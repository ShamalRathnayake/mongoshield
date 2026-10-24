/**
 * The welcome flow through the API, against the real test replica set: checking a
 * pasted connection string (cleaning, placeholders, raw passwords, friendly errors,
 * per-database users), saving it with what the check found, "Back up now" with its
 * managed key, restoring without typing a key, the recovery key and its safety rules,
 * the one-click nightly schedule, and the public IP lookup.
 */

import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanInput, PlanView } from "../../src/shared/api.ts";
import {
  countDocuments,
  mongoUri,
  removeDataDir,
  seed,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  uniqueDb,
  userWithRole,
  waitForJob,
} from "../helpers/console.ts";

const db = uniqueDb("onboard");
let testConsole: TestConsole;
let admin: TestClient;
let operator: TestClient;
let mongo: MongoClient;

/** Creates a MongoDB user and returns its name and password (not URL-encoded). */
async function createUser(
  password: string,
  roles: { role: string; db: string }[] = [{ role: "root", db: "admin" }],
): Promise<string> {
  const username = `onboard_${randomBytes(4).toString("hex")}`;
  await mongo.db("admin").command({ createUser: username, pwd: password, roles });
  return username;
}

/** The test replica set's URI with a raw (unencoded) user and password put in. */
function rawUri(username: string, password: string): string {
  const base = new URL(mongoUri());
  return `mongodb://${username}:${password}@${base.host}/?authSource=admin&replicaSet=${base.searchParams.get("replicaSet") ?? ""}`.replace(
    /&replicaSet=$/,
    "",
  );
}

beforeAll(async () => {
  mongo = new MongoClient(mongoUri());
  await mongo.connect();
  testConsole = await startConsole({ firstRun: { defaultStorage: true } });
  admin = await setupAdmin(testConsole);
  operator = await userWithRole(testConsole, admin, "operator", "oscar");
  await seed(db, "users", 25);
  await seed(db, "orders", 10);
});

afterAll(async () => {
  await mongo.db(db).dropDatabase();
  await mongo.db(`${db}_restored`).dropDatabase();
  await mongo.close();
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("checking a pasted connection string", () => {
  it("connects, describes the deployment and proposes a name and production setting", async () => {
    const check = await admin.request("POST", "/api/connections/check", { uri: mongoUri() });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      ok: true,
      topology: "replicaSet",
      production: { suggested: false },
    });
    expect(check.body.suggestedName).toEqual(expect.any(String));
    expect(check.body.atlas).toBeUndefined();
    expect(check.body.serverVersion).toMatch(/^\d+\.\d+/);
  });

  it("accepts a mongosh command and quotes, and encodes a raw password with special characters", async () => {
    const password = "p@ss:w/rd?#[x]%";
    const username = await createUser(password);
    const pasted = `mongosh "${rawUri(username, password)}"`;
    const check = await admin.request("POST", "/api/connections/check", { uri: pasted });
    expect(check.body.ok).toBe(true);
    // Saving the same text stores the encoded URI, and the password never comes back.
    const saved = await admin.request("POST", "/api/connections", {
      name: "raw-password",
      uri: `  '${rawUri(username, password)}'\n`,
      production: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(password);
    expect(saved.text).not.toContain(encodeURIComponent(password));
    const test = await admin.request("POST", `/api/connections/${saved.body.id}/test`);
    expect(test.body.ok).toBe(true);
    // A successful test keeps what it found for the badges.
    const list = await admin.request("GET", "/api/connections");
    const view = list.body.find((connection: { id: string }) => connection.id === saved.body.id);
    expect(view.deployment).toMatchObject({
      topology: "replicaSet",
      checkedAt: expect.any(String),
    });
  });

  it("asks for the password instead of a placeholder", async () => {
    const atlasCopy =
      "mongodb+srv://shamal:<db_password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority";
    for (const route of ["/api/connections/check", "/api/connections"]) {
      const response = await admin.request("POST", route, {
        uri: atlasCopy,
        name: "atlas",
        production: true,
      });
      expect(response.status, route).toBe(400);
      expect(response.body.error.message).toMatch(/Replace <db_password>/);
    }
    const notAUri = await admin.request("POST", "/api/connections/check", { uri: "https://x" });
    expect(notAUri.status).toBe(400);
  });

  it("explains a wrong password in plain words", async () => {
    const username = await createUser("the-right-password-123");
    const check = await admin.request("POST", "/api/connections/check", {
      uri: rawUri(username, "the-wrong-password-456"),
    });
    expect(check.status).toBe(200);
    expect(check.body.ok).toBe(false);
    expect(check.body.problem).toMatchObject({
      kind: "auth-failed",
      title: "Wrong user name or password",
    });
    expect(check.text).not.toContain("the-wrong-password-456");
    // The failure is audited with its kind, the URI only in its redacted form.
    const audit = await admin.request("GET", "/api/audit?limit=20");
    const entry = audit.body.find(
      (candidate: { action: string; outcome: string }) =>
        candidate.action === "connection.check" && candidate.outcome === "failure",
    );
    expect(entry.details.problem).toBe("auth-failed");
    expect(entry.target).not.toContain("the-wrong-password-456");
  });

  it("explains a refused connection and an SRV name that does not exist", async () => {
    const refused = await admin.request("POST", "/api/connections/check", {
      uri: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=2000",
    });
    expect(refused.body.problem.kind).toBe("connection-refused");
    const srv = await admin.request("POST", "/api/connections/check", {
      uri: "mongodb+srv://u:p@cluster0.does-not-exist.invalid/",
    });
    expect(srv.body.ok).toBe(false);
    expect(srv.body.problem.kind).toBe("dns-not-found");
  });

  it("lists the databases a user with per-database roles can back up", async () => {
    const username = await createUser("per-database-password", [{ role: "read", db }]);
    const check = await admin.request("POST", "/api/connections/check", {
      uri: rawUri(username, "per-database-password"),
    });
    expect(check.body.ok).toBe(true);
    // `toContain`, not `toEqual`: the test mongod is shared with test files running at
    // the same time, so only this file's database is certain to be there.
    expect(check.body.readableDatabases).toContain(db);
    expect(check.body.readableDatabases).not.toContain("admin");
    expect(check.body.privilegeAdvice).toMatchObject({ kind: "missing-privileges" });
    expect(check.body.privilegeAdvice.message).toContain(db);
  });

  it("is for admins only", async () => {
    const response = await operator.request("POST", "/api/connections/check", { uri: mongoUri() });
    expect(response.status).toBe(403);
  });
});

describe("Back up now", () => {
  let connectionId = "";
  let plan: PlanView;

  beforeAll(async () => {
    const check = await admin.request("POST", "/api/connections/check", { uri: mongoUri() });
    const created = await admin.request("POST", "/api/connections", {
      name: "local test",
      uri: mongoUri(),
      production: check.body.production.suggested,
    });
    connectionId = created.body.id;
    // Saved right after the check: it keeps what the check found out.
    expect(created.body.deployment).toMatchObject({ topology: "replicaSet" });
  });

  it("creates the quick plan with every default and runs an encrypted backup", async () => {
    const response = await admin.request("POST", "/api/quick-backup", {
      connectionId,
      include: [`${db}.*`],
    });
    expect(response.status).toBe(200);
    expect(response.body.created).toBe(true);
    plan = response.body.plan;
    expect(plan).toMatchObject({
      name: "Back up local test",
      origin: "quick",
      include: [`${db}.*`],
      compression: "zstd",
      consistency: "auto",
      verify: "fast",
      encryption: { kind: "managed", recoveryKeySaved: false },
    });
    expect(plan.encryption.kind === "managed" && plan.encryption.recipient).toMatch(/^age1/);
    expect(plan.storageId).toBe(testConsole.services.store.current.defaults?.storageId);
    // The private key is never part of a plan view.
    expect(response.text).not.toContain("AGE-SECRET-KEY");

    const job = await waitForJob(testConsole, response.body.job.id);
    expect(job.status).toBe("succeeded");
    const backups = await admin.request("GET", `/api/storage/${plan.storageId}/backups`);
    expect(backups.body[0]).toMatchObject({ status: "complete", encrypted: true });
  });

  it("reuses the plan on the next click and follows a changed selection", async () => {
    const response = await admin.request("POST", "/api/quick-backup", {
      connectionId,
      include: [`${db}.users`],
    });
    expect(response.body.created).toBe(false);
    expect(response.body.plan.id).toBe(plan.id);
    expect(response.body.plan.include).toEqual([`${db}.users`]);
    expect((await waitForJob(testConsole, response.body.job.id)).status).toBe("succeeded");
    const quickPlans = testConsole.services.store.current.plans.filter(
      (candidate) => candidate.origin === "quick",
    );
    expect(quickPlans).toHaveLength(1);
  });

  it("restores and deep-verifies without anyone typing a key", async () => {
    const backups = await admin.request("GET", `/api/storage/${plan.storageId}/backups`);
    const backupId = backups.body.at(-1).id;
    const verify = await operator.request(
      "POST",
      `/api/storage/${plan.storageId}/backups/${backupId}/verify`,
      { mode: "deep" },
    );
    expect((await waitForJob(testConsole, verify.body.id)).status).toBe("succeeded");

    const restore = await admin.request("POST", "/api/restore", {
      storageId: plan.storageId,
      backupId,
      targetConnectionId: connectionId,
      include: [`${db}.users`],
      rename: { [`${db}.*`]: `${db}_restored.*` },
      mode: "fail-if-exists",
    });
    expect(restore.status).toBe(200);
    expect((await waitForJob(testConsole, restore.body.id)).status).toBe("succeeded");
    expect(await countDocuments(`${db}_restored`, "users")).toBe(25);
  });

  it("refuses to delete the plan or change its encryption until the recovery key is saved", async () => {
    const remove = await admin.request("DELETE", `/api/plans/${plan.id}`);
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe("CONSOLE_RECOVERY_KEY_NOT_SAVED");
    const input = planInput(plan, { encryption: { kind: "none" } });
    const change = await admin.request("PUT", `/api/plans/${plan.id}`, input);
    expect(change.status).toBe(409);
  });

  it("hands the recovery key to admins only, audits it without the key, and marks it saved", async () => {
    expect((await operator.request("POST", `/api/plans/${plan.id}/recovery-key`)).status).toBe(403);
    const response = await admin.request("POST", `/api/plans/${plan.id}/recovery-key`);
    expect(response.status).toBe(200);
    expect(response.body.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    expect(response.body.recipient).toBe(
      plan.encryption.kind === "managed" ? plan.encryption.recipient : "",
    );
    expect(response.body.filename).toBe("mongoshield-recovery-key-Back-up-local-test.txt");
    expect(response.body.fileContent).toContain(response.body.identity);
    expect(response.body.fileContent).toMatch(/--identity-file/);

    const audit = await admin.request("GET", "/api/audit?limit=50");
    const entry = audit.body.find(
      (candidate: { action: string }) => candidate.action === "plan.recovery_key",
    );
    expect(entry).toMatchObject({ actor: "admin", details: { plan: plan.id } });
    expect(audit.text).not.toContain(response.body.identity);

    const plans = await admin.request("GET", "/api/plans");
    const saved = plans.body.find((candidate: PlanView) => candidate.id === plan.id);
    expect(saved.encryption.recoveryKeySaved).toBe(true);
  });

  it("makes the plan a nightly schedule in one PUT, keeping its key", async () => {
    const input = planInput(plan, {
      encryption: { kind: "managed" },
      schedule: { cron: "0 2 * * *", timezone: "UTC" },
      retention: { daily: 7, weekly: 4, monthly: 12 },
    });
    const response = await admin.request("PUT", `/api/plans/${plan.id}`, input);
    expect(response.status).toBe(200);
    expect(response.body.schedule).toEqual({ cron: "0 2 * * *", timezone: "UTC" });
    // The schedule is live (tests do not start the timers, so no next run is reported).
    expect(
      testConsole.services.store.current.plans.find((each) => each.id === plan.id)?.schedule,
    ).toBeDefined();
    expect(response.body.encryption).toEqual(
      plan.encryption.kind === "managed" ? { ...plan.encryption, recoveryKeySaved: true } : {},
    );
    // Its export keeps the public key, so the CLI can encrypt the same way.
    const exported = await admin.request("GET", "/api/config/export");
    expect(exported.body.content).toContain(
      plan.encryption.kind === "managed" ? plan.encryption.recipient : "?",
    );
  });

  it("backs up everything but MongoDB's own databases when nothing is chosen", async () => {
    const unreachable = await admin.request("POST", "/api/connections", {
      name: "unreachable",
      uri: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500",
      production: false,
    });
    const response = await admin.request("POST", "/api/quick-backup", {
      connectionId: unreachable.body.id,
    });
    expect(response.body.plan.include).toEqual([]);
    // It cannot reach that server; cancel instead of waiting for its retries.
    await admin.request("POST", `/api/jobs/${response.body.job.id}/cancel`);
    expect(["failed", "cancelled"]).toContain(
      (await waitForJob(testConsole, response.body.job.id)).status,
    );
  });

  it("needs a local storage location", async () => {
    const empty = await startConsole();
    try {
      const emptyAdmin = await setupAdmin(empty);
      const connection = await emptyAdmin.request("POST", "/api/connections", {
        name: "x",
        uri: mongoUri(),
        production: false,
      });
      const response = await emptyAdmin.request("POST", "/api/quick-backup", {
        connectionId: connection.body.id,
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONSOLE_NO_STORAGE");
    } finally {
      await empty.close();
      await removeDataDir(empty.dataDir);
    }
  });
});

describe("the public IP lookup", () => {
  it("returns the address the lookup service saw, for admins only", async () => {
    const response = await admin.request("POST", "/api/network/public-ip");
    expect(response.body).toEqual({ ip: "203.0.113.7" });
    expect((await operator.request("POST", "/api/network/public-ip")).status).toBe(403);
  });

  it("refuses answers that are not an IP address, and reports an unreachable service", async () => {
    const odd = await startConsole({
      app: { onboarding: { fetchPublicIp: async () => new Response("<html>hello</html>") } },
    });
    const down = await startConsole({
      app: {
        onboarding: {
          fetchPublicIp: async () => {
            throw new Error("offline");
          },
        },
      },
    });
    try {
      const oddAdmin = await setupAdmin(odd);
      expect((await oddAdmin.request("POST", "/api/network/public-ip")).body.error).toMatch(
        /did not answer with an IP address/,
      );
      const downAdmin = await setupAdmin(down);
      expect((await downAdmin.request("POST", "/api/network/public-ip")).body.error).toMatch(
        /could not reach/,
      );
    } finally {
      for (const each of [odd, down]) {
        await each.close();
        await removeDataDir(each.dataDir);
      }
    }
  });
});

/** A PlanInput from a view, with changes. */
function planInput(view: PlanView, changes: Partial<PlanInput>): PlanInput {
  return {
    name: view.name,
    connectionId: view.connectionId,
    storageId: view.storageId,
    include: view.include,
    exclude: view.exclude,
    compression: view.compression,
    encryption: { kind: "managed" },
    consistency: view.consistency,
    verify: view.verify,
    notify: [],
    ...changes,
  };
}
