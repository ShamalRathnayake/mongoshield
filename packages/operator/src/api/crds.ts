/**
 * The CustomResourceDefinitions, as code.
 *
 * This file is the single source of truth: `pnpm --filter @mongoshield/operator crds`
 * (scripts/generate-crds.ts) writes them as YAML into the Helm chart's crds/ folder
 * and the plain manifests, and `crds:check` fails CI when those copies are stale.
 *
 * The schemas are "structural" (every field has a type, objects list their
 * properties), which apiextensions.k8s.io/v1 requires. That lets the API server
 * prune unknown fields, apply defaults and reject invalid objects before the
 * operator ever sees them. A few rules that span several fields are written as CEL
 * expressions (`x-kubernetes-validations`, Kubernetes 1.25+, GA in 1.29).
 *
 * Every string and list has a maximum length. Besides being sensible limits, they
 * keep the CEL rules' estimated cost bounded: the API server refuses a CRD whose
 * rules could, in the worst case, take too long to evaluate.
 */

import { API_GROUP, API_VERSION, KINDS } from "./constants.ts";

// ---------------------------------------------------------------------------
// Types: the JSON shape of a CRD (with the real JSON key names, which differ from
// @kubernetes/client-node's camelCase model classes, e.g. `x-kubernetes-validations`)
// ---------------------------------------------------------------------------

/** An OpenAPI v3 schema, as accepted by apiextensions.k8s.io/v1. */
export interface JsonSchema {
  type?: "string" | "integer" | "number" | "boolean" | "object" | "array";
  description?: string;
  format?: string;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  maxProperties?: number;
  /** Filled in by the API server when the field is absent. */
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  additionalProperties?: JsonSchema;
  required?: string[];
  /** Keep fields the schema does not list (for embedded Kubernetes types). */
  "x-kubernetes-preserve-unknown-fields"?: boolean;
  /** Accept an integer or a string (resource quantities such as 512Mi or 2). */
  "x-kubernetes-int-or-string"?: boolean;
  /** `map`: list items are identified by `x-kubernetes-list-map-keys` (server-side apply). */
  "x-kubernetes-list-type"?: "atomic" | "set" | "map";
  "x-kubernetes-list-map-keys"?: string[];
  /** CEL rules; `self` is the value of this field, `oldSelf` its previous value. */
  "x-kubernetes-validations"?: { rule: string; message: string }[];
}

/** A column of `kubectl get` output. */
export interface PrinterColumn {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "date";
  jsonPath: string;
  format?: string;
  description?: string;
  /** 0: always shown; 1: only with `-o wide`. */
  priority?: number;
}

/** An apiextensions.k8s.io/v1 CustomResourceDefinition. */
export interface CustomResourceDefinition {
  apiVersion: "apiextensions.k8s.io/v1";
  kind: "CustomResourceDefinition";
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: {
    group: string;
    names: {
      kind: string;
      listKind: string;
      plural: string;
      singular: string;
      shortNames: string[];
      categories: string[];
    };
    scope: "Namespaced" | "Cluster";
    versions: {
      name: string;
      served: boolean;
      storage: boolean;
      subresources: { status: Record<string, never> };
      additionalPrinterColumns: PrinterColumn[];
      schema: { openAPIV3Schema: JsonSchema };
    }[];
  };
}

// ---------------------------------------------------------------------------
// Small helpers so the schemas below read like a table of fields
// ---------------------------------------------------------------------------

/** Longest Kubernetes object name (a DNS subdomain). */
const NAME_LENGTH = 253;

/** A string field. */
function text(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "string", maxLength: 1024, description, ...extra };
}

/** A string field restricted to a set of values. */
function choice(description: string, values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values], description };
}

/** An integer field. */
function integer(description: string, extra: JsonSchema = {}): JsonSchema {
  return { type: "integer", format: "int64", description, ...extra };
}

/** A boolean field. */
function flag(description: string): JsonSchema {
  return { type: "boolean", description };
}

/** An object with known properties. */
function object(
  description: string,
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  extra: JsonSchema = {},
): JsonSchema {
  return {
    type: "object",
    description,
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    ...extra,
  };
}

/** A list of strings (namespace patterns, recipients, …). */
function stringList(description: string, maxItems = 100): JsonSchema {
  return {
    type: "array",
    description,
    maxItems,
    items: { type: "string", maxLength: 1024 },
  };
}

