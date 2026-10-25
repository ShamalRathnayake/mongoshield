/**
 * The one HTTP helper every notifier uses: a request with a timeout and one
 * retry, that never throws.
 *
 * A notification is a side channel. If Slack is down, the backup must still be
 * reported as what it was (success or failure), so problems here are logged
 * and swallowed. The URL is never logged in full: Slack and Discord webhook
 * URLs and heartbeat URLs contain the secret that lets anyone post to them.
 */

import { type Logger, silentLogger } from "../logger.ts";

/** Options shared by every notifier. */
export interface DeliveryOptions {
  readonly logger?: Logger;
  /** Per-attempt timeout. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Delay before the single retry. Defaults to 1 second. */
  readonly retryDelayMs?: number;
}

/** One HTTP request to send. */
export interface HttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** What is being sent, for log messages (`"slack notification"`). */
  readonly label: string;
}

/** Default per-attempt timeout: generous for a webhook, short enough not to hold the lock long. */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Sends `request`, retrying once after a network error, a timeout, a 5xx or a
 * 429 (rate limited). Other 4xx answers mean the request itself is wrong (a
 * revoked webhook, say), so they are not retried.
 *
 * @returns true when the server answered 2xx. Never throws.
 */
export async function sendHttp(
  request: HttpRequest,
  options: DeliveryOptions = {},
): Promise<boolean> {
  const logger = options.logger ?? silentLogger;
  const where = safeHost(request.url);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const outcome = await attemptOnce(request, options.timeoutMs ?? DEFAULT_NOTIFY_TIMEOUT_MS);
    if (outcome.ok) {
      logger.debug(`Sent ${request.label}`, { host: where, status: outcome.status });
      return true;
    }
    const canRetry = attempt === 1 && outcome.retryable;
    const log = canRetry ? logger.debug : logger.warn;
    log(`Sending ${request.label} failed${canRetry ? "; retrying once" : ""}`, {
      host: where,
      ...(outcome.status === undefined ? {} : { status: outcome.status }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
    if (!canRetry) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
    );
  }
  return false;
}

/** What one attempt produced. */
interface AttemptOutcome {
  readonly ok: boolean;
  readonly retryable: boolean;
  readonly status?: number;
  readonly error?: string;
}

async function attemptOnce(request: HttpRequest, timeoutMs: number): Promise<AttemptOutcome> {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      ...(request.headers ? { headers: request.headers } : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect to somewhere else with our payload.
      redirect: "manual",
    });
    // Drain the body so the connection can be reused (and to avoid leaks).
    await response.arrayBuffer().catch(() => undefined);
    const status = response.status;
    return {
      ok: status >= 200 && status < 300,
      retryable: status >= 500 || status === 429,
      status,
    };
  } catch (error) {
    // Network errors and timeouts. Messages from fetch never include the URL's path.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, retryable: true, error: message };
  }
}

/** The host of a URL, which is safe to log (the secret part is the path or query). */
export function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}
