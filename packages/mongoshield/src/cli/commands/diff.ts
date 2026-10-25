/**
 * `mongoshield diff`: what changed between two backups, or between a backup and the
 * live deployment (src/extras/diff.ts).
 *
 *   mongoshield diff 2026-10-20T03-00-04Z_7f3a9c                 that backup → latest
 *   mongoshield diff 2026-10-20T03-00-04Z_7f3a9c 2026-10-21T03-00-02Z_1b2c3d
 *   mongoshield diff latest --live mongodb://…  --details        latest backup → live
 *
 * Prints one row per namespace that differs (documents added / removed / changed,
 * index and option changes) and how many are identical; --details adds example `_id`s
 * and the names of the indexes and options that differ. --json prints the whole result
 * as canonical Extended JSON.
 */

import type { EngineContext } from "../../engine/context.ts";
import {
  type DiffResult,
  type DiffSideInfo,
  diffBackups,
  type NamespaceDiff,
} from "../../extras/diff.ts";
import { openConnection } from "../../mongo/index.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { formatCount, formatDuration, plural } from "../format.ts";
import {
  createCliLogger,
  createCliShield,
  decryptionFromConfig,
  displayUri,
  rememberUriPassword,
} from "../setup.ts";
import { renderTable } from "../table.ts";
import { backupReadOverrides, previewValue, toCanonicalJson } from "./recovery-shared.ts";
import {
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "diff";

/** `mongoshield diff`. Registered in commands/index.ts. */
export const diffCommand: CommandSpec = {
  name: NAME,
  summary: "Compare two backups, or a backup with the live database",
  description: [
    "Compares every collection of two backups (or a backup and a live deployment):",
    "documents added, removed and changed (matched by _id), and differences in",
    "indexes and collection options. With one backup, it is compared with the latest.",
  ].join("\n"),
  positionals: [
    { name: "backupA", description: 'The older backup: an id or "latest"' },
    { name: "backupB", optional: true, description: "The newer backup (default: latest)" },
  ],
  options: {
    live: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Compare with this live deployment instead of a second backup",
    },
    details: {
      type: "boolean",
      description: "Show example _ids and the differing indexes and options",
    },
    examples: {
      type: "string",
      valueName: "<n>",
      defaultText: "10",
      description: "With --details: example _ids per category",
    },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "What changed since a given backup",
      command: "mongoshield diff 2026-10-20T03-00-04Z_7f3a9c",
    },
    {
      description: "How far the live database has drifted from the latest backup",
      command: 'mongoshield diff latest --live "$MONGODB_URI" --details',
    },
  ],
  run: runDiffCommand,
};

