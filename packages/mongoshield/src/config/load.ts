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

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import { MongoShieldError } from "../errors.ts";
import { readEnvironmentConfig } from "./env.ts";
import { CONFIG_PRESETS, isConfigPresetName } from "./presets.ts";
import { ConfigSchema, type MongoShieldConfig, type MongoShieldConfigInput } from "./schema.ts";
import { resolveSecretReferences } from "./secret-references.ts";

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
  const env = options.env ?? process.env;
  const fromEnv = readEnvironmentConfig(env);

  const merged = mergeConfigs(mergeConfigs(fromFile, fromEnv), options.overrides ?? {});
  // `{ env: "NAME" }` / `{ file: "/path" }` for notify and heartbeat URLs (schema.ts).
  const resolved = await resolveSecretReferences(merged, env);
  return { config: validateConfig(resolved, configFile), configFile };
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
 *
 * `import { defineConfig } from "mongoshield"` in the file resolves to the package
 * that is running (see {@link mongoshieldAliases}), not to whatever Node would find
 * next to the file: with `npx mongoshield` or the GitHub Action, the package lives
 * in npm's cache and the config's folder has no node_modules/mongoshield at all.
 */
async function importConfigFile(path: string): Promise<MongoShieldConfigInput> {
  const alias = await mongoshieldAliases(dirname(fileURLToPath(import.meta.url)));
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias });
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

/** The package name config files import, and its subpaths (`mongoshield/storage/s3`). */
const PACKAGE_NAME = "mongoshield";

/** How many folders up from this module the package's own package.json may be. */
const MAX_PACKAGE_DEPTH = 5;

/**
 * Module aliases that point `mongoshield` and each of its subpath exports at the
 * files of the running copy of the package, for jiti: `{ "mongoshield":
 * "/…/node_modules/mongoshield/dist/index.mjs", "mongoshield/storage/s3": "…" }`.
 *
 * Found by walking up from `fromDirectory` (this module's folder: `dist/` when
 * installed, `src/config/` in the repository) to the package.json named
 * "mongoshield", and reading its `exports`. Only targets that exist are listed, so
 * a source checkout without a build simply resolves as before. Using the running
 * copy also means a config and the CLI share one `defineConfig` and one set of
 * storage adapters, even if the project has another version installed.
 *
 * @returns an empty object when the package.json cannot be found or read.
 */
export async function mongoshieldAliases(fromDirectory: string): Promise<Record<string, string>> {
  const root = await findPackageRoot(fromDirectory);
  if (root === undefined) return {};
  let exportsField: unknown;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    exportsField = isPlainObject(manifest) ? manifest.exports : undefined;
  } catch {
    return {};
  }
  if (!isPlainObject(exportsField)) return {};

  const aliases: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(exportsField)) {
    // "." → "mongoshield", "./storage/s3" → "mongoshield/storage/s3".
    if (typeof target !== "string" || (subpath !== "." && !subpath.startsWith("./"))) continue;
    const specifier = subpath === "." ? PACKAGE_NAME : `${PACKAGE_NAME}/${subpath.slice(2)}`;
    const file = resolve(root, target);
    if (await fileExists(file)) aliases[specifier] = file;
  }
  return aliases;
}

/** The nearest folder at or above `directory` whose package.json is named "mongoshield". */
async function findPackageRoot(directory: string): Promise<string | undefined> {
  let current = directory;
  for (let depth = 0; depth <= MAX_PACKAGE_DEPTH; depth++) {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (isPlainObject(manifest) && manifest.name === PACKAGE_NAME) return current;
    } catch {
      // No (readable) package.json here: keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
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
