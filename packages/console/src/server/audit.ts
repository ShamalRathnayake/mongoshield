/**
 * Writing audit entries from routes. Every route that changes something, and
 * every login attempt, records who did what to which target and whether it
 * worked. `details` must never contain secrets; routes pass only ids, names,
 * modes and counts.
 */

import type { AuditEntry } from "../shared/api.ts";
import type { ConsoleServices, Principal } from "./context.ts";

/** An audit entry without its timestamp (added here from the console's clock). */
export type AuditInput = Omit<AuditEntry, "at" | "actor"> & {
  /** A principal, or a fixed actor such as "anonymous". */
  readonly actor: Principal | string;
};

/** Appends one entry to the audit log. */
export async function recordAudit(services: ConsoleServices, input: AuditInput): Promise<void> {
  const { actor, ...rest } = input;
  await services.audit.append({
    at: services.now().toISOString(),
    actor: typeof actor === "string" ? actor : actor.user.username,
    ...rest,
  });
}
