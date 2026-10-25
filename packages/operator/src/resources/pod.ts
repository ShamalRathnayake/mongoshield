/**
 * The pod template of every Job the operator runs: a plan's scheduled runs, manual
 * backups and restores all use the MongoShield image with a different command line.
 *
 * Inside the pod:
 *   /etc/mongoshield/config/mongoshield.config.json   the plan's generated config (ConfigMap)
 *   /etc/mongoshield/identity/<key>                     age identity, if the plan names one
 *   /backups (or the plan's mountPath)                  the plan's PersistentVolumeClaim, if any
 *   /tmp                                                scratch space (the root filesystem is read-only)
 *
 * Secrets never pass through the operator: the pod references them, and the kubelet
 * injects them. That is why the operator needs no permission to read Secrets.
 *
 * Results: the container runs mongoshield with --json, which prints exactly one
 * JSON document on stdout when it finishes; the operator reads it from the pod's
 * log (results/parse.ts). `FallbackToLogsOnError` puts the log tail into the pod's
 * termination message when the container fails, a second source for the error.
 */

import type { V1EnvFromSource, V1EnvVar, V1Volume, V1VolumeMount } from "@kubernetes/client-node";
import {
  CONFIG_FILE_NAME,
  CONFIG_MOUNT_PATH,
  DEFAULT_IDENTITY_SECRET_KEY,
  DEFAULT_PASSPHRASE_SECRET_KEY,
  DEFAULT_URI_SECRET_KEY,
  DEFAULT_VOLUME_MOUNT_PATH,
  IDENTITY_MOUNT_PATH,
  JOB_CONTAINER,
} from "../api/constants.ts";
import type { BackupPlan, SecretKeyRef } from "../api/types.ts";
import type { JobSpec, PodTemplateSpec } from "../kube/objects.ts";

/** Defaults the operator was configured with. */
export interface JobDefaults {
  /** The MongoShield image to run when a plan does not name one. */
  readonly image: string;
  readonly imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
}

/** Everything needed to build one pod template. */
export interface PodInputs {
  readonly plan: BackupPlan;
  readonly defaults: JobDefaults;
  /** The mongoshield command line (the image's entrypoint is the CLI). */
  readonly args: readonly string[];
  /**
   * The connection string handed to MongoShield as MONGODB_URI: the plan's source for
   * backups, the restore's target for restores; none for drills.
   */
  readonly uriSecret?: SecretKeyRef;
  /**
   * The scratch deployment of a drill, handed to MongoShield as MONGOSHIELD_DRILL_URI
   * (read by `mongoshield drill` and by `verify: drill` runs). Never in the ConfigMap.
   * Defaults to the plan's `spec.drill.targetUriSecretRef`.
   */
  readonly drillSecret?: SecretKeyRef;
  /** The ConfigMap holding the plan's mongoshield.config.json. */
  readonly configMapName: string;
  /** Labels for the pods (and, by the caller, for the Job). */
  readonly labels: Readonly<Record<string, string>>;
  /** Hash of the config, as a pod annotation: config changes are visible in the template. */
  readonly configHash: string;
}

/** Path of the generated config inside the pod. */
export const CONFIG_PATH = `${CONFIG_MOUNT_PATH}/${CONFIG_FILE_NAME}`;

/** Six hours: comfortably above most backups; set `job.activeDeadlineSeconds` for longer ones. */
const DEFAULT_ACTIVE_DEADLINE_SECONDS = 6 * 3600;

/** One day: long enough for `kubectl logs`, and for the operator to read results after a restart. */
const DEFAULT_TTL_SECONDS_AFTER_FINISHED = 24 * 3600;

/** Builds the pod template for a run or restore. */
export function buildPodTemplate(inputs: PodInputs): PodTemplateSpec {
  const { plan, defaults } = inputs;
  const job = plan.spec.job ?? {};
  const pullPolicy = job.imagePullPolicy ?? defaults.imagePullPolicy;

  return {
    metadata: {
      labels: { ...job.podLabels, ...inputs.labels },
      annotations: { ...job.podAnnotations, "mongoshield.io/config-hash": inputs.configHash },
    },
    spec: {
      // A failed pod is not restarted in place; the Job's backoffLimit decides.
      restartPolicy: "Never",
      ...(job.serviceAccountName ? { serviceAccountName: job.serviceAccountName } : {}),
      // MongoShield never calls the Kubernetes API. Workload identity (IRSA, GKE,
      // Azure) projects its own token, so the API token stays unmounted.
      automountServiceAccountToken: false,
      ...(job.imagePullSecrets?.length
        ? { imagePullSecrets: job.imagePullSecrets.map((ref) => ({ name: ref.name })) }
        : {}),
      securityContext: {
        runAsNonRoot: true,
        // The image's user (distroless "nonroot").
        runAsUser: 65532,
        runAsGroup: 65532,
        fsGroup: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: JOB_CONTAINER,
          image: job.image ?? defaults.image,
          ...(pullPolicy ? { imagePullPolicy: pullPolicy } : {}),
          args: [...inputs.args],
          env: environment(inputs),
          ...(envFromSources(plan).length > 0 ? { envFrom: envFromSources(plan) } : {}),
          volumeMounts: volumeMounts(plan),
          resources: job.resources ?? {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { memory: "1Gi" },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          terminationMessagePolicy: "FallbackToLogsOnError",
        },
      ],
      volumes: volumes(plan, inputs.configMapName),
      ...(job.nodeSelector ? { nodeSelector: { ...job.nodeSelector } } : {}),
      ...(job.tolerations ? { tolerations: [...job.tolerations] } : {}),
      ...(job.affinity ? { affinity: job.affinity } : {}),
    },
  };
}

