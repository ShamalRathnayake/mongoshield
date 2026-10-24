/**
 * From flags + config file + environment to a ready `MongoShield`.
 *
 * Commands describe their flags as a config layer (`overrides`); this file
 * loads the config with those overrides on top (see config/load.ts for the
 * priority rules), resolves the storage location, validates keys early, and
 * reads identity files and passphrases. Commands then call the shield.
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type LoadedConfig, loadConfig } from "../config/load.ts";
import type { MongoShieldConfig, MongoShieldConfigInput } from "../config/schema.ts";
import { assertValidRecipient, parseIdentityFile } from "../crypto/index.ts";
import { MongoShieldError } from "../errors.ts";
import type { LogFields, Logger } from "../logger.ts";
import { redactMongoUri } from "../redact.ts";
import { MongoShield } from "../shield.ts";
import { resolveStorage } from "../storage/resolve.ts";
import type { StorageAdapter } from "../storage/types.ts";
import type { DecryptionOptions, EncryptionOptions } from "../types.ts";
import type { CommandContext } from "./command.ts";
import type { Output } from "./io.ts";

/** A configured shield plus the facts commands like to show the user. */
export interface CliShield {
  readonly shield: MongoShield;
  readonly config: MongoShieldConfig;
  readonly configFile: string | undefined;
  /** Where backups live, safe to print (`./backups`, `s3://bucket/prefix`). */
  readonly storageLabel: string;
}

/** Loads the effective config, with `overrides` (from flags) taking priority. */
export async function loadCliConfig(
  context: CommandContext,
  overrides: MongoShieldConfigInput,
): Promise<LoadedConfig> {
  const loaded = await loadConfig({
    cwd: context.io.cwd,
    env: context.io.env,
    overrides,
    ...(context.global.config ? { configPath: context.global.config } : {}),
  });
  if (loaded.configFile) context.out.debug(`using config file ${loaded.configFile}`);
  else context.out.debug("no config file found; using environment variables and flags");

  // Remember secrets from the config so no error output can ever echo them.
  if (loaded.config.source?.uri) rememberUriPassword(context, loaded.config.source.uri);
  if (loaded.config.encryption?.passphrase) context.addSecret(loaded.config.encryption.passphrase);
  if (loaded.config.decryption?.passphrase) context.addSecret(loaded.config.decryption.passphrase);
  for (const identity of loaded.config.decryption?.identities ?? []) context.addSecret(identity);
  return loaded;
}

/** Loads the config and creates the shield. */
export async function createCliShield(
  context: CommandContext,
  overrides: MongoShieldConfigInput,
): Promise<CliShield> {
  const { config, configFile } = await loadCliConfig(context, overrides);
  const storage = await storageFromConfig(config.storage, context.io.cwd);
  const encryption = encryptionFromConfig(config);

  const shield = new MongoShield({
    storage,
    logger: createCliLogger(context.out),
    ...(config.source ? { source: { uri: config.source.uri } } : {}),
    ...(config.compression ? { compression: config.compression } : {}),
    ...(encryption ? { encryption } : {}),
    ...erasureOptions(config, context.io.env),
  });
  return { shield, config, configFile, storageLabel: describeStorage(config.storage) };
}

/**
 * Turns the configured storage into an adapter. Bare relative paths are
 * resolved against the CLI's working directory (not the process's), so
 * `--to ./backups` means what the user sees in their shell.
 */
async function storageFromConfig(
  storage: MongoShieldConfig["storage"],
  cwd: string,
): Promise<StorageAdapter> {
  if (typeof storage !== "string") return storage;
  return resolveStorage(
    hasUrlScheme(storage) || isAbsolute(storage) ? storage : resolve(cwd, storage),
  );
}

/** `s3://…`, `file://…`, `memory://…` (Windows drive letters never match). */
function hasUrlScheme(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location);
}

/** A printable description of the storage location. */
function describeStorage(storage: MongoShieldConfig["storage"]): string {
  return typeof storage === "string" ? storage : "custom storage adapter (from config file)";
}

/**
 * Validates recipients up front: a typo in a public key should fail in a
 * second, with a clear message, not after connecting to the database.
 */
function encryptionFromConfig(config: MongoShieldConfig): EncryptionOptions | undefined {
  const encryption = config.encryption;
  if (!encryption) return undefined;
  for (const recipient of encryption.recipients ?? []) assertValidRecipient(recipient);
  return {
    ...(encryption.recipients ? { recipients: encryption.recipients } : {}),
    ...(encryption.passphrase ? { passphrase: encryption.passphrase } : {}),
  };
}

/**
 * Gathers decryption secrets: inline identities, identity files and a
 * passphrase. Returns `undefined` when none are configured, so unencrypted
 * backups need no extra setup.
 */
