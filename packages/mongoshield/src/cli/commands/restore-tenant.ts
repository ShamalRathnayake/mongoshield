/**
 * `mongoshield restore-tenant`: restore one tenant's documents in every collection of a
 * backup, leaving other tenants untouched (src/extras/tenant-restore.ts).
 *
 *   mongoshield restore-tenant --filter '{"tenantId":"acme"}' --dry-run
 *   mongoshield restore-tenant latest --filter '{"tenantId":"acme"}' --mode replace-tenant
 *   mongoshield restore-tenant --filter '{"tenantId":"acme"}' \
 *     --filter-for 'app.invoices={"customer.tenant":"acme"}' --include 'app.*'
 *
 * Always: 1. a dry run counts what would be deleted / inserted / replaced, and is
 * printed; 2. `replace-tenant` (which deletes) and upserts that replace documents ask
 * for confirmation (or --yes); 3. the restore runs. --dry-run stops after step 1.
 */

import type { Document } from "mongodb";
import type { RestoreContext } from "../../engine/context.ts";
import { MongoShieldError } from "../../errors.ts";
import {
  type RestoreTenantOptions,
  type RestoreTenantResult,
  restoreTenant,
  TENANT_RESTORE_MODES,
  validateTenantMode,
} from "../../extras/tenant-restore.ts";
import { openConnection } from "../../mongo/index.ts";
import type { DecryptionOptions } from "../../types.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { confirmOrThrow } from "../confirm.ts";
import { formatCount, formatDuration, plural } from "../format.ts";
import {
  createCliLogger,
  createCliShield,
  decryptionFromConfig,
  displayUri,
  rememberUriPassword,
} from "../setup.ts";
import { renderTable } from "../table.ts";
import { backupReadOverrides, parseEjsonDocument } from "./recovery-shared.ts";
import {
  backupSelectorArgument,
  excludeOption,
  identityFileOption,
  includeOption,
  listOrUndefined,
  parseKeyValues,
  passphraseEnvOption,
  storageFromOption,
} from "./shared-options.ts";

const NAME = "restore-tenant";

/** `mongoshield restore-tenant`. Registered in commands/index.ts. */
export const restoreTenantCommand: CommandSpec = {
  name: NAME,
  summary: "Restore one tenant's documents across every collection",
  description: [
    "Restores only the documents that match a tenant filter, in every selected",
    "collection of a backup. Other tenants are not touched. Modes: insert (default)",
    "adds missing documents; upsert also replaces existing ones; replace-tenant",
    "deletes the tenant's current documents first, so it ends up exactly as backed up.",
    "A dry run is always shown first; replace-tenant asks for confirmation.",
  ].join("\n"),
  positionals: [
    { name: "backup", optional: true, description: 'Backup id, or "latest" (default)' },
  ],
  options: {
    filter: {
      type: "string",
      valueName: "<json>",
      description: 'The tenant, as an Extended JSON filter, e.g. \'{"tenantId":"acme"}\'',
    },
    "filter-for": {
      type: "string",
      multiple: true,
      valueName: "<ns=json>",
      description: 'A different filter for one collection, e.g. \'app.invoices={"org":"acme"}\'',
    },
    mode: {
      type: "string",
      choices: TENANT_RESTORE_MODES,
      defaultText: "insert",
      description: "insert, upsert, or replace-tenant (delete the tenant's documents first)",
    },
    "to-uri": {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "Restore into this deployment (default: the configured source)",
    },
    from: storageFromOption,
    include: includeOption,
    exclude: excludeOption,
    rename: {
      type: "string",
      multiple: true,
      valueName: "<from=to>",
      description: "Restore under another name, e.g. 'app.*=sandbox.*'",
    },
    "dry-run": { type: "boolean", description: "Show what would change, and write nothing" },
    "identity-file": identityFileOption,
    "passphrase-env": passphraseEnvOption,
  },
  examples: [
    {
      description: "Preview restoring tenant acme from the latest backup",
      command: 'mongoshield restore-tenant --filter \'{"tenantId":"acme"}\' --dry-run',
    },
    {
      description: "Put acme back exactly as it was in a given backup",
      command:
        'mongoshield restore-tenant 2026-10-20T03-00-04Z_7f3a9c --filter \'{"tenantId":"acme"}\' --mode replace-tenant',
    },
    {
      description: "Restore acme into a sandbox database to compare first",
      command:
        "mongoshield restore-tenant --filter '{\"tenantId\":\"acme\"}' --include 'app.*' --rename 'app.*=acme_check.*'",
    },
  ],
  run: runRestoreTenantCommand,
};

async function runRestoreTenantCommand(context: CommandContext): Promise<number> {
  if (context.positionals.length > 1) {
    throw usageError("restore-tenant takes at most one argument: the backup.", NAME);
  }
  const toUri = context.flags.string("to-uri");
  if (toUri) rememberUriPassword(context, toUri);
  const cli = await createCliShield(context, backupReadOverrides(context));
  try {
    const decryption = await decryptionFromConfig(context, cli.config);
    const options = tenantOptions(context, decryption);
    const targetUri = toUri ?? cli.config.source?.uri;
    if (!targetUri) throw missingTargetError();

    const logger = createCliLogger(context.out);
    const connection = await openConnection({ uri: targetUri }, { logger });
    try {
      const engine: RestoreContext = {
        client: connection.client,
        storage: cli.shield.storage,
        logger,
      };
      const plan = await restoreTenant(engine, { ...options, dryRun: true });
      printPlan(context, plan, targetUri);
      if (context.flags.boolean("dry-run") || plan.totals.matched + plan.totals.deleted === 0) {
        return finish(context, plan);
      }
      await confirmIfDestructive(context, plan, targetUri);
      return finish(context, await restoreTenant(engine, options));
    } finally {
      await connection.close();
    }
  } finally {
    await cli.shield.close();
  }
}

