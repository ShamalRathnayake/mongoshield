/**
 * `mongoshield replicate --to <storage-url> [latest|all|<id>]`: copy backups to a second
 * storage location (3-2-1 backups). See src/extras/replicate.ts for what is copied, in
 * which order, and how copies are verified.
 */

import { isAbsolute, resolve } from "node:path";
import { MongoShieldError } from "../../errors.ts";
import {
  type ReplicatedBackup,
  type ReplicateResult,
  replicateBackups,
} from "../../extras/replicate.ts";
import type { BackupSelection } from "../../extras/stored-files.ts";
import { resolveStorage } from "../../storage/resolve.ts";
import type { StorageAdapter } from "../../storage/types.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatBytes, formatDuration, plural } from "../format.ts";
import type { Output } from "../io.ts";
import { createCliShield } from "../setup.ts";
import { storageFromOption } from "./shared-options.ts";

const NAME = "replicate";

export const replicateCommand: CommandSpec = {
  name: NAME,
  summary: "Copy backups to another storage location (3-2-1)",
  description: [
    "Streams every file of each backup from the backup storage to --to, checks each",
    "copy against its recorded SHA-256, and writes the manifest last. Backups already",
    "there are skipped; the erasure ledger and annotations are copied too.",
  ].join("\n"),
  positionals: [
    {
      name: "backups",
      optional: true,
      description: 'Which: "all" (default), "latest", or a backup id',
    },
  ],
  options: {
    to: {
      type: "string",
      valueName: "<storage-url>",
      description: "Destination: ./dir, s3://bucket/prefix, gs://…, az://…, sftp://…",
    },
    from: storageFromOption,
    id: {
      type: "string",
      multiple: true,
      valueName: "<backup-id>",
      description: "Copy these backups (repeatable), instead of the positional",
    },
    "retain-days": {
      type: "string",
      valueName: "<days>",
      description: "Make the copies write-once at the destination for this many days",
    },
    "no-verify": {
      type: "boolean",
      description: "Do not read copies back to check them (faster, less safe)",
    },
    "dry-run": { type: "boolean", description: "Show what would be copied; copy nothing" },
  },
  examples: [
    {
      description: "Keep an off-site, write-once copy of the newest backup",
      command: "mongoshield replicate latest --to s3://offsite-backups/prod --retain-days 30",
    },
    {
      description: "Bring a second copy fully up to date",
      command: "mongoshield replicate all --to /mnt/nas/mongo",
    },
  ],
  run: runReplicateCommand,
};

async function runReplicateCommand(context: CommandContext): Promise<number> {
  const toLocation = context.flags.string("to");
  if (!toLocation) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Where to? Pass --to <storage-url>.", {
      hint: "Example: mongoshield replicate --to s3://offsite-backups/prod",
    });
  }
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  let destination: StorageAdapter | undefined;
  try {
    destination = await resolveStorageLocation(toLocation, context.io.cwd);
    const retainDays = context.flags.integer("retain-days", { min: 1, max: 36_500 });
    const out = context.out;
    const result = await replicateBackups(cli.shield.storage, destination, {
      backups: selectionOf(context),
      verify: !context.flags.boolean("no-verify"),
      dryRun: context.flags.boolean("dry-run"),
      signal: context.signal,
      ...(retainDays !== undefined ? { retainDays } : {}),
      onProgress: (event) => {
        if (event.type === "backup:start" && event.files > 0) {
          out.live(
            `${event.backupId}: ${plural(event.files, "file")}, ${formatBytes(event.bytes)}`,
          );
        }
      },
    });
    printResult(out, result, cli.storageLabel, destination.location);
    return 0;
  } finally {
    await destination?.close?.();
    await cli.shield.close();
  }
}

/** `--id` (repeatable) or the positional: all, latest, or one id. */
function selectionOf(context: CommandContext): BackupSelection {
  const ids = context.flags.list("id");
  if (ids.length > 0) return ids;
  const value = context.positionals[0] ?? "all";
  if (value === "all" || value === "latest") return value;
  return [value];
}

/** Opens a storage URL; bare relative paths are relative to the CLI's working directory. */
export async function resolveStorageLocation(
  location: string,
  cwd: string,
): Promise<StorageAdapter> {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
  return resolveStorage(hasScheme || isAbsolute(location) ? location : resolve(cwd, location));
}

function printResult(out: Output, result: ReplicateResult, from: string, to: string): void {
  if (out.settings.json) {
    out.json(result);
    return;
  }
  const count = (action: ReplicatedBackup["action"]) =>
    result.backups.filter((backup) => backup.action === action).length;
  const bytes = result.backups.reduce((sum, backup) => sum + backup.bytes, 0);
  if (result.dryRun) {
    out.result(
      `Dry run (${from} → ${to}): would copy ${plural(count("would-copy"), "backup")}, update ${plural(count("would-update"), "backup")} (${formatBytes(bytes)}); ${plural(count("skipped"), "backup")} already there.`,
    );
    return;
  }
  out.result(
    `${out.style("green", "✔")} ${from} → ${to}: copied ${plural(count("copied"), "backup")}, updated ${count("updated")}, ${count("skipped")} already there (${formatBytes(bytes)}, ${formatDuration(result.durationMs)}).`,
  );
  if (result.erasuresCopied > 0)
    out.info(`Copied ${plural(result.erasuresCopied, "erasure record")}.`);
}
