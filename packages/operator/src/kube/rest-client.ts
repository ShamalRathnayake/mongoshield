/**
 * KubeClient for a real API server.
 *
 * Authentication and TLS come from @kubernetes/client-node's KubeConfig (in-cluster
 * service account token, or ~/.kube/config with every auth plugin it supports). The
 * requests themselves are plain JSON over undici's fetch, the same HTTP client the
 * library uses, because the operator needs a few things its typed API classes do not
 * offer together: merge patches on the status subresource, watches with our own
 * timeouts, and raw JSON (RFC 3339 strings rather than Date objects).
 */

import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { type HttpMethod, type KubeConfig, RequestContext } from "@kubernetes/client-node";
import { fetch } from "undici";
import {
  KubeApiError,
  type KubeClient,
  type ListOptions,
  type ObjectList,
  type PodLogOptions,
  type PropagationPolicy,
  type ResourceType,
  type WatchEvent,
  type WatchOptions,
} from "./client.ts";
import type { KubeObject } from "./objects.ts";

/**
 * Extra time the client allows beyond the server-side watch timeout before giving up
 * on the stream itself: the server should have closed it by then, and a half-open TCP
 * connection (a node that vanished) would otherwise never end on its own.
 */
const WATCH_INACTIVITY_GRACE_MS = 30_000;

/** Ordinary requests that take longer than this are abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Builds the URL path of a collection or object. */
export function resourcePath(
  type: ResourceType,
  namespace: string | undefined,
  name?: string,
  subresource?: string,
): string {
  const root = type.group === "" ? `/api/${type.version}` : `/apis/${type.group}/${type.version}`;
  const scope = namespace === undefined ? "" : `/namespaces/${encodeURIComponent(namespace)}`;
  const object = name === undefined ? "" : `/${encodeURIComponent(name)}`;
  const sub = subresource === undefined ? "" : `/${subresource}`;
  return `${root}${scope}/${type.plural}${object}${sub}`;
}

/** Talks to the API server described by a KubeConfig. */
export class RestKubeClient implements KubeClient {
  readonly #config: KubeConfig;
  readonly #server: string;

  constructor(config: KubeConfig) {
    const cluster = config.getCurrentCluster();
    if (!cluster) throw new Error("The kubeconfig has no current cluster.");
    this.#config = config;
    this.#server = cluster.server.replace(/\/+$/, "");
  }

