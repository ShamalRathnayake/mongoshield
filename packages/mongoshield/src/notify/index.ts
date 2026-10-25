/**
 * Notifications about scheduled runs: webhooks, Slack, Discord and heartbeats.
 *
 * `notifyRun` is what the runner calls after each run. It sends to every
 * target whose `on` list includes the outcome, all at once, and pings the
 * heartbeat. Nothing here throws: a broken notification target is logged and
 * never turns a successful backup into a failed run.
 */

import { silentLogger } from "../logger.ts";
import type { RunReport } from "../schedule/report.ts";
import { sendDiscord, sendSlack } from "./chat.ts";
import { pingHeartbeat } from "./heartbeat.ts";
import type { DeliveryOptions } from "./http.ts";
import { sendWebhook } from "./webhook.ts";

export { discordPayload, sendDiscord, sendSlack, slackPayload } from "./chat.ts";
export { type HeartbeatOutcome, heartbeatUrl, pingHeartbeat } from "./heartbeat.ts";
export { DEFAULT_NOTIFY_TIMEOUT_MS, type DeliveryOptions, sendHttp } from "./http.ts";
export {
  sendWebhook,
  signWebhook,
  WEBHOOK_SECRET_ENV,
  type WebhookEvent,
  type WebhookOptions,
  type WebhookPayload,
  webhookPayload,
} from "./webhook.ts";

/** One notification target; matches an entry of `notify` in the config file. */
export interface NotifyTarget {
  readonly type: "webhook" | "slack" | "discord";
  readonly url: string;
  /** Which outcomes to send. Defaults to failures only. */
  readonly on?: readonly ("success" | "failure")[] | undefined;
}

/** Options for {@link notifyRun}. */
export interface NotifyRunOptions extends DeliveryOptions {
  readonly targets?: readonly NotifyTarget[];
  /** Heartbeat URL (healthchecks.io style). */
  readonly heartbeat?: string;
  /** Signs webhook requests (see webhook.ts). */
  readonly webhookSecret?: string;
}

/** What was delivered, for the logs and tests. */
export interface NotifyOutcome {
  /** One entry per target that wanted this outcome, in target order. */
  readonly sent: readonly { readonly type: NotifyTarget["type"]; readonly delivered: boolean }[];
  /** `undefined` when no heartbeat is configured or the run was skipped. */
  readonly heartbeat: boolean | undefined;
}

/**
 * Sends the notifications and heartbeat for a finished run. Skipped runs send
 * nothing: another runner holds the lock and reports for itself.
 */
export async function notifyRun(
  report: RunReport,
  options: NotifyRunOptions,
): Promise<NotifyOutcome> {
  if (report.status === "skipped") return { sent: [], heartbeat: undefined };
  const logger = options.logger ?? silentLogger;
  // A checkpointed run (maxDurationMs) made progress and will be resumed: as far as
  // alerting and the dead man's switch are concerned, it is a healthy run.
  const outcome = report.status === "checkpointed" ? "success" : report.status;

  const wanted = (options.targets ?? []).filter((target) =>
    (target.on ?? ["failure"]).includes(outcome),
  );
  const deliveries = wanted.map(async (target) => ({
    type: target.type,
    delivered: await sendTo(target, report, options),
  }));
  const heartbeat =
    options.heartbeat === undefined
      ? undefined
      : pingHeartbeat(options.heartbeat, outcome, options);

  const [sent, pinged] = await Promise.all([Promise.all(deliveries), heartbeat]);
  logger.debug("Notifications sent", { outcome, targets: sent.length, heartbeat: pinged });
  return { sent, heartbeat: pinged };
}

/** Sends the report to one target in its own format. */
function sendTo(
  target: NotifyTarget,
  report: RunReport,
  options: NotifyRunOptions,
): Promise<boolean> {
  switch (target.type) {
    case "slack":
      return sendSlack(target.url, report, options);
    case "discord":
      return sendDiscord(target.url, report, options);
    case "webhook":
      return sendWebhook(target.url, report, {
        ...options,
        ...(options.webhookSecret === undefined ? {} : { secret: options.webhookSecret }),
      });
  }
}
