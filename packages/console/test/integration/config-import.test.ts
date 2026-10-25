/**
 * `POST /api/config/import`: the dry run, applying it, updates with field diffs,
 * secrets only as explicit fields (never inside the document), the settings that
 * are refused rather than silently dropped, and the audit trail.
 *
 * No database is touched: an import only creates records.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigImportResult } from "../../src/shared/api.ts";
import {
  removeDataDir,
  setupAdmin,
  startConsole,
  type TestClient,
  type TestConsole,
  userWithRole,
} from "../helpers/console.ts";

const MONGO_PASSWORD = "Imp0rt-Secret-Pw";
const PASSPHRASE = "import-passphrase-long-enough";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/import-token";

let testConsole: TestConsole;
let admin: TestClient;

beforeEach(async () => {
  testConsole = await startConsole();
  admin = await setupAdmin(testConsole);
});

afterEach(async () => {
  await testConsole.close();
  await removeDataDir(testConsole.dataDir);
});

/** A config as the export's JSON equivalent would look (secrets left out). */
function config(overrides: Record<string, unknown> = {}) {
  return {
    source: { uri: "mongodb://app@db.example.net:27017/?authSource=admin" },
    storage: "memory://imported",
    compression: "zstd",
    backup: { include: ["app.*"], consistency: "auto" },
    retention: { last: 7, daily: 14 },
    schedule: { cron: "15 3 * * *", timezone: "Europe/Berlin", verify: "deep" },
    ...overrides,
  };
}

async function importConfig(body: Record<string, unknown>) {
  return admin.request("POST", "/api/config/import", body);
}

