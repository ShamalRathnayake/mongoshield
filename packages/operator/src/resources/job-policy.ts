/**
 * What a MongoShieldBackupPlan may put into the pods the operator creates for it.
 *
 * A plan's `spec.job` is copied into every backup, restore and drill pod. Two of its
 * fields decide what runs and with which identity:
 *   - `image`: the code that runs next to the database connection string, the age
 *     identity and the storage credentials;
 *   - `serviceAccountName`: the pod's identity, including the cloud role that workload
 *     identity (IRSA, GKE, Azure) attaches to it.
 * Whoever may create MongoShield objects but not Pods (a custom "backup-admin" role)
 * could otherwise run any image, as any service account in the namespace. So the
 * operator's admin decides, with two settings (settings.ts, Helm `jobPolicy`):
 *
 *   MONGOSHIELD_ALLOWED_IMAGES            image repositories a plan may name.
 *                                         Default: the repository of the default image
 *                                         (other tags or digests of it are fine).
 *   MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS  "namespace/name" entries a plan may name.
 *                                         Default: "*" (any), because the built-in
 *                                         `edit` role, which gets the MongoShield kinds
 *                                         by default, can create Pods as any service
 *                                         account anyway.
 *
 * Entries: "*" allows everything; "registry.example.com/*" allows a repository prefix.
 * For service accounts, either part may be "*": "prod/*" allows every account in the
 * prod namespace, and a namespace part of "*" allows that account name everywhere.
 * A plan that breaks the policy is not Ready (reason InvalidSpec), so no Job runs.
 *
 * Restricting images means little if the environment can change what the allowed image
 * runs: the image runs `node`, which honours NODE_OPTIONS (`--import=data:…` is arbitrary
 * code), and the dynamic loader honours LD_PRELOAD. So while images are restricted (any
 * list without "*", the default), the environment is restricted too:
 *
 *   spec.job.env      may not name a variable that loads or changes code
 *                     (CODE_LOADING_NAMES / CODE_LOADING_PREFIXES below). NODE_OPTIONS is
 *                     the one exception, for a literal value made only of the harmless
 *                     flags in SAFE_NODE_OPTIONS (`--max-old-space-size=4096`, the common
 *                     need). NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR stay
 *                     allowed: they only add trusted CAs for endpoints the plan's author
 *                     chooses anyway. Nor may it name the variables the operator sets for
 *                     the run (OPERATOR_OWNED_NAMES): those come from the plan's spec and
 *                     its Secrets, and a plan's env silently replacing them is a mistake.
 *   spec.job.envFrom  is refused: a ConfigMap or Secret can carry any name, and the
 *                     operator does not read them. MONGOSHIELD_ALLOW_JOB_ENV_FROM=true
 *                     (Helm jobPolicy.allowEnvFrom) accepts it.
 *   the pod           always gets the variables in PINNED_ENVIRONMENT, set last and to
 *                     harmless values. `env` wins over `envFrom` in Kubernetes, so this
 *                     also neutralises those names in the storage credentials Secret
 *                     (spec.storage.credentialsSecretRef, passed whole as envFrom) and in
 *                     an allowed envFrom.
 */

import type { V1EnvVar } from "@kubernetes/client-node";
import type { BackupPlan } from "../api/types.ts";

/** The admin's limits on `spec.job`. */
export interface JobPolicy {
  /** Image repositories `spec.job.image` may come from (see the header for the syntax). */
  readonly allowedImages: readonly string[];
  /** Service accounts `spec.job.serviceAccountName` may name, as "namespace/name". */
  readonly allowedServiceAccounts: readonly string[];
  /**
   * Whether `spec.job.envFrom` is accepted while images are restricted (see the header).
   * Default false; MONGOSHIELD_ALLOW_JOB_ENV_FROM, Helm `jobPolicy.allowEnvFrom`.
   */
  readonly allowEnvFrom: boolean;
}

/**
 * Variables that load code into the job's process, or change which code it loads:
 * Node's own (NODE_OPTIONS takes any CLI flag, `--import`/`--require` included;
 * NODE_PATH adds module directories; NODE_COMPILE_CACHE reuses compiled code from a
 * directory; NODE_REPL_EXTERNAL_MODULE runs a module as the REPL), glibc's GCONV_PATH
 * (loads iconv modules) and OpenSSL's (a config file can load engines and providers,
 * which are shared libraries).
 */
const CODE_LOADING_NAMES: readonly string[] = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_COMPILE_CACHE",
  "NODE_REPL_EXTERNAL_MODULE",
  "GCONV_PATH",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
];

/** The dynamic loader's variables (LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT…; DYLD_ on macOS). */
const CODE_LOADING_PREFIXES: readonly string[] = ["LD_", "DYLD_"];

/**
 * Variables the operator sets for the run itself (resources/pod.ts), plus the two the
 * library reads in preference to MONGODB_URI (MONGOSHIELD_URI, MONGOSHIELD_URI_FILE),
 * which would replace it just the same.
 */
