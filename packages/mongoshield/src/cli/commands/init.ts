/**
 * `mongoshield init`: create `mongoshield.config.ts` (and optionally a key pair).
 *
 * On a terminal it asks where backups go (a menu with Google Drive first, see
 * init-destinations.ts), a few follow-up questions for that destination, the
 * connection string variable and encryption. With --yes, or without a terminal (CI),
 * it uses the flags (`--storage`, `--destination`, …) and sensible defaults. The
 * generated config never contains secrets: the connection string is read from an
 * environment variable, credentials come from the environment, and the only key in it
 * is the public age recipient. The next steps say which secrets the destination needs
 * (`mongoshield login gdrive` and MONGOSHIELD_GDRIVE_TOKEN, B2's application key, …).
 *
 * `--preset atlas-free` (or `atlas-flex`) writes a config ready for an Atlas Free or
 * Flex cluster: the preset, a gentle read pace and a retention policy for small
 * clusters, plus Atlas-specific next steps (database user, IP access list).
 *
 * The flow is: answers (wizard or flags) → key pair → config file → InitOutcome →
 * next steps. `init --github` (a later release) plugs in after the config is written:
 * it receives the same InitOutcome (destination, its secrets and login provider, the
 * recipient and key file) and sets up the workflow instead of printing next steps.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import {
  type CANCEL_SYMBOL,
  cancel,
  confirm,
  intro,
  isCancel,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { CONFIG_FILE_NAMES } from "../../config/load.ts";
import {
  CONFIG_PRESET_NAMES,
  type ConfigPresetName,
  isConfigPresetName,
} from "../../config/presets.ts";
import { assertValidRecipient, generateIdentity } from "../../crypto/index.ts";
import { MongoShieldError } from "../../errors.ts";
import { resolveStorage } from "../../storage/resolve.ts";
import { version } from "../../version.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { findLoginProvider } from "../login/providers.ts";
import { askRecoveryPassphrase } from "../recovery-kit.ts";
import {
  type DestinationSetup,
  destinationById,
  destinationForStorage,
  INIT_DESTINATION_IDS,
  INIT_DESTINATIONS,
  type InitDestination,
  type InitPrompter,
} from "./init-destinations.ts";
import { type GithubStorageChoice, initGithub } from "./init-github.ts";
import { generateConfigText, type InitAnswers } from "./init-template.ts";
import { identityFileText, writeIdentityFile } from "./keygen.ts";
import { runLogin } from "./login.ts";

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
    "Asks where to store backups (Google Drive, OneDrive, Dropbox, GitHub artifacts,",
    "Backblaze B2, Cloudflare R2 or any storage URL), which environment variable holds",
    "the connection string, and whether to encrypt (optionally generating a key pair),",
    "then prints the next steps for that destination. With --yes or without a terminal",
    "it uses the flags below and their defaults.",
    "--preset atlas-free (or atlas-flex) writes a config for an Atlas Free or Flex cluster.",
    "--github sets up nightly backups in GitHub Actions instead: it signs in to the drive,",
    "generates the key pair and recovery kit, writes mongoshield.config.json and",
    ".github/workflows/mongoshield-backup.yml, sets the repository secrets with the gh",
    "CLI (or prints the commands) and starts the first run.",
  ].join("\n"),
  options: {
    preset: {
      type: "string",
      valueName: "<name>",
      description: `Start from a preset for your deployment: ${CONFIG_PRESET_NAMES.join(", ")}`,
    },
    destination: {
      type: "string",
      valueName: "<name>",
      choices: INIT_DESTINATION_IDS,
      description: "Where backups go, without the menu (needs --storage unless it has a default)",
    },
    storage: {
      type: "string",
      valueName: "<storage-url>",
      defaultText: DEFAULTS.storage,
      description:
        "Where backups will be stored: ./dir, gdrive://folder, b2://bucket/prefix?region=…, s3://…",
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
      description: "Where --keygen (or --github) writes the secret identity",
    },
    github: {
      type: "boolean",
      description: "Set up nightly backups in GitHub Actions in this repository (see above)",
    },
  },
  examples: [
    { description: "Answer a few questions", command: "mongoshield init" },
    {
      description: "Non-interactive, for CI or provisioning scripts",
      command: "mongoshield init --yes --storage s3://acme-backups/prod --keygen",
    },
    {
      description: "Backblaze B2 (10 GB free, no card)",
      command:
        'mongoshield init --yes --storage "b2://acme-backups/prod?region=us-west-004" --keygen',
    },
    {
      description: "Nightly encrypted backups to Google Drive from GitHub Actions",
      command: "mongoshield init --github",
    },
    {
      description: "A config for an Atlas Free (M0) cluster, encrypted with a new key",
      command: "mongoshield init --preset atlas-free --keygen",
    },
  ],
  run: runInitCommand,
};

/**
 * What `init` produced, for the next steps (and for `init --github`, which sets the
 * destination's secrets and writes the workflow from it).
 */
