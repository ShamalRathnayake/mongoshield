/**
 * Leader election with a coordination.k8s.io/v1 Lease, the same protocol client-go
 * and controller-runtime use.
 *
 * Several operator replicas may run (for fast failover), but only one may reconcile:
 * two leaders would both create Jobs for the same backup. The replicas compete for a
 * Lease object:
 *
 *   - The holder writes its identity and a fresh `renewTime` every `retryPeriod`.
 *   - Others poll. If the Lease has not changed for `leaseDuration`, the holder is
 *     presumed dead and the first replica to update the Lease takes over. The update
 *     carries the resourceVersion it read, so when two replicas try at once, the API
 *     server lets exactly one of them win (the other gets 409 Conflict).
 *   - "Has not changed" is judged by this replica's own clock — when it last saw the
 *     Lease change — never by comparing `renewTime` with the local time, so clock
 *     skew between nodes cannot cause two leaders.
 *   - A leader that cannot renew within `renewDeadline` (shorter than leaseDuration)
 *     must stop leading before anyone else could take over. The operator then exits
 *     and is restarted, which is simpler and safer than trying to wind down in place.
 *   - On graceful shutdown the leader releases the Lease, so a standby takes over in
 *     about one retry period instead of waiting out the lease.
 */

import { isAlreadyExists, isConflict, type KubeClient, RESOURCES } from "../kube/client.ts";
import { errorMessage } from "../kube/informer.ts";
import type { Lease } from "../kube/objects.ts";
import type { Logger } from "../logger.ts";
import { abortableSleep } from "../util/sleep.ts";

export interface LeaderElectionOptions {
  readonly client: KubeClient;
  /** Namespace of the Lease (the operator's own namespace). */
  readonly namespace: string;
  /** Name of the Lease. */
  readonly name: string;
  /** This replica's identity, normally its pod name. */
  readonly identity: string;
  readonly logger: Logger;
  /** How long a Lease stays valid without renewal. Default 15 s (client-go's default). */
  readonly leaseDurationMs?: number;
  /** How long the leader keeps trying to renew before giving up. Default 10 s. */
  readonly renewDeadlineMs?: number;
  /** How often to try to acquire or renew. Default 2 s. */
  readonly retryPeriodMs?: number;
  readonly now?: () => Date;
}

/** What the elector calls when leadership changes. */
export interface LeaderCallbacks {
  /** Became leader. `leading` aborts when leadership ends (lost or released). */
  onStartedLeading(leading: AbortSignal): void;
  /** Leadership ended: lost (failed to renew) or released on shutdown. */
  onStoppedLeading(reason: "lost" | "released"): void;
}

