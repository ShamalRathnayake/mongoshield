/**
 * Names shared by the CRDs, the controllers and the objects they create.
 *
 * Why the API group is `mongoshield.io` and the version `v1alpha1`:
 *
 * - Kubernetes wants custom API groups to be DNS names the author controls, so two
 *   projects never define the same group. `mongoshield.io` is the project's name as a
 *   domain; every kind lives in that one group so RBAC rules stay short.
 * - `v1alpha1` says the schema may still change incompatibly. Once it settles it moves
 *   to `v1beta1` (with a conversion webhook if old objects need rewriting) and then `v1`.
 *
 * Every kind is prefixed with "MongoShield" (`MongoShieldBackup`, not `Backup`) because
 * other popular operators (Velero, CloudNativePG, Percona) also define a `Backup` kind,
 * and `kubectl get backup` would otherwise be ambiguous in clusters that run several.
 */

/** The custom API group of every MongoShield kind. */
export const API_GROUP = "mongoshield.io";

/** The served (and stored) version of every MongoShield kind. */
export const API_VERSION = "v1alpha1";

/** `apiVersion` as written in manifests: group/version. */
export const API_GROUP_VERSION = `${API_GROUP}/${API_VERSION}`;

/** The kinds this operator defines and reconciles. */
export const KINDS = {
  /** Where and how to back up a deployment, and on which schedule. */
  plan: "MongoShieldBackupPlan",
  /** One backup run, scheduled or one-off. Its status mirrors the backup's manifest. */
  backup: "MongoShieldBackup",
  /** One restore of a backup into a deployment. */
  restore: "MongoShieldRestore",
  /** One restore drill: restore into a scratch deployment, check, clean up. */
  drill: "MongoShieldDrill",
} as const;

/**
 * Label and annotation keys. Prefixed with the API group so they never clash with
 * anyone else's.
 */
export const LABELS = {
  /** Set on every object the operator creates; also what its watches select on. */
  managedBy: "app.kubernetes.io/managed-by",
  /** The name of the BackupPlan an object belongs to. */
  plan: `${API_GROUP}/plan`,
  /** The name of the MongoShieldBackup a Job runs. */
  backup: `${API_GROUP}/backup`,
  /** The name of the MongoShieldRestore a Job runs. */
  restore: `${API_GROUP}/restore`,
  /** The name of the MongoShieldDrill a Job runs. */
  drill: `${API_GROUP}/drill`,
  /** What started a backup: `schedule` (the plan's CronJob) or `manual`. */
  trigger: `${API_GROUP}/trigger`,
  /** Which mongoshield command a Job runs: `run` or `restore`. */
  component: "app.kubernetes.io/component",
} as const;

/** The value of `app.kubernetes.io/managed-by` on objects this operator creates. */
export const MANAGED_BY = "mongoshield-operator";

/** Annotation keys. */
export const ANNOTATIONS = {
  /**
   * On a MongoShieldBackup created for a scheduled run: the name of the Job the plan's
   * CronJob started. The backup adopts that Job instead of creating its own.
   */
  scheduledJob: `${API_GROUP}/scheduled-job`,
  /**
   * A hash of the desired spec of an object the operator manages (CronJob, ConfigMap).
   * Comparing hashes, not the live spec, avoids fighting with fields the API server
   * defaults (it fills in dozens of pod spec fields we never set).
   */
  specHash: `${API_GROUP}/spec-hash`,
} as const;

/**
 * Finalizers. Each one stops the API server from deleting an object until the operator
 * has cleaned up what owner references alone would clean up too late (see the
 * reconcilers for what each one waits for).
 */
export const FINALIZERS = {
  plan: `${API_GROUP}/cronjob-cleanup`,
  backup: `${API_GROUP}/job-cleanup`,
  restore: `${API_GROUP}/job-cleanup`,
  drill: `${API_GROUP}/job-cleanup`,
  /**
   * On a MongoShieldBackup with `deletionPolicy: Delete`: the backup's data is deleted
   * from storage (by a `mongoshield delete` Job) before the object goes.
   */
  backupData: `${API_GROUP}/delete-backup-data`,
} as const;

/** The container name in every Job the operator creates; results are read from its logs. */
export const JOB_CONTAINER = "mongoshield";

/** Where the generated mongoshield.config.json is mounted in job pods. */
export const CONFIG_MOUNT_PATH = "/etc/mongoshield/config";

/** The key (file name) of the generated config in its ConfigMap. */
export const CONFIG_FILE_NAME = "mongoshield.config.json";

/** Where the age identity Secret is mounted in job pods. */
export const IDENTITY_MOUNT_PATH = "/etc/mongoshield/identity";

/** The default mount path of a plan's PersistentVolumeClaim. */
export const DEFAULT_VOLUME_MOUNT_PATH = "/backups";

/** The default key inside a connection-string Secret (the variable name MongoShield reads). */
export const DEFAULT_URI_SECRET_KEY = "MONGODB_URI";

/** The default key inside an age identity Secret. */
export const DEFAULT_IDENTITY_SECRET_KEY = "identity.txt";

/** The default key inside a passphrase Secret (the variable name MongoShield reads). */
export const DEFAULT_PASSPHRASE_SECRET_KEY = "MONGOSHIELD_PASSPHRASE";
