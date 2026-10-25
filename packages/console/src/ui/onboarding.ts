/**
 * Small pieces the welcome flow shares (pages/welcome.tsx, pages/backup-actions.tsx):
 *
 *   - `useWelcomeRedirect`: after signing in, an admin of a console with no connections
 *     lands on the welcome page instead of an empty overview (once per browser session:
 *     "Skip for now" is remembered);
 *   - `nightlyPlanInput`: the one-click "make this a schedule" change to a plan;
 *   - `atlasTierLabel`, `downloadTextFile` and the remembered "skip" flag.
 *
 * No React components here, so the pages stay focused on what is on the screen.
 */

import { useEffect } from "react";
import type { AtlasTierName, PlanInput, PlanView } from "../shared/api.ts";
import { useApi } from "./context.tsx";
import { navigate } from "./router.ts";

/** sessionStorage key: the user chose "Skip for now" on the welcome page. */
const SKIPPED_KEY = "mongoshield.welcome.skipped";

/** The nightly schedule the welcome flow offers: 02:00 every night, in the browser's time zone. */
export const NIGHTLY_CRON = "0 2 * * *";

/**
 * How long nightly backups are kept: the last 7 days, then one a week for 4 weeks and one
 * a month for 12 months. About two dozen backups at any time, covering a year.
 */
export const NIGHTLY_RETENTION = { daily: 7, weekly: 4, monthly: 12 } as const;

/** Remembers (for this browser tab session) that the welcome page was skipped. */
export function rememberWelcomeSkipped(): void {
  try {
    window.sessionStorage.setItem(SKIPPED_KEY, "1");
  } catch {
    // Storage can be unavailable (private windows); then the welcome page shows again.
  }
}

/** True when the welcome page was skipped in this browser session. */
function welcomeSkipped(): boolean {
  try {
    return window.sessionStorage.getItem(SKIPPED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Sends an admin on the overview of a console without connections to the welcome page.
 * Only admins: they are the ones who can add a connection.
 */
export function useWelcomeRedirect(path: string, isAdmin: boolean): void {
  const client = useApi();
  useEffect(() => {
    if (path !== "/" || !isAdmin || welcomeSkipped()) return;
    const controller = new AbortController();
    client.call("GET /api/connections", undefined, { signal: controller.signal }).then(
      (connections) => {
        if (!controller.signal.aborted && connections.length === 0) navigate("/welcome");
      },
      () => {
        // The overview shows its own errors; nothing to do here.
      },
    );
    return () => controller.abort();
  }, [client, path, isAdmin]);
}

/** "Atlas Free or Flex" / "Atlas Dedicated", for badges. */
export function atlasTierLabel(tier: AtlasTierName): string {
  return tier === "shared" ? "Atlas Free or Flex" : "Atlas Dedicated";
}

/** The browser's time zone (e.g. "Europe/Berlin"), or UTC when it cannot tell. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * A plan made nightly: the same plan with {@link NIGHTLY_CRON} in `timeZone` and
 * {@link NIGHTLY_RETENTION}. Secrets stay as they are: notification URLs are omitted
 * (kept by the server), and a managed key is kept by sending `{ kind: "managed" }`.
 */
export function nightlyPlanInput(plan: PlanView, timeZone: string): PlanInput {
  return {
    name: plan.name,
    connectionId: plan.connectionId,
    storageId: plan.storageId,
    include: plan.include,
    exclude: plan.exclude,
    compression: plan.compression,
    encryption: keptEncryption(plan.encryption),
    consistency: plan.consistency,
    verify: plan.verify,
    notify: plan.notify.map((target) => ({ type: target.type })),
    schedule: { cron: NIGHTLY_CRON, timezone: timeZone },
    retention: { ...NIGHTLY_RETENTION },
    ...(plan.incremental === undefined ? {} : { incremental: plan.incremental }),
  };
}

/** The encryption part of a plan input that keeps whatever the plan has. */
function keptEncryption(encryption: PlanView["encryption"]): PlanInput["encryption"] {
  switch (encryption.kind) {
    case "none":
      return { kind: "none" };
    case "recipients":
      return { kind: "recipients", recipients: encryption.recipients };
    case "passphrase":
      // Leaving the passphrase out keeps the stored one.
      return { kind: "passphrase" };
    case "managed":
      return { kind: "managed" };
  }
}

/**
 * Offers text as a file download. Uses a Blob URL and a temporary link, which the
 * console's Content-Security-Policy allows (no inline script, no data: navigation).
 */
export function downloadTextFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
