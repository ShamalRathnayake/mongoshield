// `mongoshield restore-tenant`: the checks that happen before connecting (exit code 2,
// a hint, no secrets). Restoring is in test/integration/cli-restore-tenant.test.ts and
// test/integration/extras/tenant-restore.test.ts.

import { describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";

const URI = "mongodb://admin:t3nant-pass@127.0.0.1:1/?serverSelectionTimeoutMS=200";
const FROM = ["--from", "memory://restore-tenant-args"];

describe("mongoshield restore-tenant arguments", () => {
  it.each([
    [["restore-tenant", "a", "b"], "Unexpected argument: b"],
    [["restore-tenant"], "Which tenant? Pass --filter"],
    [["restore-tenant", "--filter", "{tenant:1}"], "The filter is not valid Extended JSON"],
    [["restore-tenant", "--filter", '["acme"]'], "The filter must be a JSON object."],
    [
      ["restore-tenant", "--filter-for", "app.users"],
      '--filter-for expects key=value (got "app.users")',
    ],
    [
      ["restore-tenant", "--filter-for", "app.users=nope"],
      "The filter for app.users is not valid Extended JSON",
    ],
    [
      ["restore-tenant", "--filter", '{"t":1}', "--rename", "app.*"],
      '--rename expects key=value (got "app.*")',
    ],
    [["restore-tenant", "--filter", '{"t":1}', "--mode", "drop"], "--mode must be one of"],
  ])("%j fails with exit code 2", async (args, message) => {
    const run = await runTestCli([...args, ...FROM, "--to-uri", URI]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain("hint");
    expect(run.stderr).not.toContain("t3nant-pass");
  });

  it("needs a restore target", async () => {
    const run = await runTestCli(["restore-tenant", "--filter", '{"tenantId":"acme"}', ...FROM]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No restore target is configured.");
    expect(run.stderr).toContain("--to-uri");
  });

  it("prints the error as the one JSON document with --json", async () => {
    const run = await runTestCli(["restore-tenant", ...FROM, "--json"]);
    expect(run.code).toBe(2);
    expect(run.json()).toMatchObject({
      error: { code: "MS_CONFIG_INVALID", exitCode: 2, docsUrl: expect.stringContaining("http") },
    });
    expect(run.stderr).toBe("");
  });
});
