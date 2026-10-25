/**
 * Create-or-update for the objects a plan owns (its ConfigMap and CronJob).
 *
 *   - missing                     → create it
 *   - exists, owned, same hash    → nothing to do
 *   - exists, owned, other hash   → replace it with the desired state (conditional
 *                                   on its resourceVersion)
 *   - exists, NOT owned by us     → refuse: never take over someone else's object
 *
 * "Owned" means it has an owner reference to the plan (matched by uid), which also
 * tells apart a plan that was deleted and re-created with the same name.
 */

import { ANNOTATIONS } from "../api/constants.ts";
import { isOwnedBy } from "../controller/ownership.ts";
import type { KubeClient, ResourceType } from "../kube/client.ts";
import type { KubeObject } from "../kube/objects.ts";

/** What `ensureOwned` did. */
export type EnsureOutcome = "created" | "updated" | "unchanged";

/** Thrown when the name is taken by an object the owner does not own. */
export class NameConflictError extends Error {
  override readonly name = "NameConflictError";
}

/** Makes the object match `desired` (see the file header). */
export async function ensureOwned<T extends KubeObject>(
  client: KubeClient,
  type: ResourceType,
  owner: KubeObject,
  desired: T,
): Promise<EnsureOutcome> {
  const namespace = desired.metadata.namespace ?? "";
  const name = desired.metadata.name ?? "";
  const existing = await client.get<T>(type, namespace, name);
  if (!existing) {
    await client.create(type, namespace, desired);
    return "created";
  }
  if (!isOwnedBy(existing, owner)) {
    throw new NameConflictError(
      `${type.kind} ${name} already exists and is not managed by ${owner.kind} ${owner.metadata.name}; rename or delete it`,
    );
  }
  const wanted = desired.metadata.annotations?.[ANNOTATIONS.specHash];
  if (wanted !== undefined && existing.metadata.annotations?.[ANNOTATIONS.specHash] === wanted) {
    return "unchanged";
  }
  await client.replace(type, namespace, {
    ...desired,
    metadata: { ...desired.metadata, resourceVersion: existing.metadata.resourceVersion },
  });
  return "updated";
}
