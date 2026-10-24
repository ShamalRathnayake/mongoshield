/**
 * Vercel Cron route: a daily MongoDB backup with MongoShield (Next.js App Router).
 *
 * vercel.json schedules a GET to /api/backup. Vercel signs cron requests with
 * `Authorization: Bearer <CRON_SECRET>`; anything else is rejected, so nobody on
 * the internet can trigger backups (and the load and storage costs they bring).
 */

import { timingSafeEqual } from "node:crypto";
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

// The Node.js runtime: MongoShield needs node:stream, node:zlib and TCP sockets,
// none of which exist in the Edge runtime.
export const runtime = "nodejs";

// Never cache or prerender this route.
export const dynamic = "force-dynamic";

// Seconds this function may run. The ceiling depends on your plan (with Fluid
// compute: 300 s on Hobby, 800 s on Pro/Enterprise at the time of writing). The
// backup is aborted a little before it, so a cut-off run fails cleanly.
export const maxDuration = 300;

/** Seconds kept back for verification, pruning and the response. */
const SAFETY_MARGIN_SECONDS = 30;

export async function GET(request: Request): Promise<Response> {
  if (!isFromVercelCron(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shield = new MongoShield({
    source: { uri: requiredEnv("MONGODB_URI") },
    storage: s3Storage({
      bucket: requiredEnv("BACKUP_BUCKET"),
      prefix: "mongodb/",
      // For Cloudflare R2, Backblaze B2 and other S3-compatible stores:
      ...(process.env.BACKUP_S3_ENDPOINT ? { endpoint: process.env.BACKUP_S3_ENDPOINT } : {}),
    }),
    // Public key only: this deployment can create backups but never read them.
    encryption: { recipients: [requiredEnv("BACKUP_PUBLIC_KEY")] },
  });

  try {
    const backup = await shield.backup({
      exclude: ["*.sessions"],
      labels: { trigger: "vercel-cron" },
      signal: AbortSignal.timeout((maxDuration - SAFETY_MARGIN_SECONDS) * 1000),
    });
    const report = await shield.verify({ backup: backup.id, mode: "fast" });
    await shield.prune({ daily: 7, weekly: 4, monthly: 12 });

    return Response.json({ id: backup.id, verified: report.ok, totals: backup.manifest.totals });
  } catch (error) {
    // MongoShield errors never contain the connection string's password.
    console.error("MongoShield backup failed", error);
    return Response.json({ error: "backup failed" }, { status: 500 });
  } finally {
    await shield.close();
  }
}

/** Constant-time comparison of the Authorization header with the CRON_SECRET. */
function isFromVercelCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if the secret is not configured
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set the ${name} environment variable.`);
  return value;
}
