// `mongoshield journal` without a database: action and flag errors, and `status` on a
// store without a journal (human, JSON, --max-rpo). The writer itself is tested
// against a real deployment in test/integration/journal-cli.test.ts and
// test/integration/cli-journal.test.ts.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";

function memoryUrl(): string {
  return `memory://journal-${randomBytes(4).toString("hex")}`;
}

describe("mongoshield journal", () => {
  it("asks which action when none is given (exit 2)", async () => {
    const run = await runTestCli(["journal"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Which journal action? Use start or status.");
    expect(run.stderr).toContain("mongoshield journal start");
  });

  it("needs a connection string to start the writer", async () => {
    const run = await runTestCli(["journal", "start", "--to", memoryUrl()]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("No MongoDB connection string was given.");
    expect(run.stderr).toContain("Pass --uri, set MONGOSHIELD_URI");
  });

  it.each([["512"], ["64 parsecs"], ["0"]])("rejects --segment-size %s", async (size) => {
    const run = await runTestCli([
      "journal",
      "start",
      "--to",
      memoryUrl(),
      "--uri",
      "mongodb://127.0.0.1:1",
      "--segment-size",
      size,
    ]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`--segment-size must be a size such as 64MiB (got "${size}")`);
    expect(run.stderr).toContain("at least 1KiB");
  });

  it("rejects --segment-seconds outside 1–86400 and an unknown --on-gap", async () => {
    const seconds = await runTestCli([
      "journal",
      "start",
      "--to",
      memoryUrl(),
      "--uri",
      "mongodb://127.0.0.1:1",
      "--segment-seconds",
      "0",
    ]);
    expect(seconds.code).toBe(2);
    expect(seconds.stderr).toContain("--segment-seconds must be a whole number 1–86400");

    const onGap = await runTestCli(["journal", "start", "--on-gap", "ignore"]);
    expect(onGap.code).toBe(2);
    expect(onGap.stderr).toContain("--on-gap must be one of backup, fail");
  });

  it("says there is no journal yet in an empty store", async () => {
    const url = memoryUrl();
    const run = await runTestCli(["journal", "status", "--from", url]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      `No journal in ${url} yet. Start the writer with: mongoshield journal start`,
    );
  });

  it("prints the empty status as one JSON document, reading --to when --from is absent", async () => {
    const run = await runTestCli(["journal", "status", "--to", memoryUrl(), "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const status = run.json();
    expect(status).toMatchObject({ segments: 0, gaps: [] });
    expect(status.recoveryPoint).toBeUndefined();
  });

  it("fails --max-rpo when nothing was committed yet (exit 1, for monitoring)", async () => {
    const run = await runTestCli(["journal", "status", "--from", memoryUrl(), "--max-rpo", "10m"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("The journal has no committed segment yet.");
  });

  it.each([["10"], ["ten minutes"], ["0s"]])("rejects --max-rpo %s (exit 2)", async (value) => {
    const run = await runTestCli(["journal", "status", "--from", memoryUrl(), "--max-rpo", value]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`--max-rpo must be a duration such as 10m (got "${value}")`);
  });
});
