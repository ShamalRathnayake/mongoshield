/**
 * Shared rules for write-once retention (`PutOptions.retainUntil`).
 *
 * Every adapter enforces the same three rules, so they live here:
 *
 * 1. Fail early. An adapter that cannot lock objects (`capabilities.objectLock`
 *    is false) rejects a retained put with `MS_CONFIG_INVALID` *before reading any
 *    of the body*. A backup that asked for immutability must never quietly
 *    produce deletable files, and failing before the first byte means nothing was
 *    uploaded that has to be cleaned up. (The engine also checks the capability up
 *    front, before it reads from MongoDB; this is the adapter-level safety net.)
 * 2. `retainUntil` must be a real date in the future. Every provider rejects a
 *    past date, each with a different error; checking here gives one clear message.
 * 3. A bucket that is not set up for retention is a configuration problem
 *    (`MS_CONFIG_INVALID` with a hint naming the provider setting), not an I/O error,
 *    so retrying will not help and the CLI exits with the config exit code.
 *
 * Nothing here is public API.
 */

import type { Readable } from "node:stream";
import { isMongoShieldError, MongoShieldError, type MongoShieldErrorOptions } from "../errors.ts";
import type { PutOptions, RetentionMode, RetentionOptions } from "./types.ts";

/**
 * Compliance is the default because it is the only mode that still holds when an
 * attacker has the storage account's admin credentials, which is the point of
 * immutable backups. Governance is an explicit opt-in.
 */
export const DEFAULT_RETENTION_MODE: RetentionMode = "compliance";

/** Link shown in hints; the guide explains how to prepare each provider. */
export const IMMUTABLE_GUIDE = "docs/guides/immutable-backups.md";

/**
 * Validates an adapter's `retention` option and returns the mode to use.
 * `label` names the adapter in the error ("S3", "GCS", "Azure").
 */
export function resolveRetentionMode(
  option: RetentionOptions | undefined,
  label: string,
): RetentionMode {
  if (option === undefined) return DEFAULT_RETENTION_MODE;
  const mode: unknown = option.mode;
  if (mode === "compliance" || mode === "governance") return mode;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `Invalid ${label} retention mode "${String(mode)}".`,
    { hint: 'Use retention: { mode: "compliance" } or { mode: "governance" }.' },
  );
}

/**
 * Checks that `retainUntil` is a valid date in the future (rule 2). `now` is
 * injectable for tests.
 */
export function assertValidRetainUntil(
  retainUntil: Date,
  target: string,
  now: Date = new Date(),
): void {
  const time = retainUntil instanceof Date ? retainUntil.getTime() : Number.NaN;
  if (Number.isNaN(time)) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Cannot write ${target}: retainUntil is not a valid date.`,
    );
  }
  if (time <= now.getTime()) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Cannot write ${target}: retainUntil (${retainUntil.toISOString()}) is not in the future.`,
      { hint: "Retention must end after the write; check retainDays and the system clock." },
    );
  }
}

/**
 * Rule 1 for adapters without object lock: throws `MS_CONFIG_INVALID` if the put
 * asks for retention. Call it first thing in `put`, before touching `body`. The
 * body stream is destroyed (not read) so the caller's pipeline does not hang
 * waiting for a consumer that will never come.
 */
export function rejectRetention(
  putOptions: PutOptions,
  body: Readable | Uint8Array,
  kind: string,
  location: string,
): void {
  if (putOptions.retainUntil === undefined) return;
  if (!(body instanceof Uint8Array)) body.destroy();
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `The ${kind} storage at ${location} cannot make objects immutable (no object lock support).`,
    {
      hint:
        "Write immutable backups to S3 (Object Lock), Google Cloud Storage (object retention) " +
        `or Azure Blob Storage (version-level immutability), or drop retainDays. See ${IMMUTABLE_GUIDE}.`,
    },
  );
}

/** The hint every adapter gives when a locked object is deleted or overwritten. */
const LOCKED_HINT =
  "The object is under write-once retention (an immutable backup) and can only be removed after it expires.";

/**
 * The error for deleting or overwriting an object whose retention has not expired:
 * `MS_STORAGE_FORBIDDEN` with `details.objectLocked: true`. The flag is what lets
 * prune tell "this backup is still locked, skip it" apart from "the credentials
 * may not delete", which share the error code but need different handling.
 */
export function objectLockedError(
  message: string,
  options: MongoShieldErrorOptions = {},
): MongoShieldError {
  return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
    ...options,
    hint: options.hint ?? LOCKED_HINT,
    details: { ...options.details, objectLocked: true },
  });
}

/** True for errors made by {@link objectLockedError} (a refusal because of retention). */
export function isObjectLockedError(error: unknown): boolean {
  return isMongoShieldError(error, "MS_STORAGE_FORBIDDEN") && error.details?.objectLocked === true;
}

/**
 * Remembers a successful one-off check (such as "does this bucket have Object Lock
 * enabled?") for the adapter's lifetime, so it costs one request per process rather
 * than one per object. This is bucket configuration, not per-run state, so it does
 * not break the "adapters are stateless" rule. Failures are not remembered: after
 * the user fixes the bucket, the next put checks again.
 */
export function onceSuccessful(check: () => Promise<void>): () => Promise<void> {
  let passed: Promise<void> | undefined;
  return () => {
    if (!passed) {
      const attempt = check();
      passed = attempt;
      attempt.catch(() => {
        if (passed === attempt) passed = undefined;
      });
    }
    return passed;
  };
}
