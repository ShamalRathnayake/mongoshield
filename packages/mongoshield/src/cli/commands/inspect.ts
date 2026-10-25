/**
 * `mongoshield inspect <backup>`: everything about one backup.
 *
 * A summary of the manifest (source, consistency, compression, encryption,
 * labels, totals, verification, hold), a table of its namespaces, and the
 * history of its restore drills, newest first.
 */

import { type DrillRecord, readDrills } from "../../catalog/annotations.ts";
import { type CatalogEntry, immutableUntilOf } from "../../catalog/catalog.ts";
import { selectBackup } from "../../catalog/select.ts";
import type { Manifest, NamespaceEntry } from "../../format/manifest.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import {
  chainSummary,
  consistencySummary,
  drillSummary,
  encryptionSummary,
  formatRto,
  verificationRecordSummary,
} from "../describe.ts";
import {
  formatBytes,
  formatCount,
  formatDateWithRelative,
  formatDuration,
  formatRatio,
  formatRelative,
} from "../format.ts";
import type { Output } from "../io.ts";
import { createCliShield } from "../setup.ts";
import { renderDetails, renderTable } from "../table.ts";
import { backupSelectorArgument, storageFromOption } from "./shared-options.ts";

export const inspectCommand: CommandSpec = {
  name: "inspect",
  summary: "Show the details of one backup",
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: { from: storageFromOption },
  examples: [
    { description: "Inspect the newest backup", command: "mongoshield inspect latest" },
    {
      description: "Get one backup's manifest as JSON",
      command: "mongoshield inspect 2026-10-20T03-00-04Z_7f3a9c --json | jq .manifest",
    },
  ],
  run: runInspectCommand,
};