export interface InitOutcome {
  readonly configPath: string;
  readonly storage: string;
  readonly destination: InitDestination;
  readonly setup: DestinationSetup;
  readonly uriEnv: string;
  /** The public key backups are encrypted for, if any. */
  readonly recipient: string | undefined;
  /** Where the generated secret key was written, if one was generated. */
  readonly keyFile: string | undefined;
  readonly preset: ConfigPresetName | undefined;
  /** Whether the person answered questions (versus flags and defaults). */
  readonly interactive: boolean;
}

async function runInitCommand(context: CommandContext): Promise<number> {
  if (context.flags.boolean("github")) return runInitGithubCommand(context);
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

  const { destination, storage } = answers;
  const template: InitAnswers = {
    storage,
    uriEnv: answers.uriEnv,
    storageComment: destination.configComment(storage),
    ...(destination.extraConfig === undefined
      ? {}
      : { extraConfig: destination.extraConfig(storage) }),
    ...(recipient ? { recipient } : {}),
    ...(keyFile ? { keyFile: displayPath(context, keyFile) } : {}),
    ...(answers.preset ? { preset: answers.preset } : {}),
  };
  await writeFile(configPath, generateConfigText(template), { flag: "wx" });

  const outcome: InitOutcome = {
    configPath,
    storage,
    destination,
    setup: destination.setup(storage),
    uriEnv: answers.uriEnv,
    recipient,
    keyFile,
    preset: answers.preset,
    interactive,
  };

  if (context.out.settings.json) {
    context.out.json({
      configFile: configPath,
      storage,
      destination: destination.id,
      uriEnv: answers.uriEnv,
      ...(recipient ? { recipient } : {}),
      ...(keyFile ? { identityFile: keyFile } : {}),
      ...(answers.preset ? { preset: answers.preset } : {}),
      ...(outcome.setup.secrets.length === 0
        ? {}
        : { secrets: outcome.setup.secrets.map((secret) => secret.name) }),
      ...(outcome.setup.loginProvider === undefined
        ? {}
        : { loginProvider: outcome.setup.loginProvider }),
    });
    return 0;
  }
  await printNextSteps(context, outcome);
  return 0;
}

/** Everything the wizard decides. */
interface WizardAnswers {
  readonly destination: InitDestination;
  readonly storage: string;
  readonly uriEnv: string;
  readonly encryption: EncryptionChoice;
  readonly recipient: string | undefined;
  readonly keyFile: string;
  /** From --preset only; the wizard does not ask for it. */
  readonly preset: ConfigPresetName | undefined;
}

/**
 * Non-interactive mode: flags, then defaults. `lenient` (the wizard's defaults) lets
 * a `--destination` without a usable `--storage` through: the wizard asks for it.
 */
function answersFromFlags(context: CommandContext, lenient = false): WizardAnswers {
  const { flags } = context;
  const recipient = flags.string("recipient");
  if (recipient && flags.boolean("keygen")) {
    throw usageError("--keygen and --recipient cannot be combined.", NAME);
  }
  if (recipient) assertValidRecipient(recipient);

  const uriEnv = flags.string("uri-env") ?? DEFAULTS.uriEnv;
  checkVariableName(uriEnv);

  return {
    ...destinationFromFlags(context, lenient),
    uriEnv,
    encryption: flags.boolean("keygen") ? "generate" : recipient ? "existing" : "none",
    recipient,
    keyFile: flags.string("key-file") ?? DEFAULTS.keyFile,
    preset: presetFlag(flags.string("preset")),
  };
}

/**
 * The destination and storage from `--destination` and `--storage`. Without
 * `--destination`, the storage URL's scheme picks the destination (`b2://…` → B2);
 * without either, a `./backups` directory.
 */
