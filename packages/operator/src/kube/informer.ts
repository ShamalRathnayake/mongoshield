/**
 * An informer: a local, always-up-to-date cache of one resource type, fed by the
 * Kubernetes list-then-watch protocol.
 *
 *   1. LIST the collection. The response carries a resourceVersion: the point in the
 *      object history the list describes.
 *   2. WATCH from that resourceVersion. Every change after it arrives as an event;
 *      each event's object carries a newer resourceVersion, which we remember.
 *   3. When the stream ends (the server closes watches every few minutes on purpose),
 *      WATCH again from the last version seen: nothing is missed and nothing is
 *      listed twice. BOOKMARK events advance the version on quiet collections.
 *   4. If the server answers 410 Gone, our version is older than the history it
 *      keeps (etcd compaction). Go back to 1: list again and diff against the cache,
 *      so deletions that happened while we were away are still reported.
 *
 * Errors (API server restarts, network blips) are retried with exponential backoff.
 * Controllers read from the cache instead of the API server, and are told about
 * every change through `onChange`.
 */

import type { Logger } from "../logger.ts";
import { abortableSleep } from "../util/sleep.ts";
import type { KubeClient, ResourceType, WatchEvent } from "./client.ts";
import type { KubeObject } from "./objects.ts";

/** What happened to an object. */
export type ChangeType = "add" | "update" | "delete";

/** Called for every change seen by the informer. */
export type ChangeHandler<T extends KubeObject> = (
  change: ChangeType,
  object: T,
  previous?: T,
) => void;

/** Options of an informer. */
export interface InformerOptions {
  readonly type: ResourceType;
  /** Namespaces to watch; undefined watches every namespace (needs cluster-wide RBAC). */
  readonly namespaces?: readonly string[] | undefined;
  /** Only objects with these labels, e.g. the ones this operator created. */
  readonly labelSelector?: string;
  readonly logger: Logger;
  /**
   * Server-side watch timeout range in seconds. Each watch picks a random value in
   * it, so many informers do not all reconnect at the same moment. Default 300–600.
   */
  readonly watchTimeoutSeconds?: readonly [min: number, max: number];
  /** Retry delays after errors: doubling from `initialMs` up to `maxMs`. */
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
}

/** The cache key of an object: "namespace/name". */
export function objectKey(object: KubeObject): string {
  return `${object.metadata.namespace ?? ""}/${object.metadata.name ?? ""}`;
}

/** A cache of one resource type, kept current by list + watch. */
export class Informer<T extends KubeObject> {
  readonly #client: KubeClient;
  readonly #options: InformerOptions;
  readonly #store = new Map<string, T>();
  readonly #handlers: ChangeHandler<T>[] = [];
  /** Namespaces (or "" for all) that have completed their first list. */
  readonly #synced = new Set<string>();
  #loops: Promise<void>[] = [];

  constructor(client: KubeClient, options: InformerOptions) {
    this.#client = client;
    this.#options = options;
  }

  /** The resource type this informer caches. */
  get type(): ResourceType {
    return this.#options.type;
  }

  /** Registers a change handler. Handlers registered before `start` see the initial list as adds. */
  onChange(handler: ChangeHandler<T>): void {
    this.#handlers.push(handler);
  }

  /** Starts listing and watching in the background until `signal` aborts. */
  start(signal: AbortSignal): void {
    const scopes = this.#options.namespaces ?? [undefined];
    this.#loops = scopes.map((namespace) => this.#run(namespace, signal));
  }

