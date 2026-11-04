/**
 * `mongoshield init --github`: everything after "where do backups go?", so that a
 * fresh GitHub repository has nightly encrypted backups and a first successful run
 * before the developer closes the terminal (docs/guides/atlas-free-netlify.md).
 *
 * `init` asks for the destination (and runs `mongoshield login gdrive` for Google
 * Drive), then calls {@link initGithub} with the answer. In order, it:
 *
 *   1. generates an age key pair: the secret key is saved locally (0600, never
 *      overwritten, added to .gitignore), the public key becomes the repository
 *      variable MONGOSHIELD_RECIPIENTS, so CI can encrypt but never decrypt;
 *   2. writes the recovery kit (a passphrase-protected copy of the secret key) to the
 *      storage root, see src/crypto/recovery-kit.ts. Not for GitHub artifacts, which
 *      have no lasting root;
 *   3. writes `mongoshield.config.json` (unless a config exists): storage, the nightly
 *      schedule (verify "fast", and lock "none" where storage cannot hold a lock) and
 *      retention { last: 7, weekly: 4, monthly: 6 };
 *   4. writes `.github/workflows/mongoshield-backup.yml`: nightly plus
 *      `workflow_dispatch`, `concurrency: mongoshield-backup`, the MongoShield Action
 *      pinned to a commit SHA (or the release tag) running `command: run` (backup,
 *      verify, prune). For GitHub artifacts it also uploads `backups/`;
 *   5. sets the secrets and the variable with the `gh` CLI when `gh auth status`
 *      succeeds (secrets go on stdin, never on a command line), and otherwise prints
 *      copy-paste `gh secret set` / `gh variable set` lines whose secret values sit
 *      in 0600 temporary files, so they are never printed;
 *   6. offers to commit and push the two files (GitHub only runs workflows that are on
 *      the default branch), starts the first run with `gh workflow run`, follows it
 *      with `gh run watch` and prints the result.
 *
 * Every external command goes through an injectable {@link CommandRunner}, so tests
 * check the exact `gh`/`git` calls without running them. Secrets never reach an
 * output line: the caller registers them with `context.addSecret` as well.
 */

import { spawn } from "node:child_process";
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CONFIG_FILE_NAMES } from "../../config/load.ts";
import { generateIdentity } from "../../crypto/index.ts";
import { writeRecoveryKit } from "../../crypto/recovery-kit.ts";
import { abortError, MongoShieldError, throwIfAborted } from "../../errors.ts";
import { gdriveStorageFromUrl } from "../../storage/gdrive.ts";
import { GDRIVE_TOKEN_SECRET } from "../../storage/gdrive-auth.ts";
import type { StorageAdapter } from "../../storage/types.ts";
import { identityFileText, writeIdentityFile } from "./keygen.ts";

/** The workflow file, relative to the repository root. */
export const GITHUB_WORKFLOW_FILE = ".github/workflows/mongoshield-backup.yml";
/** The workflow's concurrency group: one backup run at a time, never cancelled. */
export const GITHUB_CONCURRENCY_GROUP = "mongoshield-backup";
/** The config file written when the repository has none. */
export const GITHUB_CONFIG_FILE = "mongoshield.config.json";
/** Repository variable with the public key(s) backups are encrypted to. */
export const RECIPIENTS_VARIABLE = "MONGOSHIELD_RECIPIENTS";
/** Repository secret with the connection string. */
export const MONGODB_URI_SECRET = "MONGODB_URI";
/** Nightly at 03:17 UTC (an odd minute avoids the top-of-the-hour rush on runners). */
export const GITHUB_BACKUP_CRON = "17 3 * * *";
/** What the nightly job keeps (the design's retention for the accessible track). */
export const GITHUB_RETENTION = { last: 7, weekly: 4, monthly: 6 } as const;
/** The Action's repository; `/action` is the Action inside it. */
const ACTION_REPOSITORY = "ShamalRathnayake/mongoshield";
/** Actions used by the workflow, pinned by commit SHA like this repository's own workflows. */
const CHECKOUT_ACTION = "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0";
const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2";
/** GitHub keeps artifacts at most 90 days (the repository setting can only shorten it). */
const ARTIFACT_RETENTION_DAYS = 90;
/** Default secret key file, in the repository root (and added to .gitignore). */
const DEFAULT_KEY_FILE = "mongoshield.key";
/** How long to wait for GitHub to list a run that was just dispatched. */
const RUN_LOOKUP_ATTEMPTS = 30;
const RUN_LOOKUP_DELAY_MS = 2000;

