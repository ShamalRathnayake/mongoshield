/**
 * `mongoshield version` (also `mongoshield --version`): print the installed version.
 */

import { version } from "../../version.ts";
import type { CommandContext, CommandSpec } from "../command.ts";

export const versionCommand: CommandSpec = {
  name: "version",
  summary: "Print the MongoShield version",
  options: {},
  examples: [{ description: "Print the version", command: "mongoshield --version" }],
  run: runVersionCommand,
};

async function runVersionCommand(context: CommandContext): Promise<number> {
  if (context.out.settings.json) {
    context.out.json({ version, node: process.versions.node });
  } else {
    context.out.result(`mongoshield ${version}`);
  }
  return 0;
}
