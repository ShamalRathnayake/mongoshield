/**
 * Error paths of the console API that the workflow tests do not reach:
 * unexpected errors (generic body, details only in the server log), scrubbing
 * of stored secrets from error messages, and the validation, not-found and
 * conflict answers of the storage, user, connection and job routes.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, Logger } from "mongoshield";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConsoleApp } from "../../src/server/app.ts";
import type { ConsoleServices } from "../../src/server/context.ts";
import { closeConsole, openConsole } from "../../src/server/services.ts";
import {
  mongoUri,
  removeDataDir,
  TEST_PASSWORD,
  TEST_PASSWORD_COST,
  TEST_SECRET,
  TestClient,
  uriWithPassword,
} from "../helpers/console.ts";

/** Server log lines written while handling requests. */
const logged: { message: string; fields: LogFields | undefined }[] = [];
const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (message, fields) => logged.push({ message, fields }),
};

let dataDir: string;
let services: ConsoleServices;
let admin: TestClient;
const transcript: string[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ms-console-errors-"));
  const opened = await openConsole({
    dataDir,
    secret: TEST_SECRET,
    passwordCost: TEST_PASSWORD_COST,
    logger,
    settings: { cookieSecure: false },
  });
  services = opened.services;
  const app = createConsoleApp(services, { heartbeatMs: 20 });
  admin = new TestClient(app, transcript);
  const setup = await admin.request("POST", "/api/setup", {
    token: opened.setupToken,
    username: "admin",
    password: TEST_PASSWORD,
  });
  if (setup.status !== 200) throw new Error(setup.text);
});

afterAll(async () => {
  await closeConsole(services, 5_000);
  await removeDataDir(dataDir);
});

/** Creates a storage location and returns its id. */
async function createStorage(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await admin.request("POST", "/api/storage", {
    name,
    url: `memory://${name}-${Date.now()}`,
    ...extra,
  });
  if (response.status !== 200) throw new Error(response.text);
  return response.body.id;
}

describe("unexpected errors", () => {
  it("answers with a generic CONSOLE_INTERNAL body and logs the details server side", async () => {
    const id = await createStorage("broken-credentials");
    // A hand-damaged state file: the sealed credentials no longer decrypt.
    await services.store.update((state) => {
      state.storage = state.storage.map((record) =>
        record.id === id
          ? { ...record, credentials: "garbage", updatedAt: new Date().toISOString() }
          : record,
      );
    });
    const response = await admin.request("GET", `/api/storage/${id}/backups`);
    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "CONSOLE_INTERNAL",
      message: "An unexpected error occurred. The server log has the details.",
    });
    const entry = logged.find((line) => line.message.startsWith("Unexpected error"));
    expect(entry?.fields).toMatchObject({
      method: "GET",
      path: `/api/storage/${id}/backups`,
      error: expect.stringContaining("Not an encrypted console secret"),
    });
    await admin.request("DELETE", `/api/storage/${id}`);
  });
});

