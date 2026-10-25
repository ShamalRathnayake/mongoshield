/**
 * Adding and removing finalizers.
 *
 * Finalizers are written with a merge patch that carries the object's
 * resourceVersion, so the write fails with 409 Conflict instead of overwriting a
 * finalizer some other controller added in the meantime (merge patches replace whole
 * lists). The controller then simply retries with the fresh object.
 */

import type { KubeClient, ResourceType } from "../kube/client.ts";
import type { KubeObject } from "../kube/objects.ts";

/** True when the object carries the finalizer. */
export function hasFinalizer(object: KubeObject, finalizer: string): boolean {
  return (object.metadata.finalizers ?? []).includes(finalizer);
}

/** Adds the finalizer if missing; returns the updated object. */
export async function addFinalizer<T extends KubeObject>(
  client: KubeClient,
  type: ResourceType,
  object: T,
  finalizer: string,
): Promise<T> {
  if (hasFinalizer(object, finalizer)) return object;
  const finalizers = [...(object.metadata.finalizers ?? []), finalizer];
  return client.mergePatch<T>(type, object.metadata.namespace ?? "", object.metadata.name ?? "", {
    metadata: { finalizers, resourceVersion: object.metadata.resourceVersion },
  });
}

/**
 * Removes the finalizer if present. If the object is being deleted and this was its
 * last finalizer, the API server deletes it right after.
 */
export async function removeFinalizer<T extends KubeObject>(
  client: KubeClient,
  type: ResourceType,
  object: T,
  finalizer: string,
): Promise<void> {
  if (!hasFinalizer(object, finalizer)) return;
  const finalizers = (object.metadata.finalizers ?? []).filter((name) => name !== finalizer);
  await client.mergePatch<T>(type, object.metadata.namespace ?? "", object.metadata.name ?? "", {
    // An empty list must be sent as such; `null` would also work but reads worse.
    metadata: { finalizers, resourceVersion: object.metadata.resourceVersion },
  });
}

/**
 * Makes the object carry exactly the wanted finalizers among the ones named in
 * `wanted` (true: present, false: absent), in one conditional patch. Finalizers not
 * named are left as they are. Returns the updated object (the input when nothing
 * had to change).
 */
export async function syncFinalizers<T extends KubeObject>(
  client: KubeClient,
  type: ResourceType,
  object: T,
  wanted: Readonly<Record<string, boolean>>,
): Promise<T> {
  const current = object.metadata.finalizers ?? [];
  const next = current.filter((name) => wanted[name] !== false);
  for (const [name, present] of Object.entries(wanted)) {
    if (present && !next.includes(name)) next.push(name);
  }
  if (next.length === current.length && next.every((name, index) => name === current[index])) {
    return object;
  }
  return client.mergePatch<T>(type, object.metadata.namespace ?? "", object.metadata.name ?? "", {
    metadata: { finalizers: next, resourceVersion: object.metadata.resourceVersion },
  });
}
