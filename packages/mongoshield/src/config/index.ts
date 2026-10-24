/**
 * Configuration: `defineConfig()` for config files, and the loader used by the CLI.
 */

export { defineConfig } from "./define.ts";
export { readEnvironmentConfig } from "./env.ts";
export {
  CONFIG_FILE_NAMES,
  type LoadConfigOptions,
  type LoadedConfig,
  loadConfig,
  mergeConfigs,
  validateConfig,
} from "./load.ts";
export {
  CONFIG_PRESET_NAMES,
  CONFIG_PRESETS,
  type ConfigPresetDefaults,
  type ConfigPresetName,
  isConfigPresetName,
} from "./presets.ts";
export {
  ConfigSchema,
  type MongoShieldConfig,
  type MongoShieldConfigInput,
  RetentionConfigSchema,
} from "./schema.ts";
