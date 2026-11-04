/**
 * Setting GitHub Actions repository secrets with the gh CLI, for `mongoshield login
 * --gh` (and `init --github`): the value goes to `gh secret set <NAME>` on stdin, so
 * it never appears in a process list, a shell history or our output.
 *
 *   await setGitHubSecret("MONGOSHIELD_GDRIVE_TOKEN", token, { cwd, env });
 *   ghSecretSetCommand("MONGOSHIELD_GDRIVE_TOKEN")   // "gh secret set MONGOSHIELD_GDRIVE_TOKEN"
 *
 * Only the CLI calls this: library code never starts other programs.
 */

import { spawn } from "node:child_process";
import { MongoShieldError } from "../../errors.ts";
import { redactSecrets } from "../../redact.ts";

/** Options for {@link setGitHubSecret}. */
export interface GitHubSecretOptions {
  /** `owner/name`; without it gh uses the repository of `cwd`. */
  readonly repo?: string | undefined;
  /** The directory gh runs in (its repository is the default target). */
  readonly cwd: string;
  /** The environment gh runs with (PATH, GH_TOKEN, …). */
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}

/** How much of gh's error output is quoted in a failure. */
const MAX_STDERR = 2000;

/** `owner/name`, as gh's --repo flag takes it (also `host/owner/name`). */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+(\/[\w.-]+)?$/;

/** The command to set a secret by hand (it prompts for the value). */
export function ghSecretSetCommand(name: string, repo?: string): string {
  return repo === undefined ? `gh secret set ${name}` : `gh secret set ${name} --repo ${repo}`;
}

/**
 * Sets the repository secret `name` to `value` with `gh secret set`.
 *
 * @throws MS_CONFIG_INVALID when gh is not installed, not logged in, or refuses
 *   (its message is quoted with the value removed); MS_ABORTED when the signal fires.
 */
export async function setGitHubSecret(
  name: string,
  value: string,
  options: GitHubSecretOptions,
): Promise<void> {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
    throw new MongoShieldError("MS_INTERNAL", `"${name}" is not a valid secret name.`);
  }
  if (options.repo !== undefined && !REPO_PATTERN.test(options.repo)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `"${options.repo}" is not a GitHub repository.`,
      {
        hint: "Use owner/name, e.g. --repo acme/web.",
      },
    );
  }
  const args = [
    "secret",
    "set",
    name,
    ...(options.repo === undefined ? [] : ["--repo", options.repo]),
  ];
  const child = spawn("gh", args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "ignore", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    if (stderr.length < MAX_STDERR) stderr += text;
  });

  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  // A closed stdin (gh exited early) must not crash the process; the exit code says why.
  child.stdin.on("error", () => undefined);
  child.stdin.end(value);

  let code: number | null;
  try {
    code = await exit;
  } catch (error) {
    if (options.signal?.aborted) {
      throw new MongoShieldError("MS_ABORTED", "Cancelled while setting the GitHub secret.");
    }
    const missing = (error as { code?: unknown }).code === "ENOENT";
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      missing ? "The GitHub CLI (gh) is not installed." : "Could not run the GitHub CLI (gh).",
      {
        cause: error,
        hint: `Install gh from https://cli.github.com and run \`gh auth login\`, or set the secret by hand: ${ghSecretSetCommand(name, options.repo)}`,
      },
    );
  }
  if (code !== 0) {
    const detail = redactSecrets(stderr, [value]).trim().split("\n").at(-1) ?? "";
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `gh could not set the secret ${name}${detail === "" ? "" : `: ${detail}`}`,
      {
        hint: `Run \`gh auth login\` (with access to the repository), or set it by hand: ${ghSecretSetCommand(name, options.repo)}`,
        details: { exitCode: code },
      },
    );
  }
}
