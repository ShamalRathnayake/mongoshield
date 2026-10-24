/**
 * `mongoshield history`: how one document looked in every backup, plus every journaled
 * change in between, newest first, with a compact diff between consecutive versions
 * (src/extras/history.ts).
 *
 *   mongoshield history app.users '{"$oid":"6523f1c2a1b2c3d4e5f60718"}'
 *   mongoshield history app.orders 42 --backups all --skip-journal
 *
 * Output (stdout):
 *
 *   2026-10-21 03:00:04Z  backup 2026-10-21T03-00-04Z_7f3a9c  present
 *       (no changes)
 *   2026-10-20 14:12:09Z  update (journal, 1760969529:3)
 *       ~ address.city: "Bergen"
 *   2026-10-20 03:00:02Z  backup 2026-10-20T03-00-02Z_1b2c3d  present
 *       (first known version)
 *
 * With --json, stdout is the history as canonical Extended JSON (every BSON type kept).
 */

import type { Document } from "mongodb";
import type { EngineContext } from "../../engine/context.ts";
import {
  type DocumentHistory,
  diffDocuments,
  documentHistory,
  type FieldChange,
  type HistoryVersion,
} from "../../extras/history.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { plural } from "../format.ts";
import { createCliLogger, createCliShield, decryptionFromConfig } from "../setup.ts";
import {
  backupReadOverrides,
  parseEjsonValue,
  previewValue,
  toCanonicalJson,
} from "./recovery-shared.ts";
import { identityFileOption, passphraseEnvOption, storageFromOption } from "./shared-options.ts";

const NAME = "history";

/** `mongoshield history`. Registered in commands/index.ts. */
export const historyCommand: CommandSpec = {
  name: NAME,
  summary: "Show how one document changed across backups and the journal",
  description: [
    "Looks a document up by _id in every backup (newest first) and, when a change",
    "journal exists, lists every change to it in between. Each version is shown with",
    "the fields that changed since the version before it.",
    'The _id is Extended JSON: \'"ada"\', 42, \'{"$oid":"…"}\'.',
  ].join("\n"),
  positionals: [
    { name: "namespace", description: "The collection, e.g. app.users" },
    { name: "id", description: "The document's _id as Extended JSON" },
  ],
  options: {
    from: storageFromOption,
    backups: {
      type: "string",
      valueName: "<n|all>",
      defaultText: "10",
      description: "How many backups that hold the collection to search",
    },
    "skip-journal": { type: "boolean", description: "Do not read the change journal" },
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "The history of one user",
      command: 'mongoshield history app.users \'{"$oid":"6523f1c2a1b2c3d4e5f60718"}\'',
    },
    {
      description: "Every backup, no journal, as JSON",
      command: "mongoshield history app.orders 42 --backups all --skip-journal --json",
    },
  ],
  run: runHistoryCommand,
};

