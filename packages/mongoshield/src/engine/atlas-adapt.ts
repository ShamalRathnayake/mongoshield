/**
 * How the engines adapt to MongoDB Atlas, once `describeDeployment` has recognised it
 * (src/mongo/atlas.ts). Everything here is a pure decision from the deployment facts
 * and the caller's options, so it is unit tested without a cluster.
 *
 * On a shared tier (Free, Flex, legacy M2/M5):
 *   - backups default to `parallelism: 2` and at most 4 MiB/s of reads, unless the
 *     caller set a parallelism or any read limit (an explicit setting always wins);
 *   - backups refuse `includeUsersAndRoles`: the tier refuses `usersInfo` and every
 *     read of the `admin` database, so there is nothing to back up;
 *   - restores into it default to `parallelism: 2` and one insert worker per
 *     collection, so the restore stays within the tier's operations per second.
 *
 * On any Atlas cluster, restores refuse `usersAndRoles: "create" | "replace"` before
 * writing anything: Atlas only accepts user and role changes through its own API and
 * rolls back changes made with database commands, so a "successful" restore of users
 * would silently vanish.
 */

import { MongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import {
  ATLAS_SHARED_TIER_TUNING,
  ATLAS_USERS_HINT,
  type DeploymentInfo,
  isAtlasSharedTier,
} from "../mongo/index.ts";
import type { BackupOptions, RestoreOptions } from "../types.ts";
import type { RateLimits } from "./rate-limit.ts";

/** The read settings a backup runs with after adapting to the deployment. */
export interface AdaptedBackupReads {
  /** Collections (and parts) dumped at the same time. */
  readonly parallelism: number;
  /** The read limits to build the rate limiter from. */
  readonly rateLimits: RateLimits;
  /** What was changed, in words, for the log; empty when nothing was. */
  readonly adjustments: readonly string[];
}

/** Restores into a shared tier use one insert worker per collection (see the file header). */
const SHARED_TIER_INSERT_WORKERS = 1;

/**
 * Applies the shared-tier backup defaults where the caller left the setting open.
 *
 * @param options the caller's backup options.
 * @param parallelism the parallelism validated so far (the caller's, or the default).
 * @param deployment what `describeDeployment` found.
 */
export function adaptBackupReads(
  options: Pick<BackupOptions, "parallelism" | "maxBytesPerSecond" | "maxDocumentsPerSecond">,
  parallelism: number,
  deployment: DeploymentInfo,
): AdaptedBackupReads {
  const requested: RateLimits = {
    maxDocumentsPerSecond: options.maxDocumentsPerSecond,
    maxBytesPerSecond: options.maxBytesPerSecond,
  };
  if (!isAtlasSharedTier(deployment)) {
    return { parallelism, rateLimits: requested, adjustments: [] };
  }

  const adjustments: string[] = [];
  let adapted = parallelism;
  if (options.parallelism === undefined && parallelism > ATLAS_SHARED_TIER_TUNING.parallelism) {
    adapted = ATLAS_SHARED_TIER_TUNING.parallelism;
    adjustments.push(`parallelism ${adapted}`);
  }
  // Either explicit limit means the caller has chosen how fast to read: keep it as is.
  const hasLimit =
    options.maxBytesPerSecond !== undefined || options.maxDocumentsPerSecond !== undefined;
  let rateLimits = requested;
  if (!hasLimit) {
    rateLimits = { maxBytesPerSecond: ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond };
    adjustments.push(
      `reads limited to ${ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond / (1024 * 1024)} MiB/s`,
    );
  }
  return { parallelism: adapted, rateLimits, adjustments };
}

/**
 * Logs what the backup changed for a shared tier, with how to override it, so a
 * slower-than-expected backup explains itself.
 */
export function logBackupAdaptation(
  logger: Logger,
  adapted: AdaptedBackupReads,
  deployment: DeploymentInfo,
): void {
  if (deployment.atlas === undefined) return;
  logger.debug("MongoDB Atlas detected", {
    tier: deployment.atlas.tier,
    signals: deployment.atlas.signals,
  });
  if (adapted.adjustments.length === 0) return;
  logger.info(
    `Atlas Free/Flex tier detected: ${adapted.adjustments.join(", ")} to stay within the tier's throughput. Set parallelism or maxBytesPerSecond to override.`,
  );
}

/**
 * Refuses a backup of users and roles from a shared tier, before anything is read.
 *
 * @throws MS_UNSUPPORTED_TOPOLOGY with the Atlas users hint.
 */
export function assertUsersAndRolesBackupSupported(
  options: Pick<BackupOptions, "includeUsersAndRoles">,
  deployment: DeploymentInfo,
): void {
  if (options.includeUsersAndRoles !== true || !isAtlasSharedTier(deployment)) return;
  throw new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    "Users and roles cannot be backed up from an Atlas Free or Flex cluster: the tier refuses usersInfo and every read of the admin database.",
    { hint: ATLAS_USERS_HINT },
  );
}

/**
 * Refuses to restore users and roles into any Atlas cluster, before anything is
 * written (see the file header).
 *
 * @throws MS_UNSUPPORTED_TOPOLOGY with the Atlas users hint.
 */
export function assertUsersAndRolesRestoreSupported(
  options: Pick<RestoreOptions, "usersAndRoles">,
  deployment: DeploymentInfo,
): void {
  const mode = options.usersAndRoles ?? "skip";
  if (mode === "skip" || deployment.atlas === undefined) return;
  throw new MongoShieldError(
    "MS_UNSUPPORTED_TOPOLOGY",
    `Users and roles cannot be restored into MongoDB Atlas (usersAndRoles "${mode}"): Atlas only accepts user and role changes through its own API.`,
    {
      hint: `Restore without users and roles (usersAndRoles "skip", the default). ${ATLAS_USERS_HINT}`,
    },
  );
}

/** The restore concurrency after adapting to the target. */
export interface AdaptedRestoreConcurrency {
  readonly parallelism: number;
  readonly insertWorkers: number;
  /** What was changed, in words, for the log; empty when nothing was. */
  readonly adjustments: readonly string[];
}

/**
 * Applies the shared-tier restore defaults where the caller left the setting open.
 *
 * @param options the caller's restore options (only "was it set?" is read).
 * @param current the validated parallelism and insert workers (the caller's or the defaults).
 */
export function adaptRestoreConcurrency(
  options: Pick<RestoreOptions, "parallelism" | "insertWorkers">,
  current: { readonly parallelism: number; readonly insertWorkers: number },
  deployment: DeploymentInfo,
): AdaptedRestoreConcurrency {
  if (!isAtlasSharedTier(deployment)) return { ...current, adjustments: [] };
  const adjustments: string[] = [];
  let { parallelism, insertWorkers } = current;
  if (options.parallelism === undefined && parallelism > ATLAS_SHARED_TIER_TUNING.parallelism) {
    parallelism = ATLAS_SHARED_TIER_TUNING.parallelism;
    adjustments.push(`parallelism ${parallelism}`);
  }
  if (options.insertWorkers === undefined && insertWorkers > SHARED_TIER_INSERT_WORKERS) {
    insertWorkers = SHARED_TIER_INSERT_WORKERS;
    adjustments.push(`${insertWorkers} insert worker per collection`);
  }
  return { parallelism, insertWorkers, adjustments };
}
