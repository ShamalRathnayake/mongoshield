/**
 * Kubernetes Events: the short history `kubectl describe` shows under an object.
 *
 *   Events:
 *     Type     Reason            From                  Message
 *     Normal   BackupStarted     mongoshield-operator  Started Job nightly-29330000
 *     Normal   BackupSucceeded   mongoshield-operator  Backup 2026-10-24T03-15-02Z_ab12cd: 1.2 GiB stored
 *
 * Like client-go's recorder, repeats of the same event (same object, reason and
 * message) within ten minutes increase the existing event's count instead of
 * creating new ones, so a retry loop cannot flood the namespace with events.
 * Recording never fails the caller: events are best-effort by design.
 */

import { randomBytes } from "node:crypto";
import { type KubeClient, RESOURCES } from "../kube/client.ts";
import { errorMessage } from "../kube/informer.ts";
import type { KubeEvent, KubeObject } from "../kube/objects.ts";
import type { Logger } from "../logger.ts";

/** "Normal" for progress, "Warning" for anything a human should look at. */
export type EventType = "Normal" | "Warning";

/** Records events about objects. */
export interface EventRecorder {
  record(object: KubeObject, type: EventType, reason: string, message: string): Promise<void>;
}

/** Repeats within this window are folded into one event with a count. */
const AGGREGATION_WINDOW_MS = 10 * 60_000;

/** The component name shown in the "From" column. */
export const EVENT_SOURCE = "mongoshield-operator";

/** Records events through the API (core/v1 Events). */
export class ApiEventRecorder implements EventRecorder {
  readonly #client: KubeClient;
  readonly #logger: Logger;
  readonly #instance: string;
  readonly #now: () => Date;
  /** Recent events: aggregation key → the event's name, its count, and when it last happened. */
  readonly #recent = new Map<string, { name: string; count: number; at: number }>();

  constructor(
    client: KubeClient,
    logger: Logger,
    instance: string,
    now: () => Date = () => new Date(),
  ) {
    this.#client = client;
    this.#logger = logger;
    this.#instance = instance;
    this.#now = now;
  }

  async record(
    object: KubeObject,
    type: EventType,
    reason: string,
    message: string,
  ): Promise<void> {
    const namespace = object.metadata.namespace ?? "default";
    const now = this.#now();
    const key = `${object.metadata.uid}|${type}|${reason}|${message}`;
    this.#forgetOld(now.getTime());

    try {
      const recent = this.#recent.get(key);
      if (recent) {
        recent.count += 1;
        recent.at = now.getTime();
        await this.#client.mergePatch(RESOURCES.events, namespace, recent.name, {
          count: recent.count,
          lastTimestamp: now.toISOString(),
        });
        return;
      }
      // Event names only need to be unique; kubectl sorts by time, not name.
      const name = `${object.metadata.name}.${now.getTime().toString(16)}${randomBytes(2).toString("hex")}`;
      const event: KubeEvent = {
        apiVersion: "v1",
        kind: "Event",
        metadata: { name, namespace },
        involvedObject: {
          apiVersion: object.apiVersion ?? "",
          kind: object.kind ?? "",
          name: object.metadata.name ?? "",
          namespace,
          uid: object.metadata.uid ?? "",
          ...(object.metadata.resourceVersion
            ? { resourceVersion: object.metadata.resourceVersion }
            : {}),
        },
        reason,
        message: message.slice(0, 1024),
        type,
        source: { component: EVENT_SOURCE },
        reportingComponent: EVENT_SOURCE,
        reportingInstance: this.#instance,
        firstTimestamp: now.toISOString(),
        lastTimestamp: now.toISOString(),
        count: 1,
      };
      await this.#client.create(RESOURCES.events, namespace, event);
      this.#recent.set(key, { name, count: 1, at: now.getTime() });
    } catch (error) {
      // Best-effort: a missing event is better than a failed reconcile.
      this.#logger.warn("could not record event", { reason, error: errorMessage(error) });
      this.#recent.delete(key);
    }
  }

  #forgetOld(nowMs: number): void {
    for (const [key, entry] of this.#recent) {
      if (nowMs - entry.at > AGGREGATION_WINDOW_MS) this.#recent.delete(key);
    }
  }
}
