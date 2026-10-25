/**
 * `mongoshield find`: search one collection of a backup, and optionally put the
 * matching documents back ("single-document restore").
 *
 *   mongoshield find app.users '{"email":"ada@example.com"}'
 *   mongoshield find 2026-10-20T03-00-04Z_7f3a9c app.users '{"_id":{"$oid":"…"}}' --restore
 *
 * The filter is MongoDB Extended JSON (relaxed or canonical), so ObjectIds, dates and
 * typed numbers can be written as `{"$oid": …}`, `{"$date": …}`, `{"$numberLong": …}`.
 * Searching needs only the backup storage (no database); the filter is evaluated
 * in-process (see src/engine/filter.ts for the supported operators).
 *
 * Output: each document pretty-printed as relaxed Extended JSON on stdout (status on
 * stderr). With --json, stdout is one JSON array of canonical Extended JSON documents,
 * which keeps every BSON type (Int32 vs Long vs Double), streamed as it is found.
 *
 * With --restore, the matching documents are written to the target (--to-uri,
 * default: the configured source; --to-namespace, default: the same namespace):
 *   1. a dry run counts what would be inserted / replaced / skipped, and is printed;
 *   2. upserts that replace existing documents ask for confirmation (or --yes);
 *   3. the documents are written. --dry-run stops after step 1.
 */

