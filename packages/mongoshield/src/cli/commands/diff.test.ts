// `mongoshield diff` between in-memory backups (no database): argument checks, the
// summary table, --details and --json. Comparing with a live deployment is covered by
// test/integration/extras/diff.test.ts.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type FixtureNamespace, writeTestBackup } from "../../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { resolveStorage } from "../../storage/resolve.ts";

/** Two backups in a fresh in-memory store: `older` first, then `newer`. */
async function twoBackups(
  older: readonly FixtureNamespace[],
  newer: readonly FixtureNamespace[],
): Promise<{ url: string; olderId: string; newerId: string }> {
  const url = `memory://diff-${randomUUID()}`;
  const storage = await resolveStorage(url);
  const first = await writeTestBackup(storage, {
    namespaces: older,
    startedAt: new Date("2026-05-01T00:00:00Z"),
  });
  const second = await writeTestBackup(storage, {
    namespaces: newer,
    startedAt: new Date("2026-05-02T00:00:00Z"),
  });
  return { url, olderId: first.id, newerId: second.id };
}

const ID_INDEX = { v: 2, key: { _id: 1 }, name: "_id_" };

describe("mongoshield diff arguments", () => {
  it.each([
    [["diff"], "Pass one or two backups"],
    [["diff", "a", "b", "--live", "mongodb://localhost"], "Pass one or two backups"],
    [["diff", "latest"], "Comparing latest with latest finds nothing"],
    [["diff", "a", "b", "c"], "Unexpected argument: c"],
    [["diff", "a", "--examples", "many"], "--examples must be a whole number ≥ 0"],
  ])("%j is a usage error (exit code 2)", async (args, message) => {
    const run = await runTestCli(args);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("mongoshield diff --help");
  });

  it("reports a missing backup with its own error code and no stack trace", async () => {
    const url = `memory://diff-${randomUUID()}`;
    const run = await runTestCli(["diff", "2026-01-01T00-00-00Z_abcdef", "--from", url]);
    expect(run.code).not.toBe(0);
    expect(run.code).not.toBe(2);
    expect(run.stderr).toContain("✖ MS_");
    expect(run.stderr).not.toContain("    at ");
  });
});

describe("mongoshield diff output", () => {
  it("says there are no differences between identical backups", async () => {
    const same: FixtureNamespace[] = [{ ns: "app.users", documents: [{ _id: 1, name: "Ada" }] }];
    const { url, olderId } = await twoBackups(same, same);
    const run = await runTestCli(["diff", olderId, "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^✔ No differences in 1 namespace \(.+\)\.\n$/);
    expect(run.stderr).toContain(`Comparing backup ${olderId} → backup `);
  });

  it("lists documents, indexes, options, new and gone namespaces, with --details", async () => {
    const { url, olderId, newerId } = await twoBackups(
      [
        {
          ns: "app.users",
          documents: [
            { _id: 1, name: "Ada" },
            { _id: 2, name: "Bob" },
            { _id: 3, name: "Cy" },
            { _id: 4, name: "Di" },
          ],
          indexes: [
            ID_INDEX,
            { v: 2, key: { name: 1 }, name: "by_name" },
            { v: 2, key: { old: 1 }, name: "old_one" },
          ],
          options: { validationLevel: "moderate" },
        },
        { ns: "app.gone", documents: [{ _id: 1 }] },
        { ns: "app.same", documents: [{ _id: 1 }] },
        { ns: "app.shape", documents: [] },
      ],
      [
        {
          ns: "app.users",
          documents: [
            { _id: 1, name: "Ada L." },
            { _id: 2, name: "Bob B." },
            { _id: 5, name: "Eve" },
          ],
          indexes: [
            ID_INDEX,
            { v: 2, key: { name: -1 }, name: "by_name" },
            { v: 2, key: { email: 1 }, name: "by_email", unique: true },
          ],
          options: { validationLevel: "strict" },
        },
        { ns: "app.fresh", documents: [{ _id: 1 }] },
        { ns: "app.same", documents: [{ _id: 1 }] },
        { ns: "app.shape", type: "view", options: { viewOn: "users", pipeline: [] } },
      ],
    );

    const run = await runTestCli([
      "diff",
      olderId,
      newerId,
      "--from",
      url,
      "--details",
      "--examples",
      "1",
    ]);
    expect(run.code, run.stderr).toBe(0);
    const out = run.stdout;
    expect(out).toMatch(/Namespace\s+Documents\s+Added\s+Removed\s+Changed\s+Indexes\s+Options/);
    expect(out).toMatch(/app\.users\s+4 → 3\s+1\s+2\s+2\s+3 changes\s+validationLevel/);
    expect(out).toContain("app.gone (gone)");
    expect(out).toContain("app.fresh (new)");
    expect(out).not.toMatch(/^app\.same/m);

    // Details: one example per category, and how many more there are.
    expect(out).toContain("  added: 5");
    expect(out).toMatch(/ {2}removed: [34], … 1 more/);
    expect(out).toMatch(/ {2}changed: [12], … 1 more/);
    expect(out).toContain("  indexes added: by_email");
    expect(out).toContain("  indexes removed: old_one");
    expect(out).toContain("  indexes changed: by_name");
    expect(out).toContain("  options changed: validationLevel");
    expect(out).toContain("  type: collection → view");
    expect(run.stderr).toMatch(/4 namespaces differ, 1 identical/);
  });

  it("prints one canonical Extended JSON document with --json", async () => {
    const { url, olderId } = await twoBackups(
      [{ ns: "app.users", documents: [{ _id: 1, n: 1 }] }],
      [{ ns: "app.users", documents: [{ _id: 1, n: 2 }] }],
    );
    const run = await runTestCli(["diff", olderId, "--from", url, "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{
      from: { kind: string };
      namespaces: { namespace: string; documents: { changed: { $numberInt: string } | number } }[];
    }>();
    expect(result.from.kind).toBe("backup");
    expect(result.namespaces[0]?.namespace).toBe("app.users");
    expect(run.stderr).toBe("");
  });

  it("compares only the selected namespaces", async () => {
    const { url, olderId } = await twoBackups(
      [
        { ns: "app.users", documents: [{ _id: 1 }] },
        { ns: "app.logs", documents: [{ _id: 1 }] },
      ],
      [
        { ns: "app.users", documents: [{ _id: 1 }] },
        { ns: "app.logs", documents: [{ _id: 2 }] },
      ],
    );
    const run = await runTestCli(["diff", olderId, "--from", url, "--exclude", "app.logs"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("No differences in 1 namespace");
    const included = await runTestCli(["diff", olderId, "--from", url, "--include", "app.logs"]);
    expect(included.stdout).toContain("app.logs");
  });
});
