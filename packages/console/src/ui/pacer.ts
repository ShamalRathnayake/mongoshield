/**
 * Pacing the queries the UI starts on its own.
 *
 * Some requests are not a direct click: the schema sample behind the field suggestions,
 * the sample of the schema and chart views. On an Atlas Free or Flex cluster every
 * operation counts against a shared budget (about 100 operations per second, and data
 * transfer limits), so firing several of them at once could throttle the application
 * that uses the database. The pacer runs such background work one task at a time per
 * connection, waits at least `gapMs` between the start of one task and the next, and
 * drops tasks whose caller has gone away (their AbortSignal fired) before they start.
 *
 * Requests the user starts directly (a page of documents, an export) do not go through
 * the pacer: waiting for them would only feel broken.
 */

/** Gap between background requests on an Atlas shared-tier cluster (ms). */
export const SHARED_TIER_GAP_MS = 1_000;
/** Gap between background requests elsewhere: none, but still one at a time. */
export const DEFAULT_GAP_MS = 0;
/** How long field suggestions wait after the last keystroke or focus before sampling (ms). */
export const SUGGESTION_DEBOUNCE_MS = 400;

/** Thrown into a task's promise when its signal fired before it could start. */
export class PacerAbortError extends Error {
  override readonly name = "AbortError";
  constructor() {
    super("The request was cancelled before it started.");
  }
}

/** One queued task. */
interface QueuedTask {
  readonly run: () => Promise<unknown>;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/** A one-at-a-time queue with a minimum gap between task starts. */
export class Pacer {
  #gapMs: number;
  readonly #queue: QueuedTask[] = [];
  #running = false;
  /** When the last task started (ms since the epoch, from `now`). */
  #lastStart = Number.NEGATIVE_INFINITY;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  /**
   * @param gapMs minimum time between task starts.
   * @param clock injectable time source and sleep, so tests run without real waiting.
   */
  constructor(
    gapMs = DEFAULT_GAP_MS,
    clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.#gapMs = gapMs;
    this.#now = clock.now ?? (() => Date.now());
    this.#sleep = clock.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Changes the gap (e.g. once the server says the cluster is a shared tier). */
  setGap(gapMs: number): void {
    this.#gapMs = gapMs;
  }

  /** Tasks waiting to start (not counting the one running). */
  get pending(): number {
    return this.#queue.length;
  }

  /** Queues a task; resolves or rejects with its result. */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(new PacerAbortError());
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        run: task,
        signal,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.#drain();
    });
  }

  /** Starts queued tasks one after the other, honouring the gap. */
  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        if (isAborted(next.signal)) {
          next.reject(new PacerAbortError());
          continue;
        }
        const wait = this.#lastStart + this.#gapMs - this.#now();
        if (wait > 0) await this.#sleep(wait);
        // The caller may have left while we waited.
        if (isAborted(next.signal)) {
          next.reject(new PacerAbortError());
          continue;
        }
        this.#lastStart = this.#now();
        try {
          next.resolve(await next.run());
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.#running = false;
    }
  }
}

/** True once a task's caller has gone away (a function, so each check reads the signal anew). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** One pacer per connection (or backup storage), shared by every view of the page. */
const pacers = new Map<string, Pacer>();

/** The pacer of a connection; created on first use. */
export function pacerFor(key: string): Pacer {
  let pacer = pacers.get(key);
  if (pacer === undefined) {
    pacer = new Pacer();
    pacers.set(key, pacer);
  }
  return pacer;
}