/** Where the backups go, as chosen in `init`. */
export type GithubStorageChoice =
  /** Google Drive: `gdrive://<folder>` and the refresh token from `mongoshield login gdrive`. */
  | { readonly kind: "gdrive"; readonly url: string; readonly refreshToken: string }
  /** GitHub artifacts: quickest to try; deleted after 90 days at most, so not a real backup on its own. */
  | { readonly kind: "github-artifacts" }
  /**
   * Any other storage URL. `secrets` are set as repository secrets and passed to the
   * Action as environment variables; `lock` is the schedule lock (default "storage").
   */
  | {
      readonly kind: "url";
      readonly url: string;
      readonly secrets?: Readonly<Record<string, string>>;
      readonly lock?: "storage" | "mongo" | "none";
    };

/** What an external command printed and returned. */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs an external command (`gh`, `git`). `input` is written to its stdin. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly input?: string },
) => Promise<CommandResult>;

/** Where {@link initGithub} reports progress (the CLI's `Output` fits). */
export interface InitGithubOutput {
  info(text: string): void;
  success(text: string): void;
  warn(text: string): void;
  /** Copy-paste lines; printed even with --quiet. */
  result(text: string): void;
}

/** Options for {@link initGithub}. */
export interface InitGithubOptions {
  /** The repository root (where the workflow and config are written). */
  readonly cwd: string;
  readonly storage: GithubStorageChoice;
  /** The running MongoShield version; the Action is pinned to its release. */
  readonly version: string;
  /** The connection string, set as the MONGODB_URI secret. Without it the user is told how. */
  readonly mongodbUri?: string;
  /** Where to save the secret key (default `mongoshield.key`). Never overwritten. */
  readonly keyFile?: string;
  /** Asks for (or reads) the recovery kit passphrase. Required unless the storage is GitHub artifacts. */
  readonly recoveryPassphrase?: () => Promise<string>;
  /** Opens the storage for the recovery kit. Default: the gdrive adapter for Google Drive. */
  readonly openStorage?: () => Promise<StorageAdapter>;
  /** An existing config file to use instead of writing mongoshield.config.json. */
  readonly configFile?: string;
  /** Asks a yes/no question; without it every question is answered "no". */
  readonly confirm?: (question: string) => Promise<boolean>;
  /** Start and watch the first run (default true). */
  readonly firstRun?: boolean;
  readonly out: InitGithubOutput;
  /** Runs `gh` and `git`. Default: the real commands, in `cwd`. */
  readonly run?: CommandRunner;
  /** Environment for the storage adapter (OAuth client overrides). Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Waits between polls; replaceable in tests. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Recovery kit scrypt cost (tests lower it). */
  readonly scryptWorkFactor?: number;
  readonly signal?: AbortSignal;
}

/** How the first run went. */
export interface FirstRunResult {
  readonly status: "success" | "failure" | "not-started";
  readonly runId?: string;
  readonly url?: string;
}

/** What {@link initGithub} did. */
export interface InitGithubResult {
  readonly workflowFile: string;
  readonly configFile: string;
  readonly keyFile: string;
  /** The public key backups are encrypted to. */
  readonly recipient: string;
  readonly recoveryKit: boolean;
  /** `configured` when `gh` set every secret and variable, `manual` when the user must. */
  readonly github: "configured" | "manual";
  readonly firstRun: FirstRunResult;
}