/** A string → string map (labels, node selectors). */
function stringMap(description: string): JsonSchema {
  return {
    type: "object",
    description,
    maxProperties: 64,
    additionalProperties: { type: "string", maxLength: 1024 },
  };
}

/**
 * A Kubernetes type embedded as-is (affinity, tolerations, env, …). Its full schema
 * would add thousands of lines; the API server validates it anyway when the operator
 * creates the Job, and a mistake shows up in the Job's events and our status.
 */
function embedded(description: string, type: "object" | "array"): JsonSchema {
  return type === "object"
    ? { type: "object", description, "x-kubernetes-preserve-unknown-fields": true }
    : {
        type: "array",
        description,
        maxItems: 100,
        items: { type: "object", "x-kubernetes-preserve-unknown-fields": true },
      };
}

/** A key in a Secret of the same namespace. */
function secretKeyRef(description: string, defaultKey: string): JsonSchema {
  return object(
    description,
    {
      name: text("Name of the Secret (same namespace).", { maxLength: NAME_LENGTH, minLength: 1 }),
      key: text(`Key in the Secret. Defaults to ${defaultKey}.`, { maxLength: NAME_LENGTH }),
    },
    ["name"],
  );
}

/** A reference by name to an object of a known kind in the same namespace. */
function localRef(description: string): JsonSchema {
  return object(
    description,
    { name: text("Object name (same namespace).", { maxLength: NAME_LENGTH, minLength: 1 }) },
    ["name"],
  );
}

/** metav1.Condition, as used in every status. */
const conditionsSchema: JsonSchema = {
  type: "array",
  description: "Conditions per the Kubernetes API conventions; the authoritative state.",
  maxItems: 16,
  "x-kubernetes-list-type": "map",
  "x-kubernetes-list-map-keys": ["type"],
  items: object(
    "One aspect of the object's state.",
    {
      type: text("Condition type, e.g. Ready or Complete.", { maxLength: 316 }),
      status: choice("True, False or Unknown.", ["True", "False", "Unknown"]),
      observedGeneration: integer("The metadata.generation this condition was computed for."),
      lastTransitionTime: text("When status last changed.", { format: "date-time" }),
      reason: text("Machine-readable CamelCase reason.", { maxLength: 1024 }),
      message: text("Human-readable details.", { maxLength: 32768 }),
    },
    ["type", "status", "lastTransitionTime", "reason", "message"],
  ),
};

/** The `error` object of backup and restore statuses. */
const runErrorSchema = object("Why the run failed (no secrets: MongoShield scrubs them).", {
  code: text("MongoShield error code, e.g. MS_CONNECT_FAILED (see docs/errors.md)."),
  message: text("What went wrong.", { maxLength: 32768 }),
  hint: text("How to fix it, when known.", { maxLength: 32768 }),
  step: text("The step that failed: setup, lock, backup, verify, replicate or prune."),
  exitCode: integer("The container's exit code."),
});

/** Pod settings for the Jobs of a plan's runs and restores. */
const jobSettingsSchema = object("Settings for the pods that run mongoshield.", {
  image: text("MongoShield image. Defaults to the image configured on the operator."),
  imagePullPolicy: choice("Image pull policy.", ["Always", "IfNotPresent", "Never"]),
  imagePullSecrets: {
    type: "array",
    description: "Secrets for pulling the image from a private registry.",
    maxItems: 16,
    items: localRef("A docker-registry Secret."),
  },
  serviceAccountName: text(
    "ServiceAccount of the pods, e.g. one annotated for IRSA or Workload Identity.",
    { maxLength: NAME_LENGTH },
  ),
  resources: object("CPU and memory requests and limits.", {
    limits: {
      type: "object",
      additionalProperties: { "x-kubernetes-int-or-string": true },
    },
    requests: {
      type: "object",
      additionalProperties: { "x-kubernetes-int-or-string": true },
    },
  }),
  nodeSelector: stringMap("Node labels the pods must run on."),
  tolerations: embedded("Pod tolerations (core/v1 Toleration).", "array"),
  affinity: embedded("Pod affinity (core/v1 Affinity).", "object"),
  podLabels: stringMap("Extra labels on the pods."),
  podAnnotations: stringMap("Extra annotations on the pods."),
  activeDeadlineSeconds: integer("Kill a run after this many seconds. Defaults to 21600 (6h).", {
    minimum: 1,
  }),
  backoffLimit: integer(
    "Pod retries at the Kubernetes level. Defaults to 0: MongoShield retries inside a run.",
    { minimum: 0, maximum: 10 },
  ),
  ttlSecondsAfterFinished: integer(
    "Delete finished Jobs after this many seconds. Defaults to 86400 (1 day).",
    { minimum: 0 },
  ),
  env: embedded("Extra environment variables (core/v1 EnvVar).", "array"),
  envFrom: embedded("Extra environment from Secrets/ConfigMaps (core/v1 EnvFromSource).", "array"),
});

