/**
 * Small descriptions of backups shared by several commands (`list`, `inspect`,
 * `verify`, `hold`, `backup`): status, encryption, consistency, verification and hold
 * markers, and picking a backup by the selector the user typed.
 */

import type { DrillRecord, VerificationRecord } from "../catalog/annotations.ts";
import { type CatalogEntry, immutableUntilOf } from "../catalog/catalog.ts";
import { selectBackup } from "../catalog/select.ts";
import type { Manifest } from "../format/manifest.ts";
import type { MongoShield } from "../shield.ts";
import { formatCount, formatDuration, formatRelative } from "./format.ts";
import type { Output } from "./io.ts";

/** `complete` in green, `incomplete` in yellow, `invalid` in red. */
export function styledStatus(entry: CatalogEntry, out: Output): string {
  switch (entry.status) {
    case "complete":
      return out.style("green", "complete");
    case "incomplete":
      return out.style("yellow", "incomplete");
    case "invalid":
      return out.style("red", "invalid");
  }
}

/**
 * The consistency mode; for converge backups also how many changes made during the
 * backup restore will replay, e.g. `converge (1,204 changes during the backup, replayed
 * on restore)`.
 */
export function consistencySummary(manifest: Manifest): string {
  const { mode } = manifest.consistency;
  if (manifest.changes === undefined) return mode;
  return `${mode} (${formatCount(manifest.changes.events)} changes during the backup, replayed on restore)`;
}

/** `yes (2 recipients)`, `yes (passphrase)`, `no`, or `–` when unknown. */
export function encryptionSummary(entry: CatalogEntry): string {
  const encryption = entry.manifest?.encryption;
  if (entry.manifest === undefined) return "–";
  if (!encryption) return "no";
  if (encryption.recipients.includes("scrypt")) return "yes (passphrase)";
  const count = encryption.recipients.length;
  return `yes (${count} recipient${count === 1 ? "" : "s"})`;
}

/**
 * The latest check of a backup: `✓ deep 2d ago`, `✗ failed 3h ago`, for a restore
 * drill `drill ✓ (RTO 42s) 1d ago`, or `–` when it was never checked.
 */
export function verificationSummary(entry: CatalogEntry, out: Output, now = new Date()): string {
  const verification = entry.verification;
  const drill = entry.lastDrill;
  // A drill restores the whole backup, so it says at least as much as a verification;
  // whichever ran last is the backup's current standing.
  if (
    drill &&
    (!verification || Date.parse(drill.drilledAt) >= Date.parse(verification.verifiedAt))
  ) {
    return drillSummary(drill, out, now);
  }
  return verificationRecordSummary(verification, out, now);
}

/** One verification run: `✓ deep 2d ago`, `✗ failed 3h ago`, or `–` when there is none. */
export function verificationRecordSummary(
  verification: VerificationRecord | undefined,
  out: Output,
  now = new Date(),
): string {
  if (!verification) return out.style("dim", "–");
  const when = formatRelative(new Date(verification.verifiedAt), now);
  if (verification.ok) return `${out.style("green", "✓")} ${verification.mode} ${when}`;
  return `${out.style("red", "✗")} failed ${when}`;
}

/** `drill ✓ (RTO 42s) 1d ago`, or `drill ✗ failed 3h ago`. */
export function drillSummary(drill: DrillRecord, out: Output, now = new Date()): string {
  const when = formatRelative(new Date(drill.drilledAt), now);
  if (drill.ok) {
    return `drill ${out.style("green", "✓")} (RTO ${formatRto(drill.restoreDurationMs)}) ${when}`;
  }
  return `drill ${out.style("red", "✗")} failed ${when}`;
}

/**
 * A drill's restore time as people quote an RTO: whole seconds under a minute
 * (`42s`), otherwise minutes or hours (`3m 05s`, `1h 12m`).
 */
export function formatRto(milliseconds: number): string {
  if (milliseconds >= 1000 && milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  return formatDuration(milliseconds);
}

/** `held` marker for tables (empty when not held). */
export function holdMarker(entry: CatalogEntry, out: Output, now = new Date()): string {
  const markers: string[] = [];
  if (entry.hold) markers.push(out.style("cyan", "held"));
  // A write-once lock that is still in force: storage refuses to delete the files.
  const lockedUntil = immutableUntilOf(entry);
  if (lockedUntil && lockedUntil > now) {
    markers.push(out.style("cyan", `locked until ${lockedUntil.toISOString().slice(0, 10)}`));
  }
  return markers.join(", ");
}

/**
 * Lists the catalog and picks one complete backup by `selector`
 * ("latest" or an id). Throws MS_BACKUP_NOT_FOUND with suggestions otherwise.
 */
export async function findBackup(
  shield: MongoShield,
  selector: string,
  signal: AbortSignal,
): Promise<CatalogEntry> {
  const entries = await shield.list({ signal });
  return selectBackup(entries, selector);
}
