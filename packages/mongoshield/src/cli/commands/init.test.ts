// `mongoshield init`: the non-interactive path (flags and defaults) and every branch of
// the interactive wizard, answered through a fake terminal.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEYS, plain, runTestCli } from "../../../test/helpers/cli.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { resolveStorage } from "../../storage/resolve.ts";
import { INIT_DESTINATIONS, type InitDestinationId } from "./init-destinations.ts";

/** Keys that move the destination menu from its first entry to `id` and choose it. */
function choose(id: InitDestinationId): string {
  const index = INIT_DESTINATIONS.findIndex((destination) => destination.id === id);
  return KEYS.down.repeat(index) + KEYS.enter;
}

/** The first question of the wizard. */
const MENU = "Where should backups go?";

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
      destination: "directory",
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
        { when: MENU, keys: choose("directory") },
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
        { when: MENU, keys: choose("directory") },
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
        // --storage ./elsewhere pre-selects the directory entry.
        { when: MENU, keys: KEYS.enter },
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
        { when: MENU, keys: choose("directory") },
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
        { when: MENU, keys: choose("directory") },
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
      terminal: [{ when: MENU, keys: KEYS.ctrlC }],
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
        { when: MENU, keys: choose("directory") },
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

describe("the destination menu of mongoshield init", () => {
  it("offers the drives first, then GitHub artifacts, B2, R2 and every URL, in that order", () => {
    expect(INIT_DESTINATIONS.map((destination) => destination.id)).toEqual([
      "gdrive",
      "onedrive",
      "dropbox",
      "github-artifacts",
      "b2",
      "r2",
      "directory",
      "s3",
      "gs",
      "az",
      "sftp",
      "url",
    ]);
    const label = (id: InitDestinationId) =>
      INIT_DESTINATIONS.find((destination) => destination.id === id)?.label;
    expect(label("github-artifacts")).toBe(
      "GitHub artifacts (quickest to try; deleted after 90 days at most, so not a real backup on its own)",
    );
    expect(label("b2")).toContain("no card");
    expect(label("r2")).toContain("needs a card");
    expect(label("gdrive")).toContain("Google Drive");
  });

  it("starts on Google Drive and writes a drive setup with the login next steps", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: KEYS.enter },
        { when: "Which folder should backups go in?", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        { when: "Where should the secret key file be written?", keys: KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    const text = await configText();
    expect(text).toContain('storage: "gdrive://mongoshield-backups",');
    expect(text).toContain("mongoshield login gdrive");
    expect(run.stdout).toContain("mongoshield login gdrive");
    expect(run.stdout).toContain("MONGOSHIELD_GDRIVE_TOKEN");
    expect(run.stdout).toContain("gh secret set MONGOSHIELD_GDRIVE_TOKEN");
  });

  it.each([
    ["onedrive", "onedrive://mongoshield-backups", "MONGOSHIELD_ONEDRIVE_TOKEN"],
    ["dropbox", "dropbox://mongoshield-backups", "MONGOSHIELD_DROPBOX_TOKEN"],
  ] as const)(
    "writes the %s setup with --destination, and names its token secret in --json",
    async (id, storage, secret) => {
      const run = await runTestCli(["init", "--destination", id, "--json"], { cwd });
      expect(run.code, run.stderr).toBe(0);
      expect(run.json()).toMatchObject({
        storage,
        destination: id,
        secrets: [secret],
        loginProvider: id,
      });
      expect(await configText()).toContain(`storage: ${JSON.stringify(storage)},`);
    },
  );

  it("asks for the drive folder and builds the URL from it", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: choose("onedrive") },
        {
          when: "Which folder should backups go in?",
          keys: `${KEYS.clearLine}../up${KEYS.enter}`,
        },
        { when: "without", keys: `${KEYS.clearLine}prod/mongo${KEYS.enter}` },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain('storage: "onedrive://prod/mongo",');
  });

  it("writes a GitHub artifacts setup: a directory, the upload step and the 90-day warning", async () => {
    const run = await runTestCli(["init", "--destination", "github-artifacts"], { cwd });
    expect(run.code, run.stderr).toBe(0);
    expect(await configText()).toContain('storage: "./backups",');
    expect(await configText()).toContain("actions/upload-artifact");
    expect(run.stdout).toContain("upload ./backups with actions/upload-artifact");
    expect(run.stderr).toContain("deleted after 90 days at most, so not a real backup on its own");
  });

  it.each([
    [
      ["--destination", "b2"],
      "--destination b2 needs --storage b2://<bucket>/<prefix>?region=<region>",
    ],
    [["--destination", "b2", "--storage", "s3://acme"], "is not a Backblaze B2"],
    [["--destination", "github-artifacts", "--storage", "s3://acme"], "Use ./<directory>"],
    [["--destination", "icloud"], "icloud"],
  ])("rejects %j with exit code 2", async (flags, message) => {
    const run = await runTestCli(["init", ...flags], { cwd });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(await exists(join(cwd, "mongoshield.config.ts"))).toBe(false);
  });

  it("gives a URL typed into the directory question that URL's next steps", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: choose("directory") },
        {
          when: "Where should backups be stored?",
          keys: `${KEYS.clearLine}gs://acme/prod${KEYS.enter}`,
        },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(run.stdout).toContain("npm install @google-cloud/storage");
  });

  it("asks for an s3:// URL and refuses anything else", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: choose("s3") },
        { when: "Storage URL (s3://", keys: `${KEYS.clearLine}gs://nope${KEYS.enter}` },
        {
          when: "Use s3://",
          keys: `${KEYS.clearLine}s3://acme/prod?region=eu-west-1${KEYS.enter}`,
        },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain('storage: "s3://acme/prod?region=eu-west-1",');
    expect(run.stdout).toContain("npm install @aws-sdk/client-s3 @aws-sdk/lib-storage");
  });
});

