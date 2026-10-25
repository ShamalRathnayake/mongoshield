/**
 * Showing `ProgressEvent`s from backup, restore and verify.
 *
 * On a terminal: one line, redrawn in place (at most ~10 times a second):
 *
 *   ⠹ Backing up  42% · 120,345/286,000 docs · 18.2 MiB · 4.1k docs/s · ETA 38s · app.users
 *
 * Elsewhere (CI logs, files): a plain line every 10 seconds, so logs show the
 * job is alive without drowning in updates:
 *
 *   Backing up: 42% (120,345/286,000 documents, 18.2 MiB, ETA 38s)
 *
 * Nothing is shown with --quiet or --json.
 */

import { stripVTControlCharacters } from "node:util";
import type { ProgressEvent } from "../types.ts";
import { compactNumber, formatBytes, formatCount, formatDuration, formatRate } from "./format.ts";
import type { Output } from "./io.ts";

/** Minimum gap between two redraws of the live line. */
const LIVE_REDRAW_MS = 100;

/** Gap between two plain progress lines in non-interactive output. */
const PLAIN_INTERVAL_MS = 10_000;

/** Braille spinner frames: smooth on every modern terminal font. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The latest numbers, merged from every event kind. */
interface ProgressState {
  documents: number;
  estimatedDocuments: number;
  bytes: number;
  elapsedMs: number;
  etaMs: number | undefined;
  /** The namespace most recently started, shown at the end of the live line. */
  currentNamespace: string | undefined;
}

/** Renders progress for one operation. Call `stop()` when it ends (success or not). */
export class ProgressDisplay {
  readonly #out: Output;
  readonly #label: string;
  readonly #enabled: boolean;
  readonly #state: ProgressState = {
    documents: 0,
    estimatedDocuments: 0,
    bytes: 0,
    elapsedMs: 0,
    etaMs: undefined,
    currentNamespace: undefined,
  };
  #lastDrawAt = Number.NEGATIVE_INFINITY;
  #lastPlainAt: number;
  #frame = 0;

  /** `label` is a verb phrase: "Backing up", "Restoring", "Verifying". */
  constructor(out: Output, label: string) {
    this.#out = out;
    this.#label = label;
    this.#enabled = !out.settings.quiet && !out.settings.json;
    // The first plain line comes after one interval, not immediately: short
    // operations finish before it and print only their summary.
    this.#lastPlainAt = Date.now();
    if (this.#enabled && out.liveProgress) this.#out.live(`${SPINNER[0]} ${label}…`);
  }

  /** The callback to pass as `onProgress`. */
  readonly onProgress = (event: ProgressEvent): void => {
    if (!this.#enabled) return;
    this.#apply(event);
    if (this.#out.liveProgress) this.#drawLive();
    else this.#maybePrintPlain();
  };

  /** Removes the live line. Safe to call more than once. */
  stop(): void {
    if (this.#out.liveProgress) this.#out.endLive();
  }

  #apply(event: ProgressEvent): void {
    const state = this.#state;
    switch (event.type) {
      case "namespace:start":
        state.currentNamespace = event.ns;
        break;
      case "overall":
        state.documents = event.documents;
        state.estimatedDocuments = event.estimatedDocuments;
        state.bytes = event.bytes;
        state.elapsedMs = event.elapsedMs;
        state.etaMs = event.etaMs;
        break;
      case "namespace:progress":
      case "namespace:done":
        // Overall events carry the totals; per-namespace counts add nothing here.
        break;
    }
  }

  #drawLive(): void {
    const now = Date.now();
    if (now - this.#lastDrawAt < LIVE_REDRAW_MS) return;
    this.#lastDrawAt = now;
    this.#frame = (this.#frame + 1) % SPINNER.length;

    const state = this.#state;
    const parts = [
      `${this.#out.style("cyan", SPINNER[this.#frame] ?? "")} ${this.#label}`,
      this.#out.style("bold", percent(state)),
      `${formatCount(state.documents)}/${formatCount(state.estimatedDocuments)} docs`,
      formatBytes(state.bytes),
      formatRate(state.documents, state.elapsedMs, "docs"),
    ];
    if (state.etaMs !== undefined) parts.push(`ETA ${formatDuration(state.etaMs)}`);
    if (state.currentNamespace) parts.push(this.#out.style("dim", state.currentNamespace));

    // Wider than the terminal would wrap, and "\r" can only rewrite one row.
    this.#out.live(truncate(parts.join(" · "), this.#out.columns - 1));
  }

  #maybePrintPlain(): void {
    const now = Date.now();
    if (now - this.#lastPlainAt < PLAIN_INTERVAL_MS) return;
    this.#lastPlainAt = now;

    const state = this.#state;
    const details = [
      `${formatCount(state.documents)}/${formatCount(state.estimatedDocuments)} documents`,
      formatBytes(state.bytes),
      `${compactNumber(state.elapsedMs > 0 ? state.documents / (state.elapsedMs / 1000) : 0)} docs/s`,
    ];
    if (state.etaMs !== undefined) details.push(`ETA ${formatDuration(state.etaMs)}`);
    this.#out.info(`${this.#label}: ${percent(state)} (${details.join(", ")})`);
  }
}

/**
 * Percentage done. Estimates come from collection statistics and can be off,
 * so it is capped at 99% until the operation actually finishes.
 */
function percent(state: ProgressState): string {
  if (state.estimatedDocuments <= 0) return "–%";
  const value = Math.min(99, Math.floor((state.documents / state.estimatedDocuments) * 100));
  return `${value}%`;
}

/**
 * Shortens a line to `width` visible characters. A line that has to be cut
 * loses its colors: cutting through an escape sequence would corrupt the screen.
 */
function truncate(line: string, width: number): string {
  const plain = stripVTControlCharacters(line);
  if (plain.length <= width) return line;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}
