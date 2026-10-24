/**
 * `mongoshield erase <namespace> '<filter>' --reason …`: record a GDPR erasure.
 *
 * Appends the request to the erasure ledger next to the backups (see
 * src/extras/erasure.ts), so every later restore, rollback and copy deletes the
 * person's documents again. With --now it also deletes them from the live database.
 *
 * The filter is Extended JSON, like `find`: '{"email": "ada@example.com"}' or
 * '{"_id": {"$oid": "…"}}'. Exact matches on strings are stored hashed, keyed with
 * MONGOSHIELD_ERASURE_SECRET (or `erasures.secret`) when set.
 */

import { hostname, userInfo } from "node:os";
import { BSON, type Document } from "mongodb";
import type { MongoShieldConfig } from "../../config/schema.ts";
import { MongoShieldError } from "../../errors.ts";
import { eraseLiveDocuments, recordErasure } from "../../extras/erasure.ts";
import { openConnection } from "../../mongo/connection.ts";
import { usageError } from "../args.ts";
import type { CommandContext, CommandSpec } from "../command.ts";
import { plural } from "../format.ts";
import { createCliLogger, createCliShield, displayUri, rememberUriPassword } from "../setup.ts";
import { storageFromOption } from "./shared-options.ts";

const NAME = "erase";

/** Environment variable holding the erasure secret (also `erasures.secret` in the config). */
export const ERASURE_SECRET_ENV = "MONGOSHIELD_ERASURE_SECRET";

export const eraseCommand: CommandSpec = {
  name: NAME,
  summary: "Record a GDPR erasure so restores never bring the data back",
  description: [
    "Appends an erasure to the ledger next to the backups. Every later restore,",
    "rollback and copy deletes the matching documents again. --now also deletes them",
    "from the live database. Exact matches on strings are stored as keyed hashes",
    `(set ${ERASURE_SECRET_ENV}), so the ledger does not keep the personal data.`,
  ].join("\n"),
  positionals: [
    { name: "namespace", description: "db.collection, a pattern like app.*, or *" },
    { name: "filter", description: `Extended JSON filter, e.g. '{"email": "ada@example.com"}'` },
  ],
  options: {
    reason: {
      type: "string",
      valueName: "<text>",
      description: "Why (required). Reference the request, not the personal data",
    },
    by: {
      type: "string",
      valueName: "<name>",
      description: "Who requested or approved it (default: user@host)",
    },
    now: { type: "boolean", description: "Also delete the documents from the live database" },
    uri: {
      type: "string",
      valueName: "<mongodb-uri>",
      description: "The live database for --now (default: config source.uri)",
    },
    to: storageFromOption,
  },
  examples: [
    {
      description: "Erase a user everywhere, now and in every future restore",
      command:
        'mongoshield erase app.users \'{"email": "ada@example.com"}\' --reason "GDPR request #4471" --now',
    },
    {
      description: "Erase a customer's documents in every collection that has a userId",
      command: "mongoshield erase 'app.*' '{\"userId\": 1042}' --reason \"account deletion 1042\"",
    },
  ],
  run: runEraseCommand,
};

async function runEraseCommand(context: CommandContext): Promise<number> {
  const [namespace, filterText] = context.positionals;
  if (namespace === undefined || filterText === undefined) {
    throw usageError("erase needs a namespace and a filter.", NAME);
  }
  const reason = context.flags.string("reason")?.trim();
  if (!reason) {
    throw new MongoShieldError("MS_CONFIG_INVALID", "An erasure needs a reason.", {
      hint: 'Reference the request, e.g. --reason "GDPR request #4471".',
    });
  }
  const filter = parseFilter(filterText);
  const uri = context.flags.string("uri");
  if (uri) rememberUriPassword(context, uri);
  const cli = await createCliShield(context, {
    source: uri ? { uri } : undefined,
    storage: context.flags.string("to"),
  });
  try {
    const secret = erasureSecret(context, cli.config);
    const by = context.flags.string("by") ?? currentUser();
    const record = await recordErasure(cli.shield.storage, {
      namespace,
      filter,
      reason,
      signal: context.signal,
      ...(by ? { requestedBy: by } : {}),
      ...(secret ? { secret } : {}),
    });
    // Every JSON filter has quotes (its keys), so look at the values: only strings in a
    // filter stored as written are a likely place for personal data.
    if (record.match.kind === "filter" && holdsString(filter)) {
      context.out.warn(
        "This filter is stored as written (it is not an exact match on strings). Make sure it holds no personal data.",
      );
    } else if (record.match.kind === "hashed" && !record.match.keyed) {
      context.out.warn(
        `The filter is stored hashed but without a secret, so a guess can be confirmed. Set ${ERASURE_SECRET_ENV}.`,
      );
    }

    let deleted: number | undefined;
    if (context.flags.boolean("now")) {
      const sourceUri = cli.config.source?.uri;
      if (!sourceUri) {
        throw new MongoShieldError("MS_CONFIG_INVALID", "--now needs the live database.", {
          hint: "Pass --uri or set source.uri / MONGODB_URI. The erasure is already recorded.",
        });
      }
      const connection = await openConnection(
        { uri: sourceUri },
        { logger: createCliLogger(context.out) },
      );
      try {
        const results = await eraseLiveDocuments(connection.client, {
          namespace,
          filter,
          signal: context.signal,
        });
        deleted = results.reduce((sum, result) => sum + result.deleted, 0);
        context.out.info(`Deleted ${plural(deleted, "document")} from ${displayUri(sourceUri)}.`);
      } finally {
        await connection.close();
      }
    }

    if (context.out.settings.json) {
      context.out.json({ record, ...(deleted !== undefined ? { deletedNow: deleted } : {}) });
    } else {
      context.out.result(
        `${context.out.style("green", "✔")} Erasure ${record.id} recorded for ${namespace}; it applies to every future restore.`,
      );
    }
    return 0;
  } finally {
    await cli.shield.close();
  }
}

/** Parses the Extended JSON filter (canonical mode, so every BSON type survives). */
function parseFilter(text: string): Document {
  let parsed: unknown;
  try {
    parsed = BSON.EJSON.parse(text, { relaxed: false });
  } catch (error) {
    throw usageError(
      `The filter is not valid Extended JSON: ${error instanceof Error ? error.message : String(error)}`,
      NAME,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError("The filter must be a JSON object, e.g. '{\"_id\": 42}'.", NAME);
  }
  return parsed as Document;
}

/** True when `value` is, or contains (in documents and arrays), a string. */
function holdsString(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.some(holdsString);
  // Plain documents only: BSON values (ObjectId, Long, …) are objects too, without strings.
  const plainDocument =
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype;
  return plainDocument && Object.values(value).some(holdsString);
}

/**
 * The erasure secret from the environment or the config, remembered as a secret. The
 * environment wins, as in setup.ts (which keys the ledger for restores): if the two
 * disagreed, records written here could not be matched by a later restore.
 */
export function erasureSecret(
  context: CommandContext,
  config: MongoShieldConfig,
): string | undefined {
  const secret = context.io.env[ERASURE_SECRET_ENV]?.trim() || config.erasures?.secret;
  if (secret) context.addSecret(secret);
  return secret || undefined;
}

/** `alice@build-01`, or undefined where the OS cannot say. */
function currentUser(): string | undefined {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return undefined;
  }
}
