/**
 * `rename` that survives Windows' transient sharing violations.
 *
 * On Windows, renaming onto (or away from) a file fails with EPERM, EBUSY or EACCES
 * while another program holds it open without FILE_SHARE_DELETE: Microsoft Defender
 * scanning a file that was just written, the search indexer, a backup or sync
 * client. The lock usually lasts a few milliseconds to a few hundred, so the
 * rename is retried with a short, growing pause, the way npm and git do. Elsewhere
 * those codes mean a real permission problem, and the first error is final.
 *
 *   await renameWithRetry(temporaryPath, finalPath);
 */

import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** Errno codes Windows reports for a file another process holds open. */
const WINDOWS_SHARING_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Pauses between attempts, in milliseconds: 6 attempts over about 1.5 s in total,
 * enough for an antivirus scan of a freshly written file, short enough that a real
 * permission error is still reported promptly.
 */
const RETRY_DELAYS_MS = [20, 50, 100, 250, 500, 600] as const;

/** Options for {@link renameWithRetry}; the defaults are right outside tests. */
export interface RenameRetryOptions {
  /** The platform whose rules apply. Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Stops waiting between attempts (the pending error is thrown). */
  readonly signal?: AbortSignal | undefined;
}

/** True when `error` from a rename on `platform` is worth retrying (see the file header). */
export function isTransientRenameError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && WINDOWS_SHARING_CODES.has(error.code);
}

/**
 * Renames `from` to `to`, replacing `to` if it exists, retrying Windows' transient
 * sharing violations. Throws the last error when the retries run out.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error, platform)) throw error;
      if (options.signal?.aborted) throw error;
      await sleep(delay, undefined, options.signal ? { signal: options.signal } : {}).catch(() => {
        // Aborted while waiting: report the rename's own error below.
      });
      if (options.signal?.aborted) throw error;
    }
  }
}
