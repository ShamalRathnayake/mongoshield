/**
 * Progress reporting for the engines: turns a stream of per-document updates into
 * a calm sequence of `ProgressEvent`s with an ETA, and protects the engine from the
 * user's callback.
 *
 *   tracker.startNamespace("app.users", 50_000)    → namespace:start
 *   tracker.updateNamespace("app.users", 1200, …)  → namespace:progress + overall (throttled)
 *   tracker.finishNamespace("app.users", 50_000, …)→ namespace:done (+ overall, throttled)
 *   tracker.finish()                               → a final overall event (never throttled)
 *
 * Updates arrive once per document, far too often for a progress bar, so
 * `namespace:progress` and `overall` events are throttled (about four per second by
 * default). Start and done events are never throttled: they are rare and a UI needs
 * every one of them. Backup and restore both use this class.
 */

import type { Logger } from "../logger.ts";
import type { ProgressEvent } from "../types.ts";

/** Default minimum gap between two throttled events of the same kind: 4 per second. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 250;

/**
 * An ETA computed from the first instants of a run is mostly noise (connection
 * set-up, the first batch), so none is given before this much time has passed.
 */
export const MIN_ETA_ELAPSED_MS = 1000;

/** Options for `ProgressTracker`. */
export interface ProgressTrackerOptions {
  /** The user's callback. Without one, the tracker does nothing (cheaply). */
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
  /** Minimum gap between throttled events. Defaults to `DEFAULT_PROGRESS_INTERVAL_MS`. */
  readonly intervalMs?: number | undefined;
  /** Clock in milliseconds. Injectable for tests; defaults to `performance.now()`. */
  readonly now?: (() => number) | undefined;
  /** Receives a warning if the callback throws. */
  readonly logger?: Logger | undefined;
}

/** Latest known counts of one namespace. */
interface NamespaceCounts {
  documents: number;
  bytes: number;
  /** When the last `namespace:progress` event for it was sent. */
  lastEmittedAt: number;
}

/**
 * Estimates the remaining time from the documents done so far, assuming the rest
 * goes at the average speed seen until now.
 *
 * Returns `undefined` when there is not enough data: nothing done yet, too little
 * time elapsed, or more documents done than estimated (the estimate was wrong, so
 * any number would be made up).
 */
export function estimateRemainingMs(
  documents: number,
  estimatedDocuments: number,
  elapsedMs: number,
): number | undefined {
  if (documents <= 0 || elapsedMs < MIN_ETA_ELAPSED_MS) return undefined;
  if (documents > estimatedDocuments) return undefined;
  const msPerDocument = elapsedMs / documents;
  return Math.round((estimatedDocuments - documents) * msPerDocument);
}

/** Tracks progress over many namespaces and emits throttled `ProgressEvent`s. */
export class ProgressTracker {
  readonly #onProgress: ((event: ProgressEvent) => void) | undefined;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #startedAt: number;
  readonly #namespaces = new Map<string, NamespaceCounts>();
  #estimatedDocuments = 0;
  /** Starts far in the past so the first overall event is never throttled away. */
  #lastOverallAt = Number.NEGATIVE_INFINITY;
  #callbackFailed = false;

  constructor(options: ProgressTrackerOptions = {}) {
    this.#onProgress = options.onProgress;
    this.#intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.#now = options.now ?? (() => performance.now());
    this.#logger = options.logger;
    this.#startedAt = this.#now();
  }

  /** True when someone listens; lets hot paths skip work entirely. */
  get enabled(): boolean {
    return this.#onProgress !== undefined;
  }

  /** Announces a namespace. `estimatedDocuments` feeds the overall ETA. */
  startNamespace(ns: string, estimatedDocuments: number): void {
    this.#estimatedDocuments += estimatedDocuments;
    this.#namespaces.set(ns, {
      documents: 0,
      bytes: 0,
      // The first progress event of a namespace waits a full interval: emitting one
      // right after `namespace:start` would only repeat "0 documents".
      lastEmittedAt: this.#now(),
    });
    this.#emit({ type: "namespace:start", ns, estimatedDocuments });
  }

  /**
   * Records the running totals of a namespace (call it as often as you like, e.g.
   * per document). Emits `namespace:progress` and `overall` at most once per interval.
   */
  updateNamespace(ns: string, documents: number, bytes: number): void {
    if (this.#onProgress === undefined) return;
    const counts = this.#countsOf(ns);
    counts.documents = documents;
    counts.bytes = bytes;

    const now = this.#now();
    if (now - counts.lastEmittedAt >= this.#intervalMs) {
      counts.lastEmittedAt = now;
      this.#emit({ type: "namespace:progress", ns, documents, bytes });
    }
    this.#maybeEmitOverall(now);
  }

  /** Records a namespace's final totals and emits `namespace:done`. */
  finishNamespace(ns: string, documents: number, bytes: number): void {
    const counts = this.#countsOf(ns);
    counts.documents = documents;
    counts.bytes = bytes;
    this.#emit({ type: "namespace:done", ns, documents });
    this.#maybeEmitOverall(this.#now());
  }

  /** Emits a last `overall` event with the final totals, regardless of throttling. */
  finish(): void {
    this.#emitOverall(this.#now(), 0);
  }

  #countsOf(ns: string): NamespaceCounts {
    let counts = this.#namespaces.get(ns);
    if (counts === undefined) {
      // Tolerate updates for a namespace that was never started rather than crash a run.
      counts = { documents: 0, bytes: 0, lastEmittedAt: this.#now() };
      this.#namespaces.set(ns, counts);
    }
    return counts;
  }

  #maybeEmitOverall(now: number): void {
    if (now - this.#lastOverallAt < this.#intervalMs) return;
    this.#emitOverall(now, undefined);
  }

  /** @param etaOverride a fixed ETA (0 when finished), or `undefined` to estimate one. */
  #emitOverall(now: number, etaOverride: number | undefined): void {
    if (this.#onProgress === undefined) return;
    this.#lastOverallAt = now;

    let documents = 0;
    let bytes = 0;
    for (const counts of this.#namespaces.values()) {
      documents += counts.documents;
      bytes += counts.bytes;
    }
    const elapsedMs = Math.max(0, Math.round(now - this.#startedAt));
    this.#emit({
      type: "overall",
      documents,
      estimatedDocuments: this.#estimatedDocuments,
      bytes,
      elapsedMs,
      etaMs: etaOverride ?? estimateRemainingMs(documents, this.#estimatedDocuments, elapsedMs),
    });
  }

  /**
   * Calls the user's callback. A throwing callback must not fail a backup that is
   * otherwise fine, so the error is logged once and swallowed.
   */
  #emit(event: ProgressEvent): void {
    if (this.#onProgress === undefined) return;
    try {
      this.#onProgress(event);
    } catch (error) {
      if (this.#callbackFailed) return;
      this.#callbackFailed = true;
      this.#logger?.warn("The onProgress callback threw; further errors from it are ignored", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