export async function decryptionFromConfig(
  context: CommandContext,
  config: MongoShieldConfig,
): Promise<DecryptionOptions | undefined> {
  const decryption = config.decryption;
  if (!decryption) return undefined;

  const identities = [...(decryption.identities ?? [])];
  for (const file of decryption.identityFiles ?? []) {
    const fromFile = await readIdentityFile(context, file);
    for (const identity of fromFile) context.addSecret(identity);
    identities.push(...fromFile);
  }

  if (identities.length === 0 && !decryption.passphrase) return undefined;
  return {
    ...(identities.length > 0 ? { identities } : {}),
    ...(decryption.passphrase ? { passphrase: decryption.passphrase } : {}),
  };
}

/** Reads and validates an age identity file (as written by `mongoshield keygen` or `age-keygen`). */
async function readIdentityFile(context: CommandContext, file: string): Promise<string[]> {
  const path = isAbsolute(file) ? file : resolve(context.io.cwd, file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Cannot read the identity file ${path}.`, {
      cause: error,
      hint: "Check the path given with --identity-file (or decryption.identityFiles / MONGOSHIELD_IDENTITY_FILE).",
    });
  }
  await warnIfShared(context.out, path);
  try {
    return parseIdentityFile(text);
  } catch (error) {
    if (error instanceof MongoShieldError) {
      throw new MongoShieldError(error.code, `${path}: ${error.message}`, {
        cause: error,
        ...(error.hint ? { hint: error.hint } : {}),
      });
    }
    throw error;
  }
}

/**
 * Secret keys readable by other users on the machine are a common mistake
 * (copying a key file resets its mode). Warn, but do not refuse: on Windows
 * and some mounted volumes, modes mean nothing.
 */
async function warnIfShared(out: Output, path: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await stat(path).catch(() => undefined);
  // 0o077: any permission bit for "group" or "others".
  if (info && (info.mode & 0o077) !== 0) {
    out.warn(`The identity file ${path} is readable by other users. Run: chmod 600 ${path}`);
  }
}

/**
 * Reads a passphrase from the environment variable named by --passphrase-env.
 *
 * There is deliberately no `--passphrase <value>` flag: command-line arguments
 * are visible to every user on the machine (`ps`), and end up in shell history
 * and CI logs. An environment variable (or a secrets manager that sets one)
 * keeps the passphrase out of all three.
 */
export function readPassphraseEnv(context: CommandContext, variable: string): string {
  const value = context.io.env[variable];
  if (value === undefined || value === "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The environment variable ${variable} (from --passphrase-env) is not set or empty.`,
      { hint: `Set it first, e.g. \`read -rs ${variable} && export ${variable}\`.` },
    );
  }
  context.addSecret(value);
  return value;
}

/** Remembers the password inside a connection string, if any, as a secret. */
export function rememberUriPassword(context: CommandContext, uri: string): void {
  const match = /^mongodb(?:\+srv)?:\/\/[^:@/]*:([^@/]+)@/i.exec(uri);
  if (match?.[1]) {
    context.addSecret(match[1]);
    // The driver may echo the URL-decoded form, so remember that too.
    const decoded = safeDecode(match[1]);
    if (decoded !== match[1]) context.addSecret(decoded);
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A connection string that is safe to print. */
export function displayUri(uri: string | undefined): string {
  return uri ? redactMongoUri(uri) : "(no connection string)";
}

/**
 * The library's logger, wired to the CLI: warnings always reach the user,
 * debug and info only with --verbose (they are chatty by design).
 */
export function createCliLogger(out: Output): Logger {
  const verbose = (level: string) => (message: string, fields?: LogFields) =>
    out.debug(`${level} ${message}${formatFields(fields)}`);
  return {
    debug: verbose("debug"),
    info: verbose("info"),
    warn: (message, fields) => out.warn(`${message}${formatFields(fields)}`),
    error: (message, fields) => out.warn(`${message}${formatFields(fields)}`),
  };
}

/** ` {"id":"…"}`, or nothing for empty fields. */
function formatFields(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  try {
    return ` ${JSON.stringify(fields)}`;
  } catch {
    return "";
  }
}

/**
 * The erasure ledger's secret: from the config file, or `MONGOSHIELD_ERASURE_SECRET`
 * (preferred, so the secret stays out of files checked into git).
 */
function erasureOptions(
  config: MongoShieldConfig,
  env: NodeJS.ProcessEnv,
): { erasures?: { secret: string } } {
  const secret = env.MONGOSHIELD_ERASURE_SECRET?.trim() || config.erasures?.secret;
  return secret ? { erasures: { secret } } : {};
}