// ---------------------------------------------------------------------------
// MongoShieldBackupPlan
// ---------------------------------------------------------------------------

const planSpecSchema = object(
  "What to back up, where to, how, and when.",
  {
    source: object(
      "The deployment to back up.",
      {
        uriSecretRef: secretKeyRef(
          "Secret key holding the MongoDB connection string. Use a user with the backup role.",
          "MONGODB_URI",
        ),
      },
      ["uriSecretRef"],
    ),
    storage: object(
      "Where backups are stored.",
      {
        url: text(
          "Storage URL (s3://bucket/prefix?region=…, gs://…, azure://…, sftp://…) or an absolute path on a mounted volume.",
          { minLength: 1, pattern: "^([a-z][a-z0-9+.-]*://.+|/.*)$" },
        ),
        credentialsSecretRef: localRef(
          "Secret whose keys become environment variables (AWS_ACCESS_KEY_ID, …). Not needed with workload identity.",
        ),
        persistentVolumeClaim: object(
          "A PersistentVolumeClaim to mount for path storage.",
          {
            claimName: text("Name of the claim (same namespace).", {
              maxLength: NAME_LENGTH,
              minLength: 1,
            }),
            mountPath: text("Where to mount it. Defaults to /backups.", { pattern: "^/.*" }),
          },
          ["claimName"],
        ),
      },
      ["url"],
    ),
    encryption: object(
      "Encryption of new backups (age format). Omit to store backups unencrypted.",
      {
        recipients: stringList("Public age keys (age1…) to encrypt for. Not secret.", 32),
        kms: {
          type: "array",
          description: "Cloud KMS keys that wrap each backup's data key.",
          maxItems: 8,
          items: object(
            "One KMS key.",
            {
              provider: choice("Key provider.", ["aws", "gcp", "azure"]),
              key: text("Key ARN/alias, GCP key resource name or Azure Key Vault key URL.", {
                minLength: 1,
              }),
            },
            ["provider", "key"],
          ),
        },
        passphraseSecretRef: secretKeyRef(
          "Secret key holding a passphrase, instead of recipients.",
          "MONGOSHIELD_PASSPHRASE",
        ),
        identitySecretRef: secretKeyRef(
          "Secret key holding an age identity, for deep verification and restores. Leave it out of the cluster when you can.",
          "identity.txt",
        ),
      },
      [],
      {
        "x-kubernetes-validations": [
          {
            rule: "!(has(self.passphraseSecretRef) && (has(self.recipients) || has(self.kms)))",
            message: "a passphrase cannot be combined with recipients or kms (age format rule)",
          },
        ],
      },
    ),
    schedule: object(
      "When to run. Without a schedule the plan only runs manual MongoShieldBackups.",
      {
        cron: text("Standard 5-field cron expression, e.g. '15 3 * * *'.", {
          minLength: 1,
          maxLength: 256,
        }),
        timeZone: text("IANA time zone for cron. Defaults to Etc/UTC.", { maxLength: 64 }),
        suspend: flag("Pause scheduled runs without deleting the plan."),
        startingDeadlineSeconds: integer(
          "Still start a missed run up to this many seconds late. Defaults to 3600.",
          { minimum: 0 },
        ),
      },
      ["cron"],
    ),
    backup: object("What each backup contains and how it is read.", {
      include: stringList("Namespace patterns to back up, e.g. app.* (default: everything)."),
      exclude: stringList("Namespace patterns to leave out, e.g. *.sessions."),
      consistency: choice("Point-in-time consistency across collections. Defaults to auto.", [
        "auto",
        "none",
        "snapshot",
        "converge",
      ]),
      compression: choice("Compression. Defaults to zstd.", ["zstd", "gzip", "none"]),
      parallelism: integer("Collections (and parts) backed up at the same time.", {
        minimum: 1,
        maximum: 64,
      }),
      readPreference: choice("Which members to read from. Defaults to secondaryPreferred.", [
        "primary",
        "primaryPreferred",
        "secondary",
        "secondaryPreferred",
        "nearest",
      ]),
      labels: stringMap("Labels stored in each backup's manifest."),
      retainDays: integer("Make backups write-once for this many days (object lock).", {
        minimum: 1,
        maximum: 36500,
      }),
      usersAndRoles: flag("Also back up users and custom roles (encrypt such backups)."),
    }),
    incremental: object(
      "Incremental backups: each run stores only the changes since the previous backup; a full backup starts a new chain when due. Full weekly, incremental hourly = an hourly cron with fullEveryDays 7. Needs a replica set or sharded cluster (MongoDB 6.0+).",
      {
        fullEveryDays: {
          type: "number",
          description:
            "Start a new chain once its full backup is this many days old. Defaults to 7.",
          minimum: 0.001,
          maximum: 366,
        },
        maxChainLength: integer("Start a new chain once it holds this many incrementals.", {
          minimum: 1,
          maximum: 100000,
        }),
      },
    ),
    retention: object(
      "Which backups to keep in storage; applied after each successful scheduled run.",
      {
        last: integer("Keep the N newest backups.", { minimum: 1 }),
        hourly: integer("Keep the newest backup of each of the last N hours.", { minimum: 1 }),
        daily: integer("…of each of the last N days.", { minimum: 1 }),
        weekly: integer("…of each of the last N weeks.", { minimum: 1 }),
        monthly: integer("…of each of the last N months.", { minimum: 1 }),
        yearly: integer("…of each of the last N years.", { minimum: 1 }),
        minVerified: integer("Never prune below this many verified backups.", { minimum: 0 }),
      },
    ),
    verify: choice(
      "How each new backup is checked. Defaults to fast. drill restores it into spec.drill's scratch deployment and checks it.",
      ["none", "fast", "deep", "drill"],
    ),
    drill: object(
      "The scratch deployment for verify: drill. Its connection string stays in the Secret (MONGOSHIELD_DRILL_URI in the pod), never in the ConfigMap.",
      {
        targetUriSecretRef: secretKeyRef(
          "Secret key holding the scratch deployment's connection string. Never the source.",
          "MONGODB_URI",
        ),
        sample: integer("Documents per collection compared byte for byte. Defaults to 0.", {
          minimum: 0,
          maximum: 10000,
        }),
        prefix: text("Prefix of the temporary database names. Defaults to msdrill_.", {
          maxLength: 32,
          minLength: 1,
        }),
      },
      ["targetUriSecretRef"],
    ),
    retries: integer("Retries inside a run, with backoff. Defaults to 2.", {
      minimum: 0,
      maximum: 10,
    }),
    lock: choice("Lock that keeps runs from overlapping. Defaults to storage.", [
      "storage",
      "mongo",
      "none",
    ]),
    extraConfig: {
      type: "object",
      description:
        "More mongoshield.config.json settings (notify, heartbeat, guard, replicate…), merged under the generated config. Stored in a ConfigMap: no secrets.",
      "x-kubernetes-preserve-unknown-fields": true,
    },
    history: object("How many finished MongoShieldBackup objects of scheduled runs to keep.", {
      successfulLimit: integer("Defaults to 10.", { minimum: 0, maximum: 1000 }),
      failedLimit: integer("Defaults to 5.", { minimum: 0, maximum: 1000 }),
    }),
    job: jobSettingsSchema,
  },
  ["source", "storage"],
  {
    "x-kubernetes-validations": [
      {
        rule: "!has(self.verify) || self.verify != 'drill' || has(self.drill)",
        message: "verify: drill needs spec.drill.targetUriSecretRef (a scratch deployment)",
      },
    ],
  },
);