/** The Job spec around a pod template, with the plan's limits. */
export function buildJobSpec(plan: BackupPlan, template: PodTemplateSpec): JobSpec {
  const job = plan.spec.job ?? {};
  return {
    // 0 by default: MongoShield retries inside a run with backoff, and a new pod
    // per retry would restart a long backup (or a half-done restore) from scratch.
    backoffLimit: job.backoffLimit ?? 0,
    activeDeadlineSeconds: job.activeDeadlineSeconds ?? DEFAULT_ACTIVE_DEADLINE_SECONDS,
    ttlSecondsAfterFinished: job.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS_AFTER_FINISHED,
    template,
  };
}

/** Environment variables: the connection string, keys, and the user's extras. */
function environment(inputs: PodInputs): V1EnvVar[] {
  const { plan, uriSecret } = inputs;
  // Every pod of a plan with `spec.drill` gets the drill target, not only the runs
  // that drill: the ConfigMap's drill section has no targetUri, and MongoShield
  // validates the whole config at startup (restores and deletions included).
  const drillSecret = inputs.drillSecret ?? plan.spec.drill?.targetUriSecretRef;
  const encryption = plan.spec.encryption;
  const env: V1EnvVar[] = [];
  if (uriSecret) {
    env.push({
      // MongoShield reads MONGODB_URI itself (src/config/env.ts in the library).
      name: "MONGODB_URI",
      valueFrom: {
        secretKeyRef: { name: uriSecret.name, key: uriSecret.key ?? DEFAULT_URI_SECRET_KEY },
      },
    });
  }
  if (drillSecret) {
    env.push({
      name: "MONGOSHIELD_DRILL_URI",
      valueFrom: {
        secretKeyRef: { name: drillSecret.name, key: drillSecret.key ?? DEFAULT_URI_SECRET_KEY },
      },
    });
  }
  // Plain logs: no ANSI colour codes in `kubectl logs` or log collectors.
  env.push({ name: "NO_COLOR", value: "1" });
  if (encryption?.passphraseSecretRef) {
    env.push({
      name: "MONGOSHIELD_PASSPHRASE",
      valueFrom: {
        secretKeyRef: {
          name: encryption.passphraseSecretRef.name,
          key: encryption.passphraseSecretRef.key ?? DEFAULT_PASSPHRASE_SECRET_KEY,
        },
      },
    });
  }
  if (encryption?.identitySecretRef) {
    env.push({
      name: "MONGOSHIELD_IDENTITY_FILE",
      value: `${IDENTITY_MOUNT_PATH}/${identityKey(plan)}`,
    });
  }
  // The user's own variables last, so they can override ours if they must.
  env.push(...(plan.spec.job?.env ?? []));
  return env;
}

/** Whole Secrets as environment: storage credentials, then the user's extras. */
function envFromSources(plan: BackupPlan): V1EnvFromSource[] {
  const sources: V1EnvFromSource[] = [];
  const credentials = plan.spec.storage.credentialsSecretRef;
  if (credentials) sources.push({ secretRef: { name: credentials.name } });
  sources.push(...(plan.spec.job?.envFrom ?? []));
  return sources;
}

function volumeMounts(plan: BackupPlan): V1VolumeMount[] {
  const mounts: V1VolumeMount[] = [
    { name: "config", mountPath: CONFIG_MOUNT_PATH, readOnly: true },
    { name: "tmp", mountPath: "/tmp" },
  ];
  if (plan.spec.encryption?.identitySecretRef) {
    mounts.push({ name: "identity", mountPath: IDENTITY_MOUNT_PATH, readOnly: true });
  }
  const claim = plan.spec.storage.persistentVolumeClaim;
  if (claim) {
    mounts.push({ name: "backups", mountPath: claim.mountPath ?? DEFAULT_VOLUME_MOUNT_PATH });
  }
  return mounts;
}

function volumes(plan: BackupPlan, configMapName: string): V1Volume[] {
  const result: V1Volume[] = [
    { name: "config", configMap: { name: configMapName } },
    { name: "tmp", emptyDir: {} },
  ];
  const identity = plan.spec.encryption?.identitySecretRef;
  if (identity) {
    result.push({
      name: "identity",
      secret: {
        secretName: identity.name,
        items: [{ key: identityKey(plan), path: identityKey(plan) }],
        // Readable by the pod's group (fsGroup 65532, the mongoshield user) only.
        // 0440 octal = 288 decimal; JSON has no octal literals.
        defaultMode: 0o440,
      },
    });
  }
  const claim = plan.spec.storage.persistentVolumeClaim;
  if (claim) {
    result.push({ name: "backups", persistentVolumeClaim: { claimName: claim.claimName } });
  }
  return result;
}

/** The key of the identity file in its Secret (also its file name in the pod). */
function identityKey(plan: BackupPlan): string {
  return plan.spec.encryption?.identitySecretRef?.key ?? DEFAULT_IDENTITY_SECRET_KEY;
}
