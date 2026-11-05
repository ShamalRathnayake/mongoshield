/**
 * `mongoshield login <provider>`: sign in to a drive provider (Google Drive, OneDrive,
 * Dropbox) and get the refresh token that unattended backups use.
 *
 *   mongoshield login gdrive          # shows a code to approve on any device
 *   mongoshield login dropbox         # opens a sign-in link in this machine's browser
 *   mongoshield login gdrive --gh     # stores the token as a repository secret with gh
 *
 * The token is printed exactly once, on stdout (so `… > token.txt` works), with the
 * environment variable / repository secret it belongs in on stderr. With `--gh` it
 * goes straight into `gh secret set` instead and is not printed at all (unless gh
 * fails, then it is printed so the sign-in is not wasted). `--json` prints
 * `{ provider, secretName, refreshToken }` (no token when it was saved with --gh).
 *
 * The providers live in src/cli/login/; `runLogin` is exported for `init --github`.
 */

import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { ghSecretSetCommand, setGitHubSecret } from "../github/secrets.ts";
import { findLoginProvider, loginProviders } from "../login/providers.ts";
import type { LoginInstructions, LoginProvider, LoginResult } from "../login/types.ts";

const NAME = "login";

export const loginCommand: CommandSpec = {
  name: NAME,
  summary: "Sign in to Google Drive, OneDrive or Dropbox and get the token for backups",
  description: [
    "Runs the provider's sign-in and prints the refresh token once, with the name of",
    "the secret it belongs in (MONGOSHIELD_<PROVIDER>_TOKEN). Google Drive and OneDrive",
    "show a code to approve on any device, which works over SSH too; Dropbox opens a",
    "sign-in link in a browser on this machine. MongoShield only gets access to its own",
    "folder (Google: only the files it created).",
    "With --gh the token is stored as a GitHub Actions secret with the gh CLI instead.",
  ].join("\n"),
  positionals: [{ name: "provider", description: "gdrive, onedrive or dropbox" }],
  options: {
    gh: {
      type: "boolean",
      description: "Store the token as a repository secret with `gh secret set` (not printed)",
    },
    repo: {
      type: "string",
      valueName: "<owner/name>",
      description: "With --gh: the repository (default: the one in the current directory)",
    },
    port: {
      type: "string",
      valueName: "<port>",
      description: "Browser sign-in (Dropbox): the local port to receive the answer on",
    },
  },
  examples: [
    { description: "Sign in to Google Drive", command: "mongoshield login gdrive" },
    {
      description: "Sign in and save the token as a GitHub Actions secret",
      command: "mongoshield login gdrive --gh",
    },
    {
      description: "Machine-readable output",
      command: "mongoshield login onedrive --json",
    },
  ],
  run: runLoginCommand,
};

async function runLoginCommand(context: CommandContext): Promise<number> {
  const { out, flags } = context;
  const provider = providerArgument(context.positionals);
  const repo = flags.string("repo");
  if (repo !== undefined && !flags.boolean("gh")) {
    throw usageError("--repo only applies with --gh.", NAME);
  }

  const result = await runLogin(context, provider);
  const secretName = provider.tokenEnv;

  let savedToGitHub = false;
  if (flags.boolean("gh")) {
    try {
      await setGitHubSecret(secretName, result.refreshToken, {
        repo,
        cwd: context.io.cwd,
        env: context.io.env,
        signal: context.signal,
      });
      savedToGitHub = true;
    } catch (error) {
      // The sign-in worked: print the token rather than lose it.
      out.warn(error instanceof Error ? error.message : String(error));
    }
  }

  if (out.settings.json) {
    out.json({
      provider: provider.id,
      secretName,
      ...(savedToGitHub ? { savedTo: "github" } : { refreshToken: result.refreshToken }),
      ...(result.account === undefined ? {} : { account: result.account }),
    });
    return 0;
  }

  const who = result.account === undefined ? "" : ` as ${result.account}`;
  out.success(`Signed in to ${provider.displayName}${who}.`);
  if (savedToGitHub) {
    out.success(`Saved the token as the repository secret ${secretName}.`);
    return 0;
  }
  out.info(`Save this token as the secret ${secretName}. It is shown only this once:`);
  out.result(result.refreshToken);
  out.info(
    `  GitHub Actions: ${ghSecretSetCommand(secretName, repo)}   (paste the token when asked)`,
  );
  out.info(
    `  Elsewhere:      set the environment variable ${secretName} to it, in your secret manager.`,
  );
  return 0;
}

/**
 * Runs `provider`'s sign-in with the CLI's terminal: instructions on stderr, Ctrl-C
 * to cancel. The refresh token is registered as a secret, so no error output can
 * repeat it. Exported for `init --github`.
 */
export async function runLogin(
  context: CommandContext,
  provider: LoginProvider,
): Promise<LoginResult> {
  const port = context.flags.integer("port", { min: 1, max: 65_535 });
  const result = await provider.login({
    env: context.io.env,
    signal: context.signal,
    show: (instructions) => showInstructions(context, provider, instructions),
    ...(port === undefined ? {} : { port }),
  });
  context.addSecret(result.refreshToken);
  return result;
}

/** Prints what the person has to do. Never hidden by --quiet: without it nothing works. */
function showInstructions(
  context: CommandContext,
  provider: LoginProvider,
  instructions: LoginInstructions,
): void {
  const { out } = context;
  const lines =
    instructions.kind === "device-code"
      ? [
          `To sign in to ${provider.displayName}, open ${out.style("cyan", instructions.verificationUri)}`,
          `on any device and enter the code ${out.style("bold", instructions.userCode)}`,
          ...(instructions.verificationUriComplete === undefined
            ? []
            : [`(or open ${instructions.verificationUriComplete}).`]),
          `The code expires at ${instructions.expiresAt.toLocaleTimeString()}. Waiting for approval…`,
        ]
      : [
          `To sign in to ${provider.displayName}, open this link in a browser on this machine:`,
          `  ${out.style("cyan", instructions.url)}`,
          "Waiting for the browser to come back…",
        ];
  out.stderr(`${lines.join("\n")}\n`);
}

/** The provider named on the command line. */
function providerArgument(positionals: readonly string[]): LoginProvider {
  const names = loginProviders().map((provider) => provider.id);
  // The parser already refuses more than one positional.
  const [name] = positionals;
  if (name === undefined) {
    throw usageError(`Name the provider to sign in to: ${names.join(", ")}.`, NAME);
  }
  const provider = findLoginProvider(name);
  if (provider === undefined) {
    throw usageError(`Unknown provider "${name}". Use one of: ${names.join(", ")}.`, NAME);
  }
  return provider;
}
