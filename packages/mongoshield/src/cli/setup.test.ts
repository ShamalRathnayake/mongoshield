// From flags, environment and config file to a working shield: storage locations
// relative to the CLI's directory, identity files and passphrases for encrypted
// backups, early validation of public keys, and keeping every secret out of the output.

import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestBackup } from "../../test/helpers/backup-fixtures.ts";
import { runTestCli } from "../../test/helpers/cli.ts";
import { validateConfig } from "../config/load.ts";
import { generateIdentity } from "../crypto/index.ts";
import { fileStorage } from "../storage/file.ts";
import { resolveStorage } from "../storage/resolve.ts";
import { encryptionFromConfig } from "./setup.ts";

let cwd: string;
const key = generateIdentity();
const PASSPHRASE = "correct horse battery staple";
/** One backup encrypted for `key`, one for the passphrase, in their own stores. */
let recipientStore: string;
let passphraseStore: string;

const memoryUrl = () => `memory://cli-setup-${randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "mongoshield-setup-"));
  recipientStore = memoryUrl();
  passphraseStore = memoryUrl();
  const documents = [{ _id: 1, name: "Ada" }];
  await writeTestBackup(await resolveStorage(recipientStore), {
    namespaces: [{ ns: "app.users", documents }],
    recipients: [key.recipient],
  });
  await writeTestBackup(await resolveStorage(passphraseStore), {
    namespaces: [{ ns: "app.users", documents }],
    passphrase: PASSPHRASE,
  });
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Writes the identity to a file with the given permissions. */
async function keyFile(name: string, mode: number, content = `${key.identity}\n`) {
  const path = join(cwd, name);
  await writeFile(path, content);
  await chmod(path, mode);
  return path;
}

describe("identity files", () => {
  it("decrypt an encrypted backup for a deep verify", async () => {
    await keyFile("private.key", 0o600);
    const run = await runTestCli(
      ["verify", "--deep", "--from", recipientStore, "--identity-file", "private.key"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("is intact");
    expect(run.stderr).not.toContain("readable by other users");
    expect(run.stdout + run.stderr).not.toContain(key.identity);
  });

  it.skipIf(process.platform === "win32")(
    "warn when other users can read the key, but still work",
    async () => {
      const path = await keyFile("shared.key", 0o644);
      const run = await runTestCli(
        ["verify", "--deep", "--from", recipientStore, "--identity-file", path],
        { cwd },
      );
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).toContain(`The identity file ${path} is readable by other users.`);
      expect(run.stderr).toContain(`chmod 600 ${path}`);
    },
  );

  it("that cannot be read are a config error naming the path (exit code 2)", async () => {
    const run = await runTestCli(
      ["verify", "--deep", "--from", recipientStore, "--identity-file", "missing.key"],
      { cwd },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`Cannot read the identity file ${resolve(cwd, "missing.key")}.`);
    expect(run.stderr).toContain("--identity-file");
  });

  it("that hold no identity are rejected with the path in the message", async () => {
    const path = await keyFile("garbage.key", 0o600, "this is not a key\n");
    const run = await runTestCli(
      ["verify", "--deep", "--from", recipientStore, "--identity-file", path],
      { cwd },
    );
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(`${path}: `);
  });

  it("can come from MONGOSHIELD_IDENTITY_FILE, and inline identities from MONGOSHIELD_IDENTITY", async () => {
    const path = await keyFile("env.key", 0o600);
    const viaFile = await runTestCli(["verify", "--deep", "--from", recipientStore], {
      cwd,
      env: { MONGOSHIELD_IDENTITY_FILE: path },
    });
    expect(viaFile.code, viaFile.stderr).toBe(0);

    const inline = await runTestCli(["verify", "--deep", "--from", recipientStore], {
      cwd,
      env: { MONGOSHIELD_IDENTITY: key.identity },
    });
    expect(inline.code, inline.stderr).toBe(0);
    expect(inline.stdout + inline.stderr).not.toContain(key.identity);
  });

  it("a deep verify of an encrypted backup without any key fails clearly", async () => {
    const run = await runTestCli(["verify", "--deep", "--from", recipientStore], { cwd });
    expect(run.code).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/identit|key|decrypt/i);
  });
});

describe("passphrases", () => {
  it("are read from the variable named by --passphrase-env", async () => {
    const run = await runTestCli(
      ["verify", "--deep", "--from", passphraseStore, "--passphrase-env", "BACKUP_PASS"],
      { cwd, env: { BACKUP_PASS: PASSPHRASE } },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toContain(PASSPHRASE);
  });

  it("an unset or empty variable is a config error that says how to set it", async () => {
    for (const env of [{}, { BACKUP_PASS: "" }]) {
      const run = await runTestCli(
        ["verify", "--deep", "--from", passphraseStore, "--passphrase-env", "BACKUP_PASS"],
        { cwd, env },
      );
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(
        "The environment variable BACKUP_PASS (from --passphrase-env) is not set or empty.",
      );
      expect(run.stderr).toContain("read -rs BACKUP_PASS");
    }
  });

  it("a wrong passphrase from MONGOSHIELD_PASSPHRASE fails without echoing it", async () => {
    const wrong = "not-the-passphrase-42";
    const run = await runTestCli(["verify", "--deep", "--from", passphraseStore, "--verbose"], {
      cwd,
      env: { MONGOSHIELD_PASSPHRASE: wrong },
    });
    expect(run.code).not.toBe(0);
    expect(run.stdout + run.stderr).not.toContain(wrong);
  });
});

describe("encryption settings", () => {
  it("rejects a malformed public key before doing anything else", async () => {
    const storage = memoryUrl();
    const run = await runTestCli(["backup", "--to", storage, "--recipient", "age1notakey"], {
      cwd,
      env: { MONGODB_URI: "mongodb://127.0.0.1:1" },
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/recipient/i);
    expect(run.stderr).not.toContain("Backing up");
  });

  it("rejects malformed keys from MONGOSHIELD_RECIPIENTS too", async () => {
    const run = await runTestCli(["backup", "--to", memoryUrl()], {
      cwd,
      env: { MONGODB_URI: "mongodb://127.0.0.1:1", MONGOSHIELD_RECIPIENTS: "nope" },
    });
    expect(run.code).toBe(2);
  });
});

describe("connection strings", () => {
  it("never echo the password, in plain or URL-decoded form", async () => {
    const run = await runTestCli(
      [
        "backup",
        "--uri",
        "mongodb://app:s3cr%40t@127.0.0.1:1/?serverSelectionTimeoutMS=300&connectTimeoutMS=300",
        "--to",
        memoryUrl(),
        "--verbose",
      ],
      { cwd },
    );
    expect(run.code).not.toBe(0);
    const printed = run.stdout + run.stderr;
    expect(printed).toContain("MS_CONNECTION_FAILED");
    expect(printed).not.toContain("s3cr%40t");
    expect(printed).not.toContain("s3cr@t");
  }, 30_000);

  it("a source URI from the config file is treated as a secret as well", async () => {
    const dir = await mkdtemp(join(cwd, "config-uri-"));
    await writeFile(
      join(dir, "mongoshield.config.mjs"),
      `export default { source: { uri: "mongodb://app:topsecret@127.0.0.1:1/?serverSelectionTimeoutMS=300" }, storage: ${JSON.stringify(memoryUrl())} };\n`,
    );
    const run = await runTestCli(["backup", "--verbose"], { cwd: dir });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("debug using config file");
    expect(run.stdout + run.stderr).not.toContain("topsecret");
  }, 30_000);
});

describe("how `list` describes encryption", () => {
  it("names passphrase backups and counts recipients", async () => {
    const passphrase = await runTestCli(["list", "--from", passphraseStore], { cwd });
    expect(passphrase.code, passphrase.stderr).toBe(0);
    expect(passphrase.stdout).toContain("yes (passphrase)");

    const single = await runTestCli(["list", "--from", recipientStore], { cwd });
    expect(single.stdout).toContain("yes (1 recipient)");

    const twoKeys = memoryUrl();
    await writeTestBackup(await resolveStorage(twoKeys), {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
      recipients: [key.recipient, generateIdentity().recipient],
    });
    const two = await runTestCli(["list", "--from", twoKeys], { cwd });
    expect(two.stdout).toContain("yes (2 recipients)");
  });
});

describe("storage locations", () => {
  it("resolve relative paths against the CLI's directory, and accept file:// URLs", async () => {
    const dir = await mkdtemp(join(cwd, "relative-"));
    await writeTestBackup(fileStorage({ path: join(dir, "backups") }), {
      namespaces: [{ ns: "app.users", documents: [{ _id: 1 }] }],
    });
    for (const from of ["./backups", "backups", `file://${join(dir, "backups")}`]) {
      const run = await runTestCli(["list", "--from", from, "--json"], { cwd: dir });
      expect(run.code, `${from}: ${run.stderr}`).toBe(0);
      expect(run.json<unknown[]>(), from).toHaveLength(1);
    }
  });

  it("describe a storage adapter object from the config file", async () => {
    const dir = await mkdtemp(join(cwd, "adapter-"));
    const memoryModule = resolve(import.meta.dirname, "../storage/memory.ts");
    await writeFile(
      join(dir, "mongoshield.config.ts"),
      [
        `import { memoryStorage } from ${JSON.stringify(memoryModule)};`,
        "export default { storage: memoryStorage() };",
        "",
      ].join("\n"),
    );
    const run = await runTestCli(["list"], { cwd: dir });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("No backups in custom storage adapter (from config file) yet.");
  });

  it("without any storage configured is a config error", async () => {
    const run = await runTestCli(["list"], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("hint");
  });
});

describe("encryption from the config file", () => {
  const kms = [{ provider: "aws" as const, key: "arn:aws:kms:eu-west-1:111122223333:key/abc" }];

  it("passes cloud KMS keys on, alone or next to recipients (they used to be dropped)", () => {
    const { recipient } = generateIdentity();
    expect(encryptionFromConfig(validateConfig({ storage: "./b", encryption: { kms } }))).toEqual({
      kms,
    });
    expect(
      encryptionFromConfig(
        validateConfig({ storage: "./b", encryption: { kms, recipients: [recipient] } }),
      ),
    ).toEqual({ kms, recipients: [recipient] });
  });

  it("keeps passphrases, is undefined without encryption, and refuses a mistyped recipient", () => {
    expect(
      encryptionFromConfig(validateConfig({ storage: "./b", encryption: { passphrase: "pw" } })),
    ).toEqual({ passphrase: "pw" });
    expect(encryptionFromConfig(validateConfig({ storage: "./b" }))).toBeUndefined();
    expect(() =>
      encryptionFromConfig(
        validateConfig({ storage: "./b", encryption: { recipients: ["age1nope"] } }),
      ),
    ).toThrow();
  });
});