/** The inputs of the workflow template. */
export interface GithubWorkflowInput {
  readonly storage: GithubStorageChoice;
  /** `ShamalRathnayake/mongoshield/action@<sha> # v2.1.0`, or `@v2.1.0`. */
  readonly actionRef: string;
  readonly configFile: string;
  readonly cron?: string;
}

/** Runs the whole `init --github` flow described in the file header. */
export async function initGithub(options: InitGithubOptions): Promise<InitGithubResult> {
  const { out, signal } = options;
  const run = options.run ?? spawnRunner(options.cwd);
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds, signal));
  throwIfAborted(signal);

  // 1. The key pair.
  const keyFile = resolve(options.cwd, options.keyFile ?? DEFAULT_KEY_FILE);
  const { identity, recipient } = generateIdentity();
  await writeIdentityFile(keyFile, identityFileText(identity, recipient));
  out.success(`Saved the secret key to ${display(options.cwd, keyFile)} (keep an offline copy).`);
  await ignoreInGit(options.cwd, keyFile, out);

  // 2. The recovery kit, next to the backups.
  const recoveryKit = await writeKit(options, identity);

  // 3 and 4. The config and the workflow.
  const configFile = await ensureConfig(options);
  const actionRef = await resolveActionRef(run, options.version);
  const workflowPath = resolve(options.cwd, GITHUB_WORKFLOW_FILE);
  await mkdir(dirname(workflowPath), { recursive: true });
  await writeNew(
    workflowPath,
    githubWorkflowText({ storage: options.storage, actionRef, configFile }),
    "Delete it first to generate a new one.",
  );
  out.success(`Wrote ${GITHUB_WORKFLOW_FILE}.`);

  // 5. Secrets and variables.
  const loggedIn = (await run("gh", ["auth", "status"])).exitCode === 0;
  const settings = repositorySettings(options, recipient);
  const github = loggedIn
    ? await setWithGh(run, settings, out)
    : await printManualSetup(settings, options, out);

  // 6. The first run.
  const firstRun =
    loggedIn && github === "configured" && options.firstRun !== false
      ? await startFirstRun(options, run, sleep, configFile)
      : notStarted(out, loggedIn);

  return {
    workflowFile: GITHUB_WORKFLOW_FILE,
    configFile,
    keyFile,
    recipient,
    recoveryKit,
    github,
    firstRun,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** The schedule lock for a destination. Google Drive cannot refuse a duplicate name. */
export function githubLockFor(storage: GithubStorageChoice): "storage" | "mongo" | "none" {
  if (storage.kind === "gdrive") return "none";
  if (storage.kind === "url") return storage.lock ?? "storage";
  return "storage";
}

/** The storage URL written to the config. */
function storageUrlOf(storage: GithubStorageChoice): string {
  return storage.kind === "github-artifacts" ? "./backups" : storage.url;
}

/** Secrets the Action step needs as environment variables (storage tokens). */
function storageSecrets(storage: GithubStorageChoice): Readonly<Record<string, string>> {
  if (storage.kind === "gdrive") return { [GDRIVE_TOKEN_SECRET]: storage.refreshToken };
  if (storage.kind === "url") return storage.secrets ?? {};
  return {};
}

/** The text of `mongoshield.config.json`. */
export function githubConfigText(storage: GithubStorageChoice, cron = GITHUB_BACKUP_CRON): string {
  const config = {
    storage: storageUrlOf(storage),
    schedule: { cron, lock: githubLockFor(storage), verify: "fast" },
    retention: GITHUB_RETENTION,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The text of `.github/workflows/mongoshield-backup.yml`. */
export function githubWorkflowText(input: GithubWorkflowInput): string {
  const cron = input.cron ?? GITHUB_BACKUP_CRON;
  const secretNames = Object.keys(storageSecrets(input.storage));
  const artifacts = input.storage.kind === "github-artifacts";
  const lines = [
    "# Nightly MongoDB backups with MongoShield, written by `mongoshield init --github`.",
    "# Backups are encrypted to the public key in the MONGOSHIELD_RECIPIENTS variable;",
    "# the secret key never comes near this workflow. Settings (storage, retention, verify)",
    `# live in ${input.configFile}. Docs: https://github.com/${ACTION_REPOSITORY}/tree/main/action`,
    "name: MongoShield backup",
    "",
    "on:",
    "  schedule:",
    `    - cron: "${cron}"`,
    "  workflow_dispatch:",
    "",
    "# One backup at a time, and never cancelled midway. This is also what keeps two runs",
    "# apart on storage that cannot hold a lock (Google Drive).",
    "concurrency:",
    `  group: ${GITHUB_CONCURRENCY_GROUP}`,
    "  cancel-in-progress: false",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  backup:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 120",
    "    steps:",
    `      - uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          persist-credentials: false",
    "      # Refuse to run without the public key rather than write unencrypted backups.",
    "      - name: Check the encryption key is set",
    "        env:",
    `          RECIPIENTS: \${{ vars.${RECIPIENTS_VARIABLE} }}`,
    "        run: |",
    '          if [ -z "$RECIPIENTS" ]; then',
    `            echo "::error::Set the repository variable ${RECIPIENTS_VARIABLE} to the public key (age1...) printed by mongoshield init."`,
    "            exit 1",
    "          fi",
    "      # Backup, verify and prune (retention) in one run, as configured.",
    "      - name: Back up, verify and prune",
    `        uses: ${input.actionRef}`,
    "        with:",
    "          command: run",
    `          config: ${input.configFile}`,
    `          uri: \${{ secrets.${MONGODB_URI_SECRET} }}`,
    `          recipients: \${{ vars.${RECIPIENTS_VARIABLE} }}`,
    ...(secretNames.length === 0
      ? []
      : [
          "        env:",
          ...secretNames.map((name) => `          ${name}: \${{ secrets.${name} }}`),
        ]),
    ...(artifacts
      ? [
          "      # GitHub artifacts: quickest to try, but deleted after 90 days at most,",
          "      # so not a real backup on its own.",
          `      - uses: ${UPLOAD_ARTIFACT_ACTION}`,
          "        with:",
          `          name: mongoshield-backup-\${{ github.run_id }}`,
          "          path: backups/",
          `          retention-days: ${ARTIFACT_RETENTION_DAYS}`,
          "          if-no-files-found: error",
        ]
      : []),
    "",
  ];
  return lines.join("\n");
}

/**
 * The Action reference: the commit SHA of this release's tag (what action/README.md
 * recommends for a fully fixed setup), or the release tag when `gh` cannot look it up.
 */
export async function resolveActionRef(run: CommandRunner, version: string): Promise<string> {
  const tag = `v${version}`;
  const lookup = await run("gh", [
    "api",
    `repos/${ACTION_REPOSITORY}/commits/${tag}`,
    "--jq",
    ".sha",
  ]).catch(() => undefined);
  const sha = lookup?.exitCode === 0 ? lookup.stdout.trim() : "";
  if (/^[0-9a-f]{40}$/.test(sha)) return `${ACTION_REPOSITORY}/action@${sha} # ${tag}`;
  return `${ACTION_REPOSITORY}/action@${tag}`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Writes the recovery kit to the storage root; skipped for GitHub artifacts. */
async function writeKit(options: InitGithubOptions, identity: string): Promise<boolean> {
  const { out, storage } = options;
  if (storage.kind === "github-artifacts") {
    out.warn(
      "GitHub artifacts have no lasting storage for a recovery kit: keep an offline copy of the secret key.",
    );
    return false;
  }
  if (!options.recoveryPassphrase) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The recovery kit needs a passphrase.", {
      hint: "Set MONGOSHIELD_RECOVERY_PASSPHRASE, or run init on a terminal.",
    });
  }
  const passphrase = await options.recoveryPassphrase();
  const adapter = await openStorageFor(options);
  try {
    const written = await writeRecoveryKit(adapter, {
      identity,
      passphrase,
      ...(options.scryptWorkFactor === undefined
        ? {}
        : { scryptWorkFactor: options.scryptWorkFactor }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    out.success(
      `Wrote the recovery kit to ${adapter.location}${written.key}. Remember its passphrase: restore asks for it.`,
    );
  } finally {
    await adapter.close?.();
  }
  return true;
}

/** The storage the kit goes to: the caller's opener, or the gdrive adapter. */
async function openStorageFor(options: InitGithubOptions): Promise<StorageAdapter> {
  if (options.openStorage) return options.openStorage();
  const { storage } = options;
  if (storage.kind === "gdrive") {
    return gdriveStorageFromUrl(new URL(storage.url), {
      ...(options.env ?? process.env),
      [GDRIVE_TOKEN_SECRET]: storage.refreshToken,
    });
  }
  throw new MongoShieldError("MS_INTERNAL", "initGithub needs openStorage for this destination.");
}

/** Uses an existing config, or writes mongoshield.config.json. Returns its path in the repo. */
async function ensureConfig(options: InitGithubOptions): Promise<string> {
  const { out, cwd } = options;
  if (options.configFile) return relative(cwd, resolve(cwd, options.configFile));
  for (const name of CONFIG_FILE_NAMES) {
    if (await exists(resolve(cwd, name))) {
      out.warn(
        `Using the existing ${name}. Check that it has storage "${storageUrlOf(options.storage)}", ` +
          `schedule.lock "${githubLockFor(options.storage)}" and the retention you want.`,
      );
      return name;
    }
  }
  await writeNew(resolve(cwd, GITHUB_CONFIG_FILE), githubConfigText(options.storage), "");
  out.success(`Wrote ${GITHUB_CONFIG_FILE}.`);
  return GITHUB_CONFIG_FILE;
}

/** One repository secret or variable. */
interface RepositorySetting {
  readonly kind: "secret" | "variable";
  readonly name: string;
  /** Undefined: not known here (the user sets it, e.g. the connection string). */
  readonly value: string | undefined;
}

function repositorySettings(options: InitGithubOptions, recipient: string): RepositorySetting[] {
  const settings: RepositorySetting[] = [
    { kind: "variable", name: RECIPIENTS_VARIABLE, value: recipient },
    { kind: "secret", name: MONGODB_URI_SECRET, value: options.mongodbUri },
  ];
  for (const [name, value] of Object.entries(storageSecrets(options.storage))) {
    settings.push({ kind: "secret", name, value });
  }
  return settings;
}

/** Sets everything with `gh`. Secrets go on stdin so they never show in a process list. */
async function setWithGh(
  run: CommandRunner,
  settings: readonly RepositorySetting[],
  out: InitGithubOutput,
): Promise<"configured" | "manual"> {
  let complete = true;
  for (const setting of settings) {
    if (setting.value === undefined) {
      out.warn(`Set the secret ${setting.name} yourself: gh secret set ${setting.name}`);
      complete = false;
      continue;
    }
    const result =
      setting.kind === "secret"
        ? await run("gh", ["secret", "set", setting.name], { input: setting.value })
        : await run("gh", ["variable", "set", setting.name, "--body", setting.value]);
    if (result.exitCode === 0) {
      out.success(`Set the repository ${setting.kind} ${setting.name}.`);
    } else {
      out.warn(`gh could not set the ${setting.kind} ${setting.name}: ${firstLine(result.stderr)}`);
      complete = false;
    }
  }
  return complete ? "configured" : "manual";
}

/**
 * Without `gh`: copy-paste lines. Secret values are written to 0600 files in a fresh
 * temporary directory and read from there with `<`, so the terminal never shows them.
 */
async function printManualSetup(
  settings: readonly RepositorySetting[],
  options: InitGithubOptions,
  out: InitGithubOutput,
): Promise<"manual"> {
  out.warn("The gh CLI is not logged in (gh auth status), so set these yourself:");
  const secretsDir = await mkdtemp(join(tmpdir(), "mongoshield-secrets-"));
  let wroteSecret = false;
  for (const setting of settings) {
    if (setting.kind === "variable") {
      out.result(`gh variable set ${setting.name} --body '${setting.value ?? ""}'`);
    } else if (setting.value === undefined) {
      out.result(`gh secret set ${setting.name}`);
    } else {
      const file = join(secretsDir, setting.name);
      await writeFile(file, setting.value, { mode: 0o600, flag: "wx" });
      out.result(`gh secret set ${setting.name} < ${file}`);
      wroteSecret = true;
    }
  }
  if (wroteSecret) out.result(`rm -r ${secretsDir}`);
  out.result(
    `git add ${GITHUB_WORKFLOW_FILE} ${options.configFile ?? GITHUB_CONFIG_FILE} && git commit -m "ci: add MongoShield nightly backups" && git push`,
  );
  out.result(`gh workflow run ${basenameOf(GITHUB_WORKFLOW_FILE)}`);
  return "manual";
}

/** Why the first run was not started, and how to start it. */
function notStarted(out: InitGithubOutput, loggedIn: boolean): FirstRunResult {
  if (loggedIn) {
    out.info(
      `Start the first backup when ready: gh workflow run ${basenameOf(GITHUB_WORKFLOW_FILE)}`,
    );
  }
  return { status: "not-started" };
}

/**
 * Pushes the workflow if GitHub does not know it yet (after asking), dispatches it,
 * finds the new run, watches it to the end and reports the outcome.
 */
async function startFirstRun(
  options: InitGithubOptions,
  run: CommandRunner,
  sleep: (milliseconds: number) => Promise<void>,
  configFile: string,
): Promise<FirstRunResult> {
  const { out } = options;
  const workflow = basenameOf(GITHUB_WORKFLOW_FILE);
  if (!(await workflowKnown(run, workflow))) {
    const pushed = await commitAndPush(options, run, configFile);
    if (!pushed) return notStarted(out, true);
    // GitHub registers a pushed workflow after a moment.
    let known = false;
    for (let attempt = 0; attempt < 10 && !known; attempt++) {
      await sleep(RUN_LOOKUP_DELAY_MS);
      known = await workflowKnown(run, workflow);
    }
    if (!known) {
      out.warn("GitHub has not picked up the workflow yet.");
      return notStarted(out, true);
    }
  }

  const before = new Set((await recentRuns(run, workflow)).map((entry) => entry.id));
  const dispatch = await run("gh", ["workflow", "run", workflow]);
  if (dispatch.exitCode !== 0) {
    out.warn(`Could not start the first run: ${firstLine(dispatch.stderr)}`);
    return notStarted(out, true);
  }
  out.info("Started the first backup run; waiting for GitHub to schedule it…");

  let started: RunEntry | undefined;
  for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS && !started; attempt++) {
    await sleep(RUN_LOOKUP_DELAY_MS);
    started = (await recentRuns(run, workflow)).find((entry) => !before.has(entry.id));
  }
  if (!started) {
    out.warn(`Could not find the run that was started. See: gh run list --workflow ${workflow}`);
    return { status: "not-started" };
  }
  out.info(`Following the run${started.url ? ` (${started.url})` : ""}…`);
  const watched = await run("gh", ["run", "watch", started.id, "--exit-status"]);
  const view = await run("gh", ["run", "view", started.id, "--json", "conclusion,url"]);
  const url = stringField(parseJson(view.stdout), "url") ?? started.url;
  const success = watched.exitCode === 0;
  if (success) out.success(`The first backup succeeded${url ? `: ${url}` : "."}`);
  else
    out.warn(
      `The first backup failed${url ? `: ${url}` : ""}. See the log: gh run view ${started.id} --log-failed`,
    );
  return {
    status: success ? "success" : "failure",
    runId: started.id,
    ...(url ? { url } : {}),
  };
}

/** True when GitHub knows the workflow (it is on the default branch). */
async function workflowKnown(run: CommandRunner, workflow: string): Promise<boolean> {
  return (await run("gh", ["workflow", "view", workflow, "--yaml"])).exitCode === 0;
}

/** Commits exactly the workflow and the config, then pushes, if the user agrees. */
async function commitAndPush(
  options: InitGithubOptions,
  run: CommandRunner,
  configFile: string,
): Promise<boolean> {
  const files = [GITHUB_WORKFLOW_FILE, configFile];
  const question = `Commit ${files.join(" and ")} and push, so GitHub can run the workflow?`;
  const agreed = options.confirm ? await options.confirm(question) : false;
  if (!agreed) {
    options.out.info(
      `Push the workflow, then start it: git add ${files.join(" ")} && git commit && git push`,
    );
    return false;
  }
  const steps: (readonly string[])[] = [
    ["add", "--", ...files],
    ["commit", "-m", "ci: add MongoShield nightly backups", "--", ...files],
    ["push"],
  ];
  for (const args of steps) {
    const result = await run("git", args);
    if (result.exitCode !== 0) {
      options.out.warn(`git ${args[0]} failed: ${firstLine(result.stderr)}`);
      return false;
    }
  }
  options.out.success("Pushed the workflow.");
  return true;
}

/** One entry of `gh run list --json databaseId,url`. */
interface RunEntry {
  readonly id: string;
  readonly url: string | undefined;
}

async function recentRuns(run: CommandRunner, workflow: string): Promise<RunEntry[]> {
  const result = await run("gh", [
    "run",
    "list",
    "--workflow",
    workflow,
    "--event",
    "workflow_dispatch",
    "--limit",
    "10",
    "--json",
    "databaseId,url",
  ]);
  if (result.exitCode !== 0) return [];
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return [];
  const runs: RunEntry[] = [];
  for (const item of parsed) {
    const id = propertyOf(item, "databaseId");
    if (typeof id === "number" || typeof id === "string") {
      runs.push({ id: String(id), url: stringField(item, "url") });
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** The real command runner: no shell, so arguments are never interpreted. */
export function spawnRunner(cwd: string): CommandRunner {
  return (command, args, runOptions = {}) =>
    new Promise((resolvePromise) => {
      const child = spawn(command, [...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // A missing binary (no gh installed) is an ordinary failure, not a crash.
      child.on("error", (error) =>
        resolvePromise({ exitCode: 127, stdout, stderr: error.message }),
      );
      child.on("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(runOptions.input ?? "");
    });
}

/** Adds the key file to .gitignore (creating it) unless it is already covered. */
async function ignoreInGit(cwd: string, keyFile: string, out: InitGithubOutput): Promise<void> {
  const relativePath = relative(cwd, keyFile);
  if (relativePath.startsWith("..")) return;
  const gitignorePath = resolve(cwd, ".gitignore");
  const gitignore = await readFile(gitignorePath, "utf8").catch(() => "");
  const covered = gitignore
    .split(/\r?\n/)
    .some((line) => ["*.key", relativePath, `/${relativePath}`].includes(line.trim()));
  if (covered) return;
  const separator = gitignore === "" || gitignore.endsWith("\n") ? "" : "\n";
  await appendFile(
    gitignorePath,
    `${separator}# MongoShield secret key: never commit it\n/${relativePath}\n`,
  );
  out.info(`Added ${relativePath} to .gitignore.`);
}

/** Writes a file that must not exist yet. */
async function writeNew(path: string, text: string, hint: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `${path} already exists; refusing to overwrite it.`,
        {
          ...(hint ? { hint } : {}),
        },
      );
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function display(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  return relativePath.startsWith("..") ? path : `./${relativePath}`;
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? "";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function propertyOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

function stringField(value: unknown, name: string): string | undefined {
  const field = propertyOf(value, name);
  return typeof field === "string" && field !== "" ? field : undefined;
}

/** A sleep that stops with MS_ABORTED when the signal fires. */
function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}
