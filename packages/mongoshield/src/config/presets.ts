/**
 * Config presets: named bundles of defaults for a kind of deployment, selected with
 * `preset` in the config file:
 *
 *   export default defineConfig({
 *     preset: "atlas-free",
 *     source: { uri: process.env.MONGODB_URI },
 *     storage: "s3://acme-backups/atlas",
 *   });
 *
 * A preset is the LOWEST layer of the configuration: everything the file, the
 * environment or a flag sets wins over it, key by key (the same deep merge as the
 * other layers; `validateConfig` in load.ts applies it). It never sets `source`,
 * `storage` or `encryption`, which only the user can know.
 *
 * The Atlas presets carry the same tuning the backup engine applies by itself when it
 * detects a shared tier (src/mongo/atlas.ts). Naming the preset still helps: the
 * values also apply where detection cannot see the tier (a connection through a
 * proxy or tunnel with its own host name), they are written down in one place, and
 * they add a retention policy sized for small clusters.
 */

import { ATLAS_SHARED_TIER_TUNING } from "../mongo/atlas.ts";
import type { MongoShieldConfigInput } from "./schema.ts";

/** The preset names `preset` accepts. */
export const CONFIG_PRESET_NAMES = ["atlas-free", "atlas-flex"] as const;

/** One of `CONFIG_PRESET_NAMES`. */
export type ConfigPresetName = (typeof CONFIG_PRESET_NAMES)[number];

/** What a preset may set: tuning only, never where data comes from or goes to. */
export type ConfigPresetDefaults = Omit<
  MongoShieldConfigInput,
  "preset" | "source" | "storage" | "encryption" | "decryption"
>;

/**
 * Retention for small clusters backed up nightly: a week of daily backups plus
 * four weekly and six monthly ones, so at most 17 backups exist at any time. A Free
 * cluster holds at most 512 MB, so this costs a few GB of storage at worst.
 */
const SMALL_CLUSTER_RETENTION = { last: 7, weekly: 4, monthly: 6 } as const;

/**
 * Flex clusters may run more operations per second than Free ones (500 vs 100) and
 * hold up to 5 GB, so their preset reads twice as fast; still well under the tier's
 * throughput, so the application keeps most of it.
 */
const FLEX_BYTES_PER_SECOND = ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond * 2;

/**
 * Every preset's defaults, by name. `satisfies` (rather than a type annotation) keeps
 * the literal values in the type, so `mongoshield init` can print them without
 * checking for missing fields.
 */
export const CONFIG_PRESETS = {
  /**
   * Atlas Free (M0) clusters, and the legacy shared M2/M5 tiers: no Atlas backups at
   * all on M0, about 100 operations per second, a weekly data transfer allowance.
   */
  "atlas-free": {
    compression: "zstd",
    backup: {
      // "auto" uses converge when the tier lets the user open a change stream on the
      // whole deployment, and plain reads otherwise (with a warning in the manifest).
      consistency: "auto",
      parallelism: ATLAS_SHARED_TIER_TUNING.parallelism,
      maxBytesPerSecond: ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond,
    },
    retention: SMALL_CLUSTER_RETENTION,
  },
  /** Atlas Flex clusters: a few daily snapshots in Atlas, 500 operations per second. */
  "atlas-flex": {
    compression: "zstd",
    backup: {
      consistency: "auto",
      parallelism: ATLAS_SHARED_TIER_TUNING.parallelism,
      maxBytesPerSecond: FLEX_BYTES_PER_SECOND,
    },
    retention: SMALL_CLUSTER_RETENTION,
  },
} as const satisfies Readonly<Record<ConfigPresetName, ConfigPresetDefaults>>;

/** True when `value` names a preset (for configs that bypassed the type checker). */
export function isConfigPresetName(value: unknown): value is ConfigPresetName {
  return typeof value === "string" && (CONFIG_PRESET_NAMES as readonly string[]).includes(value);
}
