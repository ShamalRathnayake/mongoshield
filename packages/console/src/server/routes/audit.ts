/**
 * The audit log, newest first.
 *
 *   GET /api/audit   viewer   (query: limit ≤ 500, before = ISO date for the next page)
 *
 * Admins see every entry in full. Everyone else sees the same entries without client
 * addresses (`details.address`) and without the usernames typed at failed sign-ins and
 * setups: people often type their password into the username field, and a viewer
 * account (an auto-created proxy user, say) must not learn passwords or the network
 * layout from the log.
 */

import type { Hono } from "hono";
import type { AuditEntry } from "../../shared/api.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { invalid } from "../errors.ts";
import { queryInt } from "../validate.ts";

/** Actions whose `target` is whatever an anonymous visitor typed as the username. */
const ANONYMOUS_TARGET_ACTIONS = new Set([
  "session.login_failed",
  "session.login_throttled",
  "setup.failed",
]);

/** Registers the audit route. */
export function auditRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  app.get("/api/audit", async (c) => {
    const principal = requireRole(c, "viewer");
    const limit = queryInt(c.req.query("limit"), "limit", { min: 1, max: 500, fallback: 100 });
    const before = c.req.query("before");
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw invalid('"before" must be an ISO 8601 date.');
    }
    const entries = await services.audit.read({
      limit,
      ...(before === undefined ? {} : { before }),
    });
    return c.json(principal.user.role === "admin" ? entries : entries.map(withoutPersonalData));
  });
}

/** An entry as non-admins see it (see the file header). */
export function withoutPersonalData(entry: AuditEntry): AuditEntry {
  const { target, details, ...rest } = entry;
  const keptTarget = ANONYMOUS_TARGET_ACTIONS.has(entry.action) ? undefined : target;
  let keptDetails = details;
  if (details !== undefined && Object.hasOwn(details, "address")) {
    const { address: _address, ...others } = details;
    keptDetails = others;
  }
  return {
    ...rest,
    ...(keptTarget === undefined ? {} : { target: keptTarget }),
    ...(keptDetails === undefined ? {} : { details: keptDetails }),
  };
}
