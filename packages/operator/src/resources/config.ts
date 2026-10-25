/**
 * Turns a MongoShieldBackupPlan into the mongoshield.config.json its Jobs run with.
 *
 * The file holds no secrets: connection strings, passphrases, identities and cloud
 * credentials reach the pod as environment variables and files from Secrets (see
 * pod.ts), which MongoShield reads on its own (MONGODB_URI, MONGOSHIELD_PASSPHRASE,
 * MONGOSHIELD_IDENTITY_FILE, AWS_*, …). So the config can live in a ConfigMap.
 *
 * Before it is written, the config is checked with MongoShield's own validator
 * (`validateConfig`, the same schema the CLI uses), so a mistake shows up at once in
 * the plan's status instead of in a failed pod at 3 a.m.
 */

import { PLAN_LABEL, validateConfig } from "mongoshield";
import type { BackupPlan } from "../api/types.ts";

/** A JSON object. */
export type JsonObject = Record<string, unknown>;

/**
 * The value of the `mongoshield.plan` label (MongoShield's PLAN_LABEL, the key the
 * console uses for its plans) on every backup a plan writes:
 * `kubernetes/<namespace>/<name>`.
 *
 * It is the plan's retention scope (`retention.scopeLabels`): two plans with the same
 * source and selection that share a storage location never prune each other's
 * backups, and an incremental only continues a backup of its own plan. The name, not
 * the uid, so a plan that is deleted and created again keeps managing its backups.
 */
export function planScopeValue(plan: BackupPlan): string {
  return `kubernetes/${plan.metadata.namespace}/${plan.metadata.name}`;
}

/**
 * Stands in for the drill target in validation: the real one is a Secret that only
 * the pod sees (MONGOSHIELD_DRILL_URI), so the operator cannot (and must not) read it.
 */
const DRILL_TARGET_PLACEHOLDER = "mongodb://drill-target.invalid";

/** Builds the config object for a plan (not yet validated). */
export function buildMongoShieldConfig(plan: BackupPlan): JsonObject {
  const { spec } = plan;
  const generated: JsonObject = { storage: spec.storage.url };

  if (spec.backup?.compression) generated.compression = spec.backup.compression;

  // Recipients and KMS keys are public information; a passphrase arrives through
  // MONGOSHIELD_PASSPHRASE, which MongoShield turns into encryption on its own.
  const encryption: JsonObject = {};
  if (spec.encryption?.recipients?.length) encryption.recipients = [...spec.encryption.recipients];
  if (spec.encryption?.kms?.length) encryption.kms = spec.encryption.kms.map((key) => ({ ...key }));
  if (Object.keys(encryption).length > 0) generated.encryption = encryption;

  generated.backup = backupSection(plan);
  // Always present, even without counts: the scope labels mark every backup as this
  // plan's (and without counts nothing is pruned).
  generated.retention = {
    ...spec.retention,
    scopeLabels: { [PLAN_LABEL]: planScopeValue(plan) },
  };
  // The drill section without its target: MONGOSHIELD_DRILL_URI (from the plan's
  // Secret) supplies `targetUri` in the pod.
  if (spec.drill) {
    generated.drill = {
      ...(spec.drill.sample !== undefined ? { sample: spec.drill.sample } : {}),
      ...(spec.drill.prefix !== undefined ? { prefix: spec.drill.prefix } : {}),
    };
  }

  // The schedule section configures what `mongoshield run` does on each run (lock,
  // retries, verify, prune). The cron expression itself is the CronJob's business;
  // it is copied here only because the section requires one.
  if (spec.schedule) {
    generated.schedule = {
      cron: spec.schedule.cron,
      timezone: spec.schedule.timeZone ?? "Etc/UTC",
      lock: spec.lock ?? "storage",
      retries: spec.retries ?? 2,
      verify: spec.verify ?? "fast",
      prune: true,
    };
  }

  // extraConfig is the lowest layer: the plan's own fields always win.
  return deepMerge(structuredClone(spec.extraConfig ?? {}), generated);
}

/**
 * Checks the config with MongoShield's schema. Returns the problem as a message, or
 * undefined when the config is valid.
 */
export function validateMongoShieldConfig(config: JsonObject): string | undefined {
  try {
    const drill = config.drill;
    validateConfig(
      isPlainObject(drill)
        ? { ...config, drill: { targetUri: DRILL_TARGET_PLACEHOLDER, ...drill } }
        : config,
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The `backup` section: what each backup contains and how it is read. */
function backupSection(plan: BackupPlan): JsonObject {
  const settings = plan.spec.backup ?? {};
  const section: JsonObject = {};
  if (settings.labels && Object.keys(settings.labels).length > 0)
    section.labels = { ...settings.labels };
  if (settings.include?.length) section.include = [...settings.include];
  if (settings.exclude?.length) section.exclude = [...settings.exclude];
  if (settings.consistency) section.consistency = settings.consistency;
  if (settings.parallelism !== undefined) section.parallelism = settings.parallelism;
  if (settings.readPreference) section.readPreference = settings.readPreference;
  if (settings.retainDays !== undefined) section.retainDays = settings.retainDays;
  if (settings.usersAndRoles !== undefined) section.usersAndRoles = settings.usersAndRoles;
  if (plan.spec.incremental) section.incremental = { ...plan.spec.incremental };
  return section;
}

/** Merges `top` over `base`: nested objects merge, everything else is replaced. */
export function deepMerge(base: JsonObject, top: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