describe("the dry run", () => {
  it("shows what would be created and stores nothing", async () => {
    const response = await importConfig({ document: config(), planName: "nightly", dryRun: true });
    expect(response.status, response.text).toBe(200);
    const result: ConfigImportResult = response.body;
    expect(result.dryRun).toBe(true);
    expect(result.changes.map((change) => [change.kind, change.name, change.action])).toEqual([
      ["connection", "db.example.net:27017", "create"],
      ["storage", "memory://imported", "create"],
      ["plan", "nightly", "create"],
    ]);
    expect(result.changes[0]?.fields).toEqual([
      { field: "uri", to: "mongodb://app:***@db.example.net:27017/?authSource=admin" },
      { field: "production", to: "true" },
    ]);
    expect(result.changes[2]?.fields).toEqual(
      expect.arrayContaining([
        { field: "schedule", to: "15 3 * * * (Europe/Berlin)" },
        { field: "verify", to: "deep" },
        { field: "retention", to: '{"last":7,"daily":14}' },
      ]),
    );
    expect(testConsole.services.store.current.plans).toHaveLength(0);
    expect(testConsole.services.store.current.connections).toHaveLength(0);
  });

  it("maps backup.incremental onto the plan (the library's default interval when empty)", async () => {
    const response = await importConfig({
      document: config({
        backup: { include: ["app.*"], consistency: "auto", incremental: { fullEveryDays: 3 } },
      }),
      planName: "incremental",
      dryRun: false,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.warnings ?? []).not.toContainEqual(expect.stringContaining("incremental"));
    expect(testConsole.services.store.current.plans[0]?.incremental).toEqual({ fullEveryDays: 3 });

    const defaults = await importConfig({
      document: config({ backup: { include: ["app.*"], incremental: {} } }),
      planName: "incremental",
      dryRun: true,
    });
    expect(defaults.body.changes.at(-1)?.fields).toContainEqual({
      field: "incremental",
      from: "full every 3 days, incrementals between",
      to: "full every 7 days, incrementals between",
    });
  });

  it("names the default plan when the document is a single config without a name", async () => {
    const response = await importConfig({ document: config(), dryRun: true });
    expect(response.body.changes.at(-1)).toMatchObject({ kind: "plan", name: "Imported plan" });
  });
});

describe("applying an import", () => {
  it("creates the connection, storage and plan with sealed secrets, schedules it and audits it", async () => {
    const response = await importConfig({
      document: config({ encryption: {}, notify: [{ type: "slack", on: ["failure"] }] }),
      planName: "nightly",
      secrets: {
        nightly: {
          uri: `mongodb://app:${MONGO_PASSWORD}@db.example.net:27017/?authSource=admin`,
          passphrase: PASSPHRASE,
          notifyUrls: [WEBHOOK],
        },
      },
      dryRun: false,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.warnings).toEqual([
      'Plan "nightly": notify[0].on was ignored: the console notifies on success and failure.',
    ]);

    const plans = (await admin.request("GET", "/api/plans")).body;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      name: "nightly",
      include: ["app.*"],
      encryption: { kind: "passphrase", passphrase: { configured: true } },
      schedule: { cron: "15 3 * * *", timezone: "Europe/Berlin" },
      retention: { last: 7, daily: 14 },
      verify: "deep",
      notify: [
        { type: "slack", url: { configured: true, preview: "https://hooks.slack.com/***" } },
      ],
    });
    const connections = (await admin.request("GET", "/api/connections")).body;
    expect(connections).toEqual([
      expect.objectContaining({ name: "db.example.net:27017", production: true }),
    ]);

    // No secret in console.json or in any response.
    const stateFile = await readFile(join(testConsole.dataDir, "console.json"), "utf8");
    for (const secret of [MONGO_PASSWORD, PASSPHRASE, WEBHOOK]) {
      expect(stateFile).not.toContain(secret);
      for (const body of testConsole.transcript) expect(body).not.toContain(secret);
    }

    const audit = (await admin.request("GET", "/api/audit?limit=10")).body as {
      action: string;
      details?: object;
    }[];
    const actions = audit.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "config.import",
        "connection.create",
        "storage.create",
        "plan.create",
      ]),
    );
    expect(audit.find((entry) => entry.action === "plan.create")?.details).toMatchObject({
      via: "import",
    });
    expect(JSON.stringify(audit)).not.toContain(MONGO_PASSWORD);
  });

  it("reports an identical second import as unchanged", async () => {
    const body = { document: config(), planName: "nightly", dryRun: false };
    await importConfig(body);
    const again = await importConfig({ ...body, dryRun: true });
    expect(again.body.changes).toEqual([
      { kind: "plan", name: "nightly", action: "unchanged", fields: [] },
    ]);
  });

  it("updates an existing plan field by field and keeps stored secrets", async () => {
    await importConfig({
      document: config({ encryption: {} }),
      planName: "nightly",
      secrets: { nightly: { passphrase: PASSPHRASE } },
      dryRun: false,
    });
    const before = testConsole.services.store.current.plans[0];
    const response = await importConfig({
      // No source and `encryption: {}`: keep the plan's connection and passphrase.
      document: config({
        source: undefined,
        encryption: {},
        retention: { last: 3 },
        compression: "gzip",
      }),
      planName: "nightly",
      dryRun: false,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.changes).toEqual([
      {
        kind: "plan",
        name: "nightly",
        action: "update",
        fields: [
          { field: "compression", from: "zstd", to: "gzip" },
          { field: "retention", from: '{"last":7,"daily":14}', to: '{"last":3}' },
        ],
      },
    ]);
    const after = testConsole.services.store.current.plans[0];
    expect(after?.id).toBe(before?.id);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.encryption).toEqual(before?.encryption);
  });

  it("names replaced secrets in the diff without showing them", async () => {
    await importConfig({
      document: config({ encryption: {}, notify: [{ type: "webhook" }] }),
      planName: "nightly",
      secrets: { nightly: { passphrase: PASSPHRASE, notifyUrls: [WEBHOOK] } },
      dryRun: false,
    });
    const response = await importConfig({
      document: config({ encryption: {}, notify: [{ type: "webhook" }] }),
      planName: "nightly",
      secrets: { nightly: { passphrase: `${PASSPHRASE}-2`, notifyUrls: [`${WEBHOOK}-2`] } },
      dryRun: true,
    });
    expect(response.body.changes[0].fields).toEqual([
      { field: "encryption.passphrase", from: "set", to: "replaced" },
      { field: "notify[0].url", from: "set", to: "replaced" },
    ]);
  });

  it("imports several plans keyed by name and creates a shared storage location once", async () => {
    const response = await importConfig({
      document: {
        "plan a": config(),
        "plan b": config({
          backup: { include: ["other.*"] },
          encryption: { recipients: ["age1abc"] },
        }),
      },
      dryRun: false,
    });
    expect(response.status, response.text).toBe(200);
    const kinds = response.body.changes.map(
      (change: { kind: string; action: string }) => `${change.kind}:${change.action}`,
    );
    expect(kinds).toEqual(["connection:create", "storage:create", "plan:create", "plan:create"]);
    expect(testConsole.services.store.current.plans.map((plan) => plan.encryption.kind)).toEqual([
      "none",
      "recipients",
    ]);
  });

  it("reuses existing connections (by redacted URI) and storage (by URL) and says so", async () => {
    await admin.request("POST", "/api/connections", {
      name: "prod",
      uri: `mongodb://app:${MONGO_PASSWORD}@db.example.net:27017/?authSource=admin`,
      production: true,
    });
    await admin.request("POST", "/api/storage", { name: "mem", url: "memory://imported" });
    const response = await importConfig({
      document: config(),
      planName: "nightly",
      secrets: {
        nightly: {
          uri: "mongodb://app:other@db.example.net:27017/?authSource=admin",
          storageCredentials: {},
        },
      },
      dryRun: false,
    });
    expect(response.body.changes.map((change: { kind: string }) => change.kind)).toEqual(["plan"]);
    expect(response.body.warnings).toEqual([
      'Plan "nightly" uses the existing connection "prod"; its stored connection string was kept.',
      'Plan "nightly" uses the existing storage "mem"; its stored credentials were kept.',
    ]);
    expect(testConsole.services.store.current.plans[0]?.connectionId).toBe(
      testConsole.services.store.current.connections[0]?.id,
    );
  });

  it("gives new records unique names and stores storage credentials encrypted", async () => {
    await admin.request("POST", "/api/connections", {
      name: "db.example.net:27017",
      uri: "mongodb://someone@db.example.net:27017/",
      production: false,
    });
    const response = await importConfig({
      document: config({ storage: "s3://bucket/prefix" }),
      planName: "nightly",
      secrets: {
        nightly: {
          storageCredentials: {
            AWS_ACCESS_KEY_ID: "AKIA",
            AWS_SECRET_ACCESS_KEY: "s3-secret-value",
          },
        },
      },
      dryRun: false,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.changes[0]).toMatchObject({
      kind: "connection",
      name: "db.example.net:27017 (2)",
    });
    expect(response.body.changes[1]).toMatchObject({
      kind: "storage",
      fields: [
        { field: "url", to: "s3://bucket/prefix" },
        { field: "credentials", to: "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY" },
      ],
    });
    const stateFile = await readFile(join(testConsole.dataDir, "console.json"), "utf8");
    expect(stateFile).not.toContain("s3-secret-value");
  });
});

