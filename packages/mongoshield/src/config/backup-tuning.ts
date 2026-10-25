/**
 * Turning the config file's `backup` section into the matching `BackupOptions`
 * fields for parts, reads, throttling, retention and users/roles. Shared by `mongoshield backup`
 * and the scheduled runner so both read the same settings the same way.
 */

import type { BackupOptions } from "../types.ts";
import type { MongoShieldConfig } from "./schema.ts";

/** The backup options a config section sets beyond patterns, consistency and labels. */
export type BackupTuning = Pick<
  BackupOptions,
  | "partSizeBytes"
  | "maxDurationMs"
  | "readPreference"
  | "readPreferenceTags"
  | "maxDocumentsPerSecond"
  | "maxBytesPerSecond"
  | "retainDays"
  | "includeUsersAndRoles"
>;

/** Copies the tuning fields that are set (exactOptionalPropertyTypes: no `undefined`s). */
export function backupTuningFromConfig(section: MongoShieldConfig["backup"]): BackupTuning {
  if (section === undefined) return {};
  return {
    ...(section.partSizeBytes === undefined ? {} : { partSizeBytes: section.partSizeBytes }),
    ...(section.maxDurationMs === undefined ? {} : { maxDurationMs: section.maxDurationMs }),
    ...(section.readPreference === undefined ? {} : { readPreference: section.readPreference }),
    ...(section.readPreferenceTags === undefined
      ? {}
      : { readPreferenceTags: section.readPreferenceTags }),
    ...(section.maxDocumentsPerSecond === undefined
      ? {}
      : { maxDocumentsPerSecond: section.maxDocumentsPerSecond }),
    ...(section.maxBytesPerSecond === undefined
      ? {}
      : { maxBytesPerSecond: section.maxBytesPerSecond }),
    ...(section.retainDays === undefined ? {} : { retainDays: section.retainDays }),
    ...(section.usersAndRoles === undefined ? {} : { includeUsersAndRoles: section.usersAndRoles }),
  };
}
