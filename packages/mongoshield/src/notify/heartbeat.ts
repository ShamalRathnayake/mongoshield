/**
 * Heartbeat ("dead man's switch") pings.
 *
 * Alerts on failure are not enough: if the scheduler itself dies, nothing
 * fails and nothing is sent. A heartbeat service expects a ping every period
 * and alerts when one does not arrive. MongoShield pings after every finished
 * run (not after skipped ones: another runner pings for those):
 *
 *   success  GET <url>
 *   failure  GET <url>/fail
 *
 * That is the healthchecks.io convention, which Better Stack heartbeats also
 * follow. Cronitor's telemetry URLs (`https://cronitor.link/p/<key>/<monitor>`)
 * use a `state` query parameter instead, so for `cronitor.link` URLs we send
 * `?state=complete` / `?state=fail`.
 */

import { type DeliveryOptions, sendHttp } from "./http.ts";

/** The outcome reported to the heartbeat service. */
export type HeartbeatOutcome = "success" | "failure";

/** The URL to request for an outcome (see the file header). */
export function heartbeatUrl(base: string, outcome: HeartbeatOutcome): string {
  const url = new URL(base);
  if (url.hostname === "cronitor.link") {
    url.searchParams.set("state", outcome === "success" ? "complete" : "fail");
    return url.toString();
  }
  if (outcome === "success") return url.toString();
  // Append to the path, keeping any query string (`?rid=…`) where it is.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/fail`;
  return url.toString();
}

/** Pings the heartbeat URL for `outcome`. Returns true on 2xx; never throws. */
export async function pingHeartbeat(
  base: string,
  outcome: HeartbeatOutcome,
  options: DeliveryOptions = {},
): Promise<boolean> {
  let url: string;
  try {
    url = heartbeatUrl(base, outcome);
  } catch {
    options.logger?.warn("The heartbeat URL is invalid; not pinging");
    return false;
  }
  return sendHttp({ url, method: "GET", label: `heartbeat (${outcome})` }, options);
}
