/**
 * Equality-based label selectors: building them for list/watch calls, and matching
 * them locally (the informer caches are filtered with the same rules).
 *
 * Only the two forms the operator uses are supported: `key=value` and bare `key`
 * (the label exists). Clauses are separated by commas and must all match.
 */

/** Builds `a=1,b=2` from a map; keys are sorted so the string is stable. */
export function selectorFrom(labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
}

/** True when `labels` satisfy every clause of `selector` (an empty selector matches all). */
export function matchesSelector(
  labels: Readonly<Record<string, string>> | undefined,
  selector: string | undefined,
): boolean {
  if (!selector) return true;
  for (const clause of selector.split(",")) {
    const trimmed = clause.trim();
    if (trimmed === "") continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      // Bare key: the label must exist, whatever its value.
      if (labels?.[trimmed] === undefined) return false;
      continue;
    }
    const key = trimmed.slice(0, equals);
    const value = trimmed.slice(equals + 1);
    if (labels?.[key] !== value) return false;
  }
  return true;
}
