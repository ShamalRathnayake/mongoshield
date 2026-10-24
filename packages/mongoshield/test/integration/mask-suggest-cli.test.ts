// `mongoshield mask suggest` end to end through the CLI dispatcher, against the shared
// test replica set: the human report, --json, coverage by --mask, every --write case
// (create JSON, create a module, merge JSON, refuse to rewrite a module), the usage
// errors, and the privacy rule: no sampled value and no secret is ever printed.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMaskFile } from "../../src/copy/load-file.ts";
import type { MaskSuggestionReport } from "../../src/mask/suggest/index.ts";
import { runTestCli, type TestCliRun } from "../helpers/cli.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const client = useMongoClient();

const database = uniqueDb("piicli");
const users = `${database}.users`;

/** Values that must never appear in any output. */
const RAW_VALUES = [
  "ada.lovelace@corp.example",
  "+44 20 7946 0001",
  "221 Baker Street",
  "123-45-6789",
];

const MASK_SECRET = "mask-cli-secret-0123456789abcdef";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "mongoshield-mask-cli-"));
  const db = client().db(database);
  await db.collection("users").insertMany(
    Array.from({ length: 30 }, (_unused, index) => ({
      email: index === 0 ? RAW_VALUES[0] : `user${index}@corp.example`,
      phone: index === 0 ? RAW_VALUES[1] : `+44 20 7946 ${String(1000 + index)}`,
      street: index === 0 ? RAW_VALUES[2] : `${index + 1} Baker Street`,
      ssn: index === 0 ? RAW_VALUES[3] : `123-45-${String(1000 + index)}`,
      plan: ["free", "pro"][index % 2],
    })),
  );
  await db.createCollection("empty");
  // More distinct field paths than the profiler keeps (1000).
  await db
    .collection("wide")
    .insertOne(
      Object.fromEntries(Array.from({ length: 1001 }, (_unused, index) => [`f${index}`, index])),
    );
  await db.collection("metrics").insertMany([
    { cpu: 0.5, host: "web-1" },
    { cpu: 0.7, host: "web-2" },
  ]);
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Runs `mongoshield mask …` in the work directory, sampling the seeded database. */
function mask(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<TestCliRun> {
  return runTestCli(["mask", ...args], { cwd: workDir, env: { MONGODB_URI: mongoUri(), ...env } });
}

/** Fails when any raw value (or the secret) shows up in the output. */
function expectNoRawValues(run: TestCliRun): void {
  for (const value of [...RAW_VALUES, MASK_SECRET]) {
    expect(run.stdout).not.toContain(value);
    expect(run.stderr).not.toContain(value);
  }
}

/** A path in the work directory. */
function file(name: string): string {
  return join(workDir, name);
}

describe("mongoshield mask suggest", () => {
  it("prints a table per collection and the rules to paste, and no sampled value", async () => {
    // --verbose too: debug logs must be as free of values as the report.
    const run = await mask(["suggest", "--include", `${database}.*`, "--verbose"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("Sampled a collection for personal data");
    expect(run.stdout).toContain(`${users} (30 documents sampled)`);
    expect(run.stdout).toMatch(/FIELD\s+FOUND\s+CONFIDENCE\s+MATCHED\s+EXAMPLE\s+RULE\s+STATUS/);
    expect(run.stdout).toMatch(/email\s+email\s+1\.00\s+100%\s+\S+\s+\{ fake: "email" \}\s+new/);
    expect(run.stdout).toMatch(/ssn\s+national ID: us-ssn/);
    expect(run.stdout).toContain(
      `${database}.metrics (2 documents sampled): no personal data found`,
    );
    expect(run.stdout).toContain("4 new rules; add to the `rules` of your mask file:");
    expect(run.stdout).toContain(`  "${users}": {`);
    expect(run.stdout).toContain('    email: { fake: "email" }, // email · 100% of 30 values');
    expect(run.stderr).toContain("(read-only)");
    expect(run.stderr).toContain(`${users} (3/4)`);
    expect(run.stdout).toContain(`Skipped: ${database}.empty (empty)`);
    expect(run.stdout).toContain(`${database}.wide (1 document sampled): no personal data found`);
    expect(run.stdout).toContain("(more than 1,000 field paths: the rest were not profiled)");
    expect(run.stderr).toContain("Add --mask ./mask.json --write");
    expectNoRawValues(run);
  });

  it("prints the report as JSON with --json", async () => {
    const run = await mask(["suggest", "--include", users, "--sample", "10", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const report = run.json<MaskSuggestionReport>();
    expect(report.sampleSize).toBe(10);
    expect(report.collections[0]?.documents).toBe(10);
    expect(report.rules[users]).toMatchObject({ email: { fake: "email" }, ssn: "hash" });
    expect(report).not.toHaveProperty("write");
    expectNoRawValues(run);
  });

  it("marks what --mask already covers and keeps the mask secret out of the output", async () => {
    const maskFile = file("covering.ts");
    await writeFile(
      maskFile,
      `export default { secret: ${JSON.stringify(MASK_SECRET)}, rules: { "${users}": { email: { fake: "email" }, ssn: "keep" } } };\n`,
    );
    const run = await mask(["suggest", "--include", users, "--mask", maskFile]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`covered by ${users} → email (fake:email)`);
    expect(run.stdout).toContain(`kept by ${users} → ssn (keep)`);
    expect(run.stdout).toContain("2 new rules");
    expectNoRawValues(run);
  });

  it("says so when everything found is already covered, and when nothing is found", async () => {
    const maskFile = file("everything.json");
    await writeFile(
      maskFile,
      JSON.stringify({
        rules: { [users]: { email: "hash", phone: "hash", street: "hash", ssn: "hash" } },
      }),
    );
    const covered = await mask(["suggest", "--include", users, "--mask", maskFile]);
    expect(covered.stderr).toContain("Every field found already has a rule in the mask file.");
    const nothing = await mask(["suggest", "--include", `${database}.metrics`]);
    expect(nothing.stderr).toContain("No personal data found in the sample.");
  });

  describe("--write", () => {
    it("creates a JSON mask file that copy can load, and leaves it alone the second time", async () => {
      const maskFile = file("new.json");
      const first = await mask(["suggest", "--include", users, "--mask", "new.json", "--write"]);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stderr).toContain(
        `Created ${maskFile} with 4 new rules. Review them before copying.`,
      );
      const loaded = await loadMaskFile(maskFile, workDir);
      expect(loaded.rules[users]).toMatchObject({
        email: { fake: "email" },
        phone: { fake: "phone" },
      });

      const before = await readFile(maskFile, "utf8");
      const second = await mask([
        "suggest",
        "--include",
        users,
        "--mask",
        "new.json",
        "--write",
        "--json",
      ]);
      expect(second.json()).toMatchObject({
        write: { file: maskFile, action: "unchanged", added: 0 },
      });
      expect(await readFile(maskFile, "utf8")).toBe(before);
    });

    it("merges new rules into an existing JSON mask file without touching its rules", async () => {
      const maskFile = file("merge.json");
      await writeFile(
        maskFile,
        JSON.stringify({ onUnsupported: "null", rules: { [users]: { email: "hash" } } }, null, 2),
      );
      const run = await mask(["suggest", "--include", users, "--mask", maskFile, "--write"]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain("Updated");
      expect(run.stderr).toContain("3 new rules");
      const merged = JSON.parse(await readFile(maskFile, "utf8")) as {
        onUnsupported: string;
        rules: Record<string, Record<string, unknown>>;
      };
      expect(merged.onUnsupported).toBe("null");
      expect(merged.rules[users]?.email).toBe("hash");
      expect(merged.rules[users]?.ssn).toBe("hash");
    });

    it("creates a TypeScript mask module", async () => {
      const run = await mask([
        "suggest",
        "--include",
        users,
        "--mask",
        "fresh.ts",
        "--write",
        "--json",
      ]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.json()).toMatchObject({ write: { action: "created", added: 4 } });
      const source = await readFile(file("fresh.ts"), "utf8");
      expect(source).toContain('import { defineMask } from "mongoshield";');
      expect(source).toContain(`    "${users}": {`);
      expect(source).toContain("secret: process.env.MONGOSHIELD_MASK_SECRET");
    });

    it("never rewrites an existing TypeScript mask file: it prints the snippet instead", async () => {
      const maskFile = file("existing.ts");
      const original = `// my mask\nexport default { rules: { "${users}": { email: (value) => value } } };\n`;
      await writeFile(maskFile, original);
      const run = await mask(["suggest", "--include", users, "--mask", maskFile, "--write"]);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain("3 new rules; add to the `rules` of your mask file:");
      expect(run.stderr).toContain(`Did not change ${maskFile}`);
      expect(await readFile(maskFile, "utf8")).toBe(original);
    });

    it("refuses a JSON file it cannot merge into, and writes nothing", async () => {
      const maskFile = file("broken.json");
      await writeFile(maskFile, '{ "rules": [] }');
      // It is read first, to mark covered fields, so the invalid rules stop the run early.
      const run = await mask(["suggest", "--include", users, "--mask", maskFile, "--write"]);
      expect(run.code).toBe(2);
      expect(await readFile(maskFile, "utf8")).toBe('{ "rules": [] }');
    });

    it("needs --mask, and a format it can write", async () => {
      const missing = await mask(["suggest", "--write"]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("--write needs --mask <file>");
      const yaml = await mask(["suggest", "--write", "--mask", "mask.yaml"]);
      expect(yaml.stderr).toContain('--write cannot write a ".yaml" mask file');
      const none = await mask(["suggest", "--write", "--mask", "maskfile"]);
      expect(none.stderr).toContain("(no extension)");
    });
  });

  describe("errors", () => {
    it.each([
      [["suggest", "--sample", "0"], "--sample"],
      [["suggest", "--min-confidence", "1.5"], "--min-confidence must be a number from 0 to 1"],
      [["suggest", "--min-confidence", " "], "--min-confidence must be a number from 0 to 1"],
      [["suggest", "--mask", "nowhere.ts"], "does not exist"],
      [["shuffle"], 'Unknown mask action "shuffle"'],
      [[], "Which mask action? Use suggest."],
    ])("rejects %j", async (args, message) => {
      const run = await mask(args);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(message);
    });

    it("needs a source to sample", async () => {
      const run = await runTestCli(["mask", "suggest"], { cwd: workDir, env: {} });
      expect(run.code).toBe(2);
      expect(run.stderr).toContain("Sample which deployment? No source is configured.");
    });

    it("accepts --from and --min-confidence", async () => {
      const run = await runTestCli(
        [
          "mask",
          "suggest",
          "--from",
          mongoUri(),
          "--include",
          users,
          "--exclude",
          `${database}.metrics`,
          "--min-confidence",
          "0.99",
          "--json",
        ],
        { cwd: workDir, env: {} },
      );
      expect(run.code, run.stderr).toBe(0);
      const report = run.json<MaskSuggestionReport>();
      expect(report.minConfidence).toBe(0.99);
      expect(
        report.collections[0]?.suggestions.every((suggestion) => suggestion.confidence >= 0.99),
      ).toBe(true);
    });
  });
});