describe("secret scrubbing", () => {
  it("replaces stored passwords and passphrases in error messages with ***", async () => {
    const { uri, password } = await uriWithPassword();
    const connection = await admin.request("POST", "/api/connections", {
      name: "scrub-source",
      uri,
      production: false,
    });
    const storageId = await createStorage("scrub-store");
    const passphrase = "scrub-passphrase-0123456789";
    const plan = await admin.request("POST", "/api/plans", {
      name: "scrub-plan",
      connectionId: connection.body.id,
      storageId,
      include: [],
      exclude: [],
      compression: "none",
      encryption: { kind: "passphrase", passphrase },
      consistency: "auto",
      verify: "none",
      notify: [],
    });
    expect(plan.status).toBe(200);
    // A stored connection whose URI no longer decrypts is skipped, not fatal.
    await services.store.update((state) => {
      state.connections = [
        ...state.connections,
        {
          id: "unreadable",
          name: "unreadable",
          uri: "garbage",
          uriPreview: "mongodb://x",
          production: false,
          createdAt: new Date().toISOString(),
        },
      ];
    });

    // Conflict messages quote the name, so names equal to secrets must come back scrubbed.
    for (const secret of [password, passphrase]) {
      await createStorage(secret);
      const duplicate = await admin.request("POST", "/api/storage", {
        name: secret,
        url: "memory://duplicate",
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.message).toBe('A storage location named "***" already exists.');
    }
  });

  it("never sent a stored secret inside an error body", () => {
    const errors = transcript.filter((text) => text.includes('"error"'));
    expect(errors.some((text) => text.includes("scrub-passphrase-0123456789"))).toBe(false);
  });
});

describe("storage routes", () => {
  it("validates, updates and keeps credentials, and refuses conflicts", async () => {
    const created = await admin.request("POST", "/api/storage", {
      name: "s3-store",
      url: "s3://bucket/prefix",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret-key" },
    });
    expect(created.status).toBe(200);
    const id = created.body.id;

    const kept = await admin.request("PUT", `/api/storage/${id}`, {
      name: "s3-renamed",
      url: "s3://bucket/other",
    });
    expect(kept.status).toBe(200);
    expect(kept.body.credentials).toEqual({
      configured: true,
      preview: "AWS_ACCESS_KEY_ID=***, AWS_SECRET_ACCESS_KEY=***",
    });

    const cleared = await admin.request("PUT", `/api/storage/${id}`, {
      name: "s3-renamed",
      url: "s3://bucket/other",
      credentials: {},
    });
    expect(cleared.body.credentials.configured).toBe(false);

    // The kept credential names are checked against the new URL's scheme.
    const relabel = await admin.request("PUT", `/api/storage/${id}`, {
      name: "s3-renamed",
      url: "s3://bucket/other",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA" },
    });
    expect(relabel.status).toBe(200);
    const wrongScheme = await admin.request("PUT", `/api/storage/${id}`, {
      name: "s3-renamed",
      url: "memory://now-memory",
    });
    expect(wrongScheme.status).toBe(400);
    expect(wrongScheme.body.error.code).toBe("MS_CONFIG_INVALID");

    await createStorage("taken-name");
    const conflict = await admin.request("PUT", `/api/storage/${id}`, {
      name: "taken-name",
      url: "s3://bucket/other",
    });
    expect(conflict.status).toBe(409);

    const missing = await admin.request("PUT", "/api/storage/missing", {
      name: "x",
      url: "memory://x",
    });
    expect(missing.status).toBe(404);
    expect((await admin.request("DELETE", "/api/storage/missing")).status).toBe(404);
    expect((await admin.request("POST", "/api/storage/missing/test")).status).toBe(404);
  });

  it("reports a storage probe that cannot reach its location without failing the request", async () => {
    const created = await admin.request("POST", "/api/storage", {
      name: "unreachable",
      url: "s3://bucket/prefix?region=us-east-1&endpoint=http://127.0.0.1:9&forcePathStyle=true",
      credentials: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret-key" },
    });
    const probe = await admin.request("POST", `/api/storage/${created.body.id}/test`);
    expect(probe.status).toBe(200);
    expect(probe.body.ok).toBe(false);
    expect(probe.body.error.code).toEqual(expect.any(String));
    expect(probe.text).not.toContain("secret-key");
  }, 120_000);
});

describe("user routes", () => {
  it("refuses unknown users, taken names, deleting yourself and demoting the last admin", async () => {
    const self = (await admin.session()).user;
    expect(self?.role).toBe("admin");
    const created = await admin.request("POST", "/api/users", {
      username: "eve",
      role: "viewer",
      password: TEST_PASSWORD,
    });
    expect(created.status).toBe(200);

    expect(
      (
        await admin.request("PUT", "/api/users/missing", {
          username: "x",
          role: "viewer",
        })
      ).status,
    ).toBe(404);
    expect((await admin.request("DELETE", "/api/users/missing")).status).toBe(404);

    const taken = await admin.request("PUT", `/api/users/${created.body.id}`, {
      username: "admin",
      role: "viewer",
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("CONSOLE_CONFLICT");

    const ownDelete = await admin.request("DELETE", `/api/users/${self?.id}`);
    expect(ownDelete.status).toBe(400);

    const demote = await admin.request("PUT", `/api/users/${self?.id}`, {
      username: "admin",
      role: "operator",
    });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("CONSOLE_LAST_ADMIN");

    // With a second admin, the first may be demoted and the second deleted again.
    const promoted = await admin.request("PUT", `/api/users/${created.body.id}`, {
      username: "eve",
      role: "admin",
    });
    expect(promoted.body.role).toBe("admin");
    const removed = await admin.request("DELETE", `/api/users/${created.body.id}`);
    expect(removed.status).toBe(200);
  });

  it("refuses a weak new password on update", async () => {
    const self = (await admin.session()).user;
    const weak = await admin.request("PUT", `/api/users/${self?.id}`, {
      username: "admin",
      role: "admin",
      password: "short",
    });
    expect(weak.status).toBe(400);
  });
});

describe("connection routes", () => {
  it("answers unknown connections with 404 and duplicate names with 409", async () => {
    const created = await admin.request("POST", "/api/connections", {
      name: "dup-source",
      uri: mongoUri(),
      production: false,
    });
    expect(created.status).toBe(200);
    const duplicate = await admin.request("PUT", `/api/connections/${created.body.id}`, {
      name: "scrub-source",
      production: false,
    });
    expect(duplicate.status).toBe(409);
    const missingUri = await admin.request("POST", "/api/connections", {
      name: "no-uri",
      production: false,
    });
    expect(missingUri.status).toBe(400);
    expect(
      (
        await admin.request("PUT", "/api/connections/missing", {
          name: "x",
          production: false,
        })
      ).status,
    ).toBe(404);
    expect((await admin.request("DELETE", "/api/connections/missing")).status).toBe(404);
    expect((await admin.request("GET", "/api/connections/missing/namespaces")).status).toBe(404);
    expect((await admin.request("DELETE", `/api/connections/${created.body.id}`)).status).toBe(200);
  });

  it("describes an unreachable deployment when listing namespaces, without its password", async () => {
    const created = await admin.request("POST", "/api/connections", {
      name: "unreachable-db",
      uri: "mongodb://app:Unreachable-Pw-123@127.0.0.1:9/?serverSelectionTimeoutMS=300",
      production: false,
    });
    const response = await admin.request("GET", `/api/connections/${created.body.id}/namespaces`);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("MS_CONNECTION_FAILED");
    expect(response.text).not.toContain("Unreachable-Pw-123");
  });
});

describe("job routes", () => {
  it("validates the list limit and answers unknown jobs with 404", async () => {
    expect((await admin.request("GET", "/api/jobs?limit=0")).status).toBe(400);
    expect((await admin.request("GET", "/api/jobs?limit=1")).status).toBe(200);
    expect((await admin.request("POST", "/api/jobs/missing/cancel")).status).toBe(404);
    expect((await admin.request("GET", "/api/jobs/missing/events")).status).toBe(404);
  });

  it("streams heartbeats while a job runs and stops when the client goes away", async () => {
    let release: () => void = () => {};
    const job = await services.runner.start({
      kind: "verify",
      lane: "storage:sse",
      startedBy: "admin",
      run: () =>
        new Promise((resolve) => {
          release = () => resolve({ summary: "ok" });
        }),
    });
    const controller = new AbortController();
    // Read the raw stream to see the heartbeat comments, then hang up.
    const app = createConsoleApp(services, { heartbeatMs: 10 });
    const login = await new TestClient(app, []).login("admin");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const response = await app.request(`/api/jobs/${job.id}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    let text = "";
    const decoder = new TextDecoder();
    while (reader !== undefined && !text.includes(": heartbeat")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('"type":"status"');
    expect(text).toContain(": heartbeat");
    await reader?.cancel();
    controller.abort();
    release();
    expect((await services.runner.finished(job.id))?.status).toBe("succeeded");
  });
});
