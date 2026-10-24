/**
 * Owner references: how the objects the operator creates are tied to the resource
 * they were created for.
 *
 * With a controller owner reference, Kubernetes' garbage collector deletes a plan's
 * CronJob and ConfigMap when the plan is deleted, and `kubectl describe` shows who
 * manages what. Owners must be in the same namespace as their dependents.
 */

import type { KubeObject, OwnerReference } from "../kube/objects.ts";

/** A controller owner reference pointing at `owner`. */
export function controllerReference(owner: KubeObject): OwnerReference {
  return {
    apiVersion: owner.apiVersion ?? "",
    kind: owner.kind ?? "",
    name: owner.metadata.name ?? "",
    uid: owner.metadata.uid ?? "",
    controller: true,
    // Foreground deletion of the owner waits for this dependent to be gone.
    blockOwnerDeletion: true,
  };
}

/** True when `object` has an owner reference to `owner` (matched by uid). */
export function isOwnedBy(object: KubeObject, owner: KubeObject): boolean {
  const uid = owner.metadata.uid;
  return (
    uid !== undefined && (object.metadata.ownerReferences ?? []).some((ref) => ref.uid === uid)
  );
}

/** The controller owner of `object` of the given kind, if any. */
export function controllerOf(object: KubeObject, kind: string): OwnerReference | undefined {
  return (object.metadata.ownerReferences ?? []).find(
    (ref) => ref.controller === true && ref.kind === kind,
  );
}
