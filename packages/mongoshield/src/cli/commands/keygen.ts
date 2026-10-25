/**
 * `mongoshield keygen`: create an age key pair for encrypted backups.
 *
 *   identity  (AGE-SECRET-KEY-1…)  secret; needed only to restore. Keep it offline.
 *   recipient (age1…)              public; configure it where backups run.
 *
 * The key file format is the same as `age-keygen`'s, so either tool can use it.
 * Without --output, the key file text goes to stdout (so `mongoshield keygen >
 * key.txt` works like `age-keygen > key.txt`) and a warning goes to stderr.
 */

import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { generateIdentity } from "../../crypto/index.ts";
import { MongoShieldError } from "../../errors.ts";
import type { CommandContext, CommandSpec } from "../command.ts";

export const keygenCommand: CommandSpec = {
  name: "keygen",
  summary: "Generate an age key pair for encrypted backups",
  description: [
    "The public recipient (age1…) goes in your config: backups only need it.",
    "The secret identity is needed to restore. Store a copy offline (password",
    "manager, printed in a safe): if it is lost, encrypted backups cannot be read.",
  ].join("\n"),
  options: {
    output: {
      type: "string",
      short: "o",
      valueName: "<path>",
      description: "Write the identity to this file (mode 0600; never overwrites)",
    },
  },
  examples: [
    { description: "Create a key file", command: "mongoshield keygen --output backup.key" },
    {
      description: "Use the public key for backups",
      command: "mongoshield backup --recipient age1…",
    },
  ],
  run: runKeygenCommand,
};

async function runKeygenCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const { identity, recipient } = generateIdentity();
  context.addSecret(identity);
  const output = context.flags.string("output");

  if (output) {
    const path = isAbsolute(output) ? output : resolve(context.io.cwd, output);
    await writeIdentityFile(path, identityFileText(identity, recipient));
    if (out.settings.json) {
      out.json({ recipient, identityFile: path });
      return 0;
    }
    out.success(`Wrote the secret identity to ${path} (readable only by you).`);
    out.info("Keep an offline copy: without it, encrypted backups cannot be restored.");
    out.info(`Public key (use with --recipient or encryption.recipients):`);
    out.result(recipient);
    return 0;
  }

  if (out.settings.json) {
    out.json({ recipient, identity });
  } else {
    out.result(identityFileText(identity, recipient).trimEnd());
  }
  out.warn(
    "The AGE-SECRET-KEY line is a secret. Save it to a file only you can read, keep an offline copy, and never commit it. Prefer --output <file>.",
  );
  return 0;
}

/** The age key file format: two comment lines, then the identity. */
export function identityFileText(identity: string, recipient: string): string {
  return [
    `# created: ${new Date().toISOString()}`,
    `# public key: ${recipient}`,
    identity,
    "",
  ].join("\n");
}

/**
 * Writes a secret key file with mode 0600, refusing to overwrite: replacing an
 * existing key would make every backup encrypted to it unrecoverable.
 */
export async function writeIdentityFile(path: string, text: string): Promise<void> {
  try {
    // "wx" fails if the file exists; the mode applies at creation, so the key
    // is never readable by others, not even for a moment.
    await writeFile(path, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `${path} already exists; refusing to overwrite it.`,
        {
          hint: "Overwriting a key makes backups encrypted to it unrecoverable. Choose another --output path.",
        },
      );
    }
    throw new MongoShieldError("MS_CONFIG_INVALID", `Could not write the identity file ${path}.`, {
      cause: error,
      hint: "Check that the directory exists and is writable.",
    });
  }
}
