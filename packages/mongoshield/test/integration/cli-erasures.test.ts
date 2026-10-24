// `mongoshield erase --now` and `mongoshield erasures apply` on the test replica set:
// deleting from the live database, dry runs, confirmations on a terminal, --include,
// --since and --json.

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { KEYS, plain, runTestCli } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();
const database = uniqueDb("cli_erasures");
const SECRET = "a secret for the erasure ledger";
const env = { MONGOSHIELD_ERASURE_SECRET: SECRET };

const users = () => client().db(database).collection<{ _id: number; email: string }>("users");
const logs = () => client().db(database).collection<{ _id: number; email: string }>("logs");

let store: string;

beforeEach(async () => {
  store = `memory://cli-erasures-${randomUUID()}`;
  for (const collection of [users(), logs()]) {
    await collection.deleteMany({});
    await collection.insertMany([
      { _id: 1, email: "ada@example.com" },
      { _id: 2, email: "bob@example.com" },
    ]);
  }
});

afterAll(async () => {
  await client().db(database).dropDatabase();
});

/** Records an erasure of Ada in every collection of the database (not live). */
async function recordAda(): Promise<void> {
  const run = await runTestCli(
    ["erase", `${database}.*`, '{"email":"ada@example.com"}', "--reason", "GDPR #1", "--to", store],
    { env },
  );
  expect(run.code, run.stderr).toBe(0);
}

describe("mongoshield erase --now", () => {
  it("deletes the documents from the live database and reports how many", async () => {
    const run = await runTestCli(
      [
        "erase",
        `${database}.users`,
        '{"email":"ada@example.com"}',
        "--reason",
        "GDPR #2",
        "--now",
        "--uri",
        mongoUri(),
        "--to",
        store,
        "--json",
      ],
      { env },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ deletedNow: 1 });
    expect(run.stderr).toContain("Deleted 1 document from");
    expect(await users().countDocuments()).toBe(1);
    expect(await logs().countDocuments()).toBe(2);
  });
});

describe("mongoshield erasures apply", () => {
  const apply = (...extra: string[]) => [
    "erasures",
    "apply",
    "--from",
    store,
    "--uri",
    mongoUri(),
    "--include",
    `${database}.*`,
    ...extra,
  ];

  it("counts without deleting or asking in a dry run", async () => {
    await recordAda();
    const run = await runTestCli(apply("--dry-run"), { env });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/Would delete 2 documents \(1 erasure, 2 namespaces\)\./);
    expect(await users().countDocuments()).toBe(2);
  });

  it("asks on a terminal, and deletes nothing when told no", async () => {
    await recordAda();
    const run = await runTestCli(apply(), {
      env,
      terminal: [{ when: "Delete every erased document from", keys: KEYS.enter }],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was changed.");
    expect(await users().countDocuments()).toBe(2);
  });

  it("deletes after a yes on a terminal", async () => {
    await recordAda();
    const run = await runTestCli(apply(), {
      env,
      terminal: [{ when: "Delete every erased document from", keys: `y${KEYS.enter}` }],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(plain(run.stdout)).toMatch(/Deleted 2 documents \(1 erasure, 2 namespaces\)\./);
    expect(await users().findOne({ _id: 1 })).toBeNull();
    expect(await logs().findOne({ _id: 1 })).toBeNull();
  });

  it("only applies to the --include namespaces, and prints JSON with --yes", async () => {
    await recordAda();
    const run = await runTestCli(
      [
        "erasures",
        "apply",
        "--from",
        store,
        "--uri",
        mongoUri(),
        "--include",
        `${database}.logs`,
        "--yes",
        "--json",
      ],
      { env },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.json()).toMatchObject({ documentsDeleted: 1, erasures: 1 });
    expect(await users().countDocuments()).toBe(2);
    expect(await logs().countDocuments()).toBe(1);
  });

  it("skips erasures recorded before --since", async () => {
    await recordAda();
    const run = await runTestCli(apply("--yes", "--since", "2999-01-01"), { env });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("Deleted 0 documents (0 erasures");
    expect(await users().countDocuments()).toBe(2);
  });
});
