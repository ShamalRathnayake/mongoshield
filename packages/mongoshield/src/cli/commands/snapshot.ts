/**
 * `mongoshield snapshot <label>`: back up before a migration, under a name.
 *
 * A snapshot is a normal backup labelled `mongoshield.snapshot=<label>` (see
 * src/extras/snapshot.ts), so `mongoshield rollback <label>` can find it again. Prints
 * the backup id on stdout, like `backup`, so scripts can capture it.
 */

import { MongoShieldError } from "../../errors.ts";
import { snapshot } from "../../extras/snapshot.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatDuration, plural } from "../format.ts";
import { ProgressDisplay } from "../progress.ts";
import { createCliShield, rememberUriPassword } from "../setup.ts";
import { excludeOption, includeOption, listOrUndefined, parseKeyValues } from "./shared-options.ts";

const NAME = "snapshot";

export const snapshotCommand: CommandSpec = {
  name: NAME,
  summary: "Back up under a name before a migration",
  description: [
    "Takes a consistent backup labelled with <label>, to roll back to with",
    "`mongoshield rollback <label>` if the migration goes wrong. It is an ordinary",
    "backup: list, verify, hold and prune treat it like any other.",
  ].join("\n"),
  positionals: [{ name: "label", description: "A name for this point, e.g. v42-add-index" }],
  options: {
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Connection string (default: config source.uri, MONGOSHIELD_URI or MONGODB_URI)",
    },
    to: {
      type: "string",
      valueName: "<storage-url>",
      description: "Where to store the snapshot (default: config storage)",
    },
    include: includeOption,
    exclude: excludeOption,
    label: {
      type: "string",
      multiple: true,
      valueName: "<key=value>",
      description: "Attach another label, e.g. migration=20261021-add-index",
    },
    "retain-days": {
      type: "string",
      valueName: "<days>",
      description: "Make the snapshot write-once for this many days (object lock storage)",
    },
  },
  examples: [
    {
      description: "Snapshot the app database before migrating",
      command: "mongoshield snapshot v42-add-orders-index --include 'app.*'",
    },
  ],
  run: runSnapshotCommand,
};

async function runSnapshotCommand(context: CommandContext): Promise<number> {
  const label = context.positionals[0];
  if (!label) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "A snapshot needs a label.", {
      hint: "Example: mongoshield snapshot before-v42",
    });
  }
  const uri = context.flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const cli = await createCliShield(context, {
    source: uri ? { uri } : undefined,
    storage: context.flags.string("to"),
  });
  const progress = new ProgressDisplay(context.out, "Snapshotting");
  try {
    const include = listOrUndefined(context, "include") ?? cli.config.backup?.include;
    const exclude = listOrUndefined(context, "exclude") ?? cli.config.backup?.exclude;
    const labels = parseKeyValues(context, NAME, "label");
    const retainDays = context.flags.integer("retain-days", { min: 1, max: 36_500 });
    const result = await snapshot(cli.shield, {
      label,
      signal: context.signal,
      onProgress: progress.onProgress,
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(labels ? { labels } : {}),
      ...(retainDays !== undefined ? { retainDays } : {}),
    });
    progress.stop();
    if (context.out.settings.json) {
      context.out.json({ id: result.id, label, manifest: result.manifest });
      return 0;
    }
    context.out.success(
      `Snapshot "${label}": ${plural(result.manifest.totals.documents, "document")} in ${plural(result.manifest.totals.namespaces, "namespace")}, ${formatDuration(result.durationMs)}.`,
    );
    context.out.info(`Roll back with: mongoshield rollback ${label}`);
    context.out.result(result.id);
    return 0;
  } finally {
    progress.stop();
    await cli.shield.close();
  }
}
