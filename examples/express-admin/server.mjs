/**
 * A minimal, protected admin endpoint that triggers a MongoDB backup.
 *
 *   POST /admin/backups          start a backup; 202 + { id: <run id> }, or 409 if one is running
 *   GET  /admin/backups/current  status of the current / last run
 *
 * Read README.md before deploying this. An endpoint that starts backups costs
 * database load and storage money every time it is called, so it must never be
 * reachable by the public. Restores are deliberately NOT exposed over HTTP.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { MongoShield } from "mongoshield";
import { s3Storage } from "mongoshield/storage/s3";

const ADMIN_TOKEN = requiredEnv("ADMIN_TOKEN");
if (ADMIN_TOKEN.length < 32) {
  throw new Error("ADMIN_TOKEN must be at least 32 characters (e.g. `openssl rand -hex 32`).");
}

const shield = new MongoShield({
  source: { uri: requiredEnv("MONGODB_URI") },
  storage: s3Storage({ bucket: requiredEnv("BACKUP_BUCKET"), prefix: "mongodb/" }),
  // Public key only: this server can create backups but can never read them.
  encryption: { recipients: [requiredEnv("BACKUP_PUBLIC_KEY")] },
});

/**
 * The current or most recent run. Only one backup at a time: a second request while
 * one runs gets 409 instead of doubling the load on the database.
 */
let lastRun; // { runId, status: "running" | "succeeded" | "failed", startedAt, backupId?, error? }

const app = express();
app.disable("x-powered-by");

/** Bearer-token check with a constant-time comparison (no timing side channel). */
function requireAdminToken(request, response, next) {
  const expected = Buffer.from(`Bearer ${ADMIN_TOKEN}`);
  const actual = Buffer.from(request.get("authorization") ?? "");
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return next();
  response.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
}

app.use("/admin", requireAdminToken);

app.post("/admin/backups", (_request, response) => {
  if (lastRun?.status === "running") {
    return response.status(409).json({ error: "a backup is already running", run: lastRun });
  }
  lastRun = { runId: randomUUID(), status: "running", startedAt: new Date().toISOString() };
  const run = lastRun;

  // Respond immediately: a backup can take far longer than any HTTP timeout.
  response.status(202).location("/admin/backups/current").json(run);

  shield
    .backup({
      exclude: ["*.sessions"],
      // Labels are stored in the manifest: an audit trail of who triggered what.
      labels: { trigger: "admin-api", runId: run.runId },
      signal: AbortSignal.timeout(2 * 60 * 60 * 1000),
    })
    .then((backup) => {
      Object.assign(run, { status: "succeeded", backupId: backup.id });
    })
    .catch((error) => {
      // Log the details server-side; return only the stable code to the client.
      console.error("Backup failed", error);
      Object.assign(run, { status: "failed", error: error?.code ?? "MS_INTERNAL" });
    });
});

app.get("/admin/backups/current", (_request, response) => {
  response.json(lastRun ?? { status: "idle" });
});

// Bind to localhost by default: expose it through a VPN, an internal load balancer
// or `kubectl port-forward`, never directly to the internet.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, host, () => console.log(`Admin API on http://${host}:${port}`));

// On shutdown, stop accepting requests and close the storage client.
process.on("SIGTERM", () => {
  server.close(() => shield.close().finally(() => process.exit(0)));
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set the ${name} environment variable.`);
  return value;
}
