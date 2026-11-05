/**
 * Config export and import.
 *
 *   GET  /api/config/export   admin → `{ filename, content }` (a mongoshield.config.ts)
 *   POST /api/config/import   admin → dry run or apply (see config-import.ts)
 *
 * The export contains no secrets (they are `process.env` references), but it is a
 * map of the infrastructure: every connection's hosts, storage buckets and URLs, and
 * what each plan includes. Viewers see plans and connections one by one in the UI,
 * yet a single file of all of it is admin material, like the configuration it is
 * made from (the UI offers the download to admins only).
 *
 * The import creates connections and storage and changes plans, which is admin
 * work; it is applied all or nothing, in one state
 * update that re-plans against the current state, so a dry run that went stale
 * (someone renamed a plan meanwhile) cannot apply half of its changes.
 */

import type { Hono } from "hono";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import { renderConfig } from "../config-export.ts";
import { type ImportPlan, parseImportRequest, planImport } from "../config-import.ts";
import type { AppEnv, ConsoleServices, Principal } from "../context.ts";
import { readJson } from "../security.ts";
import { asObject } from "../validate.ts";

/** Registers the config routes. */
export function configRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/config/export", async (c) => {
    const principal = requireRole(c, "admin");
    const exported = renderConfig(services.store.current, services.dataDir, services.now());
    await recordAudit(services, { actor: principal, action: "config.export", outcome: "success" });
    return c.json(exported);
  });

  app.post("/api/config/import", async (c) => {
    const principal = requireRole(c, "admin");
    const request = parseImportRequest(asObject(await readJson(c)));
    const context = {
      store: services.store,
      dataDir: services.dataDir,
      now: services.now(),
      allowUnsafeTargets: services.settings.allowUnsafeTargets === true,
    };

    let plan: ImportPlan;
    if (request.dryRun) {
      plan = planImport(services.store.current, request, context);
    } else {
      plan = await services.store.update((draft) => {
        const fresh = planImport(draft, request, context);
        fresh.applyTo(draft);
        return fresh;
      });
      services.schedules.sync();
      await auditAppliedImport(services, principal, plan);
    }

    await recordAudit(services, {
      actor: principal,
      action: request.dryRun ? "config.import_preview" : "config.import",
      outcome: "success",
      details: {
        plans: request.configs.size,
        creates: plan.result.changes.filter((change) => change.action === "create").length,
        updates: plan.result.changes.filter((change) => change.action === "update").length,
      },
    });
    return c.json(plan.result);
  });
}

/** One audit entry per record an import created or changed (names and ids only). */
async function auditAppliedImport(
  services: ConsoleServices,
  principal: Principal,
  plan: ImportPlan,
): Promise<void> {
  for (const connection of plan.createdConnections) {
    await recordAudit(services, {
      actor: principal,
      action: "connection.create",
      target: connection.name,
      outcome: "success",
      details: { id: connection.id, production: connection.production, via: "import" },
    });
  }
  for (const storage of plan.createdStorage) {
    await recordAudit(services, {
      actor: principal,
      action: "storage.create",
      target: storage.name,
      outcome: "success",
      details: { id: storage.id, url: storage.url, via: "import" },
    });
  }
  for (const [action, plans] of [
    ["plan.create", plan.createdPlans],
    ["plan.update", plan.updatedPlans],
  ] as const) {
    for (const record of plans) {
      await recordAudit(services, {
        actor: principal,
        action,
        target: record.name,
        outcome: "success",
        details: { id: record.id, scheduled: record.schedule !== undefined, via: "import" },
      });
    }
  }
}
