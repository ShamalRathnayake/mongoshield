/**
 * Netlify background function: backs up MongoDB to Google Drive, verifies the backup
 * and prunes old ones. Started by backup-schedule.mts.
 *
 * CAVEAT: this relies on UNDOCUMENTED behaviour (a scheduled function starting a
 * background function) and is meant for SMALL databases. A background function runs
 * for at most 15 minutes; the backup is aborted a little before that, and an aborted
 * backup is never marked complete, but nothing retries it. The recommended runner is
 * GitHub Actions (`npx mongoshield init --github`); see docs/guides/atlas-free-netlify.md.
 *
 * The "-background" suffix of the file name is what makes Netlify run it as a
 * background function: the caller gets 202 at once and the work continues.
 */

import { timingSafeEqual } from "node:crypto";
import { MongoShield } from "mongoshield";
import { gdriveStorageFromUrl } from "mongoshield/storage/gdrive";

/** Netlify's limit for background functions, in seconds. */
const BACKGROUND_LIMIT_SECONDS = 15 * 60;
/** Seconds kept back for verification and pruning after the backup itself. */
const SAFETY_MARGIN_SECONDS = 90;

export default async (request: Request): Promise<void> => {
  if (!isFromScheduler(request)) {
    console.error("Rejected a backup request without the right x-backup-secret header.");
    return;
  }

  const shield = new MongoShield({
    source: { uri: requiredEnv("MONGODB_URI") },
    // gdrive://<folder>, with the token from MONGOSHIELD_GDRIVE_TOKEN (and your own
    // OAuth client from MONGOSHIELD_GDRIVE_CLIENT_ID / _CLIENT_SECRET, if you use one).
    storage: gdriveStorageFromUrl(
      new URL(`gdrive://${process.env.BACKUP_FOLDER ?? "netlify"}`),
      process.env,
    ),
    // Public key only: this site can create backups but never read them.
    encryption: { recipients: [requiredEnv("MONGOSHIELD_RECIPIENTS")] },
  });

  try {
    const backup = await shield.backup({
      exclude: ["*.sessions"],
      labels: { trigger: "netlify" },
      signal: AbortSignal.timeout((BACKGROUND_LIMIT_SECONDS - SAFETY_MARGIN_SECONDS) * 1000),
    });
    const report = await shield.verify({ backup: backup.id, mode: "fast" });
    const pruned = await shield.prune({ last: 7, weekly: 4, monthly: 6 });
    console.log(
      `Backup ${backup.id}: verified ${report.ok ? "ok" : "with problems"}, ` +
        `${pruned.deletedBackups} old backup(s) pruned.`,
    );
  } catch (error) {
    // MongoShield errors never contain the connection string's password or the token.
    console.error("MongoShield backup failed", error);
  } finally {
    await shield.close();
  }
};

/** Constant-time comparison of the x-backup-secret header with BACKUP_TRIGGER_SECRET. */
function isFromScheduler(request: Request): boolean {
  const secret = process.env.BACKUP_TRIGGER_SECRET;
  if (!secret) return false; // fail closed if the secret is not configured
  const expected = Buffer.from(secret);
  const actual = Buffer.from(request.headers.get("x-backup-secret") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set the ${name} environment variable.`);
  return value;
}
