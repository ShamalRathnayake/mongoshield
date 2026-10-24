// `mongoshield snapshot` and `mongoshield rollback`: the checks that happen before
// connecting to a database (exit code 2, a hint, no secrets). The database paths are in
// test/integration/cli-snapshot.test.ts.

import { describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";

/** A URI that is never connected to: these runs fail before connecting. */
const URI = "mongodb://admin:s3cret-pass@127.0.0.1:1/?serverSelectionTimeoutMS=200";

describe("mongoshield snapshot arguments", () => {
  it.each([
    [["snapshot"], "A snapshot needs a label."],
    [["snapshot", "v1", "--label", "nokey"], '--label expects key=value (got "nokey")'],
    [["snapshot", "v1", "--label", "a=1", "--label", "a=2"], '--label gives "a" twice.'],
    [["snapshot", "v1", "--retain-days", "0"], "--retain-days must be a whole number 1–36500"],
  ])("%j fails with exit code 2", async (args, message) => {
    const run = await runTestCli([...args, "--uri", URI, "--to", "memory://snapshot-args"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("hint");
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("s3cret-pass");
  });
});

describe("mongoshield rollback arguments", () => {
  it.each([
    [["rollback"], "Name the snapshot: a label or --id."],
    [
      ["rollback", "v1", "--id", "2026-01-01T00-00-00Z_abcdef"],
      "Name the snapshot: a label or --id.",
    ],
    [
      ["rollback", "v1", "--mode", "merge"],
      "--mode must be one of drop, upsert, insert, fail-if-exists",
    ],
  ])("%j fails with exit code 2", async (args, message) => {
    const run = await runTestCli([...args, "--from", "memory://rollback-args"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it("needs a database to roll back", async () => {
    const run = await runTestCli(["rollback", "v1", "--from", "memory://rollback-args"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No database to roll back is configured.");
    expect(run.stderr).toContain("--uri");
  });

  it("needs the variable named by --passphrase-env", async () => {
    const run = await runTestCli([
      "rollback",
      "v1",
      "--uri",
      URI,
      "--from",
      "memory://rollback-args",
      "--passphrase-env",
      "MS_ROLLBACK_PASSPHRASE",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("MS_ROLLBACK_PASSPHRASE");
    expect(run.stderr).not.toContain("s3cret-pass");
  });

  it("explains an unreadable identity file without printing the URI password", async () => {
    const run = await runTestCli([
      "rollback",
      "v1",
      "--uri",
      URI,
      "--from",
      "memory://rollback-args",
      "--identity-file",
      "/nonexistent/key.txt",
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Cannot read the identity file /nonexistent/key.txt");
    expect(run.stderr).not.toContain("s3cret-pass");
  });
});
