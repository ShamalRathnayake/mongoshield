/**
 * `mongoshield hold <backup> --reason "…"`: protect a backup from pruning.
 *
 * A hold protects a backup from `prune`, whatever the retention policy says
 * (legal holds, the last backup before a migration). It is stored next to the
 * backup, not in it, because manifests are immutable. `release` removes it.
 */

import { hostname, userInfo } from "node:os";
import { MongoShieldError } from "../../errors.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { findBackup } from "../describe.ts";
import { createCliShield } from "../setup.ts";
import { requiredBackupArgument, storageFromOption } from "./shared-options.ts";

export const holdCommand: CommandSpec = {
  name: "hold",
  summary: "Protect a backup from pruning",
  positionals: [{ name: "backup", description: 'Backup id, or "latest"' }],
  options: {
    reason: {
      type: "string",
      valueName: "<text>",
      description: "Why the backup must be kept (required)",
    },
    by: {
      type: "string",
      valueName: "<name>",
      description: "Who placed the hold (default: user@host)",
    },
    from: storageFromOption,
  },
  examples: [
    {
      description: "Keep the backup taken before a migration",
      command: 'mongoshield hold latest --reason "before the v2 schema migration"',
    },
  ],
  run: runHoldCommand,
};

async function runHoldCommand(context: CommandContext): Promise<number> {
  const reason = context.flags.string("reason")?.trim();
  if (!reason) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "A hold needs a reason.", {
      hint: 'Say why the backup must be kept, e.g. --reason "audit 2026".',
    });
  }
  const selector = requiredBackupArgument(context, "hold");

  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const entry = await findBackup(cli.shield, selector, context.signal);
    const by = context.flags.string("by") ?? currentUser();
    const record = await cli.shield.hold(entry.id, { reason, ...(by ? { by } : {}) });
    if (context.out.settings.json) context.out.json(record);
    else
      context.out.result(
        `${context.out.style("green", "✔")} Backup ${entry.id} is on hold: ${reason}`,
      );
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** `alice@build-01`, or undefined where the OS cannot say. */
function currentUser(): string | undefined {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return undefined;
  }
}