/** A short run summary in a plan's status. */
const runSummarySchema = (description: string): JsonSchema =>
  object(description, {
    name: text("The MongoShieldBackup object.", { maxLength: NAME_LENGTH }),
    backupId: text("Backup id in storage."),
    phase: text("Phase of that run."),
    completionTime: text("When it finished.", { format: "date-time" }),
    bytesStored: integer("Bytes stored."),
  });

const planStatusSchema = object("Observed state of the plan.", {
  observedGeneration: integer("The metadata.generation this status describes."),
  conditions: conditionsSchema,
  cronJobName: text("The CronJob running the schedule.", { maxLength: NAME_LENGTH }),
  configMapName: text("The ConfigMap with the generated config.", { maxLength: NAME_LENGTH }),
  lastScheduleTime: text("When the CronJob last started a run.", { format: "date-time" }),
  nextScheduleTime: text("When the next run is due.", { format: "date-time" }),
  lastBackup: runSummarySchema("The newest finished run."),
  lastSuccessfulBackup: runSummarySchema("The newest successful run."),
  activeBackups: integer("Runs in progress."),
});

// ---------------------------------------------------------------------------
// MongoShieldBackup
// ---------------------------------------------------------------------------

const backupSpecSchema = object(
  "One backup run. Create one for an on-demand backup; the operator creates one per scheduled run.",
  {
    // What the run is cannot change once it exists (it happens once); only what
    // deleting it does may change, so each of these fields is immutable on its own.
    planRef: {
      ...localRef("The MongoShieldBackupPlan whose settings this run uses."),
      "x-kubernetes-validations": [
        {
          rule: "self == oldSelf",
          message: "planRef is immutable: create a new MongoShieldBackup",
        },
      ],
    },
    verify: {
      ...choice("Overrides the plan's verify for this run (drill needs the plan's spec.drill).", [
        "none",
        "fast",
        "deep",
        "drill",
      ]),
      "x-kubernetes-validations": [{ rule: "self == oldSelf", message: "verify is immutable" }],
    },
    prune: {
      ...flag("Apply the plan's retention after this run. Defaults to false."),
      "x-kubernetes-validations": [{ rule: "self == oldSelf", message: "prune is immutable" }],
    },
    deletionPolicy: {
      ...choice(
        "Retain (default): deleting this object leaves the backup in storage. Delete: the operator deletes the backup from storage first (mongoshield delete; held, write-once and depended-on backups are refused). May be changed later.",
        ["Retain", "Delete"],
      ),
      default: "Retain",
    },
  },
  ["planRef"],
);

