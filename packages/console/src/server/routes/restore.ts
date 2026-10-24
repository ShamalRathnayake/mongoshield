/**
 * Restores: a dry-run plan first, then the job.
 *
 *   POST /api/restore/plan   operator (admin for production targets)
 *   POST /api/restore        operator (admin + typed confirmation for production targets)
 *
 * Restore safety rules (docs/specs/CONSOLE.md, "Restore safety"):
 * - Operators may restore only into connections NOT marked production.
 * - Restoring into a production connection needs an admin, and the request must
 *   carry `confirmName` equal to the connection's name: the UI makes the user
 *   type it, so a mis-click cannot overwrite production.
 * - The library itself refuses to overwrite existing data unless `mode` says so,
 *   and refuses any plan with a conflict.
 * - With `filter`, only matching documents are restored (per document, through
 *   `shield.restoreTenant`; see `RestoreRequest.filter` for how modes map). The same
 *   role and confirmation rules apply: a few documents in production are still production.
 */

import type { Context, Hono } from "hono";
import { MongoShieldError, type RestoreMode } from "mongoshield";
import {
  connectionById,
  planRestoreView,
  type RestoreJobInput,
  restoreJob,
  storageById,
} from "../../jobs/tasks.ts";
import { recordAudit } from "../audit.ts";
import { hasRole, requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices, Principal } from "../context.ts";
import { forbidden } from "../errors.ts";
import { parseExtendedJsonFilter } from "../filter.ts";
import { readJson } from "../security.ts";
import {
  asObject,
  backupIdParam,
  type Fields,
  oneOf,
  optionalString,
  optionalStringArray,
  optionalStringMap,
  requiredString,
} from "../validate.ts";

/** Restore modes, safest first. */
const RESTORE_MODES: readonly RestoreMode[] = ["fail-if-exists", "drop", "insert", "upsert"];

/** Registers the restore routes. */
export function restoreRoutes(app: Hono<AppEnv>, services: ConsoleServices): void {
  const { tasks } = services;

  app.post("/api/restore/plan", async (c) => {
    const principal = requireRole(c, "operator");
    // A plan only reads, so it needs no typed confirmation; the target rule still applies.
    const { input } = await parseRequest(c, services);
    authorizeTarget(principal, input);
    return c.json(await planRestoreView(tasks, input));
  });

  app.post("/api/restore", async (c) => {
    const principal = requireRole(c, "operator");
    const { input, confirmName } = await parseRequest(c, services);
    authorizeTarget(principal, input);
    if (input.target.production && confirmName !== input.target.name) {
      await recordAudit(services, {
        actor: principal,
        action: "restore.start",
        target: input.target.name,
        outcome: "failure",
        details: { backup: input.backupId, reason: "confirmation missing" },
      });
      throw new MongoShieldError(
        "MS_CONFIRMATION_REQUIRED",
        `Restoring into the production connection "${input.target.name}" needs confirmation.`,
        { hint: "Type the connection's name to confirm (confirmName)." },
      );
    }
    const job = await services.runner.start(restoreJob(tasks, input, principal.user.username));
    await recordAudit(services, {
      actor: principal,
      action: "restore.start",
      target: input.target.name,
      outcome: "success",
      details: {
        backup: input.backupId,
        storage: input.storage.name,
        mode: input.mode,
        production: input.target.production,
        // Whether only selected documents were restored (the filter itself may hold ids, not logged).
        filtered: input.filter !== undefined,
        job: job.id,
      },
    });
    return c.json(job);
  });
}

/**
 * Parses a `RestoreRequest` body and looks up its storage and target. Also used by
 * the restore preview (restore-preview.ts), which takes the same body.
 */
export async function parseRequest(
  c: Context<AppEnv>,
  services: ConsoleServices,
): Promise<{ readonly input: RestoreJobInput; readonly confirmName: string | undefined }> {
  const body: Fields = asObject(await readJson(c));
  const storage = storageById(services.store, requiredString(body, "storageId", 64));
  const target = connectionById(services.store, requiredString(body, "targetConnectionId", 64));
  const include = optionalStringArray(body, "include");
  const exclude = optionalStringArray(body, "exclude");
  const rename = optionalStringMap(body, "rename");
  const passphrase = optionalString(body, "passphrase", 1024);
  const identities = optionalStringArray(body, "identities", { maxItems: 20, maxLength: 200 });
  const filter = parseExtendedJsonFilter(
    optionalString(body, "filter", Number.MAX_SAFE_INTEGER),
    '"filter"',
  );
  return {
    input: {
      storage,
      backupId: backupIdParam(requiredString(body, "backupId", 64)),
      target,
      mode: oneOf(body, "mode", RESTORE_MODES),
      keys: {
        ...(passphrase === undefined ? {} : { passphrase }),
        ...(identities === undefined ? {} : { identities }),
      },
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
      ...(rename === undefined ? {} : { rename }),
      ...(filter === undefined ? {} : { filter }),
    },
    confirmName: optionalString(body, "confirmName", 100),
  };
}

/** Operators may only restore into (or plan or preview restores into) non-production connections. */
export function authorizeTarget(principal: Principal, input: RestoreJobInput): void {
  if (input.target.production && !hasRole(principal.user.role, "admin")) {
    throw forbidden("Only admins may restore into a production connection.");
  }
}
