// `mongoshield keygen` and `mongoshield version`: what reaches stdout and stderr, the
// --json shapes, and the key file rules (relative paths, 0600, never overwrite).

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTestCli } from "../../../test/helpers/cli.ts";
import { identityToRecipient, parseIdentityFile } from "../../crypto/index.ts";
import { version } from "../../version.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-keygen-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("mongoshield keygen", () => {
  it("prints the key file on stdout without --output, with the secret warning on stderr", async () => {
    const run = await runTestCli(["keygen"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^# created: \d{4}-/);
    expect(lines[1]).toMatch(/^# public key: age1/);
    const [identity] = parseIdentityFile(run.stdout);
    expect(lines[1]).toBe(`# public key: ${identityToRecipient(identity ?? "")}`);
    expect(run.stderr).toContain("The AGE-SECRET-KEY line is a secret");
    expect(run.stderr).not.toContain("AGE-SECRET-KEY-1");
  });

  it("still warns with --quiet: the warning is about a secret on the screen", async () => {
    const run = await runTestCli(["keygen", "--quiet"], { cwd });
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("is a secret");
  });

  it("resolves a relative --output against the working directory and prints only the public key", async () => {
    const run = await runTestCli(["keygen", "-o", "keys.txt"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const path = join(cwd, "keys.txt");
    const [identity] = parseIdentityFile(await readFile(path, "utf8"));
    expect(run.stdout).toBe(`${identityToRecipient(identity ?? "")}\n`);
    expect(run.stderr).toContain(`Wrote the secret identity to ${path}`);
    expect(run.stderr).toContain("Keep an offline copy");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("prints the recipient and the file path as one JSON document with --json --output", async () => {
    const run = await runTestCli(["keygen", "--output", "k.key", "--json"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<{ recipient: string; identityFile: string }>();
    expect(Object.keys(result).sort()).toEqual(["identityFile", "recipient"]);
    expect(result.identityFile).toBe(join(cwd, "k.key"));
    const [identity] = parseIdentityFile(await readFile(result.identityFile, "utf8"));
    expect(result.recipient).toBe(identityToRecipient(identity ?? ""));
    expect(run.stderr).toBe("");
  });

  it("explains a directory that does not exist (exit 2, hint, docs link)", async () => {
    const path = join(cwd, "missing", "k.key");
    const run = await runTestCli(["keygen", "--output", path], { cwd });
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`Could not write the identity file ${path}`);
    expect(run.stderr).toContain("Check that the directory exists and is writable.");
    expect(run.stderr).toContain("docs");
  });

  it("reports the error as JSON with --json", async () => {
    const run = await runTestCli(["keygen", "--output", join(cwd, "no", "k.key"), "--json"], {
      cwd,
    });
    expect(run.code).toBe(2);
    expect(run.json()).toMatchObject({
      error: { code: "MS_CONFIG_INVALID", exitCode: 2, docsUrl: expect.stringContaining("http") },
    });
  });

  it("rejects an --output without a value", async () => {
    const run = await runTestCli(["keygen", "--output"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("mongoshield keygen --help");
  });
});

describe("mongoshield version", () => {
  it("prints the version", async () => {
    const run = await runTestCli(["version"]);
    expect(run).toMatchObject({ code: 0, stdout: `mongoshield ${version}\n`, stderr: "" });
  });

  it("prints the version and the Node.js version as JSON, also through --version", async () => {
    for (const args of [
      ["version", "--json"],
      ["--version", "--json"],
      ["-V", "--json"],
    ]) {
      const run = await runTestCli(args);
      expect(run.code).toBe(0);
      expect(run.json()).toEqual({ version, node: process.versions.node });
    }
  });

  it("takes no arguments", async () => {
    const run = await runTestCli(["version", "extra"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Unexpected argument: extra");
  });
});
