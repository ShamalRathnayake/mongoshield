/**
 * Which real cloud services the opt-in cloud tests (`pnpm test:cloud`) may use.
 *
 * Every cloud test file asks this module for its "target" (S3, R2, GCS, …). A
 * target is configured only when all of its environment variables are set; then
 * its tests run against the real service. Otherwise the suite is skipped, and its
 * title says which variables are missing, so a skipped run explains itself:
 *
 *   ↓ AWS S3 (skipped: set MONGOSHIELD_TEST_S3_BUCKET)
 *
 * Credentials are deliberately *not* part of a target. Each SDK finds its own
 * (AWS default chain, Google Application Default Credentials, Azure
 * DefaultAzureCredential), which is what lets CI use short-lived OIDC credentials
 * instead of stored keys. A target whose variables are set but whose credentials
 * are missing therefore fails loudly instead of skipping: that is a broken setup,
 * not an opted-out one. The only exceptions are R2 and SFTP, whose credentials
 * cannot come from a default chain and so are listed as required variables.
 *
 * This file never prints a variable's *value*, only names. See
 * docs/testing-real-clouds.md for how to create each resource.
 */

import { randomBytes } from "node:crypto";

/** One real service the cloud tests can run against. */
export interface CloudTarget {
  /** Human-readable name, e.g. "AWS S3". */
  readonly name: string;
  /** True when every required environment variable is set (non-empty). */
  readonly configured: boolean;
  /** Required variables that are not set. Empty when `configured`. */
  readonly missing: readonly string[];
  /**
   * The suite title: the name when configured, otherwise the name plus the
   * variables to set. Use it as the `describe` title so skips explain themselves.
   */
  readonly title: string;
  /** Value of a required variable. Throws for unknown or unset names. */
  readonly get: (variable: string) => string;
}

/** True when `name` is set to something other than an empty string. */
function isSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "";
}

/**
 * Describes one target from its required variables. Reading happens once, when
 * the test file is loaded, so `describe.skipIf` can use the result.
 */
export function cloudTarget(name: string, required: readonly string[]): CloudTarget {
  const missing = required.filter((variable) => !isSet(variable));
  const configured = missing.length === 0;
  const title = configured ? name : `${name} (skipped: set ${missing.join(", ")})`;
  if (!configured) {
    // One line per skipped target in the run's output (names only, never values).
    console.warn(`[cloud tests] ${title}`);
  }
  return {
    name,
    configured,
    missing,
    title,
    get(variable: string): string {
      if (!required.includes(variable)) {
        throw new Error(`${variable} is not a required variable of ${name}`);
      }
      const value = process.env[variable];
      if (value === undefined || value.trim() === "") {
        throw new Error(`${variable} is not set (target ${name} is not configured)`);
      }
      return value.trim();
    },
  };
}

/** An optional variable's value, or `undefined` when it is unset or empty. */
export function optionalEnv(name: string): string | undefined {
  return isSet(name) ? process.env[name]?.trim() : undefined;
}

/**
 * Every target and its required variables, in one place, so the docs table, the
 * workflow and the global setup agree. Optional extras (regions, ports) are read
 * with `optionalEnv` in the test files.
 */
export const CLOUD_TARGET_VARIABLES = {
  s3: ["MONGOSHIELD_TEST_S3_BUCKET"],
  s3ObjectLock: ["MONGOSHIELD_TEST_S3_LOCK_BUCKET"],
  awsKms: ["MONGOSHIELD_TEST_AWS_KMS_KEY"],
  r2: [
    "MONGOSHIELD_TEST_R2_ACCOUNT_ID",
    "MONGOSHIELD_TEST_R2_BUCKET",
    "MONGOSHIELD_TEST_R2_ACCESS_KEY_ID",
    "MONGOSHIELD_TEST_R2_SECRET_ACCESS_KEY",
  ],
  gcs: ["MONGOSHIELD_TEST_GCS_BUCKET"],
  gcsRetention: ["MONGOSHIELD_TEST_GCS_LOCK_BUCKET"],
  gcpKms: ["MONGOSHIELD_TEST_GCP_KMS_KEY"],
  azureBlob: ["MONGOSHIELD_TEST_AZURE_ACCOUNT_URL", "MONGOSHIELD_TEST_AZURE_CONTAINER"],
  azureImmutable: ["MONGOSHIELD_TEST_AZURE_ACCOUNT_URL", "MONGOSHIELD_TEST_AZURE_LOCK_CONTAINER"],
  azureKeyVault: ["MONGOSHIELD_TEST_AZURE_KEY_URL"],
  sftp: [
    "MONGOSHIELD_TEST_SFTP_HOST",
    "MONGOSHIELD_TEST_SFTP_USERNAME",
    "MONGOSHIELD_TEST_SFTP_PRIVATE_KEY",
    "MONGOSHIELD_TEST_SFTP_HOST_FINGERPRINT",
    "MONGOSHIELD_TEST_SFTP_PATH",
  ],
} as const satisfies Record<string, readonly string[]>;

/** True when at least one target is configured (the global setup only starts mongod then). */
export function anyCloudTargetConfigured(): boolean {
  return Object.values(CLOUD_TARGET_VARIABLES).some((variables) =>
    variables.every((variable) => isSet(variable)),
  );
}

/**
 * The shared top-level prefix of everything the cloud tests write. Lifecycle rules
 * on the test buckets match it to expire leftovers (see the docs), so keep the
 * default unless your rules use another one.
 */
export const CLOUD_TEST_ROOT = optionalEnv("MONGOSHIELD_TEST_PREFIX") ?? "mongoshield-ci";

/**
 * A prefix unique to this run, e.g. `mongoshield-ci/20261024-a1b2c3d4`. The date
 * first so a human browsing the bucket sees old runs at a glance; random bytes so
 * parallel runs (two CI jobs, a laptop) never touch each other's objects.
 */
export const CLOUD_RUN_PREFIX = `${CLOUD_TEST_ROOT}/${new Date()
  .toISOString()
  .slice(0, 10)
  .replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
