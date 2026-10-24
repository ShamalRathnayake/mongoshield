/**
 * The job tasks' less common paths, through the API against the real test
 * replica set: recipient encryption with retention and a webhook, keys given
 * with a request, a failed backup, a failed verification of a damaged backup,
 * filtered restores with a selection, and audit entries of scheduled jobs.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateIdentity } from "mongoshield";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const key = generateIdentity();
const db = uniqueDb("tasks");
let testConsole: TestConsole;
let admin: TestClient;
let webhook: Server;
const webhookBodies: string[] = [];
const ids = { source: "", storage: "", plan: "", backup: "" };

beforeAll(async () => {
  webhook = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      webhookBodies.push(body);
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  const port = (webhook.address() as AddressInfo).port;

  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  await seed(db, "users", 12);
  await seed(db, "cache", 3);
  ids.source = (
    await admin.request("POST", "/api/connections", {
      name: "source",
      uri: mongoUri(),
      production: false,
    })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", { name: "mem", url: `memory://${db}` })
  ).body.id;
  const plan = await admin.request("POST", "/api/plans", {
    name: "recipients",
    connectionId: ids.source,
    storageId: ids.storage,
    include: [`${db}.*`],
    exclude: [`${db}.cache`],
    compression: "gzip",
    encryption: { kind: "recipients", recipients: [key.recipient] },
    consistency: "auto",
    verify: "none",
    retention: { last: 5 },
    notify: [{ type: "webhook", url: `http://127.0.0.1:${port}/hook` }],
  });
  if (plan.status !== 200) throw new Error(plan.text);
  ids.plan = plan.body.id;
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
  await new Promise((resolve) => webhook.close(resolve));
});

describe("backups with recipient encryption, retention and a webhook", () => {
  it("backs up the selection, encrypted, and notifies the webhook", async () => {
    const run = await admin.request("POST", `/api/plans/${ids.plan}/run`);
    const job = await waitForJob(testConsole, run.body.id);
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    ids.backup = job.backupId ?? "";

    const detail = await admin.request("GET", `/api/storage/${ids.storage}/backups/${ids.backup}`);
    expect(detail.body).toMatchObject({ encrypted: true, namespaces: 1, documents: 12 });
    expect(webhookBodies.length).toBeGreaterThan(0);
    expect(webhookBodies.join("\n")).toContain(ids.backup);
  });

  it("cannot verify deeply without a key, and plans a restore with identities given", async () => {
    const verify = await admin.request(
      "POST",
      `/api/storage/${ids.storage}/backups/${ids.backup}/verify`,
      { mode: "deep" },
    );
    const failed = await waitForJob(testConsole, verify.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toMatch(/^MS_/);

    const plan = await admin.request("POST", "/api/restore/plan", {
      storageId: ids.storage,
      backupId: ids.backup,
      targetConnectionId: ids.source,
      include: [`${db}.*`],
      exclude: [`${db}.nothing`],
      rename: { [`${db}.*`]: `${db}_copy.*` },
      mode: "fail-if-exists",
      identities: [key.identity],
    });
    expect(plan.status, plan.text).toBe(200);
    expect(plan.body.entries).toEqual([
      expect.objectContaining({ from: `${db}.users`, to: `${db}_copy.users`, documents: 12 }),
    ]);
    expect(plan.text).not.toContain(key.identity);
  });

  it("plans a filtered restore with a selection and a passphrase given", async () => {
    // A passphrase for a recipient-encrypted backup does not open it: the plan reports why.
    const plan = await admin.request("POST", "/api/restore/plan", {
      storageId: ids.storage,
      backupId: ids.backup,
      targetConnectionId: ids.source,
      include: [`${db}.users`],
      exclude: [`${db}.cache`],
      rename: { [`${db}.*`]: `${db}_sel.*` },
      mode: "drop",
      filter: '{"_id": {"$in": [1, 2]}}',
      passphrase: "not-the-right-kind-of-key",
    });
    expect(plan.status).toBeGreaterThanOrEqual(400);
    expect(plan.text).not.toContain("not-the-right-kind-of-key");

    for (const mode of ["upsert", "insert", "drop"]) {
      const withKey = await admin.request("POST", "/api/restore/plan", {
        storageId: ids.storage,
        backupId: ids.backup,
        targetConnectionId: ids.source,
        include: [`${db}.users`],
        rename: { [`${db}.*`]: `${db}_sel.*` },
        mode,
        filter: '{"_id": {"$in": [1, 2]}}',
        identities: [key.identity],
      });
      expect(withKey.status, withKey.text).toBe(200);
      expect(withKey.body.entries[0]).toMatchObject({ documents: 2, to: `${db}_sel.users` });
    }
  });
});

describe("failures", () => {
  it("fails a backup whose credentials are refused, with the library's error", async () => {
    // Wrong credentials are not retried (unlike an unreachable server), so this fails fast.
    const url = new URL(mongoUri());
    url.username = "nobody";
    url.password = "Wrong-Password-1";
    url.searchParams.set("authSource", "admin");
    const connection = await admin.request("POST", "/api/connections", {
      name: "wrong-credentials",
      uri: url.toString(),
      production: false,
    });
    const plan = await admin.request("POST", "/api/plans", {
      name: "wrong-credentials",
      connectionId: connection.body.id,
      storageId: ids.storage,
      include: [],
      exclude: [],
      compression: "none",
      encryption: { kind: "none" },
      consistency: "none",
      verify: "none",
      notify: [],
    });
    const run = await admin.request("POST", `/api/plans/${plan.body.id}/run`);
    const job = await waitForJob(testConsole, run.body.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toMatch(/^MS_/);
    expect(JSON.stringify(job)).not.toContain("Wrong-Password-1");
  });

  it("fails the verification of a backup whose data was damaged", async () => {
    const record = testConsole.services.store.current.storage.find(
      (storage) => storage.id === ids.storage,
    );
    if (record === undefined) throw new Error("storage record");
    const adapter = await testConsole.services.storage.adapterFor(record);
    const keys: string[] = [];
    for await (const object of adapter.list(`backups/${ids.backup}/`)) keys.push(object.key);
    const dataKey = keys.find((candidate) => candidate.includes(`/${db}/users.bson`));
    expect(dataKey, keys.join(", ")).toBeDefined();
    await adapter.put(dataKey ?? "", Buffer.from("damaged"));

    const verify = await admin.request(
      "POST",
      `/api/storage/${ids.storage}/backups/${ids.backup}/verify`,
      { mode: "fast" },
    );
    const job = await waitForJob(testConsole, verify.body.id);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("MS_INTEGRITY_FAILED");
    expect(job.error?.message).toMatch(/failed fast verification with \d+ problem/);
  });
});

describe("scheduled jobs", () => {
  it("are audited by the runner when they finish, as there is no request to audit them", async () => {
    const job = await testConsole.services.runner.start({
      kind: "verify",
      lane: "storage:scheduled",
      startedBy: "schedule",
      planId: ids.plan,
      run: async () => ({ summary: "ok" }),
    });
    await waitForJob(testConsole, job.id);
    let entry: unknown;
    for (let attempt = 0; attempt < 50 && entry === undefined; attempt++) {
      const audit = await admin.request("GET", "/api/audit?limit=20");
      entry = audit.body.find(
        (item: { action: string; actor: string }) =>
          item.action === "verify.finish" && item.actor === "schedule",
      );
      if (entry === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(entry).toMatchObject({ target: ids.plan, outcome: "success" });
  });
});
