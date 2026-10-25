import { MongoShieldError } from "../errors.ts";

/**
 * Validates a storage key. Keys are relative POSIX paths. This check is the single
 * line of defence against path traversal for every adapter, so it is strict.
 */
export function assertValidKey(key: string): void {
  const problem = keyProblem(key);
  if (problem) {
    throw new MongoShieldError("MS_STORAGE_IO", `Invalid storage key "${key}": ${problem}.`);
  }
}

/** Validates a listing prefix: empty, or a valid key optionally ending in `/`. */
export function assertValidPrefix(prefix: string): void {
  if (prefix === "") return;
  assertValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

function keyProblem(key: string): string | undefined {
  if (key.length === 0) return "key is empty";
  if (key.length > 1024) return "key is longer than 1024 characters";
  if (key.startsWith("/")) return "key must be relative";
  if (key.includes("\\")) return "backslashes are not allowed";
  if (key.includes("\0")) return "NUL characters are not allowed";
  for (const segment of key.split("/")) {
    if (segment === "") return "empty path segments are not allowed";
    if (segment === "." || segment === "..") return "relative segments are not allowed";
  }
  return undefined;
}

/** Joins key segments with `/`, validating the result. */
export function joinKey(...segments: readonly string[]): string {
  const key = segments.filter((s) => s.length > 0).join("/");
  assertValidKey(key);
  return key;
}