function destinationFromFlags(
  context: CommandContext,
  lenient: boolean,
): {
  destination: InitDestination;
  storage: string;
} {
  const storage = nonEmpty(context.flags.string("storage"));
  const id = context.flags.string("destination");
  // The parser has checked the value against the destination ids already.
  const chosen = id === undefined ? undefined : destinationById(id);
  if (chosen === undefined) {
    const location = storage ?? DEFAULTS.storage;
    return { destination: destinationForStorage(location), storage: location };
  }
  if (lenient) {
    // The wizard asks for the storage; only the menu's starting point matters here.
    return { destination: chosen, storage: storage ?? chosen.defaultStorage ?? "" };
  }
  if (storage !== undefined) {
    if (!belongsTo(chosen, storage)) {
      throw usageError(
        `--storage ${storage} is not a ${chosen.label} location. Use ${chosen.storageForm}.`,
        NAME,
      );
    }
    return { destination: chosen, storage };
  }
  if (chosen.defaultStorage === undefined) {
    throw usageError(`--destination ${chosen.id} needs --storage ${chosen.storageForm}.`, NAME);
  }
  return { destination: chosen, storage: chosen.defaultStorage };
}

/**
 * Whether `storage` can be `destination`'s storage. GitHub artifacts are a directory
 * the workflow uploads, so any directory fits.
 */
function belongsTo(destination: InitDestination, storage: string): boolean {
  if (destination.id === "github-artifacts") {
    return destinationById("directory")?.matches(storage) === true;
  }
  return destination.matches(storage);
}

/** Validates --preset against the known preset names. */
function presetFlag(value: string | undefined): ConfigPresetName | undefined {
  if (value === undefined) return undefined;
  if (isConfigPresetName(value)) return value;
  throw usageError(
    `Unknown preset "${value}". Use one of: ${CONFIG_PRESET_NAMES.join(", ")}.`,
    NAME,
  );
}

/** The interactive wizard. Flags given on the command line become the defaults. */
/** The prompt plumbing every wizard question shares (stderr, Ctrl-C, stdin). */
type PromptCommon = ReturnType<typeof promptCommon>;

/** The prompt plumbing for `context`. */
function promptCommon(context: CommandContext) {
  return {
    output: context.io.stderr,
    signal: context.signal,
    ...(context.io.stdin ? { input: context.io.stdin } : {}),
  };
}

/**
 * The destination menu and its follow-up questions: where backups go. Shared by the
 * wizard and `init --github`.
 */
async function askDestination(
  context: CommandContext,
  common: PromptCommon,
  defaults: { readonly destination: InitDestination },
): Promise<{ destination: InitDestination; storage: string }> {
  const storageFlag = nonEmpty(context.flags.string("storage"));
  const destinationFlag = context.flags.string("destination");
  // The menu starts on what the flags said, else on the first entry (Google Drive).
  const firstEntry = INIT_DESTINATIONS[0]?.id ?? "directory";
  const destinationId = answered(
    common,
    await select({
      ...common,
      message: "Where should backups go?",
      initialValue:
        storageFlag !== undefined || destinationFlag !== undefined
          ? defaults.destination.id
          : firstEntry,
      options: INIT_DESTINATIONS.map((destination) => ({
        value: destination.id,
        label: destination.label,
      })),
    }),
  );
  const chosen = destinationById(destinationId) ?? defaults.destination;
  const prompter: InitPrompter = {
    async text(question) {
      const answer = answered(
        common,
        await text({
          ...common,
          message: question.message,
          ...(question.placeholder === undefined ? {} : { placeholder: question.placeholder }),
          ...(question.initialValue === undefined ? {} : { initialValue: question.initialValue }),
          ...(question.validate === undefined
            ? {}
            : { validate: (value) => question.validate?.(value ?? "") }),
        }),
      );
      return answer.trim();
    },
  };
  // A --storage value pre-fills the follow-up answers when it is for this destination.
  const current =
    storageFlag !== undefined && belongsTo(chosen, storageFlag) ? storageFlag : undefined;
  const storage = (await chosen.ask(prompter, current)).trim();
  // Typing a URL into the directory question still gets that URL's next steps.
  const destination = belongsTo(chosen, storage) ? chosen : destinationForStorage(storage);
  return { destination, storage };
}