const backupStatusSchema = object("Result of the run, mirrored from MongoShield's run report.", {
  observedGeneration: integer("The metadata.generation this status describes."),
  conditions: conditionsSchema,
  phase: choice("Pending, Running, Succeeded, Checkpointed, Skipped or Failed.", [
    "Pending",
    "Running",
    "Succeeded",
    "Checkpointed",
    "Skipped",
    "Failed",
  ]),
  jobName: text("The Job running this backup.", { maxLength: NAME_LENGTH }),
  startTime: text("When the run started.", { format: "date-time" }),
  completionTime: text("When the run finished.", { format: "date-time" }),
  backupId: text("Backup id in storage; use it to restore."),
  runId: text("MongoShield run id, for matching logs and notifications."),
  storage: text("Where the backup was stored (without secrets)."),
  durationMs: integer("How long the backup took, in milliseconds."),
  namespaces: integer("Collections backed up."),
  documents: integer("Documents backed up."),
  bytesRaw: integer("Uncompressed BSON bytes."),
  bytesStored: integer("Bytes written to storage."),
  kind: choice("full or incremental.", ["full", "incremental"]),
  parentBackupId: text("Incremental backups: the backup this one continues."),
  changes: integer("Incremental backups: change events recorded."),
  fullBackupReason: text("Why a plan with incrementals took a full backup this time."),
  verification: object("How the backup was verified.", {
    mode: text("none, fast or deep."),
    ok: flag("True when no problems were found."),
    problemCount: integer("Problems found."),
    problems: stringList("The first few problems.", 20),
    rtoMs: integer("Drills (verify: drill): the measured restore time in milliseconds."),
  }),
  prune: object("Retention applied after the run.", {
    deletedBackups: integer("Backups deleted."),
    kept: integer("Backups kept."),
  }),
  error: runErrorSchema,
});

// ---------------------------------------------------------------------------
// MongoShieldRestore
// ---------------------------------------------------------------------------

