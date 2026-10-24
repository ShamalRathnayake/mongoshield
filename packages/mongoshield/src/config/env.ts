/**
 * Environment variables understood by the CLI.
 *
 * They let containers and CI pipelines configure MongoShield without a config
 * file, and keep secrets out of files checked into git.
 *
 * | Variable                    | Config field                   |
 * |-----------------------------|--------------------------------|
 * | MONGOSHIELD_URI, MONGODB_URI| source.uri                     |
 * | MONGOSHIELD_STORAGE         | storage                        |
 * | MONGOSHIELD_COMPRESSION     | compression                    |
 * | MONGOSHIELD_RECIPIENTS      | encryption.recipients (comma-separated) |
 * | MONGOSHIELD_PASSPHRASE      | encryption.passphrase and decryption.passphrase |
 * | MONGOSHIELD_IDENTITY        | decryption.identities (one identity) |
 * | MONGOSHIELD_IDENTITY_FILE   | decryption.identityFiles (one path) |
 */

import type { MongoShieldConfigInput } from "./schema.ts";

/** Reads the `MONGOSHIELD_*` variables into a partial config layer. */
export function readEnvironmentConfig(env: NodeJS.ProcessEnv): MongoShieldConfigInput {
  const uri = value(env.MONGOSHIELD_URI) ?? value(env.MONGODB_URI);
  const recipients = list(env.MONGOSHIELD_RECIPIENTS);
  const passphrase = value(env.MONGOSHIELD_PASSPHRASE);
  const identity = value(env.MONGOSHIELD_IDENTITY);
  const identityFile = value(env.MONGOSHIELD_IDENTITY_FILE);

  return {
    source: uri ? { uri } : undefined,
    storage: value(env.MONGOSHIELD_STORAGE),
    compression: parseCompression(value(env.MONGOSHIELD_COMPRESSION)),
    // A passphrase only turns on encryption when no recipients are configured;
    // the merged config is validated later, which reports any conflict clearly.
    encryption: recipients || passphrase ? { recipients, passphrase } : undefined,
    decryption:
      identity || identityFile || passphrase
        ? {
            identities: identity ? [identity] : undefined,
            identityFiles: identityFile ? [identityFile] : undefined,
            passphrase,
          }
        : undefined,
  };
}

/** Treats empty strings as unset: `FOO= mongoshield ...` should not mean "empty value". */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Splits a comma-separated list, ignoring empty entries. */
function list(raw: string | undefined): string[] | undefined {
  const items = (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Passes through known values and lets validation report anything else. */
function parseCompression(raw: string | undefined): "zstd" | "gzip" | "none" | undefined {
  if (raw === undefined) return undefined;
  // Unknown values are passed through on purpose so the schema reports them.
  return raw as "zstd" | "gzip" | "none";
}
