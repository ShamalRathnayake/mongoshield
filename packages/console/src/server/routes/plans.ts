/**
 * Backup plans: connection + storage + selection + encryption + schedule +
 * retention + notifications.
 *
 *   GET    /api/plans            viewer
 *   POST   /api/plans            admin
 *   PUT    /api/plans/:id        admin   (omit the passphrase / a notify URL to keep the stored one)
 *   DELETE /api/plans/:id        admin   (backups already taken are kept)
 *   POST   /api/plans/:id/run    operator  → a backup job
 *
 * Plans are admin-only to edit because they hold secrets (backup passphrase,
 * webhook URLs) and decide what leaves the database; running one is an
 * operator action.
 */

import type { Hono } from "hono";
import { checkSchedule } from "../../jobs/schedules.ts";
import { backupJob, connectionById, planById, storageById } from "../../jobs/tasks.ts";
import type { PlanView } from "../../shared/api.ts";
import { randomId } from "../../state/crypto.ts";
import { redactUrlToOrigin } from "../../state/redact.ts";
import { sealNotifyUrl, sealPlanPassphrase } from "../../state/secrets.ts";
import type { NotifyRecord, PlanEncryptionRecord, PlanRecord } from "../../state/types.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { ConsoleError, invalid, notFound } from "../errors.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  type Fields,
  oneOf,
  optionalPositiveInt,
  optionalString,
  optionalStringArray,
  requiredString,
} from "../validate.ts";
import { planView } from "../views.ts";

/** Most notification targets per plan. */
const MAX_NOTIFY = 10;
/** Most age recipients per plan. */
const MAX_RECIPIENTS = 20;
/** Shortest backup passphrase: these protect data at rest for years. */
const MIN_PASSPHRASE_LENGTH = 12;
/** Largest retention count per bucket (about 3 years of dailies). */
const MAX_RETENTION = 1000;

/** Registers the plan routes. */
export function planRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { store } = services;

  /** A plan with its next run and its most recent job. */
  const view = (plan: PlanRecord): PlanView => {
    const lastRun = services.runner.list().find((job) => job.planId === plan.id);
    const nextRunAt = services.schedules.nextRunOf(plan.id);
    return planView(plan, {
      ...(lastRun === undefined ? {} : { lastRun }),
      ...(nextRunAt === undefined ? {} : { nextRunAt }),
    });
  };

  app.get("/api/plans", (c) => {
    requireRole(c, "viewer");
    return c.json(store.current.plans.map(view));
  });

  app.post("/api/plans", async (c) => {
    const principal = requireRole(c, "admin");
    const body = asObject(await readJson(c));
    const id = randomId();
    const record = parsePlan(services, id, body, undefined);
    await store.update((state) => {
      assertNameFree(state.plans, record.name, undefined);
      state.plans = [...state.plans, record];
    });
    services.schedules.sync();
    await recordAudit(services, {
      actor: principal,
      action: "plan.create",
      target: record.name,
      outcome: "success",
      details: { id, scheduled: record.schedule !== undefined },
    });
    return c.json(view(record));
  });

  app.put("/api/plans/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const body = asObject(await readJson(c));
    const existing = planById(store, id);
    const record = parsePlan(services, id, body, existing);
    await store.update((state) => {
      if (!state.plans.some((plan) => plan.id === id)) throw notFound("The plan");
      assertNameFree(state.plans, record.name, id);
      state.plans = state.plans.map((plan) => (plan.id === id ? record : plan));
    });
    services.schedules.sync();
    await recordAudit(services, {
      actor: principal,
      action: "plan.update",
      target: record.name,
      outcome: "success",
      details: { id, scheduled: record.schedule !== undefined },
    });
    return c.json(view(record));
  });

  app.delete("/api/plans/:id", async (c) => {
    const principal = requireRole(c, "admin");
    const id = c.req.param("id");
    const removed = await store.update((state) => {
      const existing = state.plans.find((plan) => plan.id === id);
      if (existing === undefined) throw notFound("The plan");
      state.plans = state.plans.filter((plan) => plan.id !== id);
      return existing;
    });
    services.schedules.sync();
    await recordAudit(services, {
      actor: principal,
      action: "plan.delete",
      target: removed.name,
      outcome: "success",
      details: { id },
    });
    return c.json({ ok: true as const });
  });

  app.post("/api/plans/:id/run", async (c) => {
    const principal = requireRole(c, "operator");
    const plan = planById(store, c.req.param("id"));
    const job = await services.runner.start(
      backupJob(services.tasks, plan, principal.user.username),
    );
    await recordAudit(services, {
      actor: principal,
      action: "plan.run",
      target: plan.name,
      outcome: "success",
      details: { plan: plan.id, job: job.id },
    });
    return c.json(job);
  });
}

