/**
 * An in-memory KubeClient for unit tests.
 *
 * It behaves like the API server in the ways the operator depends on:
 *
 *   - every write bumps a global resourceVersion; a replace or a patch that carries a
 *     stale resourceVersion fails with 409 Conflict (optimistic concurrency),
 *   - `metadata.generation` increases only when the spec (anything outside metadata
 *     and status) changes,
 *   - kinds with a status subresource ignore `status` on create/replace/patch, and
 *     the status endpoint changes nothing but `status`,
 *   - deleting an object with finalizers only sets `deletionTimestamp`; it is removed
 *     once the last finalizer is,
 *   - deleting an owner deletes its dependents (garbage collection by ownerReference),
 *   - watches replay events after a resourceVersion and then stream live ones; a
 *     version older than the retained history gets a 410 Gone ERROR event.
 *
 * Tests can also make the next call of a given verb fail (`failNext`) and inspect
 * what was called (`calls`).
 */

import type {
  KubeClient,
  ListOptions,
  ObjectList,
  PodLogOptions,
  PropagationPolicy,
  ResourceType,
  WatchEvent,
  WatchOptions,
} from "../../src/kube/client.ts";
import { KubeApiError } from "../../src/kube/client.ts";
import type { KubeObject } from "../../src/kube/objects.ts";
import { matchesSelector } from "../../src/kube/selectors.ts";

/** Kinds whose `status` is a subresource (written only through /status). */
const STATUS_SUBRESOURCE_KINDS = new Set([
  "MongoShieldBackupPlan",
  "MongoShieldBackup",
  "MongoShieldRestore",
  "MongoShieldDrill",
  "Job",
  "CronJob",
  "Pod",
]);

/** The verbs `failNext` can target. */
export type Verb = "get" | "list" | "create" | "replace" | "patch" | "delete" | "watch" | "logs";

/** One recorded call. */
export interface RecordedCall {
  readonly verb: Verb;
  readonly plural: string;
  readonly namespace?: string;
  readonly name?: string;
  readonly subresource?: string;
}

interface StoredEvent {
  readonly resourceVersion: number;
  readonly plural: string;
  readonly namespace: string;
  readonly event: WatchEvent<KubeObject>;
}

interface Watcher {
  readonly plural: string;
  readonly namespace: string | undefined;
  readonly labelSelector: string | undefined;
  readonly onEvent: (event: WatchEvent<KubeObject>) => void;
  readonly close: () => void;
}

/** A deep copy, so callers can never mutate stored objects by accident. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** RFC 7386 JSON merge patch: objects merge, `null` deletes, everything else replaces. */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const base: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/** Everything except metadata and status: what bumps `generation` when it changes. */
function specPart(object: KubeObject): string {
  const {
    metadata: _metadata,
    status: _status,
    ...rest
  } = object as KubeObject & {
    status?: unknown;
  };
  return JSON.stringify(rest);
}

export class FakeKubeClient implements KubeClient {
  /** plural → "namespace/name" → object */
  readonly #objects = new Map<string, Map<string, KubeObject>>();
  readonly #events: StoredEvent[] = [];
  readonly #watchers = new Set<Watcher>();
  readonly #failures: { verb: Verb; plural?: string; error: Error }[] = [];
  readonly #logs = new Map<string, string>();
  #resourceVersion = 100;
  #uid = 0;
  /** Events at or below this version were "compacted": watching from there gets 410. */
  #compactedThrough = 0;

  /** Every call made, in order. */
  readonly calls: RecordedCall[] = [];

  /** The clock used for timestamps; tests may replace it. */
  now: () => Date = () => new Date();

  // -------------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------------

  /** Makes the next matching call throw `error`. */
  failNext(verb: Verb, error: Error, plural?: string): void {
    this.#failures.push({ verb, error, ...(plural === undefined ? {} : { plural }) });
  }

