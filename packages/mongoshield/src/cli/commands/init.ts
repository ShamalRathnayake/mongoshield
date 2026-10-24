/**
 * `mongoshield init`: create `mongoshield.config.ts` (and optionally a key pair).
 *
 * On a terminal it asks a few questions; with --yes, or without a terminal
 * (CI), it uses the flags and sensible defaults. The generated config never
 * contains secrets: the connection string is read from an environment
 * variable, and the only key in it is the public age recipient.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type CANCEL_SYMBOL, cancel, intro, isCancel, outro, select, text } from "@clack/prompts";
import { CONFIG_FILE_NAMES } from "../../config/load.ts";
import { assertValidRecipient, generateIdentity } from "../../crypto/index.ts";
import { MongoShieldError } from "../../errors.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { generateConfigText, type InitAnswers } from "./init-template.ts";
import { identityFileText, writeIdentityFile } from "./keygen.ts";

const NAME = "init";

/** The file `init` writes, in the current directory. */
const CONFIG_FILE = "mongoshield.config.ts";

const DEFAULTS = {
  storage: "./backups",
  uriEnv: "MONGODB_URI",
  keyFile: "./mongoshield.key",
} as const;

/** How the wizard handles encryption. */
type EncryptionChoice = "generate" | "existing" | "none";

export const initCommand: CommandSpec = {
  name: NAME,
  summary: "Create mongoshield.config.ts (interactive)",
  description: [
    "Asks where to store backups, which environment variable holds the connection",
    "string, and whether to encrypt (optionally generating a key pair). With --yes",
    "or without a terminal it uses the flags below and their defaults.",
  ].join("\n"),
  options: {
    storage: {
      type: "string",
      valueName: "<storage-url>",
      defaultText: DEFAULTS.storage,
      description: "Where backups will be stored: ./dir or s3://bucket/prefix",
    },
    "uri-env": {
      type: "string",
      valueName: "<VAR>",
      defaultText: DEFAULTS.uriEnv,
      description: "Environment variable that holds the MongoDB connection string",
    },
    keygen: { type: "boolean", description: "Generate a key pair and encrypt backups with it" },
    recipient: {
      type: "string",
      valueName: "<age1…>",
      description: "Encrypt backups for an existing public key instead",
    },
    "key-file": {
      type: "string",
      valueName: "<path>",
      defaultText: DEFAULTS.keyFile,
      description: "Where --keygen writes the secret identity",
    },
  },
  examples: [
    { description: "Answer a few questions", command: "mongoshield init" },
    {
      description: "Non-interactive, for CI or provisioning scripts",
      command: "mongoshield init --yes --storage s3://acme-backups/prod --keygen",
    },
  ],
  run: runInitCommand,
};

async function runInitCommand(context: CommandContext): Promise<number> {
  const configPath = resolve(context.io.cwd, CONFIG_FILE);
  await refuseIfConfigExists(context.io.cwd);

  const interactive = context.out.interactive && !context.global.yes;
  const answers = interactive ? await askQuestions(context) : answersFromFlags(context);

  // The key is written first: if that fails (file exists), no config refers to it.
  let recipient = answers.recipient;
  let keyFile: string | undefined;
  if (answers.encryption === "generate") {
    const generated = generateIdentity();
    context.addSecret(generated.identity);
    keyFile = resolvePath(context, answers.keyFile);
    await writeIdentityFile(keyFile, identityFileText(generated.identity, generated.recipient));
    recipient = generated.recipient;
  }

  const template: InitAnswers = {
    storage: answers.storage,
    uriEnv: answers.uriEnv,
    ...(recipient ? { recipient } : {}),
    ...(keyFile ? { keyFile: displayPath(context, keyFile) } : {}),
  };
  await writeFile(configPath, generateConfigText(template), { flag: "wx" });

  if (context.out.settings.json) {
    context.out.json({
      configFile: configPath,
      storage: answers.storage,
      uriEnv: answers.uriEnv,
      ...(recipient ? { recipient } : {}),
      ...(keyFile ? { identityFile: keyFile } : {}),
    });
    return 0;
  }
  await printNextSteps(context, { configPath, uriEnv: answers.uriEnv, keyFile, interactive });
  return 0;
}

/** Everything the wizard decides. */
interface WizardAnswers {
  readonly storage: string;
  readonly uriEnv: string;
  readonly encryption: EncryptionChoice;
  readonly recipient: string | undefined;
  readonly keyFile: string;
}

/** Non-interactive mode: flags, then defaults. */
function answersFromFlags(context: CommandContext): WizardAnswers {
  const { flags } = context;
  const recipient = flags.string("recipient");
  if (recipient && flags.boolean("keygen")) {
    throw usageError("--keygen and --recipient cannot be combined.", NAME);
  }
  if (recipient) assertValidRecipient(recipient);

  const uriEnv = flags.string("uri-env") ?? DEFAULTS.uriEnv;
  checkVariableName(uriEnv);

  return {
    storage: nonEmpty(flags.string("storage")) ?? DEFAULTS.storage,
    uriEnv,
    encryption: flags.boolean("keygen") ? "generate" : recipient ? "existing" : "none",
    recipient,
    keyFile: flags.string("key-file") ?? DEFAULTS.keyFile,
  };
}

