// `runCli` as a user meets it: finding the command, strict flag parsing with "did you
// mean" suggestions, help pages, --json/--quiet/--verbose/--no-color, and error output.
// Everything here runs without a database: `list` over memory:// storage and `version`
// are enough to exercise the shared machinery.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../test/helpers/backup-fixtures.ts";
import { plain, runTestCli } from "../../test/helpers/cli.ts";
import { resolveStorage } from "../storage/resolve.ts";
import { version } from "../version.ts";
import { COMMANDS } from "./commands/index.ts";

/** A fresh, empty in-memory storage URL (memory://name is shared process-wide). */
function memoryUrl(): string {
  return `memory://cli-run-${randomBytes(4).toString("hex")}`;
}

/** ANSI escape introducer: present only when colors are on. */
const ESC = "\u001b[";

let cwd: string;

beforeAll(async () => {
  // An empty directory: no config file is found, so only flags and env apply.
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-run-"));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("finding the command", () => {
  it.each([[[]], [["--help"]], [["-h"]], [["help"]]])(
    "%j prints the overview with every command",
    async (args) => {
      const run = await runTestCli(args, { cwd });
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      for (const command of COMMANDS) expect(run.stdout).toContain(command.name);
      expect(run.stdout).toContain("Global options");
      expect(run.stdout).toContain(`v${version}`);
    },
  );

  it("`help <command>` and `<command> --help` print the same page", async () => {
    const viaHelp = await runTestCli(["help", "list"], { cwd });
    const viaFlag = await runTestCli(["list", "--help"], { cwd });
    expect(viaHelp.code).toBe(0);
    expect(viaHelp.stdout).toBe(viaFlag.stdout);
    expect(viaHelp.stdout).toContain("mongoshield list");
  });

  it("`help <unknown>` is a usage error with a suggestion", async () => {
    const run = await runTestCli(["help", "lsit"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Unknown command "lsit". Did you mean `mongoshield list`?');
  });

  it("suggests the closest command for a typo, and nothing for gibberish", async () => {
    const typo = await runTestCli(["restroe"], { cwd });
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain("Did you mean `mongoshield restore`?");

    const gibberish = await runTestCli(["qqqqqqqqqq"], { cwd });
    expect(gibberish.code).toBe(2);
    expect(gibberish.stderr).toContain('Unknown command "qqqqqqqqqq".');
    expect(gibberish.stderr).not.toContain("Did you mean");
  });

  it.each([[["--version"]], [["-V"]], [["version"]]])("%j prints the version", async (args) => {
    const run = await runTestCli(args, { cwd });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`mongoshield ${version}\n`);
  });

  it("--version keeps --json", async () => {
    const run = await runTestCli(["--json", "--version"], { cwd });
    expect(run.code).toBe(0);
    expect(run.json()).toEqual({ version, node: process.versions.node });
  });

  it("only global flags, without a command, is a usage error", async () => {
    for (const args of [["--quiet"], ["-q"], ["--config=x.ts"], ["--no-color", "--verbose"]]) {
      const run = await runTestCli(args, { cwd });
      expect(run.code, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("No command given.");
    }
  });

  it("an unknown option without a command says which one", async () => {
    const run = await runTestCli(["--frobnicate"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Unexpected option --frobnicate without a command.");
    expect(run.stderr).toContain("mongoshield --help");
  });

  it("everything after `--` is an argument, never a command or flag", async () => {
    const noCommand = await runTestCli(["--", "list"], { cwd });
    expect(noCommand.code).toBe(2);

    const extra = await runTestCli(["list", "--from", memoryUrl(), "--", "--json"], { cwd });
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("Unexpected argument: --json");
    // --json after `--` is data, so the error is printed for humans, not as JSON.
    expect(extra.stdout).toBe("");
  });

  it("global flags may come before the command, including --config with a separate value", async () => {
    const configPath = join(cwd, "custom.config.mjs");
    const storage = memoryUrl();
    await writeFile(configPath, `export default { storage: ${JSON.stringify(storage)} };\n`);
    for (const args of [
      ["--json", "--config", configPath, "list"],
      ["-c", configPath, "--json", "list"],
      [`--config=${configPath}`, "list", "--json"],
    ]) {
      const run = await runTestCli(args, { cwd });
      expect(run.code, `${args.join(" ")}\n${run.stdout}${run.stderr}`).toBe(0);
      expect(run.json<unknown[]>()).toEqual([]);
    }
  });
});

describe("strict flag parsing (exit code 2)", () => {
  it("suggests the intended flag for a typo", async () => {
    const run = await runTestCli(["list", "--form", "./backups"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Unknown option --form. Did you mean --from?");
    expect(run.stderr).toContain("mongoshield list --help");
    expect(run.stderr).toMatch(/docs {2}https:\/\/\S+#ms_config_invalid/);
  });

  it("has no suggestion for an option nothing resembles, also for short flags", async () => {
    const long = await runTestCli(["list", "--zzzzzzzzzz"], { cwd });
    expect(long.code).toBe(2);
    expect(long.stderr).toContain("Unknown option --zzzzzzzzzz.");
    expect(long.stderr).not.toContain("Did you mean");

    const short = await runTestCli(["list", "-Z"], { cwd });
    expect(short.code).toBe(2);
    expect(short.stderr).toContain("Unknown option -Z.");
  });

  it("reports a missing value in one short sentence", async () => {
    const run = await runTestCli(["list", "--from"], { cwd });
    expect(run.code).toBe(2);
    const firstLine = plain(run.stderr).split("\n")[0] ?? "";
    expect(firstLine).toMatch(
      /^✖ MS_CONFIG_INVALID {2}Option '--from <value>' argument missing\.$/,
    );
  });

  it("explains how to pass a value that starts with a dash", async () => {
    const run = await runTestCli(["backup", "--max-docs-per-second", "-3"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(
      'To pass a value starting with "-", write --max-docs-per-second=<value>.',
    );
  });

  it("rejects a value for a switch", async () => {
    const run = await runTestCli(["list", "--quiet=yes", "--from", memoryUrl()], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--quiet");
  });

  it("rejects values outside an option's choices", async () => {
    const run = await runTestCli(["backup", "--compression", "lz4"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--compression must be one of zstd, gzip, none (got "lz4").');
  });

  it.each([
    [["--parallelism", "0"], '--parallelism must be a whole number 1–64 (got "0").'],
    [["--parallelism", "65"], '--parallelism must be a whole number 1–64 (got "65").'],
    [["--parallelism", "2.5"], '--parallelism must be a whole number 1–64 (got "2.5").'],
    [["--max-docs-per-second=-3"], '--max-docs-per-second must be a whole number ≥ 1 (got "-3").'],
    [["--max-docs-per-second", "lots"], "--max-docs-per-second must be a whole number ≥ 1"],
  ])("rejects integer flags out of range: %j", async (flags, message) => {
    const run = await runTestCli(["backup", "--to", memoryUrl(), ...flags], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it.each([
    [["--part-size", "12 parsecs"], "--part-size"],
    [["--max-duration", "15"], "--max-duration"],
    [["--max-bytes-per-second", "0"], "--max-bytes-per-second"],
  ])("rejects sizes and durations without a valid unit: %j", async (flags, flag) => {
    const run = await runTestCli(["backup", "--to", memoryUrl(), ...flags], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(flag);
  });

  it.each([
    [["--label", "novalue"], '--label expects key=value (got "novalue").'],
    [["--label", "=x"], '--label expects key=value (got "=x").'],
    [["--label", "env=prod", "--label", "env=dev"], '--label gives "env" twice.'],
  ])("rejects malformed key=value flags: %j", async (flags, message) => {
    const run = await runTestCli(["backup", "--to", memoryUrl(), ...flags], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
  });

  it("rejects extra positional arguments", async () => {
    const run = await runTestCli(["list", "one", "two"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Unexpected argument: one two");
  });

  it("shows help even when other values are invalid", async () => {
    const run = await runTestCli(["backup", "--compression", "lz4", "--help"], { cwd });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("mongoshield backup");
    expect(run.stdout).toContain("<zstd|gzip|none>");
  });

  it("uses the last value of a repeated single-value flag", async () => {
    const empty = memoryUrl();
    const full = memoryUrl();
    await writeTestBackup(await resolveStorage(full), {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    const run = await runTestCli(["list", "--from", empty, "--from", full, "--json"], { cwd });
    expect(run.code).toBe(0);
    expect(run.json<unknown[]>()).toHaveLength(1);
  });
});

describe("output modes", () => {
  it("--json prints exactly one JSON document on stdout, also for errors", async () => {
    const run = await runTestCli(["list", "--form", "x", "--json"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toBe("");
    expect(run.json()).toEqual({
      error: {
        code: "MS_CONFIG_INVALID",
        message: "Unknown option --form. Did you mean --from?",
        hint: "Run `mongoshield list --help` to see the available options and examples.",
        docsUrl: expect.stringMatching(/#ms_config_invalid$/),
        exitCode: 2,
      },
    });
  });

  it("--json errors before the command is known are JSON too", async () => {
    const run = await runTestCli(["--json", "nope"], { cwd });
    expect(run.code).toBe(2);
    expect(run.json()).toMatchObject({ error: { code: "MS_CONFIG_INVALID", exitCode: 2 } });
  });

  it("--json with --help still prints the help page, as text", async () => {
    // Help is never JSON: it is documentation, and `--json --help` asks for it.
    for (const args of [
      ["--json", "--help"],
      ["list", "--help", "--json"],
      ["help", "list", "--json"],
    ]) {
      const run = await runTestCli(args, { cwd });
      expect(run.code, args.join(" ")).toBe(0);
      expect(run.stdout, args.join(" ")).toContain("Global options");
    }
  });

  it("an empty list says so on stderr, and nothing on stdout; --quiet hides it", async () => {
    const storage = memoryUrl();
    const normal = await runTestCli(["list", "--from", storage], { cwd });
    expect(normal.code).toBe(0);
    expect(normal.stdout).toBe("");
    expect(normal.stderr).toContain(`No backups in ${storage} yet.`);

    const quiet = await runTestCli(["list", "--from", storage, "-q"], { cwd });
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");
  });

  it("--verbose prints debug lines, and stack traces on errors", async () => {
    const debug = await runTestCli(["list", "--from", memoryUrl(), "--verbose"], { cwd });
    expect(debug.code).toBe(0);
    expect(debug.stderr).toContain("debug no config file found");

    const failing = await runTestCli(["list", "--form", "x", "--verbose"], { cwd });
    expect(failing.code).toBe(2);
    expect(failing.stderr).toMatch(/MongoShieldError: Unknown option --form/);
    expect(failing.stderr).toMatch(/\n\s+at /);
  });

  describe("colors", () => {
    const failing = ["nope"];

    it("are used on a terminal", async () => {
      const run = await runTestCli(failing, { cwd, isTTY: true });
      expect(run.stderr).toContain(ESC);
    });

    it.each([
      ["--no-color", {}, true],
      ["NO_COLOR", { NO_COLOR: "1" }, true],
      ["TERM=dumb", { TERM: "dumb" }, true],
      ["a pipe", {}, false],
    ])("are off with %s", async (label, env, isTTY) => {
      const args = label === "--no-color" ? [...failing, "--no-color"] : failing;
      const run = await runTestCli(args, { cwd, env, isTTY });
      expect(run.code).toBe(2);
      expect(run.stderr).not.toContain(ESC);
      expect(run.stderr).toContain("✖ MS_CONFIG_INVALID");
    });

    it("an empty NO_COLOR does not count (no-color.org)", async () => {
      const run = await runTestCli(failing, { cwd, env: { NO_COLOR: "" }, isTTY: true });
      expect(run.stderr).toContain(ESC);
    });

    it("FORCE_COLOR turns them on even when piped, but not FORCE_COLOR=0", async () => {
      const forced = await runTestCli(failing, { cwd, env: { FORCE_COLOR: "1" } });
      expect(forced.stderr).toContain(ESC);
      const zero = await runTestCli(failing, { cwd, env: { FORCE_COLOR: "0" } });
      expect(zero.stderr).not.toContain(ESC);
      // The flag wins over the environment.
      const flag = await runTestCli([...failing, "--no-color"], {
        cwd,
        env: { FORCE_COLOR: "1" },
      });
      expect(flag.stderr).not.toContain(ESC);
    });

    it("help pages are colored on a terminal and plain otherwise", async () => {
      const colored = await runTestCli(["list", "--help"], { cwd, isTTY: true });
      const uncolored = await runTestCli(["list", "--help"], { cwd });
      expect(colored.stdout).toContain(ESC);
      expect(uncolored.stdout).not.toContain(ESC);
      expect(plain(colored.stdout)).toBe(uncolored.stdout);
    });
  });
});

describe("cancellation", () => {
  it("an already aborted signal stops a command with MS_ABORTED (exit code 60)", async () => {
    const controller = new AbortController();
    controller.abort();
    const storage = memoryUrl();
    await writeTestBackup(await resolveStorage(storage), {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    const run = await runTestCli(["verify", "latest", "--from", storage], {
      cwd,
      signal: controller.signal,
    });
    expect(run.code).toBe(60);
    expect(run.stderr).toContain("MS_ABORTED");
  });
});

describe("every command's help page", () => {
  it.each(COMMANDS.map((command) => [command.name]))("%s --help", async (name) => {
    const run = await runTestCli([name, "--help"], { cwd });
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const page = run.stdout;
    const command = COMMANDS.find((candidate) => candidate.name === name);
    expect(page.startsWith(`mongoshield ${name}  ${command?.summary}`)).toBe(true);
    expect(page).toContain(`Usage  mongoshield ${name}`);
    expect(page).toContain("Global options");
    expect(page).toContain("-y, --yes");
    for (const option of Object.keys(command?.options ?? {})) {
      expect(page).toContain(`--${option}`);
    }
    for (const positional of command?.positionals ?? []) {
      expect(page).toContain(positional.optional ? `[${positional.name}]` : `<${positional.name}>`);
    }
    for (const example of command?.examples ?? []) expect(page).toContain(example.command);
    // Descriptions line up in one column that a long flag cannot push far right: a
    // flag wider than the column gets its description on the next line.
    for (const line of page.split("\n")) {
      const option = /^ {2}(?:-\w, | {4})--\S.*? {2,}(?=\S)/.exec(line);
      if (option) expect(option[0].length, line).toBeLessThanOrEqual(2 + 4 + 40 + 2);
    }
  });
});