  async get<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
  ): Promise<T | undefined> {
    try {
      return await this.#json<T>("GET", resourcePath(type, namespace, name));
    } catch (error) {
      if (error instanceof KubeApiError && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async list<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options: ListOptions = {},
  ): Promise<ObjectList<T>> {
    const query = new URLSearchParams();
    if (options.labelSelector) query.set("labelSelector", options.labelSelector);
    const items: T[] = [];
    let resourceVersion = "";
    let continueToken: string | undefined;
    // Page through large collections (500 at a time) instead of one huge response.
    do {
      query.set("limit", "500");
      if (continueToken) query.set("continue", continueToken);
      const page = await this.#json<{
        items?: T[];
        metadata?: { resourceVersion?: string; continue?: string };
      }>("GET", `${resourcePath(type, namespace)}?${query}`);
      // List responses leave apiVersion/kind off their items; put them back so the
      // objects look the same as ones from get and watch.
      for (const item of page.items ?? []) items.push(withTypeMeta(item, type));
      resourceVersion = page.metadata?.resourceVersion ?? resourceVersion;
      continueToken = page.metadata?.continue || undefined;
    } while (continueToken);
    return { items, resourceVersion };
  }

  create<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T> {
    return this.#json<T>("POST", resourcePath(type, namespace), body);
  }

  replace<T extends KubeObject>(type: ResourceType, namespace: string, body: T): Promise<T> {
    const name = body.metadata.name ?? "";
    return this.#json<T>("PUT", resourcePath(type, namespace, name), body);
  }

  mergePatch<T extends KubeObject>(
    type: ResourceType,
    namespace: string,
    name: string,
    patch: unknown,
    subresource?: "status",
  ): Promise<T> {
    return this.#json<T>(
      "PATCH",
      resourcePath(type, namespace, name, subresource),
      patch,
      "application/merge-patch+json",
    );
  }

  async delete(
    type: ResourceType,
    namespace: string,
    name: string,
    propagationPolicy: PropagationPolicy = "Background",
  ): Promise<void> {
    try {
      await this.#json("DELETE", resourcePath(type, namespace, name), {
        apiVersion: "v1",
        kind: "DeleteOptions",
        propagationPolicy,
      });
    } catch (error) {
      if (error instanceof KubeApiError && error.statusCode === 404) return;
      throw error;
    }
  }

  async watch<T extends KubeObject>(
    type: ResourceType,
    namespace: string | undefined,
    options: WatchOptions,
    onEvent: (event: WatchEvent<T>) => void,
  ): Promise<void> {
    const query = new URLSearchParams({
      watch: "true",
      resourceVersion: options.resourceVersion,
      // Bookmarks keep our resourceVersion fresh on quiet collections, so a reconnect
      // rarely needs a full relist.
      allowWatchBookmarks: "true",
    });
    if (options.labelSelector) query.set("labelSelector", options.labelSelector);
    const timeoutSeconds = options.timeoutSeconds ?? 300;
    query.set("timeoutSeconds", String(timeoutSeconds));

    // Our own abort: fires on the caller's signal, or when the stream outlives the
    // server-side timeout by the grace period (a dead connection).
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    options.signal.addEventListener("abort", onCallerAbort, { once: true });
    const inactivity = setTimeout(
      () => controller.abort(new Error("watch stream outlived its timeout")),
      timeoutSeconds * 1000 + WATCH_INACTIVITY_GRACE_MS,
    );

    try {
      const url = `${this.#server}${resourcePath(type, namespace)}?${query}`;
      const response = await this.#send("GET", url, undefined, undefined, controller.signal);
      if (!response.body) return;
      const lines = createInterface({ input: Readable.fromWeb(response.body) });
      for await (const line of lines) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as WatchEvent<T>;
        if (event.type !== "BOOKMARK" && event.type !== "ERROR") {
          onEvent({ type: event.type, object: withTypeMeta(event.object, type) });
        } else {
          onEvent(event);
        }
      }
    } catch (error) {
      // Aborting on purpose ends the watch quietly; anything else is a real error.
      if (options.signal.aborted) return;
      throw error;
    } finally {
      clearTimeout(inactivity);
      options.signal.removeEventListener("abort", onCallerAbort);
    }
  }

  async podLogs(namespace: string, pod: string, options: PodLogOptions): Promise<string> {
    const query = new URLSearchParams({
      container: options.container,
      tailLines: String(options.tailLines),
      limitBytes: String(options.limitBytes),
    });
    const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${query}`;
    const response = await this.#send("GET", `${this.#server}${path}`);
    return response.text();
  }

  /** Sends a request and parses the JSON response. */
  async #json<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    contentType?: string,
  ): Promise<T> {
    const response = await this.#send(method, `${this.#server}${path}`, body, contentType);
    return (await response.json()) as T;
  }

  /** Sends an authenticated request; throws KubeApiError for non-2xx responses. */
  async #send(
    method: HttpMethod,
    url: string,
    body?: unknown,
    contentType = "application/json",
    signal: AbortSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  ) {
    // client-node fills in the Authorization header (token, exec plugin, OIDC, …)
    // and the TLS settings (cluster CA, client certificates) as an undici dispatcher.
    const context = new RequestContext(url, method);
    await this.#config.applySecurityAuthentication(context);
    const headers: Record<string, string> = { ...context.getHeaders(), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = contentType;

    const dispatcher = context.getDispatcher();
    const response = await fetch(url, {
      method,
      headers,
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (response.ok) return response;
    throw toApiError(response.status, await response.text());
  }
}

/** Turns an error response (normally a Status object) into a KubeApiError. */
function toApiError(statusCode: number, text: string): KubeApiError {
  let reason = "Unknown";
  let message = text.slice(0, 500) || `HTTP ${statusCode}`;
  try {
    const status = JSON.parse(text) as { reason?: string; message?: string };
    reason = status.reason ?? reason;
    message = status.message ?? message;
  } catch {
    // Not JSON (a proxy's HTML error page, say): keep the raw text.
  }
  return new KubeApiError(statusCode, reason, message);
}

/** Fills in apiVersion and kind, which list responses omit from their items. */
function withTypeMeta<T extends KubeObject>(object: T, type: ResourceType): T {
  return {
    ...object,
    apiVersion: type.group === "" ? type.version : `${type.group}/${type.version}`,
    kind: type.kind,
  };
}
