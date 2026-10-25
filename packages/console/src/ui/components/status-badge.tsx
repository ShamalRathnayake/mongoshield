/**
 * StatusBadge: one consistent way to show any status — job states, backup states,
 * verification results, connection tests.
 *
 * Status is never shown by color alone: every badge has a word and a shape
 * (check = good, cross = failed, triangle = needs attention, filled dot = running,
 * hollow ring = waiting, dash = stopped/neutral), so it reads the same for people with
 * color blindness, in grayscale prints and in high-contrast mode.
 */

import type { ReactNode } from "react";

/** The six visual kinds; each has a color AND a shape. */
export type StatusTone = "success" | "danger" | "warning" | "running" | "pending" | "neutral";

/** Every status the console shows, mapped to a word and a tone. */
const STATUS_STYLES: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  // Jobs
  queued: { label: "Queued", tone: "pending" },
  running: { label: "Running", tone: "running" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  // Backups
  complete: { label: "Complete", tone: "success" },
  incomplete: { label: "Incomplete", tone: "warning" },
  invalid: { label: "Invalid", tone: "danger" },
  // Verification and tests
  verified: { label: "Verified", tone: "success" },
  "verify-failed": { label: "Verify failed", tone: "danger" },
  unverified: { label: "Not verified", tone: "warning" },
  ok: { label: "OK", tone: "success" },
  // Audit outcomes
  success: { label: "Success", tone: "success" },
  failure: { label: "Failure", tone: "danger" },
  // Other markers
  held: { label: "On hold", tone: "warning" },
  production: { label: "Production", tone: "danger" },
  scheduled: { label: "Scheduled", tone: "pending" },
  manual: { label: "Manual only", tone: "neutral" },
};

/** The word and tone for a status; unknown statuses are shown as-is in neutral. */
export function statusStyle(status: string): { label: string; tone: StatusTone } {
  return STATUS_STYLES[status] ?? { label: status, tone: "neutral" };
}

/** The shape drawn for each tone, as a small inline SVG (allowed by the strict CSP). */
function StatusShape(props: { tone: StatusTone }) {
  switch (props.tone) {
    case "success":
      return <path d="M3 8.5l3 3 7-7" fill="none" strokeWidth="2" />;
    case "danger":
      return <path d="M4 4l8 8M12 4l-8 8" fill="none" strokeWidth="2" />;
    case "warning":
      return <path d="M8 2l6.5 12h-13z" strokeWidth="1" />;
    case "running":
      return <circle cx="8" cy="8" r="4.5" strokeWidth="0" />;
    case "pending":
      return <circle cx="8" cy="8" r="4.5" fill="none" strokeWidth="2" />;
    case "neutral":
      return <path d="M3.5 8h9" fill="none" strokeWidth="2" />;
  }
}

/**
 * A badge with a shape and a word, e.g. "✓ Succeeded".
 *
 * @param status a known status key (`"failed"`, `"complete"`, …) or any text
 * @param label overrides the word (the tone still comes from `status`)
 */
export function StatusBadge(props: { status: string; label?: ReactNode; title?: string }) {
  const style = statusStyle(props.status);
  return (
    <span className={`status-badge status-${style.tone}`} title={props.title}>
      <svg
        className="status-shape"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        aria-hidden="true"
        focusable="false"
      >
        <StatusShape tone={style.tone} />
      </svg>
      <span className="status-label">{props.label ?? style.label}</span>
    </span>
  );
}
