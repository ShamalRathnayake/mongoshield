/**
 * `mongoshield list`: the backups in storage, newest first.
 *
 * Shows complete backups and also incomplete runs (crashed or still running)
 * and invalid ones, so nothing in storage is hidden from the user. KIND tells full
 * backups from incrementals (`incr #3`: the third after its full backup; `inspect`
 * names the parent and the base).
 */

import type { CatalogEntry } from "../../catalog/catalog.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  encryptionSummary,
  holdMarker,
  kindSummary,
  styledStatus,
  verificationSummary,
} from "../describe.ts";
import { formatBytes, formatCount, formatDateWithRelative, plural } from "../format.ts";
import { createCliShield } from "../setup.ts";
import { renderTable } from "../table.ts";
import { storageFromOption } from "./shared-options.ts";

export const listCommand: CommandSpec = {
  name: "list",
  summary: "List backups in storage",
  description:
    "Lists every backup, newest first, with its status, size, encryption and the\nlatest verification. --json prints the full catalog entries, manifests included.",
  options: { from: storageFromOption },
  examples: [
    { description: "List backups in the configured storage", command: "mongoshield list" },
    {
      description: "List backups in S3 and pick the newest id with jq",
      command: "mongoshield list --from s3://acme-backups/prod --json | jq -r '.[0].id'",
    },
  ],
  run: runListCommand,
};

async function runListCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const entries = await cli.shield.list({ signal: context.signal });
    if (out.settings.json) {
      out.json(entries);
      return 0;
    }
    if (entries.length === 0) {
      out.info(`No backups in ${cli.storageLabel} yet. Create one with: mongoshield backup`);
      return 0;
    }
    out.result(renderEntries(context, entries));
    out.info(out.style("dim", footer(entries, cli.storageLabel)));
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** The table of backups. */
function renderEntries(context: CommandContext, entries: readonly CatalogEntry[]): string {
  const { out } = context;
  const now = new Date();
  const rows = entries.map((entry) => {
    const totals = entry.manifest?.totals;
    return [
      out.style("bold", entry.id),
      formatDateWithRelative(entry.startedAt, now),
      styledStatus(entry, out),
      // `full` or `incr #n` (the n-th incremental after its full backup).
      kindSummary(entry.manifest),
      totals ? formatCount(totals.namespaces) : "–",
      totals ? formatCount(totals.documents) : "–",
      totals ? formatBytes(totals.bytesStored) : "–",
      encryptionSummary(entry),
      verificationSummary(entry, out, now),
      holdMarker(entry, out, now),
    ];
  });
  return renderTable(
    [
      { header: "ID" },
      { header: "CREATED" },
      { header: "STATUS" },
      { header: "KIND" },
      { header: "NS", align: "right" },
      { header: "DOCUMENTS", align: "right" },
      { header: "SIZE", align: "right" },
      { header: "ENCRYPTED" },
      { header: "VERIFIED" },
      { header: "PROTECTED" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
}

/** `3 backups (2 complete) · 1.2 GiB in ./backups`. */
function footer(entries: readonly CatalogEntry[], storage: string): string {
  let complete = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.status === "complete") complete++;
    bytes += entry.manifest?.totals.bytesStored ?? 0;
  }
  return `${plural(entries.length, "backup")} (${formatCount(complete)} complete) · ${formatBytes(bytes)} in ${storage}`;
}
