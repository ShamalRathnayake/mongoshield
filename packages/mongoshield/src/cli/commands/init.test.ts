// `mongoshield init`: the non-interactive path (flags and defaults) and every branch of
// the interactive wizard, answered through a fake terminal.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYS, plain, runTestCli } from "../../../test/helpers/cli.ts";
import { generateIdentity } from "../../crypto/index.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-init-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const configText = () => readFile(join(cwd, "mongoshield.config.ts"), "utf8");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("mongoshield init without a terminal", () => {
  it("writes an unencrypted config with the defaults and lists the next steps", async () => {
    const run = await runTestCli(["init"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const text = await configText();
    expect(text).toContain('storage: "./backups"');
    expect(text).toContain("process.env.MONGODB_URI");
    expect(text).toContain("// encryption: { recipients:");
    expect(run.stdout).toContain("Next steps:");
    expect(run.stdout).toContain('export MONGODB_URI="mongodb://…"');
    expect(run.stdout).not.toContain("--identity-file");
    expect(run.stderr).toContain("Created");
  });

  it("generates a key pair with --keygen, writes it 0600 and reminds about .gitignore", async () => {
    const run = await runTestCli(
      ["init", "--keygen", "--storage", "s3://bucket/prefix", "--uri-env", "PROD_URI"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    const keyPath = join(cwd, "mongoshield.key");
    const key = await readFile(keyPath, "utf8");
    expect(key).toMatch(/AGE-SECRET-KEY-1/);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const text = await configText();
    expect(text).toContain('storage: "s3://bucket/prefix"');
    expect(text).toContain("process.env.PROD_URI");
    expect(text).toMatch(/recipients: \["age1[a-z0-9]+"\]/);
    expect(text).toContain("--identity-file ./mongoshield.key");
    // The config never holds the secret half.
    expect(text).not.toContain("AGE-SECRET-KEY");

    expect(run.stdout).toContain("--identity-file ./mongoshield.key");
    expect(run.stderr).toContain("Keep an offline copy");
    expect(run.stderr).toContain(".gitignore");
    // Secrets never reach stdout or stderr.
    expect(run.stdout + run.stderr).not.toContain("AGE-SECRET-KEY");
  });

  it("does not nag about .gitignore when it already covers the key", async () => {
    await writeFile(join(cwd, ".gitignore"), "node_modules\n/*.key\n*.key\n");
    const run = await runTestCli(["init", "--keygen"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain(".gitignore");
  });

  it("accepts a .gitignore entry naming the key file by its relative path", async () => {
    await mkdir(join(cwd, "secrets"));
    await writeFile(join(cwd, ".gitignore"), "/secrets/backup.key\r\n");
    const run = await runTestCli(["init", "--keygen", "--key-file", "secrets/backup.key"], {
      cwd,
    });
    expect(run.code, run.stderr).toBe(0);
    expect(await exists(join(cwd, "secrets", "backup.key"))).toBe(true);
    expect(run.stderr).not.toContain(".gitignore");
    expect(await configText()).toContain("--identity-file ./secrets/backup.key");
  });

  it("writes the key outside the project without a .gitignore reminder and keeps the absolute path", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "mongoshield-init-key-"));
    try {
      const keyFile = join(elsewhere, "offsite.key");
      const run = await runTestCli(["init", "--keygen", "--key-file", keyFile], { cwd });
      expect(run.code, run.stderr).toBe(0);
      expect(await exists(keyFile)).toBe(true);
      expect(await configText()).toContain(`--identity-file ${keyFile}`);
      expect(run.stderr).not.toContain(".gitignore");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("encrypts for an existing --recipient", async () => {
    const { recipient } = generateIdentity();
    const run = await runTestCli(["init", "--recipient", recipient], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const text = await configText();
    expect(text).toContain(`recipients: ["${recipient}"]`);
    expect(text).toContain("--identity-file <key file>");
    expect(await exists(join(cwd, "mongoshield.key"))).toBe(false);
  });

  it("prints one JSON document with --json", async () => {
    const run = await runTestCli(["init", "--keygen", "--json"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const result = run.json<Record<string, string>>();
    expect(result).toMatchObject({
      configFile: join(cwd, "mongoshield.config.ts"),
      storage: "./backups",
      uriEnv: "MONGODB_URI",
      identityFile: join(cwd, "mongoshield.key"),
    });
    expect(result.recipient).toMatch(/^age1/);
  });

  it("prints the JSON document without encryption fields when not encrypting", async () => {
    const run = await runTestCli(["init", "--json", "--storage", "  "], { cwd });
    expect(run.code, run.stderr).toBe(0);
    const result = run.json();
    expect(result).toEqual({
      configFile: join(cwd, "mongoshield.config.ts"),
      storage: "./backups",
      uriEnv: "MONGODB_URI",
    });
  });

  it("refuses to overwrite an existing config file (any supported name)", async () => {
    await writeFile(join(cwd, "mongoshield.config.mjs"), "export default {};\n");
    const run = await runTestCli(["init"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("mongoshield.config.mjs already exists");
    expect(run.stderr).toContain("hint");
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });

  it("refuses to overwrite an existing key file, and then writes no config", async () => {
    await writeFile(join(cwd, "mongoshield.key"), "keep me\n");
    const run = await runTestCli(["init", "--keygen"], { cwd });
    expect(run.code).not.toBe(0);
    expect(await readFile(join(cwd, "mongoshield.key"), "utf8")).toBe("keep me\n");
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });

  it.each([
    [["--keygen", "--recipient", "age1abc"], "--keygen and --recipient cannot be combined"],
    [["--uri-env", "not a name"], "--uri-env must be an environment variable name"],
    [["--recipient", "age1notakey"], "recipient"],
  ])("rejects invalid flags %j with exit code 2", async (flags, message) => {
    const run = await runTestCli(["init", ...flags], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr.toLowerCase()).toContain(message.toLowerCase());
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });
});

describe("mongoshield init on a terminal", () => {
  it("accepts every default: storage, variable, and a generated key", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: "Where should backups be stored?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        { when: "Where should the secret key file be written?", keys: KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await exists(join(cwd, "mongoshield.key"))).toBe(true);
    const text = await configText();
    expect(text).toContain('storage: "./backups"');
    expect(text).toMatch(/recipients: \["age1/);
    expect(plain(run.stderr)).toContain("Writing your configuration");
  });

  it("takes typed answers, re-asks after invalid input, and uses an existing public key", async () => {
    const { recipient } = generateIdentity();
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        // An empty storage answer is refused; then a real one is typed.
        { when: "Where should backups be stored?", keys: KEYS.clearLine + KEYS.enter },
        { when: "Enter a directory or URL.", keys: `s3://acme/prod${KEYS.enter}` },
        { when: "Which environment variable", keys: `${KEYS.clearLine}BAD NAME${KEYS.enter}` },
        { when: "Use letters, digits and _.", keys: `${KEYS.clearLine}PROD_URI${KEYS.enter}` },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.enter },
        { when: "Public key (age1…):", keys: `age1nope${KEYS.enter}` },
        { when: "recipient", keys: `${KEYS.clearLine}${recipient}${KEYS.enter}` },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    const text = await configText();
    expect(text).toContain('storage: "s3://acme/prod"');
    expect(text).toContain("process.env.PROD_URI");
    expect(text).toContain(`recipients: ["${recipient}"]`);
    expect(await exists(join(cwd, "mongoshield.key"))).toBe(false);
  });

  it("writes an unencrypted config when the user says No, and pre-fills answers from flags", async () => {
    const run = await runTestCli(["init", "--storage", "./elsewhere", "--uri-env", "APP_URI"], {
      cwd,
      terminal: [
        { when: "Where should backups be stored?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    const text = await configText();
    expect(text).toContain('storage: "./elsewhere"');
    expect(text).toContain("process.env.APP_URI");
    expect(text).toContain("// encryption:");
  });

  it("pre-selects and pre-fills an existing --recipient given as a flag", async () => {
    const { recipient } = generateIdentity();
    const run = await runTestCli(["init", "--recipient", recipient], {
      cwd,
      terminal: [
        { when: "Where should backups be stored?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        { when: "Public key (age1…):", keys: KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain(`recipients: ["${recipient}"]`);
  });

  it("writes the key where the user says", async () => {
    const run = await runTestCli(["init", "--keygen"], {
      cwd,
      terminal: [
        { when: "Where should backups be stored?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        {
          when: "Where should the secret key file be written?",
          keys: `${KEYS.clearLine}./prod.key${KEYS.enter}`,
        },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await exists(join(cwd, "prod.key"))).toBe(true);
    expect(await configText()).toContain("--identity-file ./prod.key");
  });

  it("stops cleanly on Ctrl-C, writing nothing (exit code 60)", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [{ when: "Where should backups be stored?", keys: KEYS.ctrlC }],
    });
    expect(run.code).toBe(60);
    expect(plain(run.stderr)).toContain("Cancelled. Nothing was written.");
    // Prompts, including the cancel line, never touch stdout.
    expect(run.stdout).toBe("");
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });

  it("does not ask with --yes, even on a terminal", async () => {
    const run = await runTestCli(["init", "--yes"], { cwd, isTTY: true });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).not.toContain("Where should backups be stored?");
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(true);
  });

  it("does not ask in CI, even on a terminal", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      env: { CI: "true" },
      terminal: [],
    });
    expect(run.code, run.stderr).toBe(0);
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(true);
  });
});

describe("mongoshield init --preset", () => {
  it("writes a ready config for an Atlas Free cluster that loads and validates", async () => {
    const run = await runTestCli(
      ["init", "--preset", "atlas-free", "--keygen", "--storage", "s3://acme/atlas"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    const text = await configText();
    expect(text).toContain('preset: "atlas-free",');
    expect(text).toContain("backup: { parallelism: 2, maxBytesPerSecond: 4 * 1024 * 1024 },");
    expect(text).toContain("retention: { last: 7, weekly: 4, monthly: 6 },");
    expect(text).toContain("compressors=zlib");
    expect(text).toMatch(/recipients: \["age1/);
    expect(run.stdout).toContain("Only read any database");
    expect(run.stdout).toContain("Network Access");
    expect(run.stdout).toContain('export MONGODB_URI="mongodb+srv://');

    // The written file is a valid config: load it the way the CLI does.
    const { loadConfig } = await import("../../config/load.ts");
    const { config } = await loadConfig({ cwd, env: { MONGODB_URI: "mongodb://localhost" } });
    expect(config.preset).toBe("atlas-free");
    expect(config.backup?.maxBytesPerSecond).toBe(4 * 1024 * 1024);
    expect(config.retention).toEqual({ last: 7, weekly: 4, monthly: 6 });
  });

  it("writes the Flex read pace for atlas-flex and reports the preset in --json", async () => {
    const run = await runTestCli(["init", "--preset", "atlas-flex", "--json"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect(run.json<Record<string, string>>().preset).toBe("atlas-flex");
    const text = await configText();
    expect(text).toContain('preset: "atlas-flex",');
    expect(text).toContain("maxBytesPerSecond: 8 * 1024 * 1024");
  });

  it("refuses an unknown preset and lists the valid ones, writing nothing", async () => {
    const run = await runTestCli(["init", "--preset", "atlas-m10"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Unknown preset "atlas-m10"');
    expect(run.stderr).toContain("atlas-free, atlas-flex");
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });

  it("keeps the preset through the interactive wizard", async () => {
    const run = await runTestCli(["init", "--preset", "atlas-free"], {
      cwd,
      terminal: [
        { when: "Where should backups be stored?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        { when: "Where should the secret key file be written?", keys: KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain('preset: "atlas-free",');
  });
});