/** Formats a Date as a Kubernetes MicroTime: RFC 3339 with six fractional digits. */
export function microTime(date: Date): string {
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

export class LeaderElector {
  readonly #options: Required<Omit<LeaderElectionOptions, "now">> & { now: () => Date };
  #leader = false;
  /** The Lease as last seen, and when (local clock) it last changed. */
  #observed: { record: string; atMs: number } | undefined;

  constructor(options: LeaderElectionOptions) {
    this.#options = {
      leaseDurationMs: 15_000,
      renewDeadlineMs: 10_000,
      retryPeriodMs: 2_000,
      now: () => new Date(),
      ...options,
    };
  }

  /** True while this replica holds the Lease. */
  isLeader(): boolean {
    return this.#leader;
  }

  /**
   * Competes for the Lease until `signal` aborts or leadership is lost. Resolves when
   * this replica will never lead again (the caller should then exit or shut down).
   */
  async run(signal: AbortSignal, callbacks: LeaderCallbacks): Promise<void> {
    const { logger, identity, retryPeriodMs } = this.#options;

    // Phase 1: acquire.
    while (!signal.aborted) {
      if (await this.#tryAcquireOrRenew()) break;
      await abortableSleep(retryPeriodMs, signal);
    }
    if (signal.aborted) return;

    this.#leader = true;
    logger.info("became leader", { lease: this.#options.name, identity });
    const leading = new AbortController();
    callbacks.onStartedLeading(leading.signal);

    // Phase 2: renew until shut down or until renewing fails for too long.
    const outcome = await this.#renewLoop(signal);
    this.#leader = false;
    leading.abort();
    if (outcome === "released") await this.#release();
    logger.info(outcome === "lost" ? "lost leadership" : "released leadership", { identity });
    callbacks.onStoppedLeading(outcome);
  }

  /** Renews every retry period; "lost" when no renewal succeeded within the deadline. */
  async #renewLoop(signal: AbortSignal): Promise<"lost" | "released"> {
    const { retryPeriodMs, renewDeadlineMs } = this.#options;
    let lastRenewMs = this.#options.now().getTime();
    while (!signal.aborted) {
      await abortableSleep(retryPeriodMs, signal);
      if (signal.aborted) break;
      if (await this.#tryAcquireOrRenew()) {
        lastRenewMs = this.#options.now().getTime();
      } else if (this.#options.now().getTime() - lastRenewMs > renewDeadlineMs) {
        return "lost";
      }
    }
    return "released";
  }

  /** One attempt to take or keep the Lease. True when we hold it afterwards. */
  async #tryAcquireOrRenew(): Promise<boolean> {
    const { client, namespace, name, identity, logger } = this.#options;
    const now = this.#options.now();
    try {
      const lease = await client.get<Lease>(RESOURCES.leases, namespace, name);
      if (!lease) return await this.#create(now);

      this.#observe(lease, now);
      const holder = lease.spec?.holderIdentity ?? "";
      const heldByOther = holder !== "" && holder !== identity;
      if (heldByOther && !this.#expired(lease, now)) return false;

      const takingOver = holder !== identity;
      const updated: Lease = {
        ...lease,
        spec: {
          holderIdentity: identity,
          leaseDurationSeconds: Math.ceil(this.#options.leaseDurationMs / 1000),
          renewTime: microTime(now),
          acquireTime: takingOver ? microTime(now) : (lease.spec?.acquireTime ?? microTime(now)),
          leaseTransitions:
            (lease.spec?.leaseTransitions ?? 0) + (takingOver && holder !== "" ? 1 : 0),
        },
      };
      const stored = await client.replace<Lease>(RESOURCES.leases, namespace, updated);
      this.#observe(stored, now);
      return true;
    } catch (error) {
      // Conflict: another replica wrote first. Anything else: try again next period.
      if (!isConflict(error)) logger.warn("lease update failed", { error: errorMessage(error) });
      return false;
    }
  }

  async #create(now: Date): Promise<boolean> {
    const { client, namespace, name, identity } = this.#options;
    try {
      const stored = await client.create<Lease>(RESOURCES.leases, namespace, {
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: { name, namespace },
        spec: {
          holderIdentity: identity,
          leaseDurationSeconds: Math.ceil(this.#options.leaseDurationMs / 1000),
          acquireTime: microTime(now),
          renewTime: microTime(now),
          leaseTransitions: 0,
        },
      });
      this.#observe(stored, now);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  /** Remembers when (by our clock) the Lease record last changed. */
  #observe(lease: Lease, now: Date): void {
    const record = JSON.stringify(lease.spec ?? {});
    if (this.#observed?.record !== record) this.#observed = { record, atMs: now.getTime() };
  }

  /** True when the holder has not renewed for a whole lease duration (by our clock). */
  #expired(lease: Lease, now: Date): boolean {
    const durationMs = (lease.spec?.leaseDurationSeconds ?? 15) * 1000;
    const changedAt = this.#observed?.atMs ?? now.getTime();
    return now.getTime() - changedAt > durationMs;
  }

  /** Gives the Lease up so a standby can take over at once. Best-effort. */
  async #release(): Promise<void> {
    const { client, namespace, name, identity, logger } = this.#options;
    try {
      const lease = await client.get<Lease>(RESOURCES.leases, namespace, name);
      if (!lease || lease.spec?.holderIdentity !== identity) return;
      await client.replace<Lease>(RESOURCES.leases, namespace, {
        ...lease,
        // An empty holder with a 1 s duration: free for anyone, right away.
        spec: {
          ...lease.spec,
          holderIdentity: "",
          leaseDurationSeconds: 1,
          renewTime: microTime(this.#options.now()),
        },
      });
    } catch (error) {
      logger.warn("could not release the lease", { error: errorMessage(error) });
    }
  }
}
