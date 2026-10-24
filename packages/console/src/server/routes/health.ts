/**
 * Health and metrics, for load balancers and Prometheus.
 *
 *   GET /healthz   no auth   200 `{ "ok": true }` while the process serves requests
 *   GET /metrics   bearer token (MONGOSHIELD_METRICS_TOKEN); 404 when no token is set
 *
 * `/healthz` says nothing else on purpose (no version, no counts): it is
 * reachable without signing in. `/metrics` is disabled unless a token is
 * configured, because plan names and job counts describe your infrastructure.
 *
 * Metrics are computed from the console's job history (the last 500 jobs):
 *   mongoshield_console_jobs{kind,status}                    jobs by kind and outcome
 *   mongoshield_backup_last_success_timestamp_seconds{plan}  last successful backup per plan
 *   mongoshield_backup_last_duration_seconds{plan}           duration of the last finished backup per plan
 *   mongoshield_console_jobs_running                         jobs running right now
 */

import type { Hono } from "hono";
import type { JobSummary } from "../../shared/api.ts";
import { constantTimeEqual } from "../../state/crypto.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError } from "../errors.ts";

/** Registers `/healthz` and `/metrics`. */
export function healthRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/metrics", (c) => {
    const token = services.settings.metricsToken;
    if (token === undefined)
      throw new ConsoleError(404, "CONSOLE_NOT_FOUND", "Metrics are disabled.");
    const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (presented === undefined || !constantTimeEqual(presented, token)) {
      c.header("WWW-Authenticate", 'Bearer realm="mongoshield-console"');
      throw new ConsoleError(401, "CONSOLE_UNAUTHENTICATED", "A valid metrics token is required.");
    }
    return c.body(renderMetrics(services), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}

/** The Prometheus text exposition of the metrics listed in the file header. */
export function renderMetrics(services: ConsoleServices): string {
  const jobs = services.runner.list();
  const planNames = new Map(services.store.current.plans.map((plan) => [plan.id, plan.name]));
  const lines: string[] = [];

  lines.push(
    "# HELP mongoshield_console_jobs Jobs in the console's history, by kind and status.",
    "# TYPE mongoshield_console_jobs gauge",
  );
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const key = `kind="${job.kind}",status="${job.status}"`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [labels, count] of [...counts].sort()) {
    lines.push(`mongoshield_console_jobs{${labels}} ${count}`);
  }

  lines.push(
    "# HELP mongoshield_console_jobs_running Jobs running right now.",
    "# TYPE mongoshield_console_jobs_running gauge",
    `mongoshield_console_jobs_running ${services.runner.running().length}`,
  );

  const lastSuccess = new Map<string, JobSummary>();
  const lastFinished = new Map<string, JobSummary>();
  // History is newest first, so the first match per plan is the latest.
  for (const job of jobs) {
    if (job.kind !== "backup" || job.planId === undefined) continue;
    if (job.status === "succeeded" && !lastSuccess.has(job.planId))
      lastSuccess.set(job.planId, job);
    if (job.finishedAt !== undefined && !lastFinished.has(job.planId))
      lastFinished.set(job.planId, job);
  }

  lines.push(
    "# HELP mongoshield_backup_last_success_timestamp_seconds When the last successful backup of each plan finished.",
    "# TYPE mongoshield_backup_last_success_timestamp_seconds gauge",
  );
  for (const [planId, job] of lastSuccess) {
    const name = planNames.get(planId);
    if (name === undefined || job.finishedAt === undefined) continue;
    lines.push(
      `mongoshield_backup_last_success_timestamp_seconds{plan="${escapeLabel(name)}"} ${Date.parse(job.finishedAt) / 1000}`,
    );
  }

  lines.push(
    "# HELP mongoshield_backup_last_duration_seconds How long the last finished backup of each plan took.",
    "# TYPE mongoshield_backup_last_duration_seconds gauge",
  );
  for (const [planId, job] of lastFinished) {
    const name = planNames.get(planId);
    if (name === undefined || job.startedAt === undefined || job.finishedAt === undefined) continue;
    const seconds = (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000;
    lines.push(`mongoshield_backup_last_duration_seconds{plan="${escapeLabel(name)}"} ${seconds}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Escapes a label value as the Prometheus text format requires. */
function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
