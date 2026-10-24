/**
 * Config export.
 *
 *   GET /api/config/export   viewer → `{ filename, content }` (a mongoshield.config.ts)
 *
 * The file contains no secrets (they are `process.env` references), which is
 * why viewers may download it.
 */

import type { Hono } from "hono";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import { renderConfig } from "../config-export.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";

/** Registers the config routes. */
export function configRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/config/export", async (c) => {
    const principal = requireRole(c, "viewer");
    const exported = renderConfig(services.store.current, services.dataDir, services.now());
    await recordAudit(services, { actor: principal, action: "config.export", outcome: "success" });
    return c.json(exported);
  });
}