/** The interactive wizard. Flags given on the command line become the defaults. */
async function askQuestions(context: CommandContext): Promise<WizardAnswers> {
  const defaults = answersFromFlags(context);
  const common = {
    output: context.io.stderr,
    signal: context.signal,
    ...(context.io.stdin ? { input: context.io.stdin } : {}),
  };
  intro("mongoshield init", common);

  const storage = answered(
    await text({
      ...common,
      message: "Where should backups be stored?",
      placeholder: "./backups or s3://bucket/prefix",
      initialValue: defaults.storage,
      validate: (value) => (value && value.trim() !== "" ? undefined : "Enter a directory or URL."),
    }),
  ).trim();

  const uriEnv = answered(
    await text({
      ...common,
      message: "Which environment variable holds the MongoDB connection string?",
      initialValue: defaults.uriEnv,
      validate: (value) => (isVariableName(value ?? "") ? undefined : "Use letters, digits and _."),
    }),
  ).trim();

  const encryption = answered(
    await select<EncryptionChoice>({
      ...common,
      message: "Encrypt backups?",
      initialValue: defaults.encryption === "none" ? "generate" : defaults.encryption,
      options: [
        { value: "generate", label: "Yes, generate a new key pair", hint: "recommended" },
        { value: "existing", label: "Yes, with an existing age public key (age1…)" },
        { value: "none", label: "No" },
      ],
    }),
  );

  let recipient: string | undefined;
  let keyFile = defaults.keyFile;
  if (encryption === "existing") {
    recipient = answered(
      await text({
        ...common,
        message: "Public key (age1…):",
        ...(defaults.recipient ? { initialValue: defaults.recipient } : {}),
        validate: (value) => recipientProblem(value ?? ""),
      }),
    ).trim();
  } else if (encryption === "generate") {
    keyFile = answered(
      await text({
        ...common,
        message: "Where should the secret key file be written?",
        initialValue: defaults.keyFile,
      }),
    ).trim();
  }

  outro("Writing your configuration…", common);
  return { storage, uriEnv, encryption, recipient, keyFile };
}

/** Unwraps a prompt answer, turning Ctrl-C/Escape into a clean cancellation. */
function answered<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    cancel("Cancelled. Nothing was written.");
    throw new MongoShieldError("MS_ABORTED", "Cancelled. Nothing was written.");
  }
  return value;
}

/** `undefined` if the recipient is valid, otherwise what is wrong with it. */
function recipientProblem(value: string): string | undefined {
  try {
    assertValidRecipient(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Not a valid age recipient.";
  }
}

/** `init` never overwrites: an existing config may hold hand-tuned settings. */
async function refuseIfConfigExists(cwd: string): Promise<void> {
  for (const name of CONFIG_FILE_NAMES) {
    const exists = await readFile(resolve(cwd, name)).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `${name} already exists in ${cwd}.`, {
        hint: "Edit it directly, or move it away and run `mongoshield init` again.",
      });
    }
  }
}

/** What to do now, including the key-safety reminders. */
async function printNextSteps(
  context: CommandContext,
  facts: { configPath: string; uriEnv: string; keyFile: string | undefined; interactive: boolean },
): Promise<void> {
  const { out } = context;
  out.success(`Created ${facts.configPath}`);
  if (facts.keyFile) {
    out.success(`Created the secret key ${facts.keyFile} (readable only by you)`);
    out.warn(
      "Keep an offline copy of the secret key (password manager, safe). Without it, encrypted backups cannot be restored.",
    );
    await remindGitignore(context, facts.keyFile);
  }

  const steps = [
    `export ${facts.uriEnv}="mongodb://…"     # or set it in your secret manager`,
    "mongoshield backup",
    "mongoshield list",
    "mongoshield verify",
  ];
  if (facts.keyFile) {
    steps.push(
      `mongoshield restore --identity-file ${displayPath(context, facts.keyFile)} --rename 'app.*=app_restored.*'`,
    );
  }
  out.result("Next steps:");
  steps.forEach((step, index) => {
    out.result(`  ${index + 1}. ${step}`);
  });
}

/** Reminds the user to keep the key out of git, unless .gitignore already covers it. */
async function remindGitignore(context: CommandContext, keyFile: string): Promise<void> {
  const relativePath = relative(context.io.cwd, keyFile);
  // Keys outside the project directory cannot be committed by accident.
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return;

  const gitignore = await readFile(resolve(context.io.cwd, ".gitignore"), "utf8").catch(() => "");
  const name = basename(keyFile);
  const covered = gitignore.split(/\r?\n/).some((line) => {
    const entry = line.trim().replace(/^\//, "");
    return entry === name || entry === relativePath || entry === "*.key";
  });
  if (!covered) {
    context.out.warn(
      `Add the key to .gitignore so it is never committed: echo '${relativePath}' >> .gitignore`,
    );
  }
}

function resolvePath(context: CommandContext, path: string): string {
  return isAbsolute(path) ? path : resolve(context.io.cwd, path);
}

/** A path as written in the config: relative to the project when inside it. */
function displayPath(context: CommandContext, path: string): string {
  const relativePath = relative(context.io.cwd, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) return path;
  return `./${relativePath}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim());
}

function checkVariableName(value: string): void {
  if (!isVariableName(value)) {
    throw usageError(`--uri-env must be an environment variable name (got "${value}").`, NAME);
  }
}
