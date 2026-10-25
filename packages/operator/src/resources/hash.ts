/**
 * Stable hashes of desired state.
 *
 * The operator stores a hash of what it wanted an object to look like in the
 * object's `mongoshield.io/spec-hash` annotation, and rewrites the object only when
 * the hash of the new desired state differs. Comparing live specs instead would see
 * a difference on every reconcile, because the API server fills in defaults
 * (dnsPolicy, schedulerName, terminationMessagePath, …) that the operator never sets.
 */

import { createHash } from "node:crypto";

/** A short hash of a JSON value; object keys are sorted so key order never matters. */
export function hashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** JSON with object keys sorted at every level. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
