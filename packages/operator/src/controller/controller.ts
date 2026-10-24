/**
 * A controller: a work queue plus workers that call one reconcile function per key.
 *
 * The reconcile function is level-based: it is given only "namespace/name", reads the
 * current state, and makes the world match the spec. It does not care which event
 * caused the call, so missed or duplicated events are harmless, and the same code
 * handles creation, updates, drift and recovery after a restart.
 *
 * Outcomes:
 *   - returns normally            done; the failure count is reset
 *   - returns { requeueAfterMs }  done for now; look again after that delay
 *   - throws                      retried with per-key exponential backoff
 * A 409 Conflict (someone wrote the object since we read it) is expected under
 * concurrency and is retried quietly: the next run reads the newer version.
 */

import { isConflict } from "../kube/client.ts";
import { errorMessage } from "../kube/informer.ts";
import type { Logger } from "../logger.ts";
import type { OperatorMetrics } from "../operator-metrics.ts";
import { type RateLimit, WorkQueue } from "./workqueue.ts";

/** The object a reconcile call is about. */
export interface ObjectRef {
  readonly namespace: string;
  readonly name: string;
}

/** What a reconcile call may ask for. */
export interface ReconcileResult {
  /** Reconcile this object again after this many milliseconds. */
  readonly requeueAfterMs?: number;
}

/** A reconcile function: make the object's world match its spec. */
export type ReconcileFunction = (ref: ObjectRef) => Promise<ReconcileResult | undefined>;

export interface ControllerOptions {
  /** Short name for logs and metrics: "plan", "backup", "restore". */
  readonly name: string;
  readonly reconcile: ReconcileFunction;
  /** How many objects are reconciled in parallel (never the same object twice). */
  readonly workers: number;
  readonly logger: Logger;
  readonly metrics: OperatorMetrics;
  readonly rateLimit?: RateLimit;
}

export class Controller {
  readonly name: string;
  readonly queue: WorkQueue;
  readonly #options: ControllerOptions;
  readonly #logger: Logger;

  constructor(options: ControllerOptions) {
    this.name = options.name;
    this.#options = options;
    this.#logger = options.logger.child({ controller: options.name });
    this.queue = new WorkQueue(options.rateLimit);
  }

  /** Asks for the object to be reconciled. */
  enqueue(ref: ObjectRef): void {
    this.queue.add(`${ref.namespace}/${ref.name}`);
  }

  /** Runs the workers until `stop` is called; resolves when they have all finished. */
  async run(): Promise<void> {
    const workers: Promise<void>[] = [];
    for (let index = 0; index < this.#options.workers; index += 1) workers.push(this.#work());
    await Promise.all(workers);
  }

  /** Stops handing out work. Reconciles already running finish; `run` then resolves. */
  stop(): void {
    this.queue.shutDown();
  }

  async #work(): Promise<void> {
    for (;;) {
      const key = await this.queue.get();
      if (key === undefined) return;
      await this.#process(key);
    }
  }

  /** One reconcile call, with metrics, logging and requeue handling. */
  async #process(key: string): Promise<void> {
    const { metrics } = this.#options;
    const ref = parseKey(key);
    const started = performance.now();
    try {
      const result = await this.#options.reconcile(ref);
      this.queue.forget(key);
      if (result?.requeueAfterMs !== undefined) {
        this.queue.addAfter(key, result.requeueAfterMs);
        metrics.reconciles.inc({ controller: this.name, result: "requeue" });
      } else {
        metrics.reconciles.inc({ controller: this.name, result: "success" });
      }
    } catch (error) {
      const delay = this.queue.addRateLimited(key);
      if (isConflict(error)) {
        // Normal under concurrency: the next attempt reads the newer object.
        this.#logger.debug("conflict; retrying", { ...ref, retryInMs: delay });
        metrics.reconciles.inc({ controller: this.name, result: "conflict" });
      } else {
        this.#logger.error("reconcile failed", {
          ...ref,
          error: errorMessage(error),
          failures: this.queue.failures(key),
          retryInMs: delay,
        });
        metrics.reconciles.inc({ controller: this.name, result: "error" });
      }
    } finally {
      this.queue.done(key);
      const seconds = (performance.now() - started) / 1000;
      metrics.reconcileDuration.observe({ controller: this.name }, seconds);
    }
  }
}

/** Splits "namespace/name". */
export function parseKey(key: string): ObjectRef {
  const slash = key.indexOf("/");
  return { namespace: key.slice(0, slash), name: key.slice(slash + 1) };
}
