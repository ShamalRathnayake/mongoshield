/**
 * Generic webhook notifications: a JSON POST of the run report.
 *
 *   POST <url>
 *   Content-Type: application/json
 *   User-Agent: mongoshield/<version>
 *   X-MongoShield-Event: backup.success | backup.failure
 *   X-MongoShield-Timestamp: 1792555204              (only when a secret is set)
 *   X-MongoShield-Signature: sha256=<hex>            (only when a secret is set)
 *
 *   { "event": "backup.failure", "report": { …RunReport… } }
 *
 * The signature is HMAC-SHA256 with the shared secret over
 * `<timestamp>.<raw body>`, the same scheme Stripe and GitHub use. Receivers
 * recompute it and also reject old timestamps, which stops replays. The secret
 * comes from the `MONGOSHIELD_WEBHOOK_SECRET` environment variable (the CLI
 * reads it), never from the config file.
 */

import { createHmac } from "node:crypto";
import type { RunReport } from "../schedule/report.ts";
import { version } from "../version.ts";
import { type DeliveryOptions, sendHttp } from "./http.ts";

/** The environment variable the CLI reads the webhook signing secret from. */
export const WEBHOOK_SECRET_ENV = "MONGOSHIELD_WEBHOOK_SECRET";

/** The event name for a report. */
export type WebhookEvent = "backup.success" | "backup.failure" | "backup.checkpointed";

/** The JSON body of a webhook notification. */
export interface WebhookPayload {
  readonly event: WebhookEvent;
  readonly report: RunReport;
}

/** Builds the webhook body for a finished (not skipped) run. */
export function webhookPayload(report: RunReport): WebhookPayload {
  const event: WebhookEvent =
    report.status === "failure"
      ? "backup.failure"
      : report.status === "checkpointed"
        ? "backup.checkpointed"
        : "backup.success";
  return { event, report };
}

/** `sha256=<hex>`: HMAC-SHA256 of `<timestamp>.<body>` with `secret`. */
export function signWebhook(body: string, secret: string, timestamp: number): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `sha256=${digest}`;
}

/** Options for {@link sendWebhook}. */
export interface WebhookOptions extends DeliveryOptions {
  /** Signs the request when set. */
  readonly secret?: string;
  /** Unix time in seconds; for tests. */
  readonly timestamp?: number;
}

/** POSTs the report to `url`. Returns true on a 2xx answer; never throws. */
export async function sendWebhook(
  url: string,
  report: RunReport,
  options: WebhookOptions = {},
): Promise<boolean> {
  const payload = webhookPayload(report);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `mongoshield/${version}`,
    "x-mongoshield-event": payload.event,
  };
  if (options.secret !== undefined && options.secret !== "") {
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    headers["x-mongoshield-timestamp"] = String(timestamp);
    headers["x-mongoshield-signature"] = signWebhook(body, options.secret, timestamp);
  }
  return sendHttp({ url, method: "POST", headers, body, label: "webhook notification" }, options);
}
