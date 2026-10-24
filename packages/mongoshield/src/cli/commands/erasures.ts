/**
 * `mongoshield erasures list|apply`: inspect the GDPR erasure ledger, or replay it.
 *
 *   list    every recorded erasure, oldest first (hashed filters show only their
 *           field names: the values are not in the ledger)
 *   apply   delete the erased documents from a deployment now, e.g. after restoring
 *           with a tool other than MongoShield (MongoShield's own restores apply the
 *           ledger automatically)
 *
 * See src/extras/erasure.ts.
 */

import { MongoShieldError } from "../../errors.ts";
import { applyErasures, type ErasureRecord, listErasures } from "../../extras/erasure.ts";
import { discoverNamespaces, openConnection } from "../../mongo/index.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatLocalDate, plural } from "../format.ts";
import { createCliLogger, createCliShield, displayUri, rememberUriPassword } from "../setup.ts";
import { renderTable } from "../table.ts";
import { erasureSecret } from "./erase.ts";
import { includeOption, listOrUndefined, storageFromOption } from "./shared-options.ts";

const NAME = "erasures";

export const erasuresCommand: CommandSpec = {
  name: NAME,
  summary: "List the GDPR erasure ledger, or apply it to a database",
  positionals: [{ name: "action", description: "list or apply" }],
  options: {
    from: storageFromOption,
    since: {
      type: "string",
      valueName: "<date>",
      description: "Only erasures recorded at or after this date",
    },
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "apply: the deployment to clean (default: config source.uri)",
    },
    include: includeOption,
    "dry-run": { type: "boolean", description: "apply: count, delete nothing" },
  },
  examples: [
    { description: "Show every recorded erasure", command: "mongoshield erasures list" },
    {
      description: "Re-apply the ledger to a database restored by other means",
      command: "mongoshield erasures apply --uri $STAGING_URI --include 'app.*'",
    },
  ],
  run: runErasuresCommand,
};

async function runErasuresCommand(context: CommandContext): Promise<number> {
  const action = context.positionals[0];
  if (action === "list") return runList(context);
  if (action === "apply") return runApply(context);
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    action === undefined ? "Which action? Use list or apply." : `Unknown action "${action}".`,
    { hint: "Run `mongoshield erasures list` or `mongoshield erasures apply`." },
  );
}

/** `--since` as a Date. */
function sinceFlag(context: CommandContext): Date | undefined {
  const raw = context.flags.string("since");
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `--since ${raw} is not a date.`, {
      hint: "Use an ISO date, e.g. 2026-10-01.",
    });
  }
  return date;
}

async function runList(context: CommandContext): Promise<number> {
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const since = sinceFlag(context);
    const records = await listErasures(cli.shield.storage, {
      signal: context.signal,
      ...(since ? { since } : {}),
    });
    if (context.out.settings.json) {
      context.out.json(records);
      return 0;
    }
    if (records.length === 0) {
      context.out.result("No erasures recorded.");
      return 0;
    }
    const rows = records.map((record) => [
      formatLocalDate(new Date(record.recordedAt)),
      record.namespace,
      describeMatch(record),
      record.reason,
      record.requestedBy ?? "",
    ]);
    context.out.result(
      renderTable(
        [
          { header: "RECORDED" },
          { header: "NAMESPACE" },
          { header: "MATCH" },
          { header: "REASON" },
          { header: "BY" },
        ],
        rows,
        (text) => context.out.style("dim", text),
      ),
    );
    context.out.info(plural(records.length, "erasure"));
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** A hashed match shows its fields only; a plain filter is shown as stored. */
function describeMatch(record: ErasureRecord): string {
  if (record.match.kind === "filter") return JSON.stringify(record.match.filter);
  const fields = record.match.fields.map((field) => field.path).join(", ");
  return `hashed ${fields}${record.match.keyed ? " (keyed)" : ""}`;
}

async function runApply(context: CommandContext): Promise<number> {
  const uri = context.flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const cli = await createCliShield(context, {
    source: uri ? { uri } : undefined,
    storage: context.flags.string("from"),
  });
  try {
    const target = cli.config.source?.uri;
    if (!target) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "No deployment to apply erasures to.", {
        hint: "Pass --uri or set source.uri / MONGODB_URI.",
      });
    }
    const dryRun = context.flags.boolean("dry-run");
    if (!dryRun) {
      await confirmOrThrow(context, {
        question: `Delete every erased document from ${displayUri(target)}?`,
        action: "apply erasures",
      });
    }
    const since = sinceFlag(context);
    const secret = erasureSecret(context, cli.config);
    const connection = await openConnection(
      { uri: target },
      { logger: createCliLogger(context.out) },
    );
    try {
      const include = listOrUndefined(context, "include");
      const specs = await discoverNamespaces(connection.client, {
        signal: context.signal,
        ...(include ? { include } : {}),
      });
      const result = await applyErasures(connection.client, cli.shield.storage, {
        namespaces: specs.map((spec) => ({ from: spec.ns, to: spec.ns, type: spec.type })),
        dryRun,
        signal: context.signal,
        ...(since ? { since } : {}),
        ...(secret ? { secret } : {}),
      });
      if (context.out.settings.json) context.out.json(result);
      else
        context.out.result(
          `${context.out.style("green", "✔")} ${dryRun ? "Would delete" : "Deleted"} ${plural(result.documentsDeleted, "document")} (${plural(result.erasures, "erasure")}, ${plural(result.namespaces.length, "namespace")}).`,
        );
      return 0;
    } finally {
      await connection.close();
    }
  } finally {
    await cli.shield.close();
  }
}
