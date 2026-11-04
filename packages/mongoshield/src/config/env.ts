/**
 * Environment variables understood by the CLI.
 *
 * They let containers and CI pipelines configure MongoShield without a config
 * file, and keep secrets out of files checked into git.
 *
 * | Variable                    | Config field                   |
 * |-----------------------------|--------------------------------|
 * | MONGOSHIELD_URI, MONGODB_URI| source.uri                     |
 * | MONGOSHIELD_URI_FILE        | source.uri, read from that file (a mounted secret); the variables above win |
 * | MONGOSHIELD_STORAGE         | storage                        |
 * | MONGOSHIELD_COMPRESSION     | compression                    |
 * | MONGOSHIELD_RECIPIENTS      | encryption.recipients (comma-separated) |
 * | MONGOSHIELD_PASSPHRASE      | encryption.passphrase and decryption.passphrase |
 * | MONGOSHIELD_IDENTITY        | decryption.identities (one identity) |
 * | MONGOSHIELD_IDENTITY_FILE   | decryption.identityFiles (one path) |
 * | MONGOSHIELD_DRILL_URI       | drill.targetUri (and `mongoshield drill`'s --target-uri) |
 * | MONGOSHIELD_HEARTBEAT_URL   | heartbeat                      |
 *
 * MONGOSHIELD_DRILL_URI lets the scratch deployment of a restore drill come from a
 * secret (a Kubernetes Secret, a CI secret) while the rest of the `drill` section
 * (sample, prefix, assertions) stays in the config file. MONGOSHIELD_HEARTBEAT_URL does
 * the same for the heartbeat ping URL, which is a credential too; notify URLs, which sit
 * in a list, use `{ env: "NAME" }` references in the config instead (secret-references.ts).
 */

import { readFileSync } from "node:fs";
import { MongoShieldError } from "../errors.ts";
import type { MongoShieldConfigInput } from "./schema.ts";

/**
 * Reads the `MONGOSHIELD_*` variables into a partial config layer.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when `MONGOSHIELD_URI_FILE` names a file
 *   that cannot be read or is empty.
 */
export function readEnvironmentConfig(env: NodeJS.ProcessEnv): MongoShieldConfigInput {
  const uri =
    value(env.MONGOSHIELD_URI) ?? value(env.MONGODB_URI) ?? uriFromFile(env.MONGOSHIELD_URI_FILE);
  const recipients = list(env.MONGOSHIELD_RECIPIENTS);
  const passphrase = value(env.MONGOSHIELD_PASSPHRASE);
  const identity = value(env.MONGOSHIELD_IDENTITY);
  const identityFile = value(env.MONGOSHIELD_IDENTITY_FILE);
  const drillUri = value(env.MONGOSHIELD_DRILL_URI);
  const heartbeat = value(env.MONGOSHIELD_HEARTBEAT_URL);

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
    drill: drillUri ? { targetUri: drillUri } : undefined,
    heartbeat,
  };
}

/** Connection strings are short; a bigger file is not one (and is not read whole). */
const MAX_URI_FILE_BYTES = 64 * 1024;

/**
 * The connection string in the file `MONGOSHIELD_URI_FILE` names: a Kubernetes or Docker
 * secret mount, so the password never sits in the process list or the environment.
 * Surrounding whitespace (the trailing newline of `echo … > file`) is dropped.
 */
function uriFromFile(rawPath: string | undefined): string | undefined {
  const path = value(rawPath);
  if (path === undefined) return undefined;
  let text: string;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > MAX_URI_FILE_BYTES) throw new Error("the file is too large");
    text = bytes.toString("utf8");
  } catch (error) {
    // The path is not a secret; the file's contents never appear in the message.
    const reason = error instanceof Error ? error.message : String(error);
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `MONGOSHIELD_URI_FILE (${path}) cannot be read: ${reason}.`,
      { hint: "Point it at a file that holds only the connection string." },
    );
  }
  const uri = value(text);
  if (uri === undefined) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `MONGOSHIELD_URI_FILE (${path}) is empty.`, {
      hint: "Write the connection string into it, or unset the variable.",
    });
  }
  return uri;
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
