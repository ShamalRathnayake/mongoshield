/**
 * Helpers shared by the recovery commands (`restore-tenant`, `history`, `diff`, and the
 * text formats of `export`): parsing Extended JSON arguments, the "where are the
 * backups and how are they unlocked" config layer, and short value previews.
 */

import { BSON, type Document } from "mongodb";
import type { MongoShieldConfigInput } from "../../config/schema.ts";
import { MongoShieldError } from "../../errors.ts";
import { parseExtendedJson } from "../../format/ordered-json.ts";
import type { CommandContext } from "../command.ts";
import { readPassphraseEnv } from "../setup.ts";
import { listOrUndefined } from "./shared-options.ts";

/** Longest value preview printed in a table cell or a diff line. */
const PREVIEW_LENGTH = 80;

/**
 * Parses an Extended JSON value (canonical types kept: `1` is an Int32, `1.5` a Double;
 * `{"$oid": …}` an ObjectId). `what` names the argument in the error. Documents keep
 * the field order they were typed in (src/format/ordered-json.ts), so an `_id` such as
 * `{"b":1,"2":1}` stays that `_id` instead of becoming `{"2":1,"b":1}`.
 */
export function parseEjsonValue(text: string, what: string): unknown {
  try {
    return parseExtendedJson(text, { relaxed: false });
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The ${what} is not valid Extended JSON: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: `Quote it for the shell and use double quotes inside: strings as '"ada"', ObjectIds as '{"$oid":"6523f1c2a1b2c3d4e5f60718"}', filters as '{"tenantId":"acme"}'.`,
      },
    );
  }
}

/** Parses an Extended JSON object (a filter). */
export function parseEjsonDocument(text: string, what: string): Document {
  const parsed = parseEjsonValue(text, what);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `The ${what} must be a JSON object.`, {
      hint: `Example: '{"tenantId":"acme"}'.`,
    });
  }
  return parsed;
}

/** `--from`, `--identity-file` and `--passphrase-env` as a config layer. */
export function backupReadOverrides(context: CommandContext): MongoShieldConfigInput {
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

/** A value as one short line of relaxed Extended JSON (cut at {@link PREVIEW_LENGTH}). */
export function previewValue(value: unknown): string {
  const text = value === undefined ? "(missing)" : BSON.EJSON.stringify(value, { relaxed: true });
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH - 1)}…` : text;
}

/** A result with BSON values (ids, documents) as plain canonical Extended JSON, for `--json`. */
export function toCanonicalJson(value: unknown): unknown {
  return BSON.EJSON.serialize({ value }, { relaxed: false }).value;
}
