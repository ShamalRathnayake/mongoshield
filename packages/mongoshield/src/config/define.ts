/**
 * `defineConfig()` gives config files type checking and editor autocompletion.
 * It returns its argument unchanged; validation happens when the config is loaded.
 */

import type { MongoShieldConfigInput } from "./schema.ts";

/** Declares a MongoShield config with full type checking. */
export function defineConfig(config: MongoShieldConfigInput): MongoShieldConfigInput {
  return config;
}