async function runHistoryCommand(context: CommandContext): Promise<number> {
  const [namespace, idText, extra] = context.positionals;
  if (namespace === undefined || idText === undefined || extra !== undefined) {
    throw usageError("Pass a namespace and an _id, e.g. app.users '\"ada\"'.", NAME);
  }
  const id = parseEjsonValue(idText, "_id");
  const backups = parseBackupsFlag(context);
  const cli = await createCliShield(context, backupReadOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const engine: EngineContext = {
      storage: cli.shield.storage,
      logger: createCliLogger(context.out),
    };
    const history = await documentHistory(engine, {
      namespace,
      id,
      journal: !context.flags.boolean("skip-journal"),
      signal: context.signal,
      ...(backups !== undefined ? { backups } : {}),
      ...(decryption ? { decryption } : {}),
    });
    if (context.out.settings.json) context.out.json(toCanonicalJson(history));
    else printHistory(context, history);
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** `--backups 5` or `--backups all`. */
function parseBackupsFlag(context: CommandContext): "all" | number | undefined {
  const text = context.flags.string("backups");
  if (text === undefined) return undefined;
  if (text === "all") return "all";
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw usageError(`--backups expects a number ≥ 1 or "all" (got "${text}").`, NAME);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** A version with the lines describing what it changed. */
interface DescribedVersion {
  readonly version: HistoryVersion;
  readonly lines: readonly string[];
}

function printHistory(context: CommandContext, history: DocumentHistory): void {
  const { out } = context;
  const described = describeVersions(history.versions);
  for (const { version, lines } of described) {
    out.result(headline(context, version));
    for (const line of lines) out.result(`    ${line}`);
  }
  if (described.length === 0) out.result("No version of this document was found.");

  const journal =
    history.journal.status === "read"
      ? `the journal${history.journal.gaps > 0 ? ` (with ${plural(history.journal.gaps, "gap")})` : ""}`
      : history.journal.status === "none"
        ? "no journal (none exists)"
        : "no journal (--skip-journal)";
  out.info(
    out.style(
      "dim",
      `Searched ${plural(history.backupsSearched, "backup")} of ${history.namespace} and ${journal}.`,
    ),
  );
}

/**
 * Walks the versions oldest first, keeping the last known state of the document, and
 * describes each version relative to it. Returned newest first, as printed.
 */
function describeVersions(versions: readonly HistoryVersion[]): DescribedVersion[] {
  const described: DescribedVersion[] = [];
  // undefined: not known yet; null: known not to exist.
  let state: Document | null | undefined;
  for (const version of [...versions].reverse()) {
    const next = stateAfter(version, state);
    described.push({ version, lines: changeLines(version, state, next) });
    state = next;
  }
  return described.reverse();
}

/** The document after this version, as far as it tells (`undefined`: unknown). */
function stateAfter(
  version: HistoryVersion,
  before: Document | null | undefined,
): Document | null | undefined {
  if (version.kind === "backup") return version.document ?? null;
  if (version.document !== undefined) return version.document;
  if (version.operationType === "delete" || version.operationType === "drop") return null;
  if (version.operationType === "dropDatabase" || version.operationType === "rename") return null;
  // An update without the full document: keep the last full version as the baseline,
  // so the next full version is compared with it (its diff sums up the updates between).
  return before;
}

function changeLines(
  version: HistoryVersion,
  before: Document | null | undefined,
  after: Document | null | undefined,
): string[] {
  if (version.kind === "change" && version.document === undefined && version.updatedFields) {
    return updateLines(version.updatedFields, version.removedFields ?? []);
  }
  if (after === undefined) return [];
  if (after === null) return before ? ["(document gone)"] : [];
  if (before === undefined) return ["(first known version)"];
  if (before === null) return ["(document created)"];
  const changes = diffDocuments(before, after);
  return changes.length === 0 ? ["(no changes)"] : changes.map(fieldLine);
}

function updateLines(updatedFields: Document, removedFields: readonly string[]): string[] {
  const lines = Object.entries(updatedFields).map(
    ([path, value]) => `~ ${path}: ${previewValue(value)}`,
  );
  for (const path of removedFields) lines.push(`- ${path}`);
  return lines;
}

function fieldLine(change: FieldChange): string {
  if (change.kind === "added") return `+ ${change.path}: ${previewValue(change.after)}`;
  if (change.kind === "removed") return `- ${change.path}: ${previewValue(change.before)}`;
  return `~ ${change.path}: ${previewValue(change.before)} → ${previewValue(change.after)}`;
}

function headline(context: CommandContext, version: HistoryVersion): string {
  const { out } = context;
  if (version.kind === "backup") {
    const state =
      version.state === "present" ? out.style("green", "present") : out.style("yellow", "absent");
    return `${formatTime(version.completedAt)}  backup ${out.style("bold", version.backupId)}  ${state}`;
  }
  return `${formatTime(version.at)}  ${out.style("cyan", version.operationType)} (journal, ${version.time.t}:${version.time.i})`;
}

/** `2026-10-21 03:00:04Z` (UTC, like backup ids). */
function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}