const OPERATOR_OWNED_NAMES: readonly string[] = [
  "MONGODB_URI",
  "MONGOSHIELD_URI",
  "MONGOSHIELD_URI_FILE",
  "MONGOSHIELD_DRILL_URI",
  "MONGOSHIELD_PASSPHRASE",
  "MONGOSHIELD_IDENTITY_FILE",
];

/**
 * NODE_OPTIONS flags a plan may still set while images are restricted: heap sizes and
 * warning output. None of them loads code. `<n>` is a whole number (megabytes).
 */
const SAFE_NODE_OPTIONS: readonly RegExp[] = [
  /^--max-old-space-size=\d+$/,
  /^--max-semi-space-size=\d+$/,
  /^--(no-warnings|trace-warnings|trace-uncaught|enable-source-maps)$/,
];

/**
 * What every job pod gets last in `env` (see the header). Empty values turn the loader's
 * and Node's variables off; NODE_DISABLE_COMPILE_CACHE beats a NODE_COMPILE_CACHE from a
 * Secret; OPENSSL_CONF=/dev/null is an empty config (Node's bundled OpenSSL needs none).
 * NODE_OPTIONS is replaced by the plan's own value when that value is allowed.
 */
export const PINNED_ENVIRONMENT: readonly V1EnvVar[] = [
  { name: "NODE_OPTIONS", value: "" },
  { name: "NODE_PATH", value: "" },
  { name: "NODE_DISABLE_COMPILE_CACHE", value: "1" },
  { name: "LD_PRELOAD", value: "" },
  { name: "LD_AUDIT", value: "" },
  { name: "LD_LIBRARY_PATH", value: "" },
  { name: "GCONV_PATH", value: "" },
  { name: "OPENSSL_CONF", value: "/dev/null" },
];

/** Where the policy settings are documented, for the hints in problems. */
const IMAGES_SETTING = "MONGOSHIELD_ALLOWED_IMAGES, Helm value jobPolicy.allowedImages";

/** Allows everything in a list of entries. */
const ANY = "*";

/**
 * The repository part of an image reference, without tag or digest:
 * `ghcr.io/acme/mongoshield:2.0.1@sha256:…` → `ghcr.io/acme/mongoshield`.
 * A `:` before the last `/` is a registry port (`registry:5000/x`), not a tag.
 */
