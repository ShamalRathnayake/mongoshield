/**
 * Loading the effective configuration for the CLI.
 *
 * Sources, from lowest to highest priority:
 *   0. the `preset` named by any of the layers below (presets.ts)
 *   1. the config file (`mongoshield.config.ts` and friends, or `--config <path>`)
 *   2. environment variables (`MONGOSHIELD_*`, plus `MONGODB_URI`)
 *   3. command-line flags (passed in as `overrides`)
 *
 * The merged result is validated once, at the end, so error messages describe
 * the final configuration rather than one of its layers.
 */

import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { MongoShieldError } from "../errors.ts";
import { readEnvironmentConfig } from "./env.ts";
import { CONFIG_PRESETS, isConfigPresetName } from "./presets.ts";
import { ConfigSchema, type MongoShieldConfig, type MongoShieldConfigInput } from "./schema.ts";

/** File names searched, in order, when no `--config` path is given. */
export const CONFIG_FILE_NAMES = [
  "mongoshield.config.ts",
  "mongoshield.config.mts",
  "mongoshield.config.js",
  "mongoshield.config.mjs",
  "mongoshield.config.json",
] as const;

export interface LoadConfigOptions {
  /** Explicit config file path (`--config`). If given, the file must exist. */
  readonly configPath?: string;
  /** Directory searched for a config file. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Environment to read `MONGOSHIELD_*` variables from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Highest-priority values, typically from CLI flags. */
  readonly overrides?: MongoShieldConfigInput;
}

export interface LoadedConfig {
  readonly config: MongoShieldConfig;
  /** Absolute path of the config file used, if any. */
  readonly configFile: string | undefined;
}

/** Loads, merges and validates the configuration. */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configFile = await findConfigFile(cwd, options.configPath);
  const fromFile = configFile ? await importConfigFile(configFile) : {};
  const fromEnv = readEnvironmentConfig(options.env ?? process.env);

  const merged = mergeConfigs(mergeConfigs(fromFile, fromEnv), options.overrides ?? {});
  return { config: validateConfig(merged, configFile), configFile };
}

/** Validates a config object, turning schema problems into one readable error. */
export function validateConfig(input: unknown, configFile?: string): MongoShieldConfig {
  // The preset is the lowest layer, so it is applied to the merged result: a preset
  // named by any layer (file, environment, flag) fills in what none of them set.
  const result = ConfigSchema.safeParse(applyConfigPreset(removeUndefined(input)));
  if (result.success) return result.data;

  const where = configFile ? ` (from ${configFile})` : "";
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The configuration is invalid${where}:\n${z.prettifyError(result.error)}`,
    {
      hint: "Fix the values above in your config file, environment variables or flags.",
    },
  );
}

/**
 * Fills in the defaults of the named `preset` under the given (merged) config.
 * An unknown preset name is left alone, so the schema reports it with the valid names.
 */
function applyConfigPreset(input: unknown): unknown {
  if (!isPlainObject(input) || !isConfigPresetName(input.preset)) return input;
  return mergeValues(CONFIG_PRESETS[input.preset], input);
}

/** Returns the config file to load, or `undefined` if there is none. */
async function findConfigFile(cwd: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath) {
    const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    if (!(await fileExists(absolute))) {
      throw new MongoShieldError("MS_CONFIG_INVALID", `Config file not found: ${absolute}`);
    }
    return absolute;
  }

  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(cwd, name);
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Imports a config file. jiti lets users write the config in TypeScript without
 * a build step, on every supported Node version.
 */
async function importConfigFile(path: string): Promise<MongoShieldConfigInput> {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  let loaded: unknown;
  try {
    loaded = await jiti.import(path, { default: true });
  } catch (error) {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Could not load config file ${path}.`, {
      cause: error,
      hint: "Check the file for syntax errors; it must `export default defineConfig({...})`.",
    });
  }

  if (typeof loaded !== "object" || loaded === null) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Config file ${path} must export an object as its default export.`,
    );
  }
  return loaded as MongoShieldConfigInput;
}

/**
 * Deep-merges two config layers. Plain objects merge key by key; arrays,
 * strings and adapter objects from `higher` replace those in `lower`.
 * `undefined` in `higher` never erases a value from `lower`.
 */
export function mergeConfigs(
  lower: MongoShieldConfigInput,
  higher: MongoShieldConfigInput,
): MongoShieldConfigInput {
  return mergeValues(lower, higher) as MongoShieldConfigInput;
}

function mergeValues(lower: unknown, higher: unknown): unknown {
  if (higher === undefined) return lower;
  if (isPlainObject(lower) && isPlainObject(higher)) {
    const result: Record<string, unknown> = { ...lower };
    for (const [key, value] of Object.entries(higher)) {
      result[key] = mergeValues(lower[key], value);
    }
    return result;
  }
  return higher;
}

/** True for `{}`-style objects; false for arrays, adapters (class instances) and null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  const looksLikeAdapter = typeof Reflect.get(value, "put") === "function";
  return (prototype === Object.prototype || prototype === null) && !looksLikeAdapter;
}

/**
 * Drops `undefined` values recursively so that an unset environment variable in
 * the config file (`uri: process.env.MISSING`) reads as "not set" rather than
 * failing with "expected string, received undefined" deep inside an object.
 */
function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(removeUndefined);
  if (!isPlainObject(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = removeUndefined(child);
  }
  return result;
}