const restoreSpecSchema = object(
  "One restore of a backup into a deployment.",
  {
    planRef: localRef("The MongoShieldBackupPlan whose storage (and key) holds the backup."),
    backup: object(
      "Which backup. Defaults to the latest one in the plan's storage.",
      {
        name: text("A MongoShieldBackup object; its backupId is restored.", {
          maxLength: NAME_LENGTH,
        }),
        id: text("A backup id, or 'latest'.", { maxLength: 256 }),
      },
      [],
      {
        "x-kubernetes-validations": [
          { rule: "!(has(self.name) && has(self.id))", message: "set backup.name or backup.id" },
        ],
      },
    ),
    target: object(
      "Where to restore to. Required on purpose: there is no default target.",
      {
        uriSecretRef: secretKeyRef(
          "Secret key holding the target's connection string.",
          "MONGODB_URI",
        ),
      },
      ["uriSecretRef"],
    ),
    include: stringList("Namespace patterns to restore (default: everything in the backup)."),
    exclude: stringList("Namespace patterns to leave out."),
    rename: {
      type: "array",
      description: "Restore under other names, e.g. from app.* to app_restored.*.",
      maxItems: 100,
      items: object(
        "One rename rule.",
        {
          from: text("Source namespace pattern.", { minLength: 1, maxLength: 256 }),
          to: text("Target namespace pattern.", { minLength: 1, maxLength: 256 }),
        },
        ["from", "to"],
      ),
    },
    mode: choice("What to do with existing target collections. Defaults to fail-if-exists.", [
      "fail-if-exists",
      "drop",
      "insert",
      "upsert",
    ]),
    dryRun: flag("Only plan the restore; write nothing."),
    confirm: text(
      "For drop, insert and upsert: must equal target.uriSecretRef.name, to confirm the overwrite.",
      { maxLength: NAME_LENGTH },
    ),
    at: text("Point-in-time recovery: ISO date or cluster time (t:i). Needs the change journal.", {
      maxLength: 64,
    }),
    skipIndexes: flag("Do not create indexes (faster, for throwaway targets)."),
    usersAndRoles: choice("Restore the backup's users and roles.", ["skip", "create", "replace"]),
  },
  ["planRef", "target"],
  {
    "x-kubernetes-validations": [
      { rule: "self == oldSelf", message: "spec is immutable: create a new MongoShieldRestore" },
      {
        // Overwriting needs an explicit, target-specific confirmation (dry runs excepted).
        rule: "!has(self.mode) || self.mode == 'fail-if-exists' || (has(self.dryRun) && self.dryRun) || (has(self.confirm) && self.confirm == self.target.uriSecretRef.name)",
        message:
          "mode drop, insert and upsert can overwrite data: set confirm to the target Secret's name (target.uriSecretRef.name)",
      },
    ],
  },
);

const restoreStatusSchema = object("Result of the restore.", {
  observedGeneration: integer("The metadata.generation this status describes."),
  conditions: conditionsSchema,
  phase: choice("Pending, Running, Succeeded or Failed.", [
    "Pending",
    "Running",
    "Succeeded",
    "Failed",
  ]),
  jobName: text("The Job running this restore.", { maxLength: NAME_LENGTH }),
  backupId: text("The backup id restored."),
  startTime: text("When the restore started.", { format: "date-time" }),
  completionTime: text("When the restore finished.", { format: "date-time" }),
  durationMs: integer("How long the restore took, in milliseconds."),
  dryRun: flag("True when nothing was written."),
  documentsRestored: integer("Documents written."),
  namespaces: integer("Namespaces in the restore plan."),
  error: runErrorSchema,
});

// ---------------------------------------------------------------------------
// MongoShieldDrill
// ---------------------------------------------------------------------------