export function imageRepository(image: string): string {
  const withoutDigest = image.split("@")[0] ?? image;
  const lastColon = withoutDigest.lastIndexOf(":");
  const lastSlash = withoutDigest.lastIndexOf("/");
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/**
 * The policy when the admin set nothing: the default image's repository, any service
 * account, no `spec.job.envFrom`.
 */
export function defaultJobPolicy(defaultImage: string): JobPolicy {
  return {
    allowedImages: [imageRepository(defaultImage)],
    allowedServiceAccounts: [ANY],
    allowEnvFrom: false,
  };
}

/** True unless the policy allows any image ("*"): then the environment is restricted too. */
export function imagesRestricted(policy: JobPolicy): boolean {
  return !policy.allowedImages.includes(ANY);
}

/** Why the plan's `spec.job` breaks the policy, or undefined when it does not. */
export function jobPolicyProblem(plan: BackupPlan, policy: JobPolicy): string | undefined {
  const job = plan.spec.job ?? {};
  if (job.image !== undefined && !imageAllowed(job.image, policy.allowedImages)) {
    return (
      `spec.job.image "${job.image}" is not allowed: this operator only runs images from ` +
      `${policy.allowedImages.join(", ")}. Remove spec.job.image to use the default image, ` +
      "or ask the operator's admin to allow the repository (MONGOSHIELD_ALLOWED_IMAGES, " +
      "Helm value jobPolicy.allowedImages)."
    );
  }
  const namespace = plan.metadata.namespace ?? "";
  const account = job.serviceAccountName;
  if (account !== undefined && !serviceAccountAllowed(namespace, account, policy)) {
    return (
      `spec.job.serviceAccountName "${account}" is not allowed in namespace "${namespace}". ` +
      "Ask the operator's admin to allow it (MONGOSHIELD_ALLOWED_SERVICE_ACCOUNTS, Helm " +
      "value jobPolicy.allowedServiceAccounts)."
    );
  }
  return imagesRestricted(policy) ? environmentProblem(plan, policy) : undefined;
}

/**
 * Why `spec.job.env` or `spec.job.envFrom` breaks a policy that restricts images (see
 * the header), or undefined when they do not.
 */
function environmentProblem(plan: BackupPlan, policy: JobPolicy): string | undefined {
  const job = plan.spec.job ?? {};
  for (const variable of job.env ?? []) {
    const problem = variableProblem(variable);
    if (problem !== undefined) return `spec.job.env "${variable.name}" is not allowed: ${problem}`;
  }
  if ((job.envFrom ?? []).length > 0 && !policy.allowEnvFrom) {
    return (
      "spec.job.envFrom is not allowed while this operator restricts images: a ConfigMap or " +
      "Secret can set variables such as NODE_OPTIONS that change the code the image runs. " +
      "List the variables in spec.job.env (valueFrom.secretKeyRef keeps secrets out of the " +
      "plan), or ask the operator's admin to allow envFrom (MONGOSHIELD_ALLOW_JOB_ENV_FROM, " +
      "Helm value jobPolicy.allowEnvFrom)."
    );
  }
  return undefined;
}

/** Why one `spec.job.env` entry is refused while images are restricted, or undefined. */
function variableProblem(variable: V1EnvVar): string | undefined {
  // Upper-cased: Linux names are case-sensitive, so this only ever refuses more.
  const name = variable.name.toUpperCase();
  if (name === "NODE_OPTIONS") return nodeOptionsProblem(variable);
  if (loadsCode(name)) {
    return (
      "it changes the code the job's image runs, which this operator restricts. Ask the " +
      `operator's admin to allow any image ("*" in ${IMAGES_SETTING}) if you need it.`
    );
  }
  if (OPERATOR_OWNED_NAMES.includes(name)) {
    return (
      "the operator sets it from the plan's spec and its Secrets. Change spec.source, " +
      "spec.drill or spec.encryption instead."
    );
  }
  return undefined;
}

/** NODE_OPTIONS is allowed as a literal value of {@link SAFE_NODE_OPTIONS} flags only. */
function nodeOptionsProblem(variable: V1EnvVar): string | undefined {
  const hint =
    "only --max-old-space-size=<n>, --max-semi-space-size=<n>, --no-warnings, " +
    "--trace-warnings, --trace-uncaught and --enable-source-maps are allowed, because " +
    "other flags (--import, --require…) can run any code. Ask the operator's admin to " +
    `allow any image ("*" in ${IMAGES_SETTING}) for more.`;
  if (variable.valueFrom !== undefined) {
    return `it must be a literal value (not valueFrom) the operator can check: ${hint}`;
  }
  const flags = (variable.value ?? "").split(/\s+/).filter((flag) => flag !== "");
  const unsafe = flags.find((flag) => !SAFE_NODE_OPTIONS.some((pattern) => pattern.test(flag)));
  return unsafe === undefined ? undefined : `"${unsafe}": ${hint}`;
}

/** True for the names of {@link CODE_LOADING_NAMES} and {@link CODE_LOADING_PREFIXES}. */
function loadsCode(upperCaseName: string): boolean {
  if (CODE_LOADING_NAMES.includes(upperCaseName)) return true;
  return CODE_LOADING_PREFIXES.some((prefix) => upperCaseName.startsWith(prefix));
}

/**
 * The plan's own variables as they go into a pod while images are restricted, followed
 * by {@link PINNED_ENVIRONMENT}: entries that load code or have a pinned name are taken
 * out of the plan's list (no duplicate names), and NODE_OPTIONS keeps the plan's value
 * when it is allowed.
 * The plan reconciler refuses the rest beforehand; this keeps a pod safe even when it is
 * built from a plan that was never checked (an edit racing a manual backup).
 */
export function restrictedEnvironment(planEnv: readonly V1EnvVar[]): V1EnvVar[] {
  const pinnedNames = new Set(PINNED_ENVIRONMENT.map((variable) => variable.name));
  const kept = planEnv.filter(
    (variable) => !pinnedNames.has(variable.name) && !loadsCode(variable.name.toUpperCase()),
  );
  const planNodeOptions = planEnv.find((variable) => variable.name === "NODE_OPTIONS");
  const nodeOptions =
    planNodeOptions !== undefined && nodeOptionsProblem(planNodeOptions) === undefined
      ? (planNodeOptions.value ?? "")
      : "";
  const pinned = PINNED_ENVIRONMENT.map((variable) =>
    variable.name === "NODE_OPTIONS" ? { name: variable.name, value: nodeOptions } : variable,
  );
  return [...kept, ...pinned];
}

/** True when the image's repository matches an entry exactly or by a `prefix/*` entry. */
function imageAllowed(image: string, allowed: readonly string[]): boolean {
  const repository = imageRepository(image);
  return allowed.some((entry) => {
    if (entry === ANY) return true;
    if (entry.endsWith("/*")) return repository.startsWith(entry.slice(0, -1));
    return repository === entry;
  });
}

/** True when "namespace/name" matches an entry; either part of an entry may be "*". */
function serviceAccountAllowed(namespace: string, name: string, policy: JobPolicy): boolean {
  return policy.allowedServiceAccounts.some((entry) => {
    if (entry === ANY) return true;
    const [entryNamespace, entryName] = entry.split("/");
    const namespaceMatches = entryNamespace === ANY || entryNamespace === namespace;
    const nameMatches = entryName === ANY || entryName === name;
    return namespaceMatches && nameMatches;
  });
}
