/**
 * Connections, storage, plans and users: CRUD, validation, the connection and
 * storage tests, the namespace tree, config export, secret redaction, the
 * encrypted state file and persistence across restarts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataDirLockedError } from "../../src/state/lock.ts";
import { StateOpenError } from "../../src/state/store.ts";
import {
  mongoUri,
  removeDataDir,
  seed,
  setupAdmin,
  startConsole,
  TEST_PASSWORD,
  type TestClient,
  type TestConsole,
  uniqueDb,
  uriWithPassword,
  userWithRole,
} from "../helpers/console.ts";

const PASSPHRASE = "plan-passphrase-that-must-never-leak";
const WEBHOOK = "https://hooks.example.com/services/T000/B000/very-secret-webhook-token";
const AWS_SECRET = "aws-secret-access-key-that-must-never-leak";

let testConsole: TestConsole;
let admin: TestClient;
let mongoPassword: string;
let mongoUriWithPassword: string;
const db = uniqueDb();

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  ({ uri: mongoUriWithPassword, password: mongoPassword } = await uriWithPassword());
  await seed(db, "users", 5);
});

afterAll(async () => {
  await testConsole.close().catch(() => undefined);
  await removeDataDir(testConsole.dataDir);
});

describe("connections", () => {
  let connectionId: string;

  it("stores a connection and returns only a redacted preview", async () => {
    const response = await admin.request("POST", "/api/connections", {
      name: "main",
      uri: mongoUriWithPassword,
      production: true,
    });
    expect(response.status).toBe(200);
    connectionId = response.body.id;
    expect(response.body.uri.configured).toBe(true);
    expect(response.body.uri.preview).toContain(":***@");
    expect(response.text).not.toContain(mongoPassword);
  });

  it("refuses duplicate names and non-MongoDB URIs", async () => {
    const duplicate = await admin.request("POST", "/api/connections", {
      name: "main",
      uri: mongoUri(),
      production: false,
    });
    expect(duplicate.status).toBe(409);
    const bad = await admin.request("POST", "/api/connections", {
      name: "bad",
      uri: "http://example.com",
      production: false,
    });
    expect(bad.status).toBe(400);
  });

  it("tests the connection and reports the deployment", async () => {
    const response = await admin.request("POST", `/api/connections/${connectionId}/test`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      topology: "replicaSet",
      missingBackupPrivileges: [],
      missingRestorePrivileges: [],
    });
    expect(response.body.serverVersion).toMatch(/^\d+\.\d+/);
  });

  it("reports a broken connection without leaking its password", async () => {
    const broken = await admin.request("POST", "/api/connections", {
      name: "broken",
      uri: `mongodb://someone:${mongoPassword}@127.0.0.1:1/?serverSelectionTimeoutMS=500&directConnection=true`,
      production: false,
    });
    const response = await admin.request("POST", `/api/connections/${broken.body.id}/test`);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.error.code).toBe("MS_CONNECTION_FAILED");
    expect(response.text).not.toContain(mongoPassword);
    await admin.request("DELETE", `/api/connections/${broken.body.id}`);
  });

  it("lists databases and collections with counts and index numbers", async () => {
    const response = await admin.request("GET", `/api/connections/${connectionId}/namespaces`);
    expect(response.status).toBe(200);
    const database = response.body.find((node: { name: string }) => node.name === db);
    expect(database.collections).toEqual([
      { name: "users", type: "collection", estimatedDocuments: 5, indexes: 1 },
    ]);
    expect(response.body.some((node: { name: string }) => node.name === "admin")).toBe(false);
  });

  it("keeps the stored URI when an update omits it", async () => {
    const response = await admin.request("PUT", `/api/connections/${connectionId}`, {
      name: "main",
      production: true,
    });
    expect(response.status).toBe(200);
    const test = await admin.request("POST", `/api/connections/${connectionId}/test`);
    expect(test.body.ok).toBe(true);
  });
});

describe("storage", () => {
  it("creates local storage inside the data directory and probes it", async () => {
    const created = await admin.request("POST", "/api/storage", { name: "local", url: "backups" });
    expect(created.status).toBe(200);
    expect(created.body.credentials).toEqual({ configured: false });
    const probe = await admin.request("POST", `/api/storage/${created.body.id}/test`);
    expect(probe.body).toEqual({
      ok: true,
      capabilities: { conditionalWrites: true, rangeReads: true, objectLock: false },
    });
  });

  it("refuses local paths outside the data directory", async () => {
    for (const url of ["/etc", "../outside", "file:///tmp/elsewhere", "."]) {
      const response = await admin.request("POST", "/api/storage", { name: `bad ${url}`, url });
      expect(response.status, url).toBe(400);
    }
  });

  it("stores credentials encrypted and shows only their names", async () => {
    const response = await admin.request("POST", "/api/storage", {
      name: "s3",
      url: "s3://acme-backups/prod?region=eu-west-1",
      credentials: { AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: AWS_SECRET },
    });
    expect(response.status).toBe(200);
    expect(response.body.credentials).toEqual({
      configured: true,
      preview: "AWS_ACCESS_KEY_ID=***, AWS_SECRET_ACCESS_KEY=***",
    });
    expect(response.text).not.toContain(AWS_SECRET);
  });

  it("refuses unknown credential names and credentials in URLs", async () => {
    const unknown = await admin.request("POST", "/api/storage", {
      name: "typo",
      url: "s3://bucket",
      credentials: { AWS_SECRET_KEY: "x" },
    });
    expect(unknown.status).toBe(400);
    const inUrl = await admin.request("POST", "/api/storage", {
      name: "inline",
      url: "s3://key:secret@bucket",
    });
    expect(inUrl.status).toBe(400);
  });
});

describe("plans", () => {
  let planId: string;

  it("creates a plan with secrets and returns only summaries", async () => {
    const connections = (await admin.request("GET", "/api/connections")).body;
    const storage = (await admin.request("GET", "/api/storage")).body;
    const response = await admin.request("POST", "/api/plans", {
      name: "nightly",
      connectionId: connections[0].id,
      storageId: storage[0].id,
      include: [`${db}.*`],
      exclude: [],
      compression: "zstd",
      encryption: { kind: "passphrase", passphrase: PASSPHRASE },
      consistency: "auto",
      schedule: { cron: "15 3 * * *", timezone: "Europe/Berlin" },
      retention: { last: 3, daily: 7 },
      verify: "fast",
      notify: [{ type: "slack", url: WEBHOOK }],
    });
    expect(response.status).toBe(200);
    planId = response.body.id;
    expect(response.body.encryption).toEqual({
      kind: "passphrase",
      passphrase: { configured: true },
    });
    expect(response.body.notify).toEqual([
      { type: "slack", url: { configured: true, preview: "https://hooks.example.com/***" } },
    ]);
    expect(response.text).not.toContain(PASSPHRASE);
    expect(response.text).not.toContain("very-secret-webhook-token");
  });

  it("validates cron expressions, time zones and passphrases", async () => {
    const plan = (await admin.request("GET", "/api/plans")).body[0];
    const base = { ...plan, encryption: { kind: "none" }, notify: [] };
    const badCron = await admin.request("PUT", `/api/plans/${planId}`, {
      ...base,
      schedule: { cron: "every day", timezone: "UTC" },
    });
    expect(badCron.status).toBe(400);
    const badZone = await admin.request("PUT", `/api/plans/${planId}`, {
      ...base,
      schedule: { cron: "0 3 * * *", timezone: "Mars/Olympus" },
    });
    expect(badZone.status).toBe(400);
    const shortPassphrase = await admin.request("PUT", `/api/plans/${planId}`, {
      ...base,
      encryption: { kind: "passphrase", passphrase: "short" },
    });
    expect(shortPassphrase.status).toBe(400);
  });

  it("keeps the passphrase and webhook URL when an update omits them", async () => {
    const plan = (await admin.request("GET", "/api/plans")).body[0];
    const response = await admin.request("PUT", `/api/plans/${planId}`, {
      ...plan,
      name: "nightly",
      encryption: { kind: "passphrase" },
      notify: [{ type: "slack" }],
    });
    expect(response.status).toBe(200);
    const stored = testConsole.services.store.current.plans.find(
      (candidate) => candidate.id === planId,
    );
    expect(stored?.encryption.kind).toBe("passphrase");
    expect(stored?.notify).toHaveLength(1);
  });

  it("refuses to delete a connection or storage location a plan uses", async () => {
    const plan = (await admin.request("GET", "/api/plans")).body[0];
    expect((await admin.request("DELETE", `/api/connections/${plan.connectionId}`)).status).toBe(
      409,
    );
    expect((await admin.request("DELETE", `/api/storage/${plan.storageId}`)).status).toBe(409);
  });

  it("exports a config file with environment references instead of secrets", async () => {
    const response = await admin.request("GET", "/api/config/export");
    expect(response.status).toBe(200);
    expect(response.body.filename).toBe("mongoshield.config.ts");
    const content: string = response.body.content;
    expect(content).toContain("export const planNightly = defineConfig({");
    expect(content).toContain("uri: process.env.MONGODB_URI_MAIN");
    expect(content).toContain("passphrase: process.env.MONGOSHIELD_PASSPHRASE_NIGHTLY");
    expect(content).toContain("url: process.env.MONGOSHIELD_NOTIFY_NIGHTLY_1");
    expect(content).toContain('cron: "15 3 * * *"');
    expect(content).toContain("export default planNightly;");
    expect(content).not.toContain(PASSPHRASE);
    expect(content).not.toContain(mongoPassword);
  });
});

describe("users", () => {
  it("never returns password hashes and protects the last admin", async () => {
    const list = await admin.request("GET", "/api/users");
    expect(list.text).not.toContain("scrypt$");
    const self = list.body.find((user: { username: string }) => user.username === "admin");
    const demote = await admin.request("PUT", `/api/users/${self.id}`, {
      username: "admin",
      role: "viewer",
    });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("CONSOLE_LAST_ADMIN");
    expect((await admin.request("DELETE", `/api/users/${self.id}`)).status).toBe(400);
  });

  it("refuses duplicate usernames and weak passwords", async () => {
    await userWithRole(testConsole, admin, "viewer", "dup");
    const duplicate = await admin.request("POST", "/api/users", {
      username: "dup",
      role: "viewer",
      password: TEST_PASSWORD,
    });
    expect(duplicate.status).toBe(409);
    const weak = await admin.request("POST", "/api/users", {
      username: "weak",
      role: "viewer",
      password: "123",
    });
    expect(weak.status).toBe(400);
  });
});

describe("secrets at rest", () => {
  it("keeps console.json free of plaintext secrets and password hashes readable only as scrypt", async () => {
    const raw = await readFile(join(testConsole.dataDir, "console.json"), "utf8");
    expect(raw).not.toContain(mongoPassword);
    expect(raw).not.toContain(PASSPHRASE);
    expect(raw).not.toContain("very-secret-webhook-token");
    expect(raw).not.toContain(AWS_SECRET);
    expect(raw).not.toContain(TEST_PASSWORD);
    expect(raw).toContain("scrypt$");
  });

  it("keeps the audit log free of secrets", async () => {
    const audit = await readFile(join(testConsole.dataDir, "audit.jsonl"), "utf8");
    for (const secret of [
      mongoPassword,
      PASSPHRASE,
      "very-secret-webhook-token",
      AWS_SECRET,
      TEST_PASSWORD,
    ]) {
      expect(audit).not.toContain(secret);
    }
    expect(audit).toContain('"action":"connection.create"');
  });

  it("never sent a secret in any response", () => {
    const everything = testConsole.transcript.join("\n");
    for (const secret of [mongoPassword, PASSPHRASE, "very-secret-webhook-token", AWS_SECRET]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("restart", () => {
  it("refuses a second console on the same data directory", async () => {
    await expect(startConsole({ dataDir: testConsole.dataDir })).rejects.toBeInstanceOf(
      DataDirLockedError,
    );
  });

  it("keeps everything across a restart and refuses a different secret", async () => {
    const before = testConsole.services.store.current;
    await testConsole.close();

    await expect(
      startConsole({
        dataDir: testConsole.dataDir,
        secret: "another-secret-0123456789abcdef0123456789",
      }),
    ).rejects.toBeInstanceOf(StateOpenError);

    testConsole = await startConsole({ dataDir: testConsole.dataDir });
    expect(testConsole.setupToken).toBeUndefined();
    const client = testConsole.client();
    expect((await client.login("admin")).status).toBe(200);
    const connections = (await client.request("GET", "/api/connections")).body;
    expect(connections.map((connection: { name: string }) => connection.name)).toEqual(
      before.connections.map((connection) => connection.name),
    );
    const test = await client.request("POST", `/api/connections/${connections[0].id}/test`);
    expect(test.body.ok).toBe(true);
    expect((await client.request("GET", "/api/plans")).body).toHaveLength(before.plans.length);
  });
});
