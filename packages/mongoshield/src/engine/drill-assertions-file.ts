/**
 * Loading a drill assertions file: the `--assertions <file>` of `mongoshield drill`
 * and the `drill.assertions` setting used by scheduled drills (`schedule.verify:
 * "drill"`). Both go through this one loader so they accept exactly the same files.
 *
 * The file's default export is either one function, run against every restored
 * database, or an object of functions keyed by the database name in the backup:
 *
 *   // drill.ts
 *   import type { Db } from "mongodb";
 *   export default {
 *     app: async (db: Db) => {
 *       if ((await db.collection("users").countDocuments()) === 0) throw new Error("no users");
 *     },
 *   };
 *
 * jiti loads TypeScript without a build step, as for config files.
 */

import { isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import { MongoShieldError } from "../errors.ts";
import type { DrillAssertion, DrillAssertions } from "./drill.ts";

/**
 * Loads an assertions file. A relative `path` is resolved against `cwd`.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the file is missing, does not
 *   load, or its default export is neither a function nor an object of functions.
 */
export async function loadDrillAssertionsFile(path: string, cwd: string): Promise<DrillAssertions> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);

  let loaded: unknown;
  try {
    // No module cache: a long-running scheduler picks up edits to the file.
    loaded = await createJiti(import.meta.url, { moduleCache: false }).import(absolute, {
      default: true,
    });
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Could not load the assertions file ${absolute}.`,
      {
        cause: error,
        hint: "Check the path and the file for syntax errors; it must `export default` a function or an object of functions.",
      },
    );
  }
  return toAssertions(loaded, absolute);
}

/** Checks the shape of an assertions module's default export. */
function toAssertions(loaded: unknown, path: string): DrillAssertions {
  // Functions cannot be checked further before they run; a wrong signature fails
  // at drill time and is reported as a failed assertion.
  if (typeof loaded === "function") return loaded as DrillAssertion;
  if (typeof loaded === "object" && loaded !== null) {
    const assertions: Record<string, DrillAssertion> = {};
    for (const [database, assertion] of Object.entries(loaded)) {
      if (typeof assertion !== "function") {
        throw invalidAssertions(path, `"${database}" is not a function`);
      }
      assertions[database] = assertion as DrillAssertion;
    }
    return assertions;
  }
  throw invalidAssertions(path, "the default export is neither a function nor an object");
}

function invalidAssertions(path: string, reason: string): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", `Invalid assertions file ${path}: ${reason}.`, {
    hint: "Export a function `(db) => …`, or an object `{ <database>: (db) => … }`.",
  });
}