describe("what an import refuses", () => {
  const refused: [string, Record<string, unknown>, RegExp][] = [
    [
      "a password inside source.uri",
      { document: config({ source: { uri: "mongodb://app:pw@h/" } }) },
      /contains a password/,
    ],
    [
      "a secret URI option",
      {
        document: config({
          source: { uri: "mongodb://h/?authMechanismProperties=AWS_SESSION_TOKEN:x" },
        }),
      },
      /contains a password/,
    ],
    [
      "an inline passphrase",
      { document: config({ encryption: { passphrase: PASSPHRASE } }) },
      /must not be in the document/,
    ],
    [
      "inline notification URLs",
      { document: config({ notify: [{ type: "slack", url: WEBHOOK }] }) },
      /must not be in the document/,
    ],
    [
      "decryption keys",
      { document: config({ decryption: { identities: ["AGE-SECRET-KEY-1X"] } }) },
      /holds secrets/,
    ],
    [
      "KMS encryption",
      { document: config({ encryption: { kms: [{ provider: "aws", key: "k" }] } }) },
      /cannot manage KMS/,
    ],
    [
      "write-once backups",
      { document: config({ backup: { retainDays: 30 } }) },
      /cannot make backups write-once/,
    ],
    [
      "drill verification",
      { document: config({ schedule: { cron: "0 3 * * *", verify: "drill" } }) },
      /"fast" or "deep"/,
    ],
    [
      "unknown settings",
      { document: config({ sorce: {} }) },
      /the config is invalid: Unrecognized key: "sorce"/,
    ],
    [
      "unknown nested settings",
      { document: config({ backup: { includes: ["a.*"] } }) },
      /backup: Unrecognized key: "includes"/,
    ],
    [
      "an invalid cron expression",
      { document: config({ schedule: { cron: "every day" } }) },
      /cron|schedule/i,
    ],
    [
      "a schedule without cron",
      { document: config({ schedule: { timezone: "UTC" } }) },
      /schedule.cron/,
    ],
    [
      "a non-mongodb URI",
      { document: config({ source: { uri: "postgres://h/db" } }) },
      /mongodb:\/\//,
    ],
    [
      "a missing connection string",
      { document: config({ source: undefined }) },
      /needs a connection string/,
    ],
    ["a missing storage", { document: { source: {}, storage: "" } }, /storage/],
    [
      "local storage outside the data directory",
      { document: config({ storage: "/etc" }) },
      /Plan "Imported plan": storage/,
    ],
    [
      "bad storage credentials",
      {
        document: config({ storage: "s3://b/p" }),
        secrets: { "Imported plan": { storageCredentials: { AWS_KEY: "x" } } },
      },
      /not a credential/,
    ],
    [
      "passphrase encryption without a passphrase",
      { document: config({ encryption: {} }) },
      /no passphrase was given/,
    ],
    [
      "a short passphrase",
      {
        document: config({ encryption: {} }),
        secrets: { "Imported plan": { passphrase: "short" } },
      },
      /at least 12/,
    ],
    [
      "a passphrase without an encryption section",
      { document: config(), secrets: { "Imported plan": { passphrase: PASSPHRASE } } },
      /no encryption section/,
    ],
    [
      "a passphrase together with recipients",
      {
        document: config({ encryption: { recipients: ["age1x"] } }),
        secrets: { "Imported plan": { passphrase: PASSPHRASE } },
      },
      /cannot be combined/,
    ],
    [
      "non-age recipients",
      { document: config({ encryption: { recipients: ["ssh-ed25519 AAA"] } }) },
      /age public keys/,
    ],
    [
      "a notify target without URL",
      { document: config({ notify: [{ type: "webhook" }] }) },
      /needs a URL/,
    ],
    [
      "a notify target without type",
      { document: config({ notify: [{}] }) },
      /notify\[0\]\.type: Invalid option/,
    ],
    [
      "too many notify URLs",
      { document: config(), secrets: { "Imported plan": { notifyUrls: [WEBHOOK] } } },
      /more URLs/,
    ],
    [
      "a non-http notify URL",
      {
        document: config({ notify: [{ type: "webhook" }] }),
        secrets: { "Imported plan": { notifyUrls: ["ftp://x"] } },
      },
      /http\(s\)/,
    ],
    [
      "secrets for a plan not in the document",
      { document: config(), secrets: { other: {} } },
      /does not contain/,
    ],
    [
      "misspelt secret fields",
      { document: config(), secrets: { "Imported plan": { password: "x" } } },
      /unknown setting "password"/,
    ],
    [
      "a retention count of zero",
      { document: config({ retention: { last: 0 } }) },
      /retention\.last: Too small/,
    ],
    [
      "a retention count above what the console keeps",
      { document: config({ retention: { daily: 1001 } }) },
      /between 1 and 1000/,
    ],
    [
      "an unknown compression",
      { document: config({ compression: "lz4" }) },
      /compression: Invalid option: expected one of "zstd"\|"gzip"\|"none"/,
    ],
    ["an empty document", { document: {} }, /is empty/],
    ["a document that is not a config", { document: { a: { source: {} } } }, /has no "storage"/],
    ["a document that is a list", { document: [config()] }, /must be a JSON object/],
    [
      "a plan name with control characters",
      { document: config(), planName: "bad\nname" },
      /control characters/,
    ],
  ];

  it.each(refused)("refuses %s", async (_name, body, message) => {
    const response = await importConfig({ dryRun: true, ...body });
    expect(response.status, response.text).toBe(400);
    expect(`${response.body.error.message} ${response.body.error.hint ?? ""}`).toMatch(message);
    // A refusal never echoes a secret back.
    expect(response.text).not.toContain(PASSPHRASE);
    expect(response.text).not.toContain(WEBHOOK);
  });

  it("requires dryRun to be said explicitly", async () => {
    expect((await importConfig({ document: config() })).status).toBe(400);
  });

  it("warns about settings the console does not manage", async () => {
    const response = await importConfig({
      document: config({
        heartbeat: "https://hc-ping.com/abc",
        guard: { maxDocumentDropPercent: 10 },
        backup: { parallelism: 4 },
        retention: { last: 2, hourly: 24, minVerified: 1 },
        schedule: { cron: "0 * * * *", retries: 3, lock: "mongo" },
      }),
      dryRun: true,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.warnings).toEqual([
      'Plan "Imported plan": heartbeat is not managed by the console and was ignored.',
      'Plan "Imported plan": guard is not managed by the console and was ignored.',
      'Plan "Imported plan": backup.parallelism is not managed by the console and was ignored.',
      'Plan "Imported plan": retention.hourly is not managed by the console and was ignored.',
      'Plan "Imported plan": retention.minVerified is not managed by the console and was ignored.',
      'Plan "Imported plan": schedule.lock is not managed by the console and was ignored.',
      'Plan "Imported plan": schedule.retries is not managed by the console and was ignored.',
    ]);
  });

  it("accepts and warns about library settings added after the console's mapping (journal)", async () => {
    // The import validates with the library's own schema, so a setting the CLI
    // accepts is never refused as unknown; the console just does not manage it.
    const response = await importConfig({
      document: config({ journal: { segmentSeconds: 60 } }),
      dryRun: true,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.warnings).toEqual([
      'Plan "Imported plan": journal is not managed by the console and was ignored.',
    ]);
  });

  it("validates notify targets and passphrase encryption with the secrets left out", async () => {
    const response = await importConfig({
      document: config({ encryption: {}, notify: [{ type: "slack", on: ["failure"] }] }),
      secrets: { "Imported plan": { passphrase: PASSPHRASE, notifyUrls: [WEBHOOK] } },
      dryRun: true,
    });
    expect(response.status, response.text).toBe(200);
    expect(response.body.warnings).toEqual([
      'Plan "Imported plan": notify[0].on was ignored: the console notifies on success and failure.',
    ]);
    expect(response.text).not.toContain("secret-given-separately");
  });

  it("is admin-only", async () => {
    const operator = await userWithRole(testConsole, admin, "operator");
    expect(
      (await operator.request("POST", "/api/config/import", { document: config(), dryRun: true }))
        .status,
    ).toBe(403);
  });
});
