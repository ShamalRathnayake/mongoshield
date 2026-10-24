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
 * Metrics (Prometheus text exposition format 0.0.4):
 *
 *   from the console's job history (the last 500 jobs)
 *     mongoshield_console_jobs{kind,status}                    jobs by kind and outcome
 *     mongoshield_console_jobs_running                         jobs running right now
 *     mongoshield_backup_last_success_timestamp_seconds{plan}  last successful backup per plan
 *     mongoshield_backup_last_duration_seconds{plan}           duration of the last finished backup per plan
 *
 *   from the change journal of each storage location that has one (`journalStatus`)
 *     mongoshield_recovery_point_timestamp_seconds{storage}    every change up to this time is journaled
 *     mongoshield_journal_rpo_seconds{storage}                 how far that is behind now (the live RPO)
 *     mongoshield_journal_gaps{storage}                        recorded gaps (lost history)
 *     mongoshield_journal_status_ok{storage}                   1 when the status could be read, else 0
 *
 * Alert on `time() - mongoshield_recovery_point_timestamp_seconds > <your RPO>`:
 * it keeps growing when the journal writer stops, which a writer cannot report itself.
 *
 * Reading journal status lists objects in every storage location, so results are
 * cached for {@link JOURNAL_CACHE_MS} (scrapes every 15 s do not become 4 listings
 * a minute per bucket) and each read has a timeout, so a slow bucket cannot hang
 * the scrape.
 */

import type { Hono } from "hono";
import { type JournalStatus, journalStatus, type StorageAdapter } from "mongoshield";
import type { JobSummary } from "../../shared/api.ts";
import { constantTimeEqual } from "../../state/crypto.ts";
import type { StorageRecord } from "../../state/types.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError } from "../errors.ts";

/** How long journal status is reused between scrapes. */
export const JOURNAL_CACHE_MS = 30_000;
/** Longest wait for one storage location's journal status. */
const JOURNAL_TIMEOUT_MS = 10_000;

/** Reads a journal's status; injectable so tests can make it fail. */
export type JournalStatusReader = (
  storage: StorageAdapter,
  options: { readonly now: Date; readonly signal: AbortSignal },
) => Promise<JournalStatus>;

/** Options for {@link healthRoutes}. */
export interface HealthRouteOptions {
  readonly readJournalStatus?: JournalStatusReader;
}

/** The journal status of one storage location, as last read. */
export type JournalReading =
  | { readonly ok: true; readonly status: JournalStatus }
  | { readonly ok: false };

/** Registers `/healthz` and `/metrics`. */
export function healthRoutes(
  app: Hono<AppEnv>,
  services: ConsoleServices,
  options: HealthRouteOptions = {},
): void {
  const journals = new JournalCache(services, options.readJournalStatus ?? journalStatus);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/metrics", async (c) => {
    const token = services.settings.metricsToken;
    if (token === undefined)
      throw new ConsoleError(404, "CONSOLE_NOT_FOUND", "Metrics are disabled.");
    const presented = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (presented === undefined || !constantTimeEqual(presented, token)) {
      c.header("WWW-Authenticate", 'Bearer realm="mongoshield-console"');
      throw new ConsoleError(401, "CONSOLE_UNAUTHENTICATED", "A valid metrics token is required.");
    }
    const readings = await journals.read();
    return c.body(renderMetrics(services, readings), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}

/** Journal status per storage location, cached (see the file header). */
class JournalCache {
  readonly #services: ConsoleServices;
  readonly #reader: JournalStatusReader;
  #cached: { readonly at: number; readonly readings: Map<string, JournalReading> } | undefined;

  constructor(services: ConsoleServices, reader: JournalStatusReader) {
    this.#services = services;
    this.#reader = reader;
  }

  /** Readings by storage id; locations without a journal are left out. */
  async read(): Promise<ReadonlyMap<string, JournalReading>> {
    const now = this.#services.now();
    const cached = this.#cached;
    if (cached !== undefined && Math.abs(now.getTime() - cached.at) < JOURNAL_CACHE_MS) {
      return cached.readings;
    }
    const readings = new Map<string, JournalReading>();
    await Promise.all(
      this.#services.store.current.storage.map(async (record) => {
        const reading = await this.#readOne(record, now);
        if (reading !== undefined) readings.set(record.id, reading);
      }),
    );
    this.#cached = { at: now.getTime(), readings };
    return readings;
  }

  async #readOne(record: StorageRecord, now: Date): Promise<JournalReading | undefined> {
    try {
      const adapter = await this.#services.storage.adapterFor(record);
      const status = await this.#reader(adapter, {
        now,
        signal: AbortSignal.timeout(JOURNAL_TIMEOUT_MS),
      });
      // No segments and no recovery point: this location has no journal at all.
      if (status.recoveryPoint === undefined && status.segments === 0) return undefined;
      return { ok: true, status };
    } catch (error) {
      this.#services.logger.warn("Cannot read the journal status for metrics", {
        storage: record.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  }
}

