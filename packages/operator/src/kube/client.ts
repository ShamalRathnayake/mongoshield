/**
 * The operator's view of the Kubernetes API: a small interface with only the calls
 * the controllers make.
 *
 * Two implementations exist:
 *   - rest-client.ts talks to a real API server (via @kubernetes/client-node's auth),
 *   - test/helpers/fake-client.ts keeps objects in memory for unit tests, with the
 *     API server behaviours the reconcilers depend on (resourceVersion conflicts,
 *     generation, finalizers, the status subresource, watches).
 *
 * Keeping the surface this small is what makes the fake trustworthy: every method
 * here is one well-defined REST call.
 */

import { API_GROUP, API_VERSION } from "../api/constants.ts";
import type { KubeObject } from "./objects.ts";

/** Identifies a kind of resource and how to reach it over REST. */
export interface ResourceType {
  /** API group; "" for the core group (pods, configmaps, events). */
  readonly group: string;
  readonly version: string;
  readonly kind: string;
  /** The lowercase plural used in URLs, e.g. "jobs". */
  readonly plural: string;
}

/** Every resource type the operator touches. All are namespaced. */
export const RESOURCES = {
  plans: {
    group: API_GROUP,
    version: API_VERSION,
    kind: "MongoShieldBackupPlan",
    plural: "mongoshieldbackupplans",
  },
  backups: {
    group: API_GROUP,
    version: API_VERSION,
    kind: "MongoShieldBackup",
    plural: "mongoshieldbackups",
  },
  restores: {
    group: API_GROUP,
    version: API_VERSION,
    kind: "MongoShieldRestore",
    plural: "mongoshieldrestores",
  },
  drills: {
    group: API_GROUP,
    version: API_VERSION,
    kind: "MongoShieldDrill",
    plural: "mongoshielddrills",
  },
  jobs: { group: "batch", version: "v1", kind: "Job", plural: "jobs" },
  cronJobs: { group: "batch", version: "v1", kind: "CronJob", plural: "cronjobs" },
  pods: { group: "", version: "v1", kind: "Pod", plural: "pods" },
  configMaps: { group: "", version: "v1", kind: "ConfigMap", plural: "configmaps" },
  events: { group: "", version: "v1", kind: "Event", plural: "events" },
  leases: { group: "coordination.k8s.io", version: "v1", kind: "Lease", plural: "leases" },
} as const satisfies Record<string, ResourceType>;

/** `apiVersion` of a resource type: "v1" for core, "group/version" otherwise. */
export function apiVersionOf(type: ResourceType): string {
  return type.group === "" ? type.version : `${type.group}/${type.version}`;
}

/** Options of a list call. */
export interface ListOptions {
  /** Equality-based label selector, e.g. `app.kubernetes.io/managed-by=mongoshield-operator`. */
  readonly labelSelector?: string;
}

/** A page of objects plus the collection's resourceVersion (where a watch should start). */
export interface ObjectList<T extends KubeObject> {
  readonly items: T[];
  readonly resourceVersion: string;
}

/** One event from a watch stream. */
export type WatchEvent<T extends KubeObject> =
  | { readonly type: "ADDED" | "MODIFIED" | "DELETED"; readonly object: T }
  /** Carries only a newer resourceVersion: "nothing changed up to here". */
  | { readonly type: "BOOKMARK"; readonly object: KubeObject }
  /** A Status object; code 410 means "your resourceVersion is too old, list again". */
  | {
      readonly type: "ERROR";
      readonly object: { readonly code?: number; readonly message?: string };
    };

/** Options of a watch call. */
export interface WatchOptions extends ListOptions {
  /** Only events after this version. */
  readonly resourceVersion: string;
  /** Ask the server to close the stream after this long (it is then simply reopened). */
  readonly timeoutSeconds?: number;
  readonly signal: AbortSignal;
}

/** Which part of a container log to read. */
export interface PodLogOptions {
  readonly container: string;
  readonly tailLines: number;
  readonly limitBytes: number;
}

/** How dependents are deleted along with an object. */
export type PropagationPolicy = "Foreground" | "Background" | "Orphan";

/** The calls the operator makes. Namespaced resources only. */
export interface KubeClient {
  /** Returns the object, or `undefined` when it does not exist. */
  get<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
  ): Promise<T | undefined>;
  /** Lists objects in one namespace, or in every namespace when `namespace` is undefined. */
  list<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options?: ListOptions,
  ): Promise<ObjectList<T>>;
  /** Creates an object. Throws a 409 AlreadyExists error when the name is taken. */
  create<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T>;
  /**
   * Replaces an object (PUT). Its `metadata.resourceVersion` must be the current one,
   * or the call fails with 409 Conflict: optimistic concurrency.
   */
  replace<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T>;
  /**
   * Applies a JSON merge patch (RFC 7386). With `subresource: "status"` only the
   * status is changed (and only the status may be). Include
   * `metadata.resourceVersion` in the patch to make it conditional.
   */
  mergePatch<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
    patch: unknown,
    subresource?: "status",
  ): Promise<T>;
  /** Deletes an object. Resolves quietly when it is already gone. */
  delete(
    type: ResourceType,
    namespace: string,
    name: string,
    propagationPolicy?: PropagationPolicy,
  ): Promise<void>;
  /**
   * Streams changes until the server closes the stream or `signal` aborts; resolves
   * then. Rejects on connection errors.
   */
  watch<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options: WatchOptions,
    onEvent: (event: WatchEvent<T>) => void,
  ): Promise<void>;
  /**
   * The end of a container's log (stdout and stderr interleaved, as `kubectl logs`
   * shows it): the last `tailLines` lines, of which at most `limitBytes` bytes.
   */
  podLogs(namespace: string, pod: string, options: PodLogOptions): Promise<string>;
}

/** An error response from the API server. */
export class KubeApiError extends Error {
  override readonly name = "KubeApiError";

  constructor(
    /** HTTP status: 404 not found, 409 conflict/already exists, 410 gone, 422 invalid, … */
    readonly statusCode: number,
    /** The Status `reason`: NotFound, AlreadyExists, Conflict, Invalid, Forbidden, … */
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** True for "the object does not exist". */
export function isNotFound(error: unknown): boolean {
  return error instanceof KubeApiError && error.statusCode === 404;
}

/** True for "someone else wrote the object since you read it" (or "name already taken"). */
export function isConflict(error: unknown): boolean {
  return error instanceof KubeApiError && error.statusCode === 409;
}

/** True when the name is taken (a 409 with reason AlreadyExists). */
export function isAlreadyExists(error: unknown): boolean {
  return isConflict(error) && (error as KubeApiError).reason === "AlreadyExists";
}
