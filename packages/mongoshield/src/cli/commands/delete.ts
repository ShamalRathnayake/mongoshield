/**
 * `mongoshield delete <backup-id>`: delete one backup from storage.
 *
 * For the backup a retention policy is not the right tool for: one taken by
 * mistake, one holding data that must go, or the Kubernetes operator's
 * `deletionPolicy: Delete`. The library does the work and the checks
 * (catalog/delete.ts): held, write-once and depended-on backups are refused with
 * MS_BACKUP_PROTECTED (exit 35); the manifest is deleted first, so a restore never
 * sees a half-deleted backup.
 *
 * Only an exact id is accepted ("latest" is not: deleting is not the place for a
 * selector that changes meaning over time). Deleting asks for confirmation; without
 * a terminal, pass --yes. Every deletion prints an audit line on stderr (and is in
 * the --json result): what was deleted, by whom, when.
 */

import { hostname, userInfo } from "node:os";
import { MongoShieldError } from "../../errors.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatBytes } from "../format.ts";
import { createCliShield } from "../setup.ts";
import { storageFromOption } from "./shared-options.ts";

const NAME = "delete";

export const deleteCommand: CommandSpec = {
  name: NAME,
  summary: "Delete one backup by id (refuses held, locked or depended-on backups)",
  description: [
    "Deletes the backup's manifest first, then its files, annotations and checkpoint.",
    "Refuses backups on hold, backups still write-once (retainDays / object lock) and",
    "backups an incremental backup depends on. Asks for confirmation (--yes in scripts).",
  ].join("\n"),
  positionals: [{ name: "backup", description: 'The exact backup id (not "latest")' }],
  options: {
    from: storageFromOption,
    by: {
      type: "string",
      valueName: "<name>",
      description: "Who asked for the deletion, for the audit line (default: user@host)",
    },
  },
  examples: [
    {
      description: "Delete a backup taken by mistake",
      command: "mongoshield delete 2026-10-20T03-00-04Z_7f3a9c",
    },
    {
      description: "In a script, with a JSON result",
      command: "mongoshield delete 2026-10-20T03-00-04Z_7f3a9c --yes --json",
    },
  ],
  run: runDeleteCommand,
};

async function runDeleteCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const id = exactIdArgument(context);
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    out.info(`Deleting backup ${id} from ${cli.storageLabel}`);
    await confirmOrThrow(context, {
      question: `Delete backup ${id} from ${cli.storageLabel}? This cannot be undone.`,
      action: `delete backup ${id}`,
    });
    const requestedBy = context.flags.string("by") ?? currentUser();
    const result = await cli.shield.deleteBackup(id, {
      signal: context.signal,
      ...(requestedBy ? { requestedBy } : {}),
    });
    // The audit line: always printed, even with --quiet or --json (it goes to stderr).
    out.stderr(
      `audit: deleted backup ${result.id} (${result.status}, ${result.deletedObjects} objects, ${result.deletedBytes} bytes) from ${cli.storageLabel} at ${result.deletedAt}${result.requestedBy ? ` by ${result.requestedBy}` : ""}\n`,
    );
    if (out.settings.json) {
      out.json({ ...result, storage: cli.storageLabel });
    } else {
      out.result(
        `${out.style("green", "✔")} Deleted backup ${result.id}: ${result.deletedObjects} objects, ${formatBytes(result.deletedBytes)}.`,
      );
    }
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** The backup id argument; selectors such as "latest" are refused. */
function exactIdArgument(context: CommandContext): string {
  const value = context.positionals[0];
  if (!value || value === "latest") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "Which backup? Pass its exact id.", {
      hint: `Run \`mongoshield list\` to see the ids, then: mongoshield ${NAME} <id>.`,
    });
  }
  return value;
}

/** user@host, for the audit line. */
function currentUser(): string | undefined {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return undefined;
  }
}
