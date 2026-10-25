// `mongoshield erase` and `mongoshield erasures list` against in-memory storage (no
// database): argument checks, the warnings about what the ledger stores, which secret
// keys the hashes, and the list table. `--now` and `erasures apply` need a database
// and are in test/integration/cli-erasures.test.ts.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { deriveErasureKey } from "../../extras/erasure-match.ts";

const SECRET = "an erasure secret of some length";
const OTHER_SECRET = "another secret, from the config file";

let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-erase-"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const newStore = () => `memory://erase-${randomUUID()}`;

interface RecordJson {
  record: {
    id: string;
    namespace: string;
    requestedBy?: string;
    match: { kind: string; keyed?: boolean; keyId?: string; fields?: { path: string }[] };
  };
  deletedNow?: number;
}

describe("mongoshield erase arguments", () => {
  it.each([
    [["erase", "app.users"], "erase needs a namespace and a filter."],
    [["erase", "app.users", "{}"], "An erasure needs a reason."],
    [["erase", "app.users", "{}", "--reason", "   "], "An erasure needs a reason."],
    [["erase", "app.users", "{email:1}", "--reason", "r"], "The filter is not valid Extended JSON"],
    [["erase", "app.users", "[1]", "--reason", "r"], "The filter must be a JSON object"],
    [["erase", "app.users", '"ada"', "--reason", "r"], "The filter must be a JSON object"],
    [["erase", "app.users", "{}", "--reason", "r"], "An erasure needs a non-empty filter."],
  ])("%j fails with exit code 2 and a hint", async (args, message) => {
    const run = await runTestCli([...args, "--to", newStore()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("hint");
  });
});

describe("mongoshield erase", () => {
  it("records a keyed hash and says where it applies", async () => {
    const store = newStore();
    const run = await runTestCli(
      ["erase", "app.users", '{"email":"ada@example.com"}', "--reason", "GDPR #1", "--to", store],
      { env: { MONGOSHIELD_ERASURE_SECRET: SECRET } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(
      /^✔ Erasure \S+ recorded for app\.users; it applies to every future restore\.\n$/,
    );
    expect(run.stderr).toBe("");
    // The personal data never reaches the output.
    expect(run.stdout + run.stderr).not.toContain("ada@example.com");
  });

  it("warns when a string match is hashed without a secret", async () => {
    const run = await runTestCli([
      "erase",
      "app.users",
      '{"email":"ada@example.com"}',
      "--reason",
      "GDPR #2",
      "--to",
      newStore(),
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("stored hashed but without a secret");
    expect(run.stderr).toContain("MONGOSHIELD_ERASURE_SECRET");
  });

  it("warns that a non-exact filter with strings is stored as written", async () => {
    const run = await runTestCli([
      "erase",
      "app.users",
      '{"email":{"$in":["ada@example.com"]}}',
      "--reason",
      "GDPR #3",
      "--to",
      newStore(),
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("stored as written");
  });

  it("does not warn about a numeric filter, stored as is", async () => {
    const run = await runTestCli([
      "erase",
      "app.users",
      '{"_id": 42}',
      "--reason",
      "account 42",
      "--to",
      newStore(),
      "--json",
    ]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const result = run.json<RecordJson>();
    expect(result.record.match.kind).toBe("filter");
    expect(result.deletedNow).toBeUndefined();
  });

  it("records who asked with --by, and prints the record with --json", async () => {
    const run = await runTestCli(
      [
        "erase",
        "app.*",
        '{"email":"ada@example.com"}',
        "--reason",
        "GDPR #4",
        "--by",
        "dpo@example.com",
        "--to",
        newStore(),
        "--json",
      ],
      { env: { MONGOSHIELD_ERASURE_SECRET: SECRET } },
    );
    expect(run.code, run.stderr).toBe(0);
    const { record } = run.json<RecordJson>();
    expect(record).toMatchObject({
      namespace: "app.*",
      requestedBy: "dpo@example.com",
      match: { kind: "hashed", keyed: true, fields: [{ path: "email" }] },
    });
  });

  it("keys the hash with the environment's secret over the config's, as restores do", async () => {
    const dir = await mkdtemp(join(cwd, "config-"));
    const store = newStore();
    await writeFile(
      join(dir, "mongoshield.config.json"),
      JSON.stringify({ storage: store, erasures: { secret: OTHER_SECRET } }),
    );
    const fromEnv = await runTestCli(
      ["erase", "app.users", '{"email":"a@b.c"}', "--reason", "r", "--json"],
      { cwd: dir, env: { MONGOSHIELD_ERASURE_SECRET: ` ${SECRET} ` } },
    );
    expect(fromEnv.code, fromEnv.stderr).toBe(0);
    expect(fromEnv.json<RecordJson>().record.match.keyId).toBe(deriveErasureKey(SECRET).keyId);

    const fromConfig = await runTestCli(
      ["erase", "app.users", '{"email":"a@b.c"}', "--reason", "r", "--json"],
      { cwd: dir },
    );
    expect(fromConfig.code, fromConfig.stderr).toBe(0);
    expect(fromConfig.json<RecordJson>().record.match.keyId).toBe(
      deriveErasureKey(OTHER_SECRET).keyId,
    );
  });

  it("never prints the secret, even when it is too short to use", async () => {
    const run = await runTestCli(
      ["erase", "app.users", '{"email":"a@b.c"}', "--reason", "r", "--to", newStore()],
      { env: { MONGOSHIELD_ERASURE_SECRET: "short-s3cret" } },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("at least 16 characters");
    expect(run.stderr).not.toContain("short-s3cret");
  });

  it("records the erasure, then explains that --now needs a live database", async () => {
    const store = newStore();
    const run = await runTestCli([
      "erase",
      "app.users",
      '{"_id": 1}',
      "--reason",
      "r",
      "--now",
      "--to",
      store,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--now needs the live database.");
    expect(run.stderr).toContain("The erasure is already recorded.");
    const listed = await runTestCli(["erasures", "list", "--from", store, "--json"]);
    expect(listed.json<unknown[]>()).toHaveLength(1);
  });
});

describe("mongoshield erasures", () => {
  it.each([
    [["erasures"], "Which action? Use list or apply."],
    [["erasures", "purge"], 'Unknown action "purge".'],
  ])("%j is refused with exit code 2", async (args, message) => {
    const run = await runTestCli(args);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("mongoshield erasures list");
  });

  it("says when nothing is recorded", async () => {
    const run = await runTestCli(["erasures", "list", "--from", newStore()]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("No erasures recorded.\n");
  });

  it("lists plain, hashed and keyed erasures in a table, without the values", async () => {
    const store = newStore();
    const erase = (filter: string, env: NodeJS.ProcessEnv = {}) =>
      runTestCli(
        ["erase", "app.users", filter, "--reason", "ticket 9", "--by", "dpo", "--to", store],
        {
          env,
        },
      );
    expect((await erase('{"_id": 7}')).code).toBe(0);
    expect((await erase('{"email":"ada@example.com"}')).code).toBe(0);
    expect(
      (await erase('{"email":"bob@example.com"}', { MONGOSHIELD_ERASURE_SECRET: SECRET })).code,
    ).toBe(0);

    const run = await runTestCli(["erasures", "list", "--from", store], {
      env: { MONGOSHIELD_ERASURE_SECRET: SECRET },
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/RECORDED\s+NAMESPACE\s+MATCH\s+REASON\s+BY/);
    expect(run.stdout).toContain('{"_id":{"$numberInt":"7"}}');
    expect(run.stdout).toMatch(/hashed email\s+ticket 9/);
    expect(run.stdout).toContain("hashed email (keyed)");
    expect(run.stdout).not.toContain("example.com");
    expect(run.stderr).toContain("3 erasures");
  });

  it("filters by --since and rejects a date it cannot read", async () => {
    const store = newStore();
    await runTestCli(["erase", "app.users", '{"_id": 1}', "--reason", "r", "--to", store]);
    const future = await runTestCli([
      "erasures",
      "list",
      "--from",
      store,
      "--since",
      "2999-01-01",
      "--json",
    ]);
    expect(future.code, future.stderr).toBe(0);
    expect(future.json()).toEqual([]);
    const past = await runTestCli([
      "erasures",
      "list",
      "--from",
      store,
      "--since",
      "2000-01-01",
      "--json",
    ]);
    expect(past.json<unknown[]>()).toHaveLength(1);

    const bad = await runTestCli(["erasures", "list", "--from", store, "--since", "yesterday-ish"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--since yesterday-ish is not a date.");
  });

  it("needs a deployment for apply", async () => {
    const run = await runTestCli(["erasures", "apply", "--from", newStore()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No deployment to apply erasures to.");
  });

  it("refuses to apply without confirmation in a non-interactive session (exit code 3)", async () => {
    const run = await runTestCli([
      "erasures",
      "apply",
      "--from",
      newStore(),
      "--uri",
      "mongodb://app:pa55word-here@localhost:1",
    ]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("Refusing to apply erasures without confirmation");
    expect(run.stderr).toContain("--yes");
    expect(run.stdout + run.stderr).not.toContain("pa55word-here");
  });
});