  /** Resolves once every list-watch loop has stopped (after the signal aborted). */
  async stopped(): Promise<void> {
    await Promise.all(this.#loops);
  }

  /** True once the first list of every watched namespace has been loaded. */
  hasSynced(): boolean {
    const scopes = this.#options.namespaces ?? [undefined];
    return scopes.every((namespace) => this.#synced.has(namespace ?? ""));
  }

  /** Resolves when `hasSynced()` becomes true (or the signal aborts). */
  async waitForSync(signal: AbortSignal, pollMs = 50): Promise<void> {
    while (!this.hasSynced() && !signal.aborted) await abortableSleep(pollMs, signal);
  }

  /** A cached object (a copy), or undefined. */
  get(namespace: string, name: string): T | undefined {
    const found = this.#store.get(`${namespace}/${name}`);
    return found ? structuredClone(found) : undefined;
  }

  /** Every cached object, optionally only in one namespace (copies). */
  list(namespace?: string): T[] {
    const result: T[] = [];
    for (const object of this.#store.values()) {
      if (namespace === undefined || object.metadata.namespace === namespace) {
        result.push(structuredClone(object));
      }
    }
    return result;
  }

  /** The list-watch loop for one namespace (or all of them). */
  async #run(namespace: string | undefined, signal: AbortSignal): Promise<void> {
    const { type, logger } = this.#options;
    const backoff = this.#options.backoff ?? { initialMs: 1000, maxMs: 30_000 };
    let resourceVersion = "";
    let failures = 0;

    while (!signal.aborted) {
      try {
        if (resourceVersion === "") {
          resourceVersion = await this.#relist(namespace);
          this.#synced.add(namespace ?? "");
        }
        const outcome = await this.#watchOnce(namespace, resourceVersion, signal);
        resourceVersion = outcome.resourceVersion;
        failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        const delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** (failures - 1));
        logger.warn("list/watch failed; retrying", {
          resource: type.plural,
          namespace: namespace ?? "*",
          retryInMs: delay,
          error: errorMessage(error),
        });
        await abortableSleep(delay, signal);
      }
    }
  }

  /**
   * Lists the collection and makes the cache match it: new objects are adds, changed
   * ones updates, and cached objects missing from the list deletes. Returns the
   * list's resourceVersion.
   */
  async #relist(namespace: string | undefined): Promise<string> {
    const { type, labelSelector } = this.#options;
    const listed = await this.#client.list<T>(
      type,
      namespace,
      labelSelector ? { labelSelector } : {},
    );
    const seen = new Set<string>();
    for (const object of listed.items) {
      seen.add(objectKey(object));
      this.#upsert(object);
    }
    for (const [key, cached] of [...this.#store]) {
      const inScope = namespace === undefined || cached.metadata.namespace === namespace;
      if (inScope && !seen.has(key)) this.#remove(cached);
    }
    return listed.resourceVersion;
  }

  /**
   * Watches until the stream ends. Returns the version to continue from: the last one
   * seen, or "" when the server said 410 Gone (the caller then lists again).
   */
  async #watchOnce(
    namespace: string | undefined,
    fromVersion: string,
    signal: AbortSignal,
  ): Promise<{ resourceVersion: string }> {
    const { type, labelSelector } = this.#options;
    const [min, max] = this.#options.watchTimeoutSeconds ?? [300, 600];
    const timeoutSeconds = Math.floor(min + Math.random() * (max - min + 1));
    // Our own controller, so a 410 can end this watch without stopping the informer.
    const watchController = new AbortController();
    const onStop = (): void => watchController.abort();
    signal.addEventListener("abort", onStop, { once: true });

    let resourceVersion = fromVersion;
    try {
      await this.#client.watch<T>(
        type,
        namespace,
        {
          resourceVersion: fromVersion,
          timeoutSeconds,
          signal: watchController.signal,
          ...(labelSelector ? { labelSelector } : {}),
        },
        (event: WatchEvent<T>) => {
          if (event.type === "ERROR") {
            // 410 Gone: our version was compacted away. Anything else: also relist,
            // the safe way to get back to a consistent cache.
            resourceVersion = "";
            watchController.abort();
            return;
          }
          resourceVersion = event.object.metadata.resourceVersion ?? resourceVersion;
          if (event.type === "BOOKMARK") return;
          if (event.type === "DELETED") this.#remove(event.object);
          else this.#upsert(event.object);
        },
      );
    } finally {
      signal.removeEventListener("abort", onStop);
    }
    return { resourceVersion };
  }

  #upsert(object: T): void {
    const key = objectKey(object);
    const previous = this.#store.get(key);
    // A relist returns objects we already have; same version means nothing changed.
    if (previous?.metadata.resourceVersion === object.metadata.resourceVersion) return;
    this.#store.set(key, object);
    this.#notify(previous ? "update" : "add", object, previous);
  }

  #remove(object: T): void {
    const key = objectKey(object);
    const previous = this.#store.get(key);
    if (!previous) return;
    this.#store.delete(key);
    this.#notify("delete", object, previous);
  }

  #notify(change: ChangeType, object: T, previous: T | undefined): void {
    for (const handler of this.#handlers) {
      try {
        handler(change, structuredClone(object), previous ? structuredClone(previous) : undefined);
      } catch (error) {
        // A failing handler must not break the cache for everyone else.
        this.#options.logger.error("informer change handler failed", {
          resource: this.#options.type.plural,
          error: errorMessage(error),
        });
      }
    }
  }
}

/** The message of an unknown error value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