/** The Prometheus text exposition of the metrics listed in the file header. */
export function renderMetrics(
  services: ConsoleServices,
  journals: ReadonlyMap<string, JournalReading> = new Map(),
): string {
  const lines: string[] = [];
  renderJobMetrics(services, lines);
  renderJournalMetrics(services, journals, lines);
  return `${lines.join("\n")}\n`;
}

/** One gauge family: `# HELP`, `# TYPE` and its samples. */
function gauge(lines: string[], name: string, help: string, samples: readonly string[]): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples);
}

function renderJobMetrics(services: ConsoleServices, lines: string[]): void {
  const jobs = services.runner.list();
  const planNames = new Map(services.store.current.plans.map((plan) => [plan.id, plan.name]));

  const counts = new Map<string, number>();
  for (const job of jobs) {
    const key = `kind="${job.kind}",status="${job.status}"`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  gauge(
    lines,
    "mongoshield_console_jobs",
    "Jobs in the console's history, by kind and status.",
    [...counts].sort().map(([labels, count]) => `mongoshield_console_jobs{${labels}} ${count}`),
  );
  gauge(lines, "mongoshield_console_jobs_running", "Jobs running right now.", [
    `mongoshield_console_jobs_running ${services.runner.running().length}`,
  ]);

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

  const successSamples: string[] = [];
  for (const [planId, job] of lastSuccess) {
    const name = planNames.get(planId);
    if (name === undefined || job.finishedAt === undefined) continue;
    successSamples.push(
      `mongoshield_backup_last_success_timestamp_seconds{plan="${escapeLabel(name)}"} ${Date.parse(job.finishedAt) / 1000}`,
    );
  }
  gauge(
    lines,
    "mongoshield_backup_last_success_timestamp_seconds",
    "When the last successful backup of each plan finished.",
    successSamples,
  );

  const durationSamples: string[] = [];
  for (const [planId, job] of lastFinished) {
    const name = planNames.get(planId);
    if (name === undefined || job.startedAt === undefined || job.finishedAt === undefined) continue;
    const seconds = (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000;
    durationSamples.push(
      `mongoshield_backup_last_duration_seconds{plan="${escapeLabel(name)}"} ${seconds}`,
    );
  }
  gauge(
    lines,
    "mongoshield_backup_last_duration_seconds",
    "How long the last finished backup of each plan took.",
    durationSamples,
  );
}

function renderJournalMetrics(
  services: ConsoleServices,
  journals: ReadonlyMap<string, JournalReading>,
  lines: string[],
): void {
  const recoveryPoints: string[] = [];
  const rpos: string[] = [];
  const gaps: string[] = [];
  const ok: string[] = [];
  for (const record of services.store.current.storage) {
    const reading = journals.get(record.id);
    if (reading === undefined) continue;
    const label = `storage="${escapeLabel(record.name)}"`;
    ok.push(`mongoshield_journal_status_ok{${label}} ${reading.ok ? 1 : 0}`);
    if (!reading.ok) continue;
    const { status } = reading;
    if (status.recoveryPointDate !== undefined) {
      recoveryPoints.push(
        `mongoshield_recovery_point_timestamp_seconds{${label}} ${status.recoveryPointDate.getTime() / 1000}`,
      );
    }
    if (status.rpoMs !== undefined) {
      rpos.push(`mongoshield_journal_rpo_seconds{${label}} ${status.rpoMs / 1000}`);
    }
    gaps.push(`mongoshield_journal_gaps{${label}} ${status.gaps.length}`);
  }
  gauge(
    lines,
    "mongoshield_recovery_point_timestamp_seconds",
    "Every change up to this time is in the storage location's change journal.",
    recoveryPoints,
  );
  gauge(
    lines,
    "mongoshield_journal_rpo_seconds",
    "How far the journal's recovery point is behind now.",
    rpos,
  );
  gauge(lines, "mongoshield_journal_gaps", "Recorded gaps (lost history) in the journal.", gaps);
  gauge(
    lines,
    "mongoshield_journal_status_ok",
    "1 when the journal status of the storage location could be read, else 0.",
    ok,
  );
}

/**
 * Escapes a label value as the Prometheus text format requires: backslash,
 * double quote and line feed (everything else, including other control
 * characters, is allowed inside the quotes).
 */
export function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}
