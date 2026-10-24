/**
 * The Kubernetes object shapes the operator reads and writes, as plain JSON.
 *
 * The operator talks to the API server with plain JSON (see rest-client.ts), so
 * timestamps are RFC 3339 strings here. @kubernetes/client-node's model classes turn
 * them into `Date` objects through its serializer, which this code does not use, so
 * the metadata and status types are declared here with only the fields the operator
 * needs. Pod spec pieces (containers, volumes, …) have no timestamps, so the client
 * library's complete types are reused for those.
 */

import type {
  V1CronJobSpec as LibraryCronJobSpec,
  V1JobSpec,
  V1PodSpec,
  V1PodTemplateSpec,
} from "@kubernetes/client-node";

/** A reference from a dependent object to the object that owns it. */
export interface OwnerReference {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  /** The managing controller. At most one owner per object may have this set. */
  readonly controller?: boolean;
  /** With foreground deletion, the owner waits until this dependent is gone. */
  readonly blockOwnerDeletion?: boolean;
}

/** Standard object metadata (the fields this operator uses). */
export interface ObjectMeta {
  name?: string;
  namespace?: string;
  uid?: string;
  /** Opaque version of the object, changed on every write; used for optimistic concurrency. */
  resourceVersion?: string;
  /** Incremented by the API server when the spec changes (not on status or metadata writes). */
  generation?: number;
  creationTimestamp?: string;
  /** Set when deletion was requested; the object stays until its finalizers are removed. */
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  ownerReferences?: OwnerReference[];
}

/** Any Kubernetes object. */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: ObjectMeta;
}

/**
 * A status condition, as defined by the Kubernetes API conventions
 * (metav1.Condition): `status` is "True", "False" or "Unknown"; `reason` is a
 * CamelCase machine-readable word; `message` is for humans.
 */
export interface Condition {
  type: string;
  status: "True" | "False" | "Unknown";
  /** The `metadata.generation` the condition was computed for. */
  observedGeneration?: number;
  /** When `status` last changed (not when the condition was last written). */
  lastTransitionTime: string;
  reason: string;
  message: string;
}

/** A batch/v1 Job condition (Complete, Failed, SuccessCriteriaMet, FailureTarget, …). */
export interface JobCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** batch/v1 Job. */
export interface Job extends KubeObject {
  spec?: V1JobSpec;
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: JobCondition[];
  };
}

/** batch/v1 CronJob. */
export interface CronJob extends KubeObject {
  spec?: LibraryCronJobSpec;
  status?: {
    active?: { name?: string; namespace?: string; uid?: string }[];
    lastScheduleTime?: string;
    lastSuccessfulTime?: string;
  };
}

/** The state of one container, as reported in a pod's status. */
export interface ContainerState {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: {
    exitCode: number;
    reason?: string;
    /** The termination message (with FallbackToLogsOnError: the log tail on failure). */
    message?: string;
    startedAt?: string;
    finishedAt?: string;
  };
}

/** core/v1 Pod (status only; the operator never creates pods directly). */
export interface Pod extends KubeObject {
  spec?: V1PodSpec;
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    containerStatuses?: { name: string; state?: ContainerState }[];
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

/** core/v1 ConfigMap. */
export interface ConfigMap extends KubeObject {
  data?: Record<string, string>;
}

/** coordination.k8s.io/v1 Lease, used for leader election. */
export interface Lease extends KubeObject {
  spec?: {
    holderIdentity?: string;
    leaseDurationSeconds?: number;
    /** MicroTime: RFC 3339 with microseconds, e.g. 2026-10-24T12:00:00.000000Z. */
    acquireTime?: string;
    renewTime?: string;
    leaseTransitions?: number;
  };
}

/** core/v1 Event. */
export interface KubeEvent extends KubeObject {
  involvedObject: {
    apiVersion?: string;
    kind?: string;
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
  };
  reason: string;
  message: string;
  type: "Normal" | "Warning";
  source?: { component?: string; host?: string };
  firstTimestamp?: string;
  lastTimestamp?: string;
  count?: number;
  reportingComponent?: string;
  reportingInstance?: string;
}

/** The parts of a pod template the operator builds. */
export type PodTemplateSpec = V1PodTemplateSpec;

/** A CronJob spec, as the operator builds it. */
export type CronJobSpec = LibraryCronJobSpec;

/** A Job spec, as the operator builds it. */
export type JobSpec = V1JobSpec;