const drillSpecSchema = object(
  "One restore drill: restore a backup into temporary databases on a scratch deployment, check counts, indexes and a sample of documents, drop them, and measure the restore time.",
  {
    planRef: localRef("The MongoShieldBackupPlan whose storage (and key) holds the backup."),
    backup: object(
      "Which backup. Defaults to the latest one in the plan's storage.",
      {
        name: text("A MongoShieldBackup object; its backupId is drilled.", {
          maxLength: NAME_LENGTH,
        }),
        id: text("A backup id, or 'latest'.", { maxLength: 256 }),
      },
      [],
      {
        "x-kubernetes-validations": [
          { rule: "!(has(self.name) && has(self.id))", message: "set backup.name or backup.id" },
        ],
      },
    ),
    target: object(
      "The scratch deployment. Never the backup's source: MongoShield refuses that.",
      {
        uriSecretRef: secretKeyRef(
          "Secret key holding the scratch deployment's connection string.",
          "MONGODB_URI",
        ),
      },
      ["uriSecretRef"],
    ),
    sample: integer("Documents per collection compared byte for byte with the backup.", {
      minimum: 0,
      maximum: 10000,
    }),
    prefix: text("Prefix of the temporary database names. Defaults to msdrill_.", {
      maxLength: 32,
      minLength: 1,
    }),
    include: stringList("Namespace patterns to drill (default: everything in the backup)."),
    exclude: stringList("Namespace patterns to leave out."),
  },
  ["planRef", "target"],
  {
    "x-kubernetes-validations": [
      { rule: "self == oldSelf", message: "spec is immutable: create a new MongoShieldDrill" },
    ],
  },
);

const drillStatusSchema = object("Result of the drill, from MongoShield's drill report.", {
  observedGeneration: integer("The metadata.generation this status describes."),
  conditions: conditionsSchema,
  phase: choice("Pending, Running, Succeeded or Failed.", [
    "Pending",
    "Running",
    "Succeeded",
    "Failed",
  ]),
  jobName: text("The Job running this drill.", { maxLength: NAME_LENGTH }),
  backupId: text("The backup id drilled."),
  startTime: text("When the drill started.", { format: "date-time" }),
  completionTime: text("When the drill finished.", { format: "date-time" }),
  ok: flag("True when the backup restored and every check passed."),
  rtoMs: integer("The measured restore time (RTO), in milliseconds."),
  durationMs: integer("The whole drill, checks and cleanup included."),
  documentsRestored: integer("Documents restored into the scratch deployment."),
  namespaces: integer("Namespaces drilled."),
  problemCount: integer("Problems found."),
  problems: stringList("The first few problems.", 20),
  error: runErrorSchema,
});

// ---------------------------------------------------------------------------
// The CRD objects
// ---------------------------------------------------------------------------

/** What differs between the three CRDs. */
interface CrdShape {
  readonly kind: string;
  readonly plural: string;
  readonly singular: string;
  readonly shortNames: readonly string[];
  readonly description: string;
  readonly spec: JsonSchema;
  readonly status: JsonSchema;
  readonly columns: PrinterColumn[];
}

/** Builds one CRD: namespaced, one version, with the status subresource. */
function buildCrd(shape: CrdShape): CustomResourceDefinition {
  return {
    apiVersion: "apiextensions.k8s.io/v1",
    kind: "CustomResourceDefinition",
    metadata: {
      name: `${shape.plural}.${API_GROUP}`,
      labels: { "app.kubernetes.io/part-of": "mongoshield" },
    },
    spec: {
      group: API_GROUP,
      names: {
        kind: shape.kind,
        listKind: `${shape.kind}List`,
        plural: shape.plural,
        singular: shape.singular,
        shortNames: [...shape.shortNames],
        // `kubectl get mongoshield` lists every MongoShield object in the namespace.
        categories: ["mongoshield"],
      },
      // Namespaced: plans, backups and restores live next to the Secrets they use,
      // and namespace RBAC decides who may back up or restore what.
      scope: "Namespaced",
      versions: [
        {
          name: API_VERSION,
          served: true,
          storage: true,
          // status is written only through /status, so users editing the spec can't
          // overwrite results, and a spec change bumps metadata.generation.
          subresources: { status: {} },
          additionalPrinterColumns: shape.columns,
          schema: {
            openAPIV3Schema: object(
              shape.description,
              {
                apiVersion: { type: "string" },
                kind: { type: "string" },
                metadata: { type: "object" },
                spec: shape.spec,
                status: shape.status,
              },
              ["spec"],
            ),
          },
        },
      ],
    },
  };
}

