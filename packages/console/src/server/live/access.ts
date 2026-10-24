/**
 * Who may change live data, and where.
 *
 * Reading live documents needs the operator role (like browsing backup documents:
 * operators may restore that data anyway). Changing them needs all of:
 *
 *   1. the operator role or higher,
 *   2. the `data:write` permission on the user (granted by an admin; separate from roles,
 *      so even admins must be granted it explicitly),
 *   3. "Allow live edits" turned on for the connection by an admin,
 *   4. for a connection marked production, that setting confirmed for production (the
 *      admin typed the connection's name and gave a reason). Marking a connection
 *      production later turns live edits off (routes/connections.ts), and this check is
 *      the second line of defence.
 *
 * Every check runs on the server for every request; the UI only mirrors them to hide
 * buttons that would fail.
 */

import type { Context } from "hono";
import {
  LIVE_BULK_DEFAULT_LIMIT,
  type LiveEditSettingsView,
  type Permission,
} from "../../shared/api.ts";
import type { ConnectionRecord, UserRecord } from "../../state/types.ts";
import { hasRole, requireRole } from "../auth.ts";
import type { AppEnv, Principal } from "../context.ts";
import { ConsoleError, forbidden } from "../errors.ts";

/** The permission that allows live writes. */
export const DATA_WRITE: Permission = "data:write";

/** True when the user holds a permission (and a role that may use it). */
export function hasPermission(user: UserRecord, permission: Permission): boolean {
  return hasRole(user.role, "operator") && (user.permissions ?? []).includes(permission);
}

/** Why a user may not write to a connection, or `undefined` when they may. */
export function liveWriteRefusal(
  user: UserRecord,
  connection: ConnectionRecord,
): ConsoleError | undefined {
  if (!hasPermission(user, DATA_WRITE)) {
    return forbidden("Changing live data needs the data:write permission, which an admin grants.");
  }
  const settings = connection.liveEdits;
  if (settings === undefined || !settings.enabled) {
    return new ConsoleError(
      403,
      "CONSOLE_LIVE_EDITS_DISABLED",
      `Live edits are turned off for the connection "${connection.name}".`,
      'An admin can turn on "Allow live edits" on the connection page.',
    );
  }
  if (connection.production && !settings.productionConfirmed) {
    return new ConsoleError(
      403,
      "CONSOLE_LIVE_EDITS_DISABLED",
      `"${connection.name}" is marked production and live edits were not confirmed for production.`,
      "An admin must turn live edits on again, typing the connection's name and a reason.",
    );
  }
  return undefined;
}

/**
 * The signed-in principal if they may write to `connection` (role, permission and the
 * connection's settings), else `401`/`403`. The role and permission are checked before
 * the connection is looked up, so a refused caller learns nothing about connection ids.
 */
export function requireLiveWriter(c: Context<AppEnv>): Principal {
  const principal = requireRole(c, "operator");
  if (!hasPermission(principal.user, DATA_WRITE)) {
    throw forbidden("Changing live data needs the data:write permission, which an admin grants.");
  }
  return principal;
}

/** Throws the refusal for a connection, if there is one. */
export function assertLiveWritable(principal: Principal, connection: ConnectionRecord): void {
  const refusal = liveWriteRefusal(principal.user, connection);
  if (refusal !== undefined) throw refusal;
}

/** A connection's live edit settings as the API shows them (defaults when never set). */
export function liveEditSettingsView(connection: ConnectionRecord): LiveEditSettingsView {
  const settings = connection.liveEdits;
  if (settings === undefined) {
    return {
      enabled: false,
      productionConfirmed: false,
      maxBulkDocuments: LIVE_BULK_DEFAULT_LIMIT,
    };
  }
  return {
    enabled: settings.enabled,
    productionConfirmed: settings.productionConfirmed,
    changedBy: settings.changedBy,
    changedAt: settings.changedAt,
    ...(settings.reason === undefined ? {} : { reason: settings.reason }),
    ...(settings.journalStorageId === undefined
      ? {}
      : { journalStorageId: settings.journalStorageId }),
    maxBulkDocuments: settings.maxBulkDocuments,
  };
}
