/**
 * Loading mask and subset files for the CLI.
 *
 * They are TypeScript (or JavaScript/JSON) modules whose default export is the
 * config, loaded with jiti like `mongoshield.config.ts`, so they can use
 * `process.env`, `new Date(…)`, helper functions and custom mask functions without
 * a build step. Their content is validated by `compileMask` / `compileSubset`.
 */

import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import { MongoShieldError } from "../errors.ts";
import type { MaskConfig } from "../mask/index.ts";
import type { SubsetConfig } from "../subset/index.ts";

/**
 * Loads a mask file (`export default defineMask({...})`).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the file is missing, does not
 *   load, or does not export an object with `rules`.
 */
export async function loadMaskFile(path: string, cwd: string): Promise<MaskConfig> {
  const loaded = await importDefault(path, cwd, "mask");
  if (!hasObject(loaded, "rules")) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The mask file ${path} has no \`rules\` object.`,
      {
        hint: 'It must `export default defineMask({ rules: { "app.users": { email: { fake: "email" } } } })`.',
      },
    );
  }
  // `rules` is an object; every rule inside is validated by compileMask.
  return loaded as MaskConfig;
}

/**
 * Loads a subset file (`export default defineSubset({...})`).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the file is missing, does not
 *   load, or exports neither `filters` nor `follow`.
 */
export async function loadSubsetFile(path: string, cwd: string): Promise<SubsetConfig> {
  const loaded = await importDefault(path, cwd, "subset");
  if (!hasObject(loaded, "filters") && !hasObject(loaded, "follow")) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The subset file ${path} has neither \`filters\` nor \`follow\`.`,
      { hint: "It must `export default defineSubset({ filters: {...}, follow: [...] })`." },
    );
  }
  // The shape is checked in detail by compileSubset.
  return loaded as SubsetConfig;
}

/** Imports a module's default export with jiti. */
async function importDefault(path: string, cwd: string, kind: string): Promise<unknown> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    await access(absolute);
  } catch {
    throw new MongoShieldError("MS_CONFIG_INVALID", `The ${kind} file ${absolute} does not exist.`);
  }
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  try {
    return await jiti.import(absolute, { default: true });
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Could not load the ${kind} file ${absolute}.`,
      {
        cause: error,
        hint: `Check the file for syntax errors; it must export the ${kind} config as its default export.`,
      },
    );
  }
}

/** True when `value` is an object whose `key` is an object (or array). */
function hasObject(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const child: unknown = Reflect.get(value, key);
  return typeof child === "object" && child !== null;
}