/** The flags as engine options. */
function tenantOptions(
  context: CommandContext,
  decryption: DecryptionOptions | undefined,
): RestoreTenantOptions {
  const filterText = context.flags.string("filter");
  const byNamespace = parseFilterMap(context);
  if (filterText === undefined && byNamespace === undefined) {
    throw usageError('Which tenant? Pass --filter \'{"tenantId":"acme"}\'.', NAME);
  }
  const include = listOrUndefined(context, "include");
  const exclude = listOrUndefined(context, "exclude");
  const rename = parseKeyValues(context, NAME, "rename");
  return {
    backup: backupSelectorArgument(context),
    mode: validateTenantMode(context.flags.string("mode")),
    signal: context.signal,
    ...(filterText !== undefined ? { tenantFilter: parseEjsonDocument(filterText, "filter") } : {}),
    ...(byNamespace ? { tenantFilterByNamespace: byNamespace } : {}),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
    ...(rename ? { rename } : {}),
    ...(decryption ? { decryption } : {}),
  };
}

/** `--filter-for ns=json`, repeated. */
function parseFilterMap(context: CommandContext): Record<string, Document> | undefined {
  const pairs = parseKeyValues(context, NAME, "filter-for");
  if (pairs === undefined) return undefined;
  const filters: Record<string, Document> = {};
  for (const [namespace, text] of Object.entries(pairs)) {
    filters[namespace] = parseEjsonDocument(text, `filter for ${namespace}`);
  }
  return filters;
}

/** Deleting (replace-tenant) and replacing (upsert) documents need a yes. */
async function confirmIfDestructive(
  context: CommandContext,
  plan: RestoreTenantResult,
  targetUri: string,
): Promise<void> {
  const where = displayUri(targetUri);
  if (plan.mode === "replace-tenant") {
    await confirmOrThrow(context, {
      question: `Delete ${plural(plan.totals.deleted, "current document")} of this tenant in ${where} and insert ${formatCount(plan.totals.inserted)} from backup ${plan.backupId}?`,
      action: "delete the tenant's current documents with --mode replace-tenant",
    });
  } else if (plan.mode === "upsert" && plan.totals.replaced > 0) {
    await confirmOrThrow(context, {
      question: `Replace ${plural(plan.totals.replaced, "existing document")} in ${where} with the backed-up version?`,
      action: "replace existing documents with --mode upsert",
    });
  }
}

/** The dry run, one row per collection, on stderr. */
function printPlan(context: CommandContext, plan: RestoreTenantResult, targetUri: string): void {
  const { out } = context;
  if (out.settings.json) return;
  out.info(
    `Tenant restore from backup ${out.style("bold", plan.backupId)} into ${displayUri(targetUri)} (mode: ${plan.mode})`,
  );
  const rows = plan.namespaces.map((namespace) => [
    namespace.namespace === namespace.targetNamespace
      ? namespace.namespace
      : `${namespace.namespace} → ${namespace.targetNamespace}`,
    formatCount(namespace.matched),
    plan.mode === "replace-tenant" ? formatCount(namespace.deleted) : "-",
    formatCount(namespace.inserted),
    plan.mode === "upsert" ? formatCount(namespace.replaced) : "-",
    formatCount(namespace.skipped),
    namespace.createsCollection ? "creates collection" : "",
  ]);
  out.info(
    renderTable(
      [
        { header: "Collection" },
        { header: "In backup", align: "right" },
        { header: "Delete", align: "right" },
        { header: "Insert", align: "right" },
        { header: "Replace", align: "right" },
        { header: "Skip", align: "right" },
        { header: "" },
      ],
      rows,
      (text) => out.style("dim", text),
    ),
  );
  for (const skipped of plan.skipped)
    out.warn(`Not restored: ${skipped.namespace}: ${skipped.reason}`);
}

/** Prints the outcome: a summary line, or the result object with --json. */
function finish(context: CommandContext, result: RestoreTenantResult): number {
  const { out } = context;
  if (out.settings.json) {
    out.json(result);
    return 0;
  }
  if (result.dryRun) {
    out.success("Dry run: nothing was written.");
    return 0;
  }
  const { totals } = result;
  const parts = [`${formatCount(totals.inserted)} inserted`];
  if (result.mode === "replace-tenant") parts.unshift(`${formatCount(totals.deleted)} deleted`);
  if (result.mode === "upsert") parts.push(`${formatCount(totals.replaced)} replaced`);
  if (totals.skipped > 0)
    parts.push(`${formatCount(totals.skipped)} skipped (_id already present)`);
  out.result(
    `${out.style("green", "✔")} Restored the tenant in ${plural(result.namespaces.length, "collection")} (${parts.join(", ")}) in ${formatDuration(result.durationMs)}.`,
  );
  return 0;
}

function missingTargetError(): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", "No restore target is configured.", {
    hint: "Pass --to-uri, set MONGODB_URI (or MONGOSHIELD_URI), or set source.uri in mongoshield.config.ts.",
  });
}
