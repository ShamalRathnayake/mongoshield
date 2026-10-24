/**
 * Flags used by more than one command, defined once so their wording and
 * behaviour stay identical everywhere, plus helpers to read them.
 */

import { MongoShieldError } from "../../errors.ts";
import { usageError } from "../args.ts";
import type { CommandContext, OptionSpec } from "../command.ts";

export const includeOption: OptionSpec = {
  type: "string",
  multiple: true,
  valueName: "<pattern>",
  description: "Only these namespaces, e.g. app.* or app.users",
};

export const excludeOption: OptionSpec = {
  type: "string",
  multiple: true,
  valueName: "<pattern>",
  description: "Skip these namespaces, e.g. *.audit_*",
};

export const identityFileOption: OptionSpec = {
  type: "string",
  multiple: true,
  valueName: "<path>",
  description: "age identity file for encrypted backups (from `mongoshield keygen`)",
};

export const passphraseEnvOption: OptionSpec = {
  type: "string",
  valueName: "<VAR>",
  description: "Read the encryption passphrase from this environment variable",
};

export const storageFromOption: OptionSpec = {
  type: "string",
  valueName: "<storage-url>",
  description: "Where backups are stored: ./dir, file:///abs, s3://bucket/prefix (default: config)",
};

/**
 * Parses repeated `key=value` flags (`--label env=prod`, `--rename 'a.*=b.*'`).
 * Splits on the first `=` only, so values may themselves contain `=`.
 */
export function parseKeyValues(
  context: CommandContext,
  commandName: string,
  flag: string,
): Record<string, string> | undefined {
  const values = context.flags.list(flag);
  if (values.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const item of values) {
    const separator = item.indexOf("=");
    const key = separator > 0 ? item.slice(0, separator).trim() : "";
    const value = separator > 0 ? item.slice(separator + 1).trim() : "";
    if (key === "" || value === "") {
      throw usageError(`--${flag} expects key=value (got "${item}").`, commandName);
    }
    if (Object.hasOwn(result, key)) {
      throw usageError(`--${flag} gives "${key}" twice.`, commandName);
    }
    result[key] = value;
  }
  return result;
}

/** The non-empty list of a repeatable flag, or `undefined` so config values apply. */
export function listOrUndefined(context: CommandContext, flag: string): string[] | undefined {
  const values = context.flags.list(flag);
  return values.length > 0 ? values : undefined;
}

/** The backup selector positional: an id, or "latest" (the default). */
export function backupSelectorArgument(context: CommandContext): string {
  const value = context.positionals[0];
  if (value === undefined || value === "") return "latest";
  return value;
}

/** Rejects two flags that contradict each other, e.g. `--recipient` with `--passphrase-env`. */
export function assertNotBoth(
  context: CommandContext,
  commandName: string,
  first: string,
  second: string,
): void {
  if (context.flags.has(first) && context.flags.has(second)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `--${first} and --${second} cannot be combined.`,
      {
        hint: `Run \`mongoshield ${commandName} --help\` for details.`,
      },
    );
  }
}

/** Holds and releases are deliberate acts, so the backup must be named (no implicit "latest"). */
export function requiredBackupArgument(context: CommandContext, command: string): string {
  const value = context.positionals[0];
  if (!value) {
    throw new MongoShieldError("MS_CONFIG_INVALID", 'Which backup? Pass an id or "latest".', {
      hint: `Example: mongoshield ${command} latest. Run \`mongoshield list\` to see the ids.`,
    });
  }
  return value;
}
