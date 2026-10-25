/**
 * The audit log, newest first.
 *
 *   GET /api/audit   viewer   (query: limit ≤ 500, before = ISO date for the next page)
 */

import type { Hono } from "hono";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { invalid } from "../errors.ts";
import { queryInt } from "../validate.ts";

/** Registers the audit route. */
export function auditRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/audit", async (c) => {
    requireRole(c, "viewer");
    const limit = queryInt(c.req.query("limit"), "limit", { min: 1, max: 500, fallback: 100 });
    const before = c.req.query("before");
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw invalid('"before" must be an ISO 8601 date.');
    }
    return c.json(
      await services.audit.read({ limit, ...(before === undefined ? {} : { before }) }),
    );
  });
}