describe("mongoshield init for Backblaze B2 (no card) and Cloudflare R2", () => {
  // The written config is resolved like the CLI does, and the S3 client the adapter
  // builds is inspected: this is the proof that init writes a WORKING B2 setup.
  let classMock: ReturnType<typeof mockClient>;

  beforeEach(() => {
    classMock = mockClient(S3Client);
    classMock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
  });

  afterEach(() => {
    classMock.restore();
  });

  /** Loads the written config, resolves its storage and reports the S3 client's settings. */
  async function writtenS3Client(env: NodeJS.ProcessEnv = {}) {
    const { loadConfig } = await import("../../config/load.ts");
    const { config } = await loadConfig({
      cwd,
      env: { MONGODB_URI: "mongodb://localhost", ...env },
    });
    if (typeof config.storage !== "string") throw new Error("expected a storage URL");
    const storage = await resolveStorage(config.storage);
    await storage.head("probe");
    const created = classMock.send.getCall(0).thisValue;
    if (!(created instanceof S3Client)) throw new Error("no S3 client was created");
    const endpoint = await created.config.endpoint?.();
    return {
      kind: storage.kind,
      location: storage.location,
      host: endpoint?.hostname,
      region: await created.config.region(),
      forcePathStyle: (created.config as { forcePathStyle?: boolean }).forcePathStyle,
      requestChecksumCalculation: await created.config.requestChecksumCalculation(),
    };
  }

  it("writes a working B2 setup with --storage b2://…, and the application key steps", async () => {
    const run = await runTestCli(
      ["init", "--yes", "--storage", "b2://acme-backups/prod?region=us-west-004", "--keygen"],
      { cwd },
    );
    expect(run.code, run.stderr).toBe(0);
    const text = await configText();
    expect(text).toContain('storage: "b2://acme-backups/prod?region=us-west-004",');
    expect(text).toContain("application key's keyID");

    expect(await writtenS3Client()).toEqual({
      kind: "s3",
      location: "s3://acme-backups/prod/",
      host: "s3.us-west-004.backblazeb2.com",
      region: "us-west-004",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });

    expect(run.stdout).toContain("npm install @aws-sdk/client-s3 @aws-sdk/lib-storage");
    expect(run.stdout).toContain("Application Keys");
    expect(run.stdout).toContain("acme-backups only");
    expect(run.stdout).toContain('export AWS_ACCESS_KEY_ID="<keyID>"');
    expect(run.stdout).toContain('export AWS_SECRET_ACCESS_KEY="<applicationKey>"');
    // No card is needed, so nothing warns about one.
    expect(run.stderr).not.toContain("card");
  });

  it("asks for the bucket, region and folder, re-asking for an AWS-style region", async () => {
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: choose("b2") },
        { when: "B2 bucket name:", keys: `acme-backups${KEYS.enter}` },
        { when: "B2 region", keys: `us-west-2${KEYS.enter}` },
        { when: "Use a region such as", keys: `${KEYS.clearLine}us-west-004${KEYS.enter}` },
        { when: "Folder inside the bucket", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.enter },
        { when: "Where should the secret key file be written?", keys: KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain(
      'storage: "b2://acme-backups/mongoshield?region=us-west-004",',
    );
    expect((await writtenS3Client()).host).toBe("s3.us-west-004.backblazeb2.com");
  });

  it("pre-fills the B2 answers from --storage", async () => {
    const run = await runTestCli(["init", "--storage", "b2://acme/prod?region=eu-central-003"], {
      cwd,
      terminal: [
        { when: MENU, keys: KEYS.enter },
        { when: "B2 bucket name:", keys: KEYS.enter },
        { when: "B2 region", keys: KEYS.enter },
        { when: "Folder inside the bucket", keys: KEYS.enter },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain('storage: "b2://acme/prod?region=eu-central-003",');
  });

  it("writes a working R2 setup and warns that R2 needs a card", async () => {
    const account = "0123456789abcdef0123456789abcdef";
    const run = await runTestCli(["init"], {
      cwd,
      terminal: [
        { when: MENU, keys: choose("r2") },
        { when: "Cloudflare account id", keys: `nope${KEYS.enter}` },
        {
          when: "32 hex characters",
          keys: `${KEYS.clearLine}${account.toUpperCase()}${KEYS.enter}`,
        },
        { when: "R2 bucket name:", keys: `acme${KEYS.enter}` },
        { when: "Folder inside the bucket", keys: `${KEYS.clearLine}${KEYS.enter}` },
        { when: "Which environment variable", keys: KEYS.enter },
        { when: "Encrypt backups?", keys: KEYS.down + KEYS.down + KEYS.enter },
      ],
    });
    expect(run.code, plain(run.stderr)).toBe(0);
    expect(await configText()).toContain(`storage: "r2://${account}/acme",`);
    expect(await writtenS3Client()).toMatchObject({
      host: `${account}.r2.cloudflarestorage.com`,
      region: "auto",
    });
    expect(run.stdout).toContain("Manage API tokens");
    expect(plain(run.stderr)).toContain("R2 asks for a payment card");
  });
});