import { BSON, type Document } from "mongodb";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import type { EngineContext, RestoreContext } from "../../engine/context.ts";
import { findInBackup } from "../../engine/find.ts";
import {
  type RestoreDocumentsMode,
  type RestoreDocumentsOptions,
  type RestoreDocumentsResult,
  restoreDocuments,
} from "../../engine/find-restore.ts";
import { MongoShieldError } from "../../errors.ts";
import { openConnection } from "../../mongo/index.ts";
import type { DecryptionOptions } from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatDuration, plural } from "../format.ts";
import {
  type CliShield,
  createCliLogger,
  createCliShield,
  decryptionFromConfig,
  displayUri,
  readPassphraseEnv,
  rememberUriPassword,
} from "../setup.ts";
import {
  identityFileOption,
  listOrUndefined,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "find";

const MODES: readonly RestoreDocumentsMode[] = ["insert", "upsert"];

/** `mongoshield find`. Registered in commands/index.ts. */
export const findInBackupCommand: CommandSpec = {
  name: NAME,
  summary: "Search a backup for documents, and restore just those",
  description: [
    "Searches one collection of a backup with a MongoDB filter, without restoring it.",
    'The filter is Extended JSON: \'{"_id":{"$oid":"…"}}\', \'{"age":{"$gte":18}}\'.',
    "Supported: equality, $eq $ne $gt $gte $lt $lte $in $nin $exists $type $regex",
    "$and $or $nor $not $elemMatch $size. With --restore, the matching documents are",
    "written back (insert skips documents whose _id exists; upsert replaces them).",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
    { name: "namespace", description: "The collection to search, e.g. app.users" },
    {
      name: "filter",
      optional: true,
      description: "MongoDB filter as Extended JSON (default: {})",
    },
  ],
  options: {
    from: storageFromOption,
    limit: {
      type: "string",
      valueName: "<n>",
      description: "Stop after n matching documents (default: no limit)",
    },
    projection: {
      type: "string",
      valueName: "<json>",
      description: 'Only these fields, e.g. \'{"name":1,"email":1}\' (or 0 to drop fields)',
    },
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
    restore: { type: "boolean", description: "Write the matching documents to the target" },
    "to-uri": {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "With --restore: the deployment to write to (default: the configured source)",
    },
    "to-namespace": {
      type: "string",
      valueName: "<db.collection>",
      description: "With --restore: the collection to write to (default: the same namespace)",
    },
    mode: {
      type: "string",
      choices: MODES,
      defaultText: "insert",
      description: "With --restore: insert (skip existing _id) or upsert (replace them)",
    },
    create: {
      type: "boolean",
      description: "With --restore: create the target collection if it does not exist",
    },
    "dry-run": {
      type: "boolean",
      description: "With --restore: count what would be written, and write nothing",
    },
  },
  examples: [
    {
      description: "Find a user in the latest backup",
      command: 'mongoshield find app.users \'{"email":"ada@example.com"}\'',
    },
    {
      description: "Find by ObjectId in a specific backup, as type-preserving JSON",
      command:
        'mongoshield find 2026-10-20T03-00-04Z_7f3a9c app.users \'{"_id":{"$oid":"6523f1c2a1b2c3d4e5f60718"}}\' --json',
    },
    {
      description: "Put back orders deleted by mistake (keeps the ones that still exist)",
      command:
        'mongoshield find app.orders \'{"customerId":42,"createdAt":{"$gte":{"$date":"2026-10-01T00:00:00Z"}}}\' --restore',
    },
    {
      description: "Preview restoring into a side collection",
      command:
        'mongoshield find app.users \'{"tags":"vip"}\' --restore --to-namespace app.users_restored --create --dry-run',
    },
  ],
  run: runFindCommand,
};

/** The positionals, sorted out: `[backup] <namespace> [filter]`. */
interface FindArguments {
  readonly backup: string;
  readonly namespace: string;
  readonly filter: Document;
}

async function runFindCommand(context: CommandContext): Promise<number> {
  const args = parseArguments(context);
  checkRestoreFlags(context);
  const cli = await createCliShield(context, findOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    if (context.flags.boolean("restore")) {
      return await runRestore(context, cli, args, decryption);
    }
    return await printMatches(context, cli, args, decryption);
  } finally {
    await cli.shield.close();
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * `find <ns>`, `find <ns> <filter>`, `find <backup> <ns>`, `find <backup> <ns> <filter>`.
 * With two arguments, the second is the filter when it looks like JSON (`{…}`).
 */
function parseArguments(context: CommandContext): FindArguments {
  const [first, second, third] = context.positionals;
  if (first === undefined) {
    throw usageError("Which collection? Pass a namespace such as app.users.", NAME);
  }
  let backup = "latest";
  let namespace = first;
  let filterText: string | undefined;
  if (third !== undefined) {
    backup = first;
    namespace = second ?? "";
    filterText = third;
  } else if (second !== undefined) {
    if (second.trim().startsWith("{")) filterText = second;
    else {
      backup = first;
      namespace = second;
    }
  }
  if (!namespace.includes(".") || namespace.startsWith(".") || namespace.endsWith(".")) {
    throw usageError(`"${namespace}" is not a namespace; use <database>.<collection>.`, NAME);
  }
  return { backup, namespace, filter: parseJsonDocument(filterText ?? "{}", "filter") };
}

/** Parses Extended JSON (canonical types kept: `1` is an Int32, `1.5` a Double). */
function parseJsonDocument(text: string, what: string): Document {
  let parsed: unknown;
  try {
    parsed = BSON.EJSON.parse(text, { relaxed: false });
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The ${what} is not valid Extended JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: `Quote it for the shell and use double quotes inside, e.g. '{"_id":{"$oid":"6523f1c2a1b2c3d4e5f60718"}}'.`,
      },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `The ${what} must be a JSON object.`, {
      hint: `Example: '{"email":"ada@example.com"}'.`,
    });
  }
  return parsed;
}

/** --to-uri, --mode, … only make sense with --restore; silently ignoring them would mislead. */
function checkRestoreFlags(context: CommandContext): void {
  if (context.flags.boolean("restore")) return;
  for (const flag of ["to-uri", "to-namespace", "mode", "create", "dry-run"]) {
    if (context.flags.has(flag)) throw usageError(`--${flag} needs --restore.`, NAME);
  }
}

/** Flags as a config layer: where backups are read from, and decryption secrets. */
function findOverrides(context: CommandContext): MongoShieldConfigInput {
  const toUri = context.flags.string("to-uri");
  if (toUri) rememberUriPassword(context, toUri);
  const passphraseVariable = context.flags.string("passphrase-env");
  const passphrase = passphraseVariable
    ? readPassphraseEnv(context, passphraseVariable)
    : undefined;
  const identityFiles = listOrUndefined(context, "identity-file");
  return {
    storage: context.flags.string("from"),
    decryption: identityFiles || passphrase ? { identityFiles, passphrase } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/** Streams the matches to stdout: pretty EJSON, or one JSON array with --json. */
async function printMatches(
  context: CommandContext,
  cli: CliShield,
  args: FindArguments,
  decryption: DecryptionOptions | undefined,
): Promise<number> {
  const { out } = context;
  const projectionText = context.flags.string("projection");
  const limit = context.flags.integer("limit", { min: 1 });
  const engine: EngineContext = { storage: cli.shield.storage, logger: createCliLogger(out) };
  const documents = findInBackup(engine, {
    backup: args.backup,
    namespace: args.namespace,
    filter: args.filter,
    signal: context.signal,
    ...(projectionText ? { projection: parseJsonDocument(projectionText, "projection") } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(decryption ? { decryption } : {}),
  });

  const stdout = context.io.stdout;
  let count = 0;
  if (out.settings.json) stdout.write("[");
  for await (const document of documents) {
    if (out.settings.json) {
      // Canonical EJSON keeps every BSON type; the array is written as it streams.
      stdout.write(
        `${count === 0 ? "\n" : ",\n"}  ${BSON.EJSON.stringify(document, { relaxed: false })}`,
      );
    } else {
      out.result(BSON.EJSON.stringify(document, undefined, 2, { relaxed: true }));
    }
    count += 1;
  }
  if (out.settings.json) stdout.write(count === 0 ? "]\n" : "\n]\n");

  out.info(
    `${plural(count, "matching document")} in ${args.namespace} (backup ${args.backup}, ${cli.storageLabel}).`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/** Dry run → (confirm upserts) → write. */
async function runRestore(
  context: CommandContext,
  cli: CliShield,
  args: FindArguments,
  decryption: DecryptionOptions | undefined,
): Promise<number> {
  if (context.flags.has("limit") || context.flags.has("projection")) {
    throw usageError(
      "--limit and --projection cannot be used with --restore (whole matching documents are restored).",
      NAME,
    );
  }
  const targetUri = context.flags.string("to-uri") ?? cli.config.source?.uri;
  if (!targetUri) throw missingTargetError();

  const connection = await openConnection(
    { uri: targetUri },
    { logger: createCliLogger(context.out) },
  );
  try {
    const engine: RestoreContext = {
      client: connection.client,
      storage: cli.shield.storage,
      logger: createCliLogger(context.out),
    };
    const options = restoreOptions(context, args, decryption);
    const plan = await restoreDocuments(engine, { ...options, dryRun: true });
    printPlan(context, plan, targetUri);
    if (context.flags.boolean("dry-run")) return finish(context, plan);

    if (plan.matched === 0) {
      // The plan is a dry run; saying "Dry run" here would suggest --dry-run was given.
      if (!context.out.settings.json) {
        context.out.success("Nothing to restore: no backed-up document matches.");
        return 0;
      }
      return finish(context, plan);
    }
    if (plan.mode === "upsert" && plan.replaced > 0) {
      await confirmOrThrow(context, {
        question: `Replace ${plural(plan.replaced, "existing document")} in ${plan.targetNamespace} (${displayUri(targetUri)}) with the backed-up version?`,
        action: "replace existing documents with --mode upsert",
      });
    }
    return finish(context, await restoreDocuments(engine, options));
  } finally {
    await connection.close();
  }
}

function restoreOptions(
  context: CommandContext,
  args: FindArguments,
  decryption: DecryptionOptions | undefined,
): RestoreDocumentsOptions {
  const mode = MODES.find((candidate) => candidate === context.flags.string("mode")) ?? "insert";
  const targetNamespace = context.flags.string("to-namespace");
  return {
    backup: args.backup,
    namespace: args.namespace,
    filter: args.filter,
    mode,
    createIfMissing: context.flags.boolean("create"),
    signal: context.signal,
    ...(targetNamespace ? { targetNamespace } : {}),
    ...(decryption ? { decryption } : {}),
  };
}

/** What the restore will do, on stderr (context for the decision). */
function printPlan(context: CommandContext, plan: RestoreDocumentsResult, targetUri: string): void {
  const { out } = context;
  if (out.settings.json) return;
  out.info(
    `Restore from backup ${out.style("bold", plan.backupId)}: ${plan.namespace} → ${plan.targetNamespace} in ${displayUri(targetUri)} (mode: ${plan.mode})`,
  );
  const lines = [`  ${plural(plan.matched, "matching document")}`];
  lines.push(`  ${out.style("green", `${plan.inserted} to insert`)}`);
  if (plan.mode === "upsert") lines.push(`  ${out.style("yellow", `${plan.replaced} to replace`)}`);
  else lines.push(`  ${out.style("dim", `${plan.skipped} already present (skipped)`)}`);
  if (!plan.targetExisted) {
    lines.push(
      `  ${out.style("yellow", `${plan.targetNamespace} does not exist and will be created`)}`,
    );
  }
  out.info(lines.join("\n"));
}

/** Prints the outcome: a summary line, or the result object with --json. */
function finish(context: CommandContext, result: RestoreDocumentsResult): number {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return 0;
  }
  if (result.dryRun) {
    out.success("Dry run: nothing was written.");
    return 0;
  }
  const details =
    result.mode === "upsert"
      ? `${result.inserted} inserted, ${result.replaced} replaced`
      : `${result.inserted} inserted, ${result.skipped} skipped (already present)`;
  out.result(
    `${out.style("green", "✔")} Restored ${plural(result.inserted + result.replaced, "document")} into ${result.targetNamespace} (${details}) in ${formatDuration(result.durationMs)}.`,
  );
  return 0;
}

function missingTargetError(): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", "No restore target is configured.", {
    hint: "Pass --to-uri, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
  });
}
