/**
 * `mongoshield rekey [backup|all]`: change who can decrypt existing backups.
 *
 * Only age headers are rewritten; the encrypted data stays as it is (see
 * src/extras/rekey.ts and docs/specs/ENCRYPTION.md, "Rekeying"). Removing a key
 * asks for confirmation (or --yes), because a backup whose last working key is removed
 * is lost.
 */

import { MongoShieldError } from "../../errors.ts";
import { type RekeyBackupResult, type RekeyResult, rekeyBackups } from "../../extras/rekey.ts";
import type { BackupSelection } from "../../extras/stored-files.ts";
import type { KmsKeyRef } from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { plural } from "../format.ts";
import type { Output } from "../io.ts";
import { createCliShield, decryptionFromConfig, readPassphraseEnv } from "../setup.ts";
import {
  identityFileOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "rekey";

export const rekeyCommand: CommandSpec = {
  name: NAME,
  summary: "Add or remove the keys that can decrypt existing backups",
  description: [
    "Rewrites only the age headers of a backup's files (or of its key file), for a new",
    "set of recipients, KMS keys or a new passphrase. The data is not re-encrypted, so",
    "a removed key that already had a copy of the files can still read them.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'A backup id, "latest", or "all" (default)' },
  ],
  options: {
    from: storageFromOption,
    "add-recipient": {
      type: "string",
      multiple: true,
      valueName: "<age1…>",
      description: "Let this age public key decrypt the backups",
    },
    "remove-recipient": {
      type: "string",
      multiple: true,
      valueName: "<age1…>",
      description: "Stop this age public key from decrypting them",
    },
    "add-kms": {
      type: "string",
      multiple: true,
      valueName: "<provider:key>",
      description: "KMS backups: add a KMS key, e.g. aws:arn:aws:kms:…",
    },
    "remove-kms": {
      type: "string",
      multiple: true,
      valueName: "<provider:key>",
      description: "KMS backups: remove a KMS key (one must remain)",
    },
    "identity-file": identityFileOption,
    "passphrase-env": {
      ...passphraseEnvOption,
      description: "The CURRENT passphrase, from this variable",
    },
    "new-passphrase-env": {
      type: "string",
      valueName: "<VAR>",
      description: "Passphrase backups: the new passphrase, from this variable",
    },
    "dry-run": { type: "boolean", description: "Show what would change; write nothing" },
  },
  examples: [
    {
      description: "Hand backups over to a new ops key and retire the old one",
      command:
        "mongoshield rekey all --add-recipient age1new… --remove-recipient age1old… --identity-file old.key",
    },
    {
      description: "Change the passphrase of the newest backup",
      command: "mongoshield rekey latest --passphrase-env OLD_PASS --new-passphrase-env NEW_PASS",
    },
  ],
  run: runRekeyCommand,
};

async function runRekeyCommand(context: CommandContext): Promise<number> {
  const passphraseVariable = context.flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  const newPassphraseVariable = context.flags.string("new-passphrase-env");
  const newPassphrase = newPassphraseVariable
    ? readPassphraseEnv(context, newPassphraseVariable)
    : undefined;
  const identityFiles = listOrUndefined(context, "identity-file");
  const cli = await createCliShield(context, {
    storage: context.flags.string("from"),
    decryption: identityFiles || passphrase ? { identityFiles, passphrase } : undefined,
  });
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const addRecipients = listOrUndefined(context, "add-recipient");
    const removeRecipients = listOrUndefined(context, "remove-recipient");
    const addKms = kmsFlags(context, "add-kms");
    const removeKms = kmsFlags(context, "remove-kms");
    const selection = selectionOf(context);
    const options = {
      backups: selection,
      signal: context.signal,
      ...(addRecipients ? { addRecipients } : {}),
      ...(removeRecipients ? { removeRecipients } : {}),
      ...(addKms ? { addKms } : {}),
      ...(removeKms ? { removeKms } : {}),
      ...(newPassphrase !== undefined ? { newPassphrase } : {}),
      ...(decryption ? { decryption } : {}),
    };

    const preview = await rekeyBackups(cli.shield.storage, { ...options, dryRun: true });
    const dryRun = context.flags.boolean("dry-run");
    const affected = preview.backups.filter((backup) => backup.action === "would-rekey");
    if (dryRun || affected.length === 0) {
      printResult(context.out, preview);
      return exitCode(preview, selection);
    }
    if (removeRecipients || removeKms || newPassphrase !== undefined) {
      await confirmOrThrow(context, {
        question: `Rewrite the keys of ${plural(affected.length, "backup")}? Keys you remove can no longer open them.`,
        action: "rekey backups",
      });
    }
    const result = await rekeyBackups(cli.shield.storage, options);
    printResult(context.out, result);
    return exitCode(result, selection);
  } finally {
    await cli.shield.close();
  }
}

/** The positional: all (default), latest, or one id. */
function selectionOf(context: CommandContext): BackupSelection {
  const value = context.positionals[0] ?? "all";
  if (value === "all" || value === "latest") return value;
  return [value];
}

/** `--add-kms aws:arn:aws:kms:…` → `{ provider: "aws", key: "arn:aws:kms:…" }`. */
function kmsFlags(context: CommandContext, flag: string): KmsKeyRef[] | undefined {
  const values = context.flags.list(flag);
  if (values.length === 0) return undefined;
  return values.map((value) => {
    const separator = value.indexOf(":");
    const provider = value.slice(0, separator);
    const key = value.slice(separator + 1);
    if (provider !== "aws" && provider !== "gcp" && provider !== "azure") {
      throw usageError(
        `--${flag} expects provider:key with aws, gcp or azure (got "${value}").`,
        NAME,
      );
    }
    if (key === "") throw usageError(`--${flag} ${value} has no key.`, NAME);
    return { provider, key };
  });
}

/** Skipped backups the user named are a failure; with "all" they are only reported. */
function exitCode(result: RekeyResult, selection: BackupSelection): number {
  const skipped = result.backups.some((backup) => backup.action === "skipped");
  return skipped && selection !== "all" ? 1 : 0;
}

const ACTION_TEXT: Readonly<Record<RekeyBackupResult["action"], string>> = {
  rekeyed: "rekeyed",
  "would-rekey": "would rekey",
  unchanged: "unchanged",
  skipped: "skipped",
};

function printResult(out: Output, result: RekeyResult): void {
  if (out.settings.json) {
    out.json(result);
    return;
  }
  if (result.backups.length === 0) {
    throw new MongoShieldError("MS_BACKUP_NOT_FOUND", "There are no backups to rekey.");
  }
  for (const backup of result.backups) {
    const details =
      backup.action === "skipped"
        ? `: ${backup.reason ?? ""}`
        : backup.files > 0
          ? ` (${plural(backup.files, "file")}) → ${backup.recipients.join(", ")}`
          : "";
    const resumed = backup.resumed ? " (finished an interrupted rekey first)" : "";
    out.result(`${backup.backupId}  ${ACTION_TEXT[backup.action]}${details}${resumed}`);
  }
  if (result.dryRun) out.info("Dry run: nothing was written.");
}