async function runDiffCommand(context: CommandContext): Promise<number> {
  const [first, second, extra] = context.positionals;
  const liveUri = context.flags.string("live");
  if (
    first === undefined ||
    extra !== undefined ||
    (second !== undefined && liveUri !== undefined)
  ) {
    throw usageError("Pass one or two backups, or one backup and --live <uri>.", NAME);
  }
  if (liveUri === undefined && second === undefined && first === "latest") {
    throw usageError(
      "Comparing latest with latest finds nothing; name another backup or use --live.",
      NAME,
    );
  }
  if (liveUri) rememberUriPassword(context, liveUri);
  const examples = context.flags.integer("examples", { min: 0 });
  const cli = await createCliShield(context, backupReadOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const engine: EngineContext = {
      storage: cli.shield.storage,
      logger: createCliLogger(context.out),
    };
    const include = listOrUndefined(context, "include");
    const exclude = listOrUndefined(context, "exclude");
    const common = {
      from: first,
      signal: context.signal,
      ...(include ? { include } : {}),
      ...(exclude ? { exclude } : {}),
      ...(examples !== undefined ? { examples } : {}),
      ...(decryption ? { decryption } : {}),
    };
    if (liveUri === undefined) {
      printResult(
        context,
        await diffBackups(engine, { ...common, to: second ?? "latest" }),
        undefined,
      );
      return 0;
    }
    const connection = await openConnection({ uri: liveUri }, { logger: engine.logger });
    try {
      printResult(
        context,
        await diffBackups(engine, { ...common, to: { live: connection.client } }),
        liveUri,
      );
      return 0;
    } finally {
      await connection.close();
    }
  } finally {
    await cli.shield.close();
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printResult(
  context: CommandContext,
  result: DiffResult,
  liveUri: string | undefined,
): void {
  const { out } = context;
  if (out.settings.json) {
    out.json(toCanonicalJson(result));
    return;
  }
  out.info(`Comparing ${sideLabel(result.from, liveUri)} → ${sideLabel(result.to, liveUri)}`);
  const differing = result.namespaces.filter((namespace) => !namespace.identical);
  const identical = result.namespaces.length - differing.length;
  if (differing.length === 0) {
    out.result(
      `${out.style("green", "✔")} No differences in ${plural(result.namespaces.length, "namespace")} (${formatDuration(result.durationMs)}).`,
    );
    return;
  }

  out.result(
    renderTable(
      [
        { header: "Namespace" },
        { header: "Documents", align: "right" },
        { header: "Added", align: "right" },
        { header: "Removed", align: "right" },
        { header: "Changed", align: "right" },
        { header: "Indexes" },
        { header: "Options" },
      ],
      differing.map(summaryRow),
      (text) => out.style("dim", text),
    ),
  );
  if (context.flags.boolean("details")) {
    for (const namespace of differing) printDetails(context, namespace);
  }
  out.info(
    out.style(
      "dim",
      `${plural(differing.length, "namespace")} differ, ${formatCount(identical)} identical (${formatDuration(result.durationMs)}).`,
    ),
  );
}

function sideLabel(side: DiffSideInfo, liveUri: string | undefined): string {
  return side.kind === "backup" ? `backup ${side.backupId}` : `live ${displayUri(liveUri)}`;
}

/** One table row: the namespace, its counts and a short note on metadata changes. */
function summaryRow(namespace: NamespaceDiff): string[] {
  const { documents, indexes } = namespace;
  const name =
    namespace.presence === "both"
      ? namespace.namespace
      : `${namespace.namespace} (${namespace.presence === "only-to" ? "new" : "gone"})`;
  const indexChanges = indexes.added.length + indexes.removed.length + indexes.changed.length;
  return [
    name,
    `${formatCount(documents.from)} → ${formatCount(documents.to)}`,
    formatCount(documents.added),
    formatCount(documents.removed),
    formatCount(documents.changed),
    indexChanges > 0 ? plural(indexChanges, "change") : "",
    namespace.options.length > 0 ? namespace.options.join(", ") : "",
  ];
}

/** Example ids and metadata names for one namespace. */
function printDetails(context: CommandContext, namespace: NamespaceDiff): void {
  const { out } = context;
  const lines: string[] = [out.style("bold", namespace.namespace)];
  const { examples, indexes, documents } = namespace;
  const exampleLine = (label: string, ids: readonly unknown[], total: number): void => {
    if (ids.length === 0) return;
    const more = total > ids.length ? `, … ${formatCount(total - ids.length)} more` : "";
    lines.push(`  ${label}: ${ids.map(previewValue).join(", ")}${more}`);
  };
  exampleLine("added", examples.added, documents.added);
  exampleLine("removed", examples.removed, documents.removed);
  exampleLine("changed", examples.changed, documents.changed);
  if (indexes.added.length > 0) lines.push(`  indexes added: ${indexes.added.join(", ")}`);
  if (indexes.removed.length > 0) lines.push(`  indexes removed: ${indexes.removed.join(", ")}`);
  if (indexes.changed.length > 0) lines.push(`  indexes changed: ${indexes.changed.join(", ")}`);
  if (namespace.options.length > 0)
    lines.push(`  options changed: ${namespace.options.join(", ")}`);
  if (
    namespace.type.from !== undefined &&
    namespace.type.to !== undefined &&
    namespace.type.from !== namespace.type.to
  ) {
    lines.push(`  type: ${namespace.type.from} → ${namespace.type.to}`);
  }
  out.result(lines.join("\n"));
}
