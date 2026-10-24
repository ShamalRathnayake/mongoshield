/**
 * The shape of `mongoshield.config.ts` and its validation.
 *
 * A config file describes *where* to back up from and to, and *how*. It is used
 * by the CLI (and later the scheduler and console). Library users can skip it
 * entirely and pass options to `new MongoShield(...)` directly.
 *
 *   // mongoshield.config.ts
 *   import { defineConfig } from "mongoshield";
 *
 *   export default defineConfig({
 *     source: { uri: process.env.MONGODB_URI },
 *     storage: "s3://acme-backups/prod",
 *     encryption: { recipients: [process.env.BACKUP_PUBLIC_KEY] },
 *     retention: { last: 3, daily: 7, weekly: 4, monthly: 12 },
 *   });
 *
 * Values may be `undefined` in the file (an unset environment variable, say);
 * validation runs after environment variables and CLI flags are merged in, so
 * the error message points at what is actually missing.
 */

import { z } from "zod";

/** A non-empty string; empty strings usually mean an environment variable was set to "". */
const nonEmpty = z.string().trim().min(1);

/** A namespace pattern such as `app.*` or `*.sessions` (validated in detail by the engine). */
const namespacePattern = nonEmpty;

/** A storage adapter instance, recognised by its shape (we can't use `instanceof` on interfaces). */
const storageAdapterLike = z.custom<import("../storage/types.ts").StorageAdapter>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "put") === "function" &&
    typeof Reflect.get(value, "get") === "function",
  { message: "expected a storage URL string or a storage adapter object" },
);

export const RetentionConfigSchema = z
  .object({
    /** Keep the N newest backups. */
    last: z.number().int().positive().optional(),
    /** Keep the newest backup from each of the last N hours / days / weeks / months / years. */
    hourly: z.number().int().positive().optional(),
    daily: z.number().int().positive().optional(),
    weekly: z.number().int().positive().optional(),
    monthly: z.number().int().positive().optional(),
    yearly: z.number().int().positive().optional(),
    /** Never prune below this many verified backups. */
    minVerified: z.number().int().nonnegative().optional(),
  })
  .strict();

/** A cloud KMS key that wraps each backup's data key. */
export const KmsKeySchema = z
  .object({
    provider: z.enum(["aws", "gcp", "azure"]),
    /**
     * The key: an AWS key ARN or alias, a GCP key resource name
     * (`projects/…/cryptoKeys/…`), or an Azure Key Vault key URL.
     */
    key: nonEmpty,
  })
  .strict();

export const ScheduleConfigSchema = z
  .object({
    /** Standard 5-field cron expression, e.g. `"15 3 * * *"` for 03:15 every day. */
    cron: nonEmpty,
    /** IANA time zone for the cron expression. Defaults to UTC. */
    timezone: nonEmpty.optional(),
    /**
     * Prevents two schedulers (for example several app replicas) from running the
     * same backup: `"storage"` (default) uses a lock object next to the backups,
     * `"mongo"` a lock document in the source database, `"none"` no lock.
     */
    lock: z.enum(["storage", "mongo", "none"]).optional(),
    /** Random delay before each run, so many deployments don't all start at once. */
    jitterSeconds: z.number().int().nonnegative().max(3600).optional(),
    /** Retries after a failed run, with exponential backoff. Defaults to 2. */
    retries: z.number().int().nonnegative().max(10).optional(),
    /** Abort a run that takes longer than this. */
    timeoutMinutes: z.number().positive().optional(),
    /** Prune with the `retention` policy after each successful backup. Defaults to true. */
    prune: z.boolean().optional(),
    /**
     * Verify each new backup. Defaults to `"fast"`. `"drill"` restores it into the
     * scratch deployment configured in `drill` and checks it, which also measures
     * how long a real restore takes (your RTO).
     */
    verify: z.enum(["none", "fast", "deep", "drill"]).optional(),
  })
  .strict();

export const NotifyTargetSchema = z
  .object({
    type: z.enum(["webhook", "slack", "discord"]),
    url: z.url(),
    /** Which outcomes to report. Defaults to failures only. */
    on: z
      .array(z.enum(["success", "failure"]))
      .min(1)
      .optional(),
  })
  .strict();

