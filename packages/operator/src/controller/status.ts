/**
 * Writing status through the status subresource, only when it changed.
 *
 * Skipping identical writes matters: every write bumps the resourceVersion and
 * produces a watch event, which would trigger another reconcile, which would write
 * again… Comparing first keeps the controller quiet once the world matches the spec.
 */

import { isDeepStrictEqual } from "node:util";
import type { KubeClient, ResourceType } from "../kube/client.ts";
import type { KubeObject } from "../kube/objects.ts";

/**
 * Replaces the object's status with `status`: a merge patch with every field, and
 * `null` for top-level fields that were set before but are not anymore. Returns the
 * object as stored afterwards (the input itself when nothing had to be written).
 *
 * The patch carries the object's resourceVersion, which makes it conditional: if the
 * object changed since it was read, the status may describe an outdated spec, so the
 * write fails with 409 Conflict and the reconcile is retried with the newer object.
 */
export async function updateStatus<S extends object, T extends KubeObject & { status?: S }>(
  client: KubeClient,
  type: ResourceType,
  object: T,
  status: S,
): Promise<T> {
  if (isDeepStrictEqual(normalize(object.status ?? {}), normalize(status))) return object;
  const patch: Record<string, unknown> = { ...(status as Record<string, unknown>) };
  // Merge patches only add and change; fields that disappeared must be nulled.
  for (const key of Object.keys(object.status ?? {})) {
    if (!(key in patch) || patch[key] === undefined) patch[key] = null;
  }
  return client.mergePatch<T>(
    type,
    object.metadata.namespace ?? "",
    object.metadata.name ?? "",
    { metadata: { resourceVersion: object.metadata.resourceVersion }, status: patch },
    "status",
  );
}

/** Drops undefined values so `{a: undefined}` and `{}` compare equal. */
function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
