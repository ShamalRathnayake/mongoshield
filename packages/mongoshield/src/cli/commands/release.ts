/**
 * `mongoshield release <backup>`: remove a hold placed with `mongoshield hold`,
 * so the retention policy applies to the backup again.
 */

import type { CommandContext, CommandSpec } from "../command.ts";
import { findBackup } from "../describe.ts";
import { createCliShield } from "../setup.ts";
import { requiredBackupArgument, storageFromOption } from "./shared-options.ts";

export const releaseCommand: CommandSpec = {
  name: "release",
  summary: "Remove a hold so the backup can be pruned again",
  positionals: [{ name: "backup", description: 'Backup id, or "latest"' }],
  options: { from: storageFromOption },
  examples: [
    { description: "Release a hold", command: "mongoshield release 2026-10-20T03-00-04Z_7f3a9c" },
  ],
  run: runReleaseCommand,
};

async function runReleaseCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const selector = requiredBackupArgument(context, "release");
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const entry = await findBackup(cli.shield, selector, context.signal);
    const wasHeld = entry.hold !== undefined;
    await cli.shield.release(entry.id);

    if (out.settings.json) {
      out.json({ backupId: entry.id, released: wasHeld });
    } else if (wasHeld) {
      out.result(`${out.style("green", "✔")} Released the hold on ${entry.id}.`);
    } else {
      out.result(`Backup ${entry.id} was not on hold; nothing to release.`);
    }
    return 0;
  } finally {
    await cli.shield.close();
  }
}
