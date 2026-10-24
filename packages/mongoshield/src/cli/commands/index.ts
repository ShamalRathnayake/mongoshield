/**
 * Every CLI command, in the order `mongoshield --help` lists them:
 * the daily workflow first, then maintenance, then setup.
 */

import type { CommandSpec } from "../command.ts";
import { backupCommand } from "./backup.ts";
import { copyCommand } from "./copy.ts";
import { diffCommand } from "./diff.ts";
import { drillCommand } from "./drill.ts";
import { eraseCommand } from "./erase.ts";
import { erasuresCommand } from "./erasures.ts";
import { exportCommand } from "./export.ts";
import { findInBackupCommand } from "./find.ts";
import { historyCommand } from "./history.ts";
import { holdCommand } from "./hold.ts";
import { importCommand } from "./import.ts";
import { initCommand } from "./init.ts";
import { inspectCommand } from "./inspect.ts";
import { journalCommand } from "./journal.ts";
import { keygenCommand } from "./keygen.ts";
import { listCommand } from "./list.ts";
import { pruneCommand } from "./prune.ts";
import { pullCommand } from "./pull.ts";
import { rekeyCommand } from "./rekey.ts";
import { releaseCommand } from "./release.ts";
import { replicateCommand } from "./replicate.ts";
import { restoreCommand } from "./restore.ts";
import { restoreTenantCommand } from "./restore-tenant.ts";
import { rollbackCommand } from "./rollback.ts";
import { runCommand } from "./run.ts";
import { scheduleCommand } from "./schedule.ts";
import { snapshotCommand } from "./snapshot.ts";
import { verifyCommand } from "./verify.ts";
import { versionCommand } from "./version.ts";

/** The command list. `help` is handled by the dispatcher itself. */
export const COMMANDS: readonly CommandSpec[] = [
  backupCommand,
  restoreCommand,
  snapshotCommand,
  rollbackCommand,
  findInBackupCommand,
  restoreTenantCommand,
  historyCommand,
  diffCommand,
  copyCommand,
  pullCommand,
  listCommand,
  inspectCommand,
  verifyCommand,
  drillCommand,
  importCommand,
  exportCommand,
  pruneCommand,
  replicateCommand,
  rekeyCommand,
  runCommand,
  scheduleCommand,
  journalCommand,
  holdCommand,
  releaseCommand,
  eraseCommand,
  erasuresCommand,
  keygenCommand,
  initCommand,
  versionCommand,
];

/** Finds a command by name. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