/** Validates a plan body into a record; `existing` supplies kept secrets on update. */
function parsePlan(
  services: ConsoleServices,
  id: string,
  body: Fields,
  existing: PlanRecord | undefined,
): PlanRecord {
  const connectionId = requiredString(body, "connectionId", 64);
  const storageId = requiredString(body, "storageId", 64);
  // Both must exist (404 otherwise), so a plan never points at nothing.
  connectionById(services.store, connectionId);
  storageById(services.store, storageId);

  const schedule = parseSchedule(body.schedule);
  const retention = parseRetention(body.retention);
  return {
    id,
    name: requiredString(body, "name", 100),
    connectionId,
    storageId,
    include: optionalStringArray(body, "include") ?? [],
    exclude: optionalStringArray(body, "exclude") ?? [],
    compression: oneOf(body, "compression", ["zstd", "gzip", "none"]),
    encryption: parseEncryption(services, id, body.encryption, existing),
    consistency: oneOf(body, "consistency", ["auto", "none", "snapshot", "converge"]),
    verify: oneOf(body, "verify", ["none", "fast", "deep"]),
    notify: parseNotify(services, id, body.notify, existing),
    createdAt: existing?.createdAt ?? services.now().toISOString(),
    ...(schedule === undefined ? {} : { schedule }),
    ...(retention === undefined ? {} : { retention }),
  };
}

function parseEncryption(
  services: ConsoleServices,
  planId: string,
  value: unknown,
  existing: PlanRecord | undefined,
): PlanEncryptionRecord {
  const fields = asObject(value, '"encryption"');
  const kind = oneOf(fields, "kind", ["none", "recipients", "passphrase"]);
  if (kind === "none") return { kind };
  if (kind === "recipients") {
    const recipients =
      optionalStringArray(fields, "recipients", { maxItems: MAX_RECIPIENTS, maxLength: 200 }) ?? [];
    if (recipients.length === 0 || !recipients.every((recipient) => recipient.startsWith("age1"))) {
      throw invalid('"encryption.recipients" must list age public keys (age1…).');
    }
    return { kind, recipients };
  }
  const passphrase = optionalString(fields, "passphrase", 1024);
  if (passphrase === undefined) {
    // Keep the stored passphrase, if there is one.
    if (existing?.encryption.kind === "passphrase") return existing.encryption;
    throw invalid('"encryption.passphrase" is required.');
  }
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw invalid(
      `The backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long.`,
    );
  }
  return { kind, passphrase: sealPlanPassphrase(services.store, planId, passphrase) };
}

function parseNotify(
  services: ConsoleServices,
  planId: string,
  value: unknown,
  existing: PlanRecord | undefined,
): NotifyRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTIFY) {
    throw invalid(`"notify" must be a list of at most ${MAX_NOTIFY} targets.`);
  }
  return value.map((item: unknown, index): NotifyRecord => {
    const fields = asObject(item, `"notify[${index}]"`);
    const type = oneOf(fields, "type", ["webhook", "slack", "discord"]);
    const url = optionalString(fields, "url", 2048);
    if (url === undefined) {
      // Keep the URL stored at the same position.
      const kept = existing?.notify[index];
      if (kept === undefined) throw invalid(`"notify[${index}].url" is required.`);
      return { ...kept, type };
    }
    if (!/^https?:\/\//i.test(url)) throw invalid(`"notify[${index}].url" must be an http(s) URL.`);
    return {
      type,
      url: sealNotifyUrl(services.store, planId, url),
      urlPreview: redactUrlToOrigin(url),
    };
  });
}

function parseSchedule(value: unknown): PlanRecord["schedule"] {
  if (value === undefined || value === null) return undefined;
  const fields = asObject(value, '"schedule"');
  const cron = requiredString(fields, "cron", 100);
  const timezone = optionalString(fields, "timezone", 64)?.trim() || "UTC";
  checkSchedule(cron, timezone);
  return { cron, timezone };
}

function parseRetention(value: unknown): PlanRecord["retention"] {
  if (value === undefined || value === null) return undefined;
  const fields = asObject(value, '"retention"');
  const retention: Record<string, number> = {};
  for (const bucket of ["last", "daily", "weekly", "monthly", "yearly"] as const) {
    const count = optionalPositiveInt(fields, bucket, MAX_RETENTION);
    if (count !== undefined && count > 0) retention[bucket] = count;
  }
  // A policy without any count says nothing; refuse it so the UI never stores an ambiguous one.
  if (Object.keys(retention).length === 0) {
    throw invalid(
      '"retention" needs at least one positive count, or leave it out to keep everything.',
    );
  }
  return retention;
}

function assertNameFree(
  plans: readonly PlanRecord[],
  name: string,
  exceptId: string | undefined,
): void {
  if (plans.some((plan) => plan.name === name && plan.id !== exceptId)) {
    throw new ConsoleError(409, "CONSOLE_CONFLICT", `A plan named "${name}" already exists.`);
  }
}
