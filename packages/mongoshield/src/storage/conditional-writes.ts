/**
 * The error an adapter throws when the store turns out not to support
 * `put(…, { ifNoneMatch: "*" })` after all, and the check for it.
 *
 * An adapter's `capabilities.conditionalWrites` is decided up front, but some
 * stores can only be found out at run time: an S3-compatible service may answer
 * 501 NotImplemented, or ignore the header (src/storage/s3.ts probes for that).
 * Such a put fails with MS_CONFIG_INVALID carrying the marker below, so callers can
 * react precisely. The same error (marked `inconclusive`) is raised when the check
 * itself fails, for example because the role may not write the probe object:
 * - the storage lock (src/schedule/lock-storage.ts) refuses, with a hint to use the
 *   mongo lock, because a lock without create-if-absent is no lock;
 * - the manifest write (src/format/manifest-io.ts) retries without the condition,
 *   which only guarded against a duplicate backup id.
 */

import { MongoShieldError } from "../errors.ts";

/** `details.reason` of the error, the marker `isConditionalWritesUnsupported` looks for. */
const REASON = "conditional-writes-unsupported";

/** Extra facts for {@link conditionalWritesUnsupportedError}. */
export interface ConditionalWritesUnsupportedOptions {
  /**
   * The store could not be checked (the probe failed for a reason that says
   * nothing about conditional writes, such as a permission or network error),
   * rather than shown not to honour them. Only the message changes: callers
   * react the same way, since neither case proves that create-if-absent works.
   */
  readonly inconclusive?: boolean;
}

/**
 * The error for a conditional put to a store without working conditional writes,
 * or to one whose support could not be confirmed (`inconclusive`).
 *
 * @param target - the full location of the object (`s3://bucket/prefix/key`).
 */
export function conditionalWritesUnsupportedError(
  target: string,
  cause?: unknown,
  options: ConditionalWritesUnsupportedOptions = {},
): MongoShieldError {
  const message = options.inconclusive
    ? `Could not write ${target} with a condition: checking whether this storage service supports conditional writes (If-None-Match) failed, so they are not used.`
    : `Could not write ${target}: this storage service does not support conditional writes (If-None-Match).`;
  return new MongoShieldError("MS_CONFIG_INVALID", message, {
    ...(cause === undefined ? {} : { cause }),
    details: { reason: REASON, ...(options.inconclusive ? { inconclusive: true } : {}) },
    hint:
      'The storage lock needs them: set schedule.lock to "mongo" (or "none" if only one runner ' +
      "can ever start). To skip the check on a service you know supports them, pass " +
      "conditionalWrites: true (s3:// URLs: ?conditionalWrites=true).",
  });
}

/** True for the error made by {@link conditionalWritesUnsupportedError}. */
export function isConditionalWritesUnsupported(error: unknown): error is MongoShieldError {
  return (
    error instanceof MongoShieldError &&
    error.code === "MS_CONFIG_INVALID" &&
    error.details?.reason === REASON
  );
}
