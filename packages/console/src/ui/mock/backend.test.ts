/**
 * Tests of the mock server's newer routes (pruning, config import, SSO-only users),
 * called through the real ApiClient. The mock must keep the rules the UI relies on
 * (refusing inline secrets, never pruning more than confirmed), or page tests built on
 * it would prove nothing.
 */

import { describe, expect, it } from "vitest";
import type { ConfigImportRequest } from "../../shared/api.ts";
import { ApiClient, ConflictError, ValidationError } from "../api.ts";
import { createMockBackend, type MockBackendOptions } from "./backend.ts";

/** A client signed in to a fresh mock backend. */
async function signedIn(options: MockBackendOptions = {}, username = "admin", password = "admin") {
  const backend = createMockBackend({ jobTickMs: 0, ...options });
  const client = new ApiClient({ fetch: backend.fetch, openEventSource: backend.openEventSource });
  await client.call("POST /api/session", { username, password });
  return { backend, client };
}

/** Calls the import route and returns the error it threw. */
async function importError(client: ApiClient, request: ConfigImportRequest): Promise<unknown> {
  return client.call("POST /api/config/import", request).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("mock SSO-only users", () => {
  it("creates password-less users only when single sign-on is enabled", async () => {
    const plain = await signedIn();
    await expect(
      plain.client.call("POST /api/users", { username: "jo", role: "viewer" }),
    ).rejects.toBeInstanceOf(ValidationError);

    const sso = await signedIn({ authMethods: ["password", "proxy"] });
    const created = await sso.client.call("POST /api/users", { username: "jo", role: "viewer" });
    expect(created.signIn).toBe("sso");
    // An SSO-only account can never sign in with an (empty) password.
    const anonymous = new ApiClient({ fetch: sso.backend.fetch });
    await expect(
      anonymous.call("POST /api/session", { username: "jo", password: "" }),
    ).rejects.toThrow("Wrong username or password.");
  });

  it("advertises the configured sign-in methods", async () => {
    const { client } = await signedIn({ authMethods: ["password", "oidc"] });
    expect((await client.call("GET /api/session")).authMethods).toEqual(["password", "oidc"]);
  });
});

describe("mock pruning", () => {
  it("refuses plans without retention and empty prunes", async () => {
    const { client } = await signedIn();
    await expect(
      client.call("POST /api/plans/:id/prune/plan", undefined, { params: { id: "plan-local" } }),
    ).rejects.toThrow(/has no retention policy/);
    await expect(
      client.call("POST /api/plans/:id/prune", { remove: [] }, { params: { id: "plan-hourly" } }),
    ).rejects.toThrow("There is nothing to prune.");
  });

  it("refuses a confirmation that does not cover the current plan", async () => {
    const { client } = await signedIn();
    const error = await client
      .call("POST /api/plans/:id/prune", { remove: [] }, { params: { id: "plan-nightly" } })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ConflictError);
  });

  it("needs the admin role", async () => {
    const { client } = await signedIn({}, "maya", "operator");
    await expect(
      client.call("POST /api/plans/:id/prune/plan", undefined, { params: { id: "plan-nightly" } }),
    ).rejects.toThrow(/needs the admin role/);
  });
});

describe("mock config import", () => {
  it("refuses documents that are not config objects", async () => {
    const { client } = await signedIn();
    expect(await importError(client, { document: [], dryRun: true })).toBeInstanceOf(
      ValidationError,
    );
    expect(await importError(client, { document: {}, dryRun: true })).toMatchObject({
      message: "The document contains no config.",
    });
    expect(await importError(client, { document: { a: 1 }, dryRun: true })).toMatchObject({
      message: '"a" must be a config object.',
    });
    expect(
      await importError(client, { document: { a: { storage: "" } }, dryRun: true }),
    ).toMatchObject({ message: '"a": storage must be a storage URL.' });
  });

  it("refuses secrets inside the document", async () => {
    const { client } = await signedIn();
    const passphrase = await importError(client, {
      document: { storage: "/b", encryption: { passphrase: "x" } },
      dryRun: true,
    });
    expect(passphrase).toMatchObject({
      message: '"Imported plan": encryption.passphrase is a secret.',
    });
    const notify = await importError(client, {
      document: { storage: "/b", notify: [{ type: "slack", url: "https://hooks.slack.com/x" }] },
      dryRun: true,
    });
    expect(notify).toMatchObject({ message: '"Imported plan": notify URLs are secrets.' });
  });

  it("needs a connection string for a new plan", async () => {
    const { client } = await signedIn();
    expect(
      await importError(client, { document: { New: { storage: "/b" } }, dryRun: true }),
    ).toMatchObject({ message: expect.stringContaining('"New" needs a connection string') });
  });

  it("reuses matching connections and storage, takes the URI from secrets, and applies", async () => {
    const { client, backend } = await signedIn();
    const request: ConfigImportRequest = {
      document: {
        Fresh: {
          source: {},
          storage: "s3://acme-backups/prod/",
          encryption: { recipients: ["age1example"] },
          compression: "gzip",
          retention: { last: 2, note: "ignored" },
          schedule: { cron: "0 4 * * *", timezone: "Europe/Paris" },
        },
      },
      secrets: { Fresh: { uri: "mongodb+srv://backup:other@prod-cluster.a1b2c.mongodb.net/" } },
      dryRun: true,
    };
    const preview = await client.call("POST /api/config/import", request);
    expect(preview.changes).toEqual([
      { kind: "plan", name: "Fresh", action: "create", fields: [] },
    ]);

    const applied = await client.call("POST /api/config/import", { ...request, dryRun: false });
    expect(applied.dryRun).toBe(false);
    const plan = backend.data.plans.find((candidate) => candidate.name === "Fresh");
    expect(plan).toMatchObject({
      connectionId: "conn-prod",
      storageId: "st-s3",
      compression: "gzip",
      encryption: { kind: "recipients", recipients: ["age1example"] },
      retention: { last: 2 },
      schedule: { cron: "0 4 * * *", timezone: "Europe/Paris" },
    });

    const again = await client.call("POST /api/config/import", request);
    expect(again.changes).toEqual([
      { kind: "plan", name: "Fresh", action: "unchanged", fields: [] },
    ]);
  });

  it("creates a production connection named after the host", async () => {
    const { client, backend } = await signedIn();
    const result = await client.call("POST /api/config/import", {
      document: { source: { uri: "mongodb://reports.example.net/app" }, storage: "/data/r" },
      planName: "  ",
      dryRun: false,
    });
    expect(
      result.changes.map((change) => `${change.kind}:${change.name}:${change.action}`),
    ).toEqual([
      "storage:/data/r:create",
      "connection:reports.example.net:create",
      "plan:Imported plan:create",
    ]);
    expect(
      backend.data.connections.find((connection) => connection.name === "reports.example.net")
        ?.production,
    ).toBe(true);
  });
});
