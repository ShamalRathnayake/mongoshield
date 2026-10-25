/**
 * Atomic file replacement: write a temp file, fsync it, rename it over the
 * target, fsync the directory.
 *
 * A crash at any point leaves either the old file or the new one, never a
 * truncated mix: rename() within one directory is atomic on POSIX file
 * systems, and the two fsyncs make sure the data and the rename itself reach
 * the disk before we report success.
 */

import { randomBytes } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Replaces `path` with `content` atomically. The file is created with mode 0600:
 * console.json holds password hashes and encrypted secrets, which no other user
 * on the host needs to read.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  // Hidden, random temp name in the same directory (rename across file systems is not atomic).
  const temp = join(directory, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(directory);
}

/** fsyncs a directory so a rename in it is durable. Not supported on every platform. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // Windows cannot open directories; the rename is still atomic there.
  } finally {
    await handle?.close();
  }
}