async function askQuestions(context: CommandContext): Promise<WizardAnswers> {
  const defaults = answersFromFlags(context, true);
  const common = promptCommon(context);
  intro("mongoshield init", common);

  const { destination, storage } = await askDestination(context, common, defaults);

  const uriEnv = answered(
    common,
    await text({
      ...common,
      message: "Which environment variable holds the MongoDB connection string?",
      initialValue: defaults.uriEnv,
      validate: (value) => (isVariableName(value ?? "") ? undefined : "Use letters, digits and _."),
    }),
  ).trim();

  const encryption = answered(
    common,
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
      common,
      await text({
        ...common,
        message: "Public key (age1…):",
        ...(defaults.recipient ? { initialValue: defaults.recipient } : {}),
        validate: (value) => recipientProblem(value ?? ""),
      }),
    ).trim();
  } else if (encryption === "generate") {
    keyFile = answered(
      common,
      await text({
        ...common,
        message: "Where should the secret key file be written?",
        initialValue: defaults.keyFile,
      }),
    ).trim();
  }

  outro("Writing your configuration…", common);
  return {
    destination,
    storage,
    uriEnv,
    encryption,
    recipient,
    keyFile,
    preset: defaults.preset,
  };
}

/**
 * Unwraps a prompt answer, turning Ctrl-C/Escape into a clean cancellation. The
 * cancel line goes to the prompts' stream (stderr): clack defaults to stdout.
 */