export const GuardConfigSchema = z
  .object({
    /** Fail if any collection lost more than this percentage of its documents. */
    maxDocumentDropPercent: z.number().min(0).max(100).optional(),
    /** Fail if the backup's total raw size dropped by more than this percentage. */
    maxSizeDropPercent: z.number().min(0).max(100).optional(),
    /** Fail if a collection present in the previous backup is missing. Defaults to true. */
    failOnMissingCollection: z.boolean().optional(),
    /** `"fail"` (default) refuses to commit the backup; `"warn"` only reports. */
    action: z.enum(["fail", "warn"]).optional(),
  })
  .strict();

/** One place backups are replicated to after each scheduled run. */
export const ReplicateTargetSchema = z
  .object({
    /** A storage URL (`s3://offsite-bucket/prod`) or adapter, like `storage`. */
    storage: z.union([nonEmpty, storageAdapterLike]),
    /** Make the copies write-once there for this many days (needs object lock). */
    retainDays: z.number().int().positive().max(36500).optional(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    /** The database to back up (and the default restore target). */
    source: z
      .object({
        uri: nonEmpty.describe("MongoDB connection string"),
      })
      .strict()
      .optional(),

    /** Where backups live: a URL like `s3://bucket/prefix`, a path, or an adapter object. */
    storage: z.union([nonEmpty, storageAdapterLike]),

    /** Compression for new backups. Defaults to zstd. */
    compression: z.enum(["zstd", "gzip", "none"]).optional(),

    /** Encryption for new backups. Omit to store backups unencrypted. */
    encryption: z
      .object({
        /** Public age recipients (`age1…`). Recommended for unattended backups. */
        recipients: z.array(nonEmpty).min(1).optional(),
        /** A passphrase instead of recipients. Cannot be combined with recipients. */
        passphrase: nonEmpty.optional(),
        /**
         * Cloud KMS keys that protect each backup's key. Can be combined with
         * `recipients` (recommended: keep one offline recipient as a recovery key).
         */
        kms: z.array(KmsKeySchema).min(1).optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.recipients !== undefined ||
          value.passphrase !== undefined ||
          value.kms !== undefined,
        { message: "set recipients, passphrase or kms" },
      )
      .refine((value) => !(value.passphrase && (value.recipients || value.kms)), {
        // age's scrypt (passphrase) stanza must be the only one in a file.
        message: "a passphrase cannot be combined with recipients or kms (age format rule)",
      })
      .optional(),

    /** Secrets used to read encrypted backups (restore, verify --deep). */
    decryption: z
      .object({
        /** age identities (`AGE-SECRET-KEY-1…`). Prefer `identityFiles` so keys stay out of config. */
        identities: z.array(nonEmpty).optional(),
        /** Paths to files containing age identities, one per line (age's key file format). */
        identityFiles: z.array(nonEmpty).optional(),
        passphrase: nonEmpty.optional(),
      })
      .strict()
      .optional(),

    /** Defaults for `mongoshield backup`. */
    backup: z
      .object({
        include: z.array(namespacePattern).optional(),
        exclude: z.array(namespacePattern).optional(),
        consistency: z.enum(["auto", "none", "snapshot", "converge"]).optional(),
        parallelism: z.number().int().min(1).max(64).optional(),
        /**
         * Make every backup write-once for this many days (S3 Object Lock, GCS
         * object retention, Azure immutability). The storage must support it.
         */
        retainDays: z.number().int().positive().max(36500).optional(),
        labels: z.record(z.string(), z.string()).optional(),
        /** Split collections larger than this (raw BSON bytes) into parts. Defaults to 256 MiB. */
        partSizeBytes: z.number().int().positive().optional(),
        /**
         * Stop after about this long and save a checkpoint; `mongoshield run` resumes
         * it on its next invocation. Implies consistency "none".
         */
        maxDurationMs: z.number().int().positive().optional(),
        /** Where data is read from. Defaults to "secondaryPreferred". */
        readPreference: z
          .enum(["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"])
          .optional(),
        /** Tag sets for `readPreference`, e.g. `[{ use: "backup" }, {}]`. */
        readPreferenceTags: z.array(z.record(z.string(), z.string())).optional(),
        /** Read at most this many documents per second (all collections together). */
        maxDocumentsPerSecond: z.number().positive().optional(),
        /** Read at most this many raw BSON bytes per second (all collections together). */
        maxBytesPerSecond: z.number().positive().optional(),
        /**
         * Also back up users and custom roles (with their password hashes: encrypt such
         * backups). Off by default. See `BackupOptions.includeUsersAndRoles`.
         */
        usersAndRoles: z.boolean().optional(),
      })
      .strict()
      .optional(),

    /** Policy used by `mongoshield prune`. */
    retention: RetentionConfigSchema.optional(),

    /** Running backups on a schedule (`mongoshield schedule`). */
    schedule: ScheduleConfigSchema.optional(),

    /**
     * The change journal for point-in-time recovery (`mongoshield journal start`; its
     * flags override these). See docs/guides/point-in-time-recovery.md.
     */
    journal: z
      .object({
        /** Close a segment after this many seconds: the normal worst-case RPO. Default 300. */
        segmentSeconds: z.number().int().min(1).max(86_400).optional(),
        /** …or once it holds this many bytes of change data (at least 1 KiB). Default 64 MiB. */
        segmentBytes: z.number().int().min(1024).optional(),
        /** When change history is lost: take a new base backup (default), or stop the writer. */
        onGap: z.enum(["backup", "fail"]).optional(),
      })
      .strict()
      .optional(),

    /** Where to send success and failure notifications. */
    notify: z.array(NotifyTargetSchema).optional(),

    /**
     * A "dead man's switch" URL (healthchecks.io, Cronitor, Better Stack…).
     * Pinged on success, and with `/fail` appended on failure, so the service
     * alerts you when backups stop arriving.
     */
    heartbeat: z.url().optional(),

    /** Restore drills (`mongoshield drill`, `schedule.verify: "drill"`). */
    drill: z
      .object({
        /** A scratch deployment to restore into. Never the production source. */
        targetUri: nonEmpty,
        /** Documents per collection to compare byte for byte with the backup. */
        sample: z.number().int().nonnegative().optional(),
        /** A .ts/.js file whose default export checks the restored data. */
        assertions: nonEmpty.optional(),
        /** Prefix of the temporary database names. Defaults to `msdrill_`. */
        prefix: nonEmpty.optional(),
      })
      .strict()
      .optional(),

    /** Refuse to commit a backup that looks like data was lost since the previous one. */
    guard: GuardConfigSchema.optional(),

    /**
     * Copies of every new backup in other storage locations (3-2-1): `mongoshield run`
     * replicates each successful backup to each target (src/extras/replicate.ts).
     */
    replicate: z.array(ReplicateTargetSchema).min(1).optional(),

    /** The GDPR erasure ledger (src/extras/erasure.ts). */
    erasures: z
      .object({
        /**
         * Keys the hashes of erasure filters, so the ledger cannot confirm guessed
         * emails. At least 16 characters; keep it with your other secrets.
         */
        secret: z.string().min(16).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // A drill needs somewhere to restore to; say so when the config is loaded rather
  // than hours later, when the first scheduled run reaches its verify step.
  .refine((config) => config.schedule?.verify !== "drill" || config.drill !== undefined, {
    message:
      'schedule.verify "drill" needs a drill section with a targetUri (a scratch deployment)',
    path: ["drill", "targetUri"],
  });

/** A fully validated config. */
export type MongoShieldConfig = z.infer<typeof ConfigSchema>;

/**
 * What users write in a config file. Every leaf may be `undefined` so that
 * `process.env.X` can be used directly without `!`.
 */
export type MongoShieldConfigInput = DeepAllowUndefined<z.input<typeof ConfigSchema>>;

/** Recursively allows `undefined` on every property (but keeps functions and adapters intact). */
type DeepAllowUndefined<T> = T extends readonly (infer Item)[]
  ? readonly DeepAllowUndefined<Item>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { [Key in keyof T]?: DeepAllowUndefined<T[Key]> | undefined }
      : T | undefined;