/** MongoShieldBackupPlan: the "where and how" of backups, plus an optional schedule. */
export const backupPlanCrd: CustomResourceDefinition = buildCrd({
  kind: KINDS.plan,
  plural: "mongoshieldbackupplans",
  singular: "mongoshieldbackupplan",
  shortNames: ["msplan"],
  description: "A MongoShield backup plan: source, storage, encryption, schedule and retention.",
  spec: planSpecSchema,
  status: planStatusSchema,
  columns: [
    { name: "Schedule", type: "string", jsonPath: ".spec.schedule.cron" },
    { name: "Suspended", type: "boolean", jsonPath: ".spec.schedule.suspend" },
    { name: "Ready", type: "string", jsonPath: '.status.conditions[?(@.type=="Ready")].status' },
    { name: "Last Success", type: "date", jsonPath: ".status.lastSuccessfulBackup.completionTime" },
    {
      name: "Last Backup",
      type: "string",
      jsonPath: ".status.lastSuccessfulBackup.backupId",
      priority: 1,
    },
    { name: "Next", type: "date", jsonPath: ".status.nextScheduleTime", priority: 1 },
    { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
  ],
});

/** MongoShieldBackup: one run. */
export const backupCrd: CustomResourceDefinition = buildCrd({
  kind: KINDS.backup,
  plural: "mongoshieldbackups",
  singular: "mongoshieldbackup",
  shortNames: ["msbackup"],
  description: "One MongoShield backup run; its status mirrors the backup's manifest.",
  spec: backupSpecSchema,
  status: backupStatusSchema,
  columns: [
    { name: "Plan", type: "string", jsonPath: ".spec.planRef.name" },
    { name: "Phase", type: "string", jsonPath: ".status.phase" },
    { name: "Backup ID", type: "string", jsonPath: ".status.backupId" },
    { name: "Stored", type: "integer", jsonPath: ".status.bytesStored", format: "int64" },
    { name: "Verified", type: "boolean", jsonPath: ".status.verification.ok" },
    { name: "Kind", type: "string", jsonPath: ".status.kind", priority: 1 },
    { name: "Deletion", type: "string", jsonPath: ".spec.deletionPolicy", priority: 1 },
    { name: "Duration (ms)", type: "integer", jsonPath: ".status.durationMs", priority: 1 },
    { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
  ],
});

/** MongoShieldRestore: one restore. */
export const restoreCrd: CustomResourceDefinition = buildCrd({
  kind: KINDS.restore,
  plural: "mongoshieldrestores",
  singular: "mongoshieldrestore",
  shortNames: ["msrestore"],
  description: "One MongoShield restore of a backup into a deployment.",
  spec: restoreSpecSchema,
  status: restoreStatusSchema,
  columns: [
    { name: "Plan", type: "string", jsonPath: ".spec.planRef.name" },
    { name: "Backup ID", type: "string", jsonPath: ".status.backupId" },
    { name: "Mode", type: "string", jsonPath: ".spec.mode" },
    { name: "Dry Run", type: "boolean", jsonPath: ".spec.dryRun" },
    { name: "Phase", type: "string", jsonPath: ".status.phase" },
    { name: "Documents", type: "integer", jsonPath: ".status.documentsRestored" },
    { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
  ],
});

/** MongoShieldDrill: one restore drill. */
export const drillCrd: CustomResourceDefinition = buildCrd({
  kind: KINDS.drill,
  plural: "mongoshielddrills",
  singular: "mongoshielddrill",
  shortNames: ["msdrill"],
  description:
    "One MongoShield restore drill: restore a backup into a scratch deployment, check it, clean up, measure the RTO.",
  spec: drillSpecSchema,
  status: drillStatusSchema,
  columns: [
    { name: "Plan", type: "string", jsonPath: ".spec.planRef.name" },
    { name: "Backup ID", type: "string", jsonPath: ".status.backupId" },
    { name: "Phase", type: "string", jsonPath: ".status.phase" },
    { name: "OK", type: "boolean", jsonPath: ".status.ok" },
    { name: "RTO (ms)", type: "integer", jsonPath: ".status.rtoMs" },
    { name: "Problems", type: "integer", jsonPath: ".status.problemCount", priority: 1 },
    { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp" },
  ],
});

/** All CRDs, in install order. */
export const ALL_CRDS: readonly CustomResourceDefinition[] = [
  backupPlanCrd,
  backupCrd,
  restoreCrd,
  drillCrd,
];
