/**
 * Plan routes: validation of every plan field, kept secrets on update, name
 * conflicts and unknown ids. No database is touched (creating a plan only checks
 * that its connection and storage exist).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
} from "../helpers/console.ts";

let testConsole: TestConsole;
let admin: TestClient;
const ids = { connection: "", storage: "" };

/** A valid plan body; `overrides` replace fields. */
function plan(overrides: Record<string, unknown> = {}) {
  return {
    name: "nightly",
    connectionId: ids.connection,
    storageId: ids.storage,
    include: [],
    exclude: [],
    compression: "zstd",
    encryption: { kind: "none" },
    consistency: "auto",
    verify: "fast",
    notify: [],
    ...overrides,
  };
}

beforeAll(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
  ids.connection = (
    await admin.request("POST", "/api/connections", {
      name: "db",
      uri: "mongodb://db.example.net:27017/",
      production: false,
    })
  ).body.id;
  ids.storage = (
    await admin.request("POST", "/api/storage", { name: "mem", url: "memory://plans" })
  ).body.id;
});

afterAll(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

describe("plan validation", () => {
  it.each([
    [
      "recipients that are not age keys",
      { encryption: { kind: "recipients", recipients: ["ssh-rsa AAA"] } },
      /age public keys/,
    ],
    ["no recipients", { encryption: { kind: "recipients", recipients: [] } }, /age public keys/],
    ["a missing passphrase", { encryption: { kind: "passphrase" } }, /passphrase" is required/],
    [
      "a short passphrase",
      { encryption: { kind: "passphrase", passphrase: "short" } },
      /at least 12/,
    ],
    ["notify that is not a list", { notify: "https://x" }, /list of at most 10/],
    ["a notify target without URL", { notify: [{ type: "slack" }] }, /url" is required/],
    ["a non-http notify URL", { notify: [{ type: "slack", url: "ftp://x" }] }, /http\(s\) URL/],
    ["an empty retention policy", { retention: { last: 0 } }, /at least one positive count/],
    ["an invalid schedule", { schedule: { cron: "never" } }, /cron|schedule/i],
    ["an unknown connection", { connectionId: "missing" }, /connection was not found/],
  ])("refuses %s", async (_name, overrides, message) => {
    const response = await admin.request("POST", "/api/plans", plan(overrides));
    expect([400, 404], response.text).toContain(response.status);
    expect(response.body.error.message).toMatch(message);
  });

  it("defaults the schedule's time zone to UTC", async () => {
    const response = await admin.request(
      "POST",
      "/api/plans",
      plan({ name: "scheduled", schedule: { cron: "0 3 * * *", timezone: " " } }),
    );
    expect(response.status, response.text).toBe(200);
    expect(response.body.schedule).toEqual({ cron: "0 3 * * *", timezone: "UTC" });
  });
});

describe("updating and deleting plans", () => {
  it("keeps the stored passphrase and notification URLs when they are left out", async () => {
    const created = await admin.request(
      "POST",
      "/api/plans",
      plan({
        name: "secretive",
        encryption: { kind: "passphrase", passphrase: "a-long-enough-passphrase" },
        notify: [{ type: "slack", url: "https://hooks.slack.com/services/T/B/token" }],
      }),
    );
    expect(created.status, created.text).toBe(200);
    const before = testConsole.services.store.current.plans.find(
      (record) => record.id === created.body.id,
    );
    const updated = await admin.request(
      "PUT",
      `/api/plans/${created.body.id}`,
      plan({
        name: "secretive",
        encryption: { kind: "passphrase" },
        notify: [{ type: "discord" }],
      }),
    );
    expect(updated.status, updated.text).toBe(200);
    const after = testConsole.services.store.current.plans.find(
      (record) => record.id === created.body.id,
    );
    expect(after?.encryption).toEqual(before?.encryption);
    expect(after?.notify[0]?.url).toBe(before?.notify[0]?.url);
    expect(after?.notify[0]?.type).toBe("discord");
    // A new target needs its URL.
    const extra = await admin.request(
      "PUT",
      `/api/plans/${created.body.id}`,
      plan({
        name: "secretive",
        encryption: { kind: "passphrase" },
        notify: [{ type: "slack" }, { type: "webhook" }],
      }),
    );
    expect(extra.status).toBe(400);
  });

  it("refuses duplicate names, and unknown ids on update and delete", async () => {
    await admin.request("POST", "/api/plans", plan({ name: "unique" }));
    const duplicate = await admin.request("POST", "/api/plans", plan({ name: "unique" }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONSOLE_CONFLICT");
    expect((await admin.request("PUT", "/api/plans/missing", plan({ name: "x" }))).status).toBe(
      404,
    );
    expect((await admin.request("DELETE", "/api/plans/missing")).status).toBe(404);
  });

  it("deletes a plan and audits it", async () => {
    const created = await admin.request("POST", "/api/plans", plan({ name: "short-lived" }));
    expect((await admin.request("DELETE", `/api/plans/${created.body.id}`)).status).toBe(200);
    expect(
      testConsole.services.store.current.plans.some((record) => record.id === created.body.id),
    ).toBe(false);
    const audit = (await admin.request("GET", "/api/audit?limit=1")).body;
    expect(audit[0]).toMatchObject({ action: "plan.delete", target: "short-lived" });
  });
});