  /** All stored objects of a type (copies). */
  objects<T extends KubeObject>(type: ResourceType, namespace?: string): T[] {
    const all = [...(this.#objects.get(type.plural)?.values() ?? [])];
    return all
      .filter((object) => namespace === undefined || object.metadata.namespace === namespace)
      .map((object) => clone(object) as T);
  }

  /** One stored object (a copy), or undefined. */
  object<T extends KubeObject>(type: ResourceType, namespace: string, name: string): T | undefined {
    const found = this.#bucket(type).get(`${namespace}/${name}`);
    return found ? (clone(found) as T) : undefined;
  }

  /**
   * Writes an object as a controller other than ours would (the Job controller
   * setting a Job's status, the kubelet a pod's): no conflict checks, status kept.
   */
  setObject<T extends KubeObject>(type: ResourceType, object: T): T {
    const namespace = object.metadata.namespace ?? "default";
    const key = `${namespace}/${object.metadata.name}`;
    const existing = this.#bucket(type).get(key);
    const stored = clone(object) as KubeObject;
    stored.apiVersion = type.group === "" ? type.version : `${type.group}/${type.version}`;
    stored.kind = type.kind;
    stored.metadata = {
      ...stored.metadata,
      namespace,
      uid: existing?.metadata.uid ?? stored.metadata.uid ?? this.#nextUid(),
      creationTimestamp:
        existing?.metadata.creationTimestamp ??
        stored.metadata.creationTimestamp ??
        this.now().toISOString(),
      generation: stored.metadata.generation ?? existing?.metadata.generation ?? 1,
      resourceVersion: this.#nextVersion(),
    };
    this.#bucket(type).set(key, stored);
    this.#emit(type, namespace, { type: existing ? "MODIFIED" : "ADDED", object: stored });
    return clone(stored) as T;
  }

  /** Sets the log text `podLogs` returns for a pod. */
  setPodLogs(namespace: string, pod: string, text: string): void {
    this.#logs.set(`${namespace}/${pod}`, text);
  }

  /** Forgets all events so far: watches from older versions now get 410 Gone. */
  compactHistory(): void {
    this.#compactedThrough = this.#resourceVersion;
    this.#events.length = 0;
  }

  /** Ends every open watch, as the API server does when its timeout passes. */
  closeWatches(): void {
    for (const watcher of [...this.#watchers]) watcher.close();
  }

  /** How many watches are open right now. */
  get openWatches(): number {
    return this.#watchers.size;
  }

  // -------------------------------------------------------------------------
  // KubeClient
  // -------------------------------------------------------------------------

  async get<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
  ): Promise<T | undefined> {
    this.#record({ verb: "get", plural: type.plural, namespace, name });
    this.#maybeFail("get", type);
    return this.object<T>(type, namespace, name);
  }

  async list<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options: ListOptions = {},
  ): Promise<ObjectList<T>> {
    this.#record({ verb: "list", plural: type.plural, ...(namespace ? { namespace } : {}) });
    this.#maybeFail("list", type);
    const items = this.objects<T>(type, namespace).filter((object) =>
      matchesSelector(object.metadata.labels, options.labelSelector),
    );
    return { items, resourceVersion: String(this.#resourceVersion) };
  }

  async create<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T> {
    const name = body.metadata.name ?? "";
    this.#record({ verb: "create", plural: type.plural, namespace, name });
    this.#maybeFail("create", type);
    if (name === "") throw new KubeApiError(422, "Invalid", "metadata.name is required");
    const key = `${namespace}/${name}`;
    if (this.#bucket(type).has(key)) {
      throw new KubeApiError(409, "AlreadyExists", `${type.plural} "${name}" already exists`);
    }
    const stored = clone(body) as KubeObject & { status?: unknown };
    if (STATUS_SUBRESOURCE_KINDS.has(type.kind)) delete stored.status;
    stored.apiVersion = type.group === "" ? type.version : `${type.group}/${type.version}`;
    stored.kind = type.kind;
    stored.metadata = {
      ...stored.metadata,
      namespace,
      uid: this.#nextUid(),
      generation: 1,
      creationTimestamp: this.now().toISOString(),
      resourceVersion: this.#nextVersion(),
    };
    this.#bucket(type).set(key, stored);
    this.#emit(type, namespace, { type: "ADDED", object: stored });
    return clone(stored) as T;
  }

  async replace<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T> {
    const name = body.metadata.name ?? "";
    this.#record({ verb: "replace", plural: type.plural, namespace, name });
    this.#maybeFail("replace", type);
    const existing = this.#existing(type, namespace, name);
    this.#checkVersion(existing, body.metadata.resourceVersion, type, name);
    const next = clone(body) as KubeObject & { status?: unknown };
    if (STATUS_SUBRESOURCE_KINDS.has(type.kind)) {
      next.status = (existing as KubeObject & { status?: unknown }).status;
    }
    return clone(this.#commit(type, namespace, existing, next)) as T;
  }

  async mergePatch<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
    patch: unknown,
    subresource?: "status",
  ): Promise<T> {
    this.#record({
      verb: "patch",
      plural: type.plural,
      namespace,
      name,
      ...(subresource ? { subresource } : {}),
    });
    this.#maybeFail("patch", type);
    const existing = this.#existing(type, namespace, name);
    const patchVersion = (patch as { metadata?: { resourceVersion?: string } }).metadata
      ?.resourceVersion;
    this.#checkVersion(existing, patchVersion, type, name);

    let next: KubeObject & { status?: unknown };
    if (subresource === "status") {
      // The status endpoint changes the status and nothing else.
      const patched = applyMergePatch(existing, {
        status: (patch as { status?: unknown }).status,
      }) as KubeObject & { status?: unknown };
      next = { ...clone(existing), status: patched.status };
    } else {
      next = applyMergePatch(existing, patch) as KubeObject & { status?: unknown };
      if (STATUS_SUBRESOURCE_KINDS.has(type.kind)) {
        next.status = (existing as KubeObject & { status?: unknown }).status;
      }
    }
    return clone(this.#commit(type, namespace, existing, next)) as T;
  }

  async delete(
    type: ResourceType,
    namespace: string,
    name: string,
    _propagationPolicy?: PropagationPolicy,
  ): Promise<void> {
    this.#record({ verb: "delete", plural: type.plural, namespace, name });
    this.#maybeFail("delete", type);
    const existing = this.#bucket(type).get(`${namespace}/${name}`);
    if (!existing) return;
    this.#deleteObject(type, namespace, existing);
  }

  watch<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options: WatchOptions,
    onEvent: (event: WatchEvent<T>) => void,
  ): Promise<void> {
    this.#record({ verb: "watch", plural: type.plural, ...(namespace ? { namespace } : {}) });
    try {
      this.#maybeFail("watch", type);
    } catch (error) {
      return Promise.reject(error);
    }
    const deliver = onEvent as (event: WatchEvent<KubeObject>) => void;
    const from = Number(options.resourceVersion);

    // Too old: the server no longer has that history.
    if (from < this.#compactedThrough) {
      deliver({ type: "ERROR", object: { code: 410, message: "too old resource version" } });
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const watcher: Watcher = {
        plural: type.plural,
        namespace,
        labelSelector: options.labelSelector,
        onEvent: deliver,
        close: () => {
          this.#watchers.delete(watcher);
          resolve();
        },
      };
      // Replay what happened after `from`, then stream live events.
      for (const stored of this.#events) {
        if (stored.resourceVersion > from && this.#watcherWants(watcher, stored)) {
          deliver(clone(stored.event));
        }
      }
      this.#watchers.add(watcher);
      if (options.signal.aborted) watcher.close();
      options.signal.addEventListener("abort", () => watcher.close(), { once: true });
    });
  }

  async podLogs(namespace: string, pod: string, options: PodLogOptions): Promise<string> {
    this.#record({ verb: "logs", plural: "pods", namespace, name: pod });
    this.#maybeFail("logs", { group: "", version: "v1", kind: "Pod", plural: "pods" });
    const text = this.#logs.get(`${namespace}/${pod}`);
    if (text === undefined) throw new KubeApiError(404, "NotFound", `pods "${pod}" not found`);
    // Like the real endpoint: the last tailLines lines, then at most limitBytes of them.
    const tail = text
      .split("\n")
      .slice(-options.tailLines - 1)
      .join("\n");
    return tail.slice(0, options.limitBytes);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #bucket(type: ResourceType): Map<string, KubeObject> {
    let bucket = this.#objects.get(type.plural);
    if (!bucket) {
      bucket = new Map();
      this.#objects.set(type.plural, bucket);
    }
    return bucket;
  }

  #existing(type: ResourceType, namespace: string, name: string): KubeObject {
    const existing = this.#bucket(type).get(`${namespace}/${name}`);
    if (!existing) throw new KubeApiError(404, "NotFound", `${type.plural} "${name}" not found`);
    return existing;
  }

