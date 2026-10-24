/**
 * Stored records → API views.
 *
 * This is the one place where records with secrets become response bodies, so
 * it is where the "never return a secret" rule is enforced: each view copies
 * the fields it wants, one by one. A secret field added to a record later is
 * therefore never exposed by accident; it has to be added here on purpose.
 */

import type { ConnectionView, JobSummary, PlanView, StorageView, UserView } from "../shared/api.ts";
import type { ConnectionRecord, PlanRecord, StorageRecord, UserRecord } from "../state/types.ts";

/** A user, without the password hash. */
export function userView(user: UserRecord): UserView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    // Accounts without a password hash can only sign in through SSO (OIDC or the proxy).
    signIn: user.passwordHash === "" ? "sso" : "password",
    createdAt: user.createdAt,
    ...(user.lastLoginAt === undefined ? {} : { lastLoginAt: user.lastLoginAt }),
  };
}

/** A connection, with only the redacted URI preview. */
export function connectionView(connection: ConnectionRecord): ConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    uri: { configured: true, preview: connection.uriPreview },
    production: connection.production,
    createdAt: connection.createdAt,
  };
}

/** A storage location, with credential names but never their values. */
export function storageView(storage: StorageRecord): StorageView {
  const names = storage.credentialNames ?? [];
  return {
    id: storage.id,
    name: storage.name,
    url: storage.url,
    credentials:
      storage.credentials === undefined
        ? { configured: false }
        : { configured: true, preview: names.map((name) => `${name}=***`).join(", ") },
    createdAt: storage.createdAt,
  };
}

/** A plan, with its passphrase and notification URLs reduced to summaries. */
export function planView(
  plan: PlanRecord,
  extra: { readonly nextRunAt?: Date; readonly lastRun?: JobSummary },
): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    connectionId: plan.connectionId,
    storageId: plan.storageId,
    include: plan.include,
    exclude: plan.exclude,
    compression: plan.compression,
    encryption:
      plan.encryption.kind === "passphrase"
        ? { kind: "passphrase", passphrase: { configured: true } }
        : plan.encryption,
    consistency: plan.consistency,
    ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
    ...(plan.retention === undefined ? {} : { retention: plan.retention }),
    verify: plan.verify,
    notify: plan.notify.map((target) => ({
      type: target.type,
      url: { configured: true, preview: target.urlPreview },
    })),
    ...(extra.nextRunAt === undefined ? {} : { nextRunAt: extra.nextRunAt.toISOString() }),
    ...(extra.lastRun === undefined ? {} : { lastRun: extra.lastRun }),
  };
}