function answered<T>(prompts: { readonly output: Writable }, value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    cancel("Cancelled. Nothing was written.", { output: prompts.output });
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

// ---------------------------------------------------------------------------
// init --github
// ---------------------------------------------------------------------------

/**
 * `init --github`: asks only where backups go, signs in to the drive when it needs a
 * token (or takes it from the environment), then hands over to `initGithub`
 * (init-github.ts), which writes the key pair, the recovery kit, the config and the
 * workflow, sets the repository secrets and starts the first run.
 *
 * The plain wizard's encryption questions are skipped on purpose: CI backups are
 * always encrypted, for a key pair generated here whose public half becomes a
 * repository variable.
 */
async function runInitGithubCommand(context: CommandContext): Promise<number> {
  for (const flag of ["keygen", "recipient", "preset"] as const) {
    if (context.flags.string(flag) !== undefined || context.flags.boolean(flag)) {
      throw usageError(
        `--${flag} does not apply with --github: it always generates a key pair.`,
        NAME,
      );
    }
  }
  const interactive = context.out.interactive && !context.global.yes;
  const common = promptCommon(context);
  if (interactive) intro("mongoshield init --github", common);
  const { destination, storage } = interactive
    ? await askDestination(context, common, destinationFromFlags(context, true))
    : destinationFromFlags(context, false);
  const setup = destination.setup(storage);

  // The drive's token: from the environment, else a sign-in now.
  const env: NodeJS.ProcessEnv = { ...context.io.env };
  let token: string | undefined;
  if (setup.loginProvider !== undefined) {
    const provider = findLoginProvider(setup.loginProvider);
    if (provider === undefined)
      throw new MongoShieldError("MS_INTERNAL", `No login for ${setup.loginProvider}.`);
    token = nonEmpty(env[provider.tokenEnv]) ?? (await runLogin(context, provider)).refreshToken;
    context.addSecret(token);
    env[provider.tokenEnv] = token;
  }

  const uriEnv = context.flags.string("uri-env") ?? DEFAULTS.uriEnv;
  checkVariableName(uriEnv);
  const mongodbUri =
    nonEmpty(env[uriEnv]) ?? (interactive ? await askConnectionString(common) : undefined);
  if (mongodbUri !== undefined) context.addSecret(mongodbUri);

  // With --json the copy-paste commands (`gh secret set NAME < /tmp/…`) would be
  // dropped like every other text line, so they are collected for the JSON instead.
  const commands: string[] = [];
  const { out } = context;
  const output = out.settings.json
    ? {
        info: (text: string) => out.info(text),
        success: (text: string) => out.success(text),
        warn: (text: string) => out.warn(text),
        result: (text: string) => {
          commands.push(text);
        },
      }
    : out;
  const result = await initGithub({
    cwd: context.io.cwd,
    storage: githubStorageChoice(destination, storage, setup, env, token),
    version,
    ...(mongodbUri === undefined ? {} : { mongodbUri }),
    keyFile: context.flags.string("key-file") ?? DEFAULTS.keyFile,
    recoveryPassphrase: () =>
      askRecoveryPassphrase(context, {
        confirm: true,
        message: "Choose a recovery kit passphrase",
      }),
    openStorage: () => resolveStorage(storage, { env }),
    ...(interactive ? { confirm: (question: string) => askYesNo(common, question) } : {}),
    out: output,
    env,
    signal: context.signal,
  });

  if (context.out.settings.json) {
    context.out.json({
      destination: destination.id,
      storage,
      workflowFile: result.workflowFile,
      configFile: result.configFile,
      keyFile: result.keyFile,
      recipient: result.recipient,
      recoveryKit: result.recoveryKit,
      github: result.github,
      firstRun: result.firstRun,
      ...(commands.length === 0 ? {} : { commands }),
    });
  } else if (interactive) {
    outro(
      result.firstRun.status === "success"
        ? "Your first backup ran. Nightly backups are set up."
        : "Set up. Commit the workflow and run it once to check it works.",
      common,
    );
  }
  return result.firstRun.status === "failure" ? 1 : 0;
}

/**
 * The storage as `initGithub` wants it. Google Drive and GitHub artifacts have their
 * own kinds; everything else is a URL whose secrets (the drive token, B2/R2 keys...)
 * become repository secrets when they are set here.
 */
export function githubStorageChoice(
  destination: InitDestination,
  storage: string,
  setup: DestinationSetup,
  env: NodeJS.ProcessEnv,
  token: string | undefined,
): GithubStorageChoice {
  if (destination.id === "github-artifacts") return { kind: "github-artifacts" };
  if (destination.id === "gdrive" && token !== undefined) {
    return { kind: "gdrive", url: storage, refreshToken: token };
  }
  const secrets: Record<string, string> = {};
  for (const secret of setup.secrets) {
    const value = nonEmpty(env[secret.name]);
    if (value !== undefined) secrets[secret.name] = value;
  }
  return { kind: "url", url: storage, secrets };
}

/** Asks for the connection string (hidden), or nothing: initGithub then says how to set it. */
async function askConnectionString(common: PromptCommon): Promise<string | undefined> {
  const answer = answered(
    common,
    await password({
      ...common,
      message: "MongoDB connection string (stored as the MONGODB_URI secret; Enter to skip)",
    }),
  );
  return nonEmpty(answer);
}

/** A yes/no question for initGithub (commit and push the workflow?). */
async function askYesNo(common: PromptCommon, message: string): Promise<boolean> {
  return answered(common, await confirm({ ...common, message }));
}

/** What to do now: the destination's setup, then the usual commands and key reminders. */
async function printNextSteps(context: CommandContext, outcome: InitOutcome): Promise<void> {
  const { out } = context;
  out.success(`Created ${outcome.configPath}`);
  if (outcome.keyFile) {
    out.success(`Created the secret key ${outcome.keyFile} (readable only by you)`);
    out.warn(
      "Keep an offline copy of the secret key (password manager, safe). Without it, encrypted backups cannot be restored.",
    );
    await remindGitignore(context, outcome.keyFile);
  }
  for (const note of outcome.setup.notes ?? []) out.warn(note);

  const steps = [
    ...(outcome.preset === undefined ? [] : ATLAS_SETUP_STEPS),
    ...outcome.setup.steps,
    outcome.preset === undefined
      ? `export ${outcome.uriEnv}="mongodb://…"     # or set it in your secret manager`
      : `export ${outcome.uriEnv}="mongodb+srv://…/?compressors=zlib"     # or set it in your secret manager`,
    "mongoshield backup",
    "mongoshield list",
    "mongoshield verify",
  ];
  if (outcome.keyFile) {
    steps.push(
      `mongoshield restore --identity-file ${displayPath(context, outcome.keyFile)} --rename 'app.*=app_restored.*'`,
    );
  }
  out.result("Next steps:");
  steps.forEach((step, index) => {
    out.result(`  ${index + 1}. ${step}`);
  });
}

/** The Atlas side of the setup, listed first in the next steps of the Atlas presets. */
const ATLAS_SETUP_STEPS: readonly string[] = [
  'Atlas → Database Access: add a user with the role "Only read any database" (readAnyDatabase)',
  "Atlas → Network Access: allow the IP address backups run from",
];

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