async function runInspectCommand(context: CommandContext): Promise<number> {
  const { out } = context;
  const cli = await createCliShield(context, { storage: context.flags.string("from") });
  try {
    const entries = await cli.shield.list({ signal: context.signal });
    const entry = selectBackup(entries, backupSelectorArgument(context));
    // The catalog entry carries only the last drill; inspect shows them all.
    const drills = (
      await readDrills(cli.shield.storage, entry.id, { signal: context.signal })
    ).reverse();
    if (out.settings.json) {
      out.json({ ...entry, drills });
      return 0;
    }
    // selectBackup only returns complete backups, which always have a manifest.
    if (entry.manifest) {
      out.result(renderSummary(out, entry, entry.manifest, entries));
      out.result();
      out.result(renderNamespaces(out, entry.manifest.namespaces));
    }
    if (drills.length > 0) {
      out.result();
      out.result(renderDrills(out, drills));
    }
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** The label/value block at the top. */
function renderSummary(
  out: Output,
  entry: CatalogEntry,
  manifest: Manifest,
  entries: readonly CatalogEntry[],
): string {
  const started = new Date(manifest.startedAt);
  const completed = new Date(manifest.completedAt);
  const { totals, consistency, source } = manifest;

  const pairs: [string, string][] = [
    ["Backup id", out.style("bold", manifest.id)],
    ["Completed", formatDateWithRelative(completed)],
    ["Duration", formatDuration(completed.getTime() - started.getTime())],
    ["Written by", manifest.tool],
    // Full or incremental, and where it sits in its chain (src/catalog/chain.ts).
    ["Kind", chainSummary(manifest, entries)],
    ["Source", `${source.topology}, MongoDB ${source.serverVersion}`],
    ["Consistency", consistencySummary(manifest)],
    ["Compression", manifest.compression],
    ["Encryption", encryptionDetails(entry, manifest)],
    ["Namespaces", formatCount(totals.namespaces)],
    ["Documents", formatCount(totals.documents)],
    [
      "Size",
      `${formatBytes(totals.bytesRaw)} raw → ${formatBytes(totals.bytesStored)} stored (${formatRatio(totals.bytesRaw, totals.bytesStored)})`,
    ],
    ["Labels", labelsText(manifest.labels)],
    ["Verified", verificationDetails(out, entry)],
    [
      "Last drill",
      entry.lastDrill ? drillSummary(entry.lastDrill, out) : "never (run: mongoshield drill)",
    ],
    ["Hold", holdDetails(entry)],
    ["Immutable", immutableDetails(entry)],
  ];
  if (consistency.warning) pairs.splice(7, 0, ["", out.style("yellow", consistency.warning)]);
  return renderDetails(pairs, (label) => out.style("dim", label));
}

/** `yes (1 recipient): age1…` with every recipient listed. */
function encryptionDetails(entry: CatalogEntry, manifest: Manifest): string {
  const summary = encryptionSummary(entry);
  const recipients = manifest.encryption?.recipients ?? [];
  if (recipients.length === 0) return summary;
  return `${summary}: ${recipients.join(", ")}`;
}

function labelsText(labels: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  return pairs.length > 0 ? pairs.join(", ") : "–";
}

/** The latest verification with its counts, or "never". */
function verificationDetails(out: Output, entry: CatalogEntry): string {
  const verification = entry.verification;
  if (!verification) return "never (run: mongoshield verify)";
  const counts = `${formatCount(verification.filesChecked)} files, ${formatCount(verification.documentsChecked)} documents, ${formatCount(verification.problemCount)} problems`;
  return `${verificationRecordSummary(verification, out)} (${counts})`;
}

/** Write-once retention: until when storage refuses to delete or overwrite the backup. */
function immutableDetails(entry: CatalogEntry): string {
  const until = immutableUntilOf(entry);
  if (!until) return "no (files can be deleted by prune or by hand)";
  const state = until > new Date() ? "locked" : "lock expired";
  return `${state} until ${formatDateWithRelative(until)}`;
}

function holdDetails(entry: CatalogEntry): string {
  const hold = entry.hold;
  if (!hold) return "–";
  const by = hold.by ? ` by ${hold.by}` : "";
  return `held since ${formatDateWithRelative(new Date(hold.heldAt))}${by}: ${hold.reason}`;
}

/** One row per namespace. */
function renderNamespaces(out: Output, namespaces: readonly NamespaceEntry[]): string {
  const rows = namespaces.map((entry) => {
    const stored = entry.files.reduce((sum, file) => sum + file.size, entry.metadata.size);
    return [
      entry.ns,
      entry.type,
      formatCount(entry.documents),
      formatBytes(entry.bytesRaw),
      formatBytes(stored),
      formatCount(entry.files.length),
    ];
  });
  return renderTable(
    [
      { header: "NAMESPACE" },
      { header: "TYPE" },
      { header: "DOCUMENTS", align: "right" },
      { header: "RAW", align: "right" },
      { header: "STORED", align: "right" },
      { header: "PARTS", align: "right" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
}

/**
 * One row per restore drill, newest first. When some of them are upgrade rehearsals
 * (`mongoshield rehearse-upgrade`), a MONGODB column shows the version each one
 * proved (`–` for ordinary drills); without rehearsals the table is unchanged.
 */
function renderDrills(out: Output, drills: readonly DrillRecord[]): string {
  const now = new Date();
  const withVersions = drills.some((drill) => drill.targetVersion !== undefined);
  const rows = drills.map((drill) => [
    formatRelative(new Date(drill.drilledAt), now),
    drill.ok ? out.style("green", "passed") : out.style("red", "failed"),
    ...(withVersions ? [drill.targetVersion === undefined ? "–" : `→ ${drill.targetVersion}`] : []),
    drill.restored ? formatRto(drill.restoreDurationMs) : "–",
    formatCount(drill.documentsRestored),
    formatCount(drill.problemCount),
  ]);
  return renderTable(
    [
      { header: "DRILLED" },
      { header: "RESULT" },
      ...(withVersions ? [{ header: "MONGODB" }] : []),
      { header: "RTO", align: "right" },
      { header: "DOCUMENTS", align: "right" },
      { header: "PROBLEMS", align: "right" },
    ],
    rows,
    (text) => out.style("dim", text),
  );
}