  #checkVersion(
    existing: KubeObject,
    version: string | undefined,
    type: ResourceType,
    name: string,
  ): void {
    if (version !== undefined && version !== existing.metadata.resourceVersion) {
      throw new KubeApiError(
        409,
        "Conflict",
        `Operation cannot be fulfilled on ${type.plural} "${name}": the object has been modified`,
      );
    }
  }

  /** Stores an updated object: version, generation, finalizer-driven removal, event. */
  #commit(
    type: ResourceType,
    namespace: string,
    existing: KubeObject,
    next: KubeObject,
  ): KubeObject {
    // Identity fields cannot be changed by writes.
    next.metadata = {
      ...next.metadata,
      name: existing.metadata.name ?? "",
      namespace,
      uid: existing.metadata.uid ?? "",
      creationTimestamp: existing.metadata.creationTimestamp ?? "",
      generation:
        specPart(next) === specPart(existing)
          ? (existing.metadata.generation ?? 1)
          : (existing.metadata.generation ?? 1) + 1,
      resourceVersion: this.#nextVersion(),
      ...(existing.metadata.deletionTimestamp
        ? { deletionTimestamp: existing.metadata.deletionTimestamp }
        : {}),
    };
    if (next.metadata.deletionTimestamp && (next.metadata.finalizers ?? []).length === 0) {
      // The last finalizer is gone: the deletion that was waiting now happens.
      this.#remove(type, namespace, next);
      return next;
    }
    this.#bucket(type).set(`${namespace}/${next.metadata.name}`, next);
    this.#emit(type, namespace, { type: "MODIFIED", object: next });
    return next;
  }

  #deleteObject(type: ResourceType, namespace: string, existing: KubeObject): void {
    if ((existing.metadata.finalizers ?? []).length > 0) {
      if (existing.metadata.deletionTimestamp) return;
      const marked = clone(existing);
      marked.metadata.deletionTimestamp = this.now().toISOString();
      marked.metadata.resourceVersion = this.#nextVersion();
      this.#bucket(type).set(`${namespace}/${existing.metadata.name}`, marked);
      this.#emit(type, namespace, { type: "MODIFIED", object: marked });
      return;
    }
    this.#remove(type, namespace, existing);
  }

  /** Removes an object for good, then garbage-collects its dependents. */
  #remove(type: ResourceType, namespace: string, object: KubeObject): void {
    this.#bucket(type).delete(`${namespace}/${object.metadata.name}`);
    const removed = clone(object);
    removed.metadata.resourceVersion = this.#nextVersion();
    this.#emit(type, namespace, { type: "DELETED", object: removed });

    const uid = object.metadata.uid;
    for (const [plural, bucket] of this.#objects) {
      for (const dependent of [...bucket.values()]) {
        const owned = (dependent.metadata.ownerReferences ?? []).some((ref) => ref.uid === uid);
        if (!owned || dependent.metadata.namespace !== namespace) continue;
        const dependentType: ResourceType = {
          group: "",
          version: "",
          kind: dependent.kind ?? "",
          plural,
        };
        this.#deleteObject(dependentType, namespace, dependent);
      }
    }
  }

  #emit(type: ResourceType, namespace: string, event: WatchEvent<KubeObject>): void {
    const stored: StoredEvent = {
      resourceVersion: this.#resourceVersion,
      plural: type.plural,
      namespace,
      event: clone(event),
    };
    this.#events.push(stored);
    for (const watcher of [...this.#watchers]) {
      if (this.#watcherWants(watcher, stored)) watcher.onEvent(clone(stored.event));
    }
  }

  #watcherWants(watcher: Watcher, stored: StoredEvent): boolean {
    if (watcher.plural !== stored.plural) return false;
    if (watcher.namespace !== undefined && watcher.namespace !== stored.namespace) return false;
    const object = stored.event.object as KubeObject;
    return matchesSelector(object.metadata?.labels, watcher.labelSelector);
  }

  #nextVersion(): string {
    this.#resourceVersion += 1;
    return String(this.#resourceVersion);
  }

  #nextUid(): string {
    this.#uid += 1;
    return `uid-${this.#uid}`;
  }

  #record(call: RecordedCall): void {
    this.calls.push(call);
  }

  #maybeFail(verb: Verb, type: ResourceType): void {
    const index = this.#failures.findIndex(
      (failure) =>
        failure.verb === verb && (failure.plural === undefined || failure.plural === type.plural),
    );
    if (index === -1) return;
    const [failure] = this.#failures.splice(index, 1);
    if (failure) throw failure.error;
  }
}
