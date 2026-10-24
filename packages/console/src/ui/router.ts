/**
 * A tiny hash-based router: `#/backups/s3-main/2026-10-21T02-00-04Z_7f3a9c?tab=browse`.
 *
 * Hash URLs need no server-side routing (the server only serves index.html and the
 * bundle), survive reloads, and work with the browser's back button. The router is a
 * handful of pure functions (`parseLocation`, `matchPath`, `buildHref`) plus one React
 * hook that re-renders when the hash changes.
 */

import { useEffect, useState } from "react";

/** The current location inside the app. */
export interface AppLocation {
  /** Path without the leading `#`, always starting with `/`, e.g. `/plans/abc`. */
  readonly path: string;
  /** Query parameters after `?` inside the hash. */
  readonly query: URLSearchParams;
}

/** Splits `#/plans/abc?tab=x` into path and query. An empty hash means `/`. */
export function parseLocation(hash: string): AppLocation {
  const withoutHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const questionMark = withoutHash.indexOf("?");
  const rawPath = questionMark === -1 ? withoutHash : withoutHash.slice(0, questionMark);
  const rawQuery = questionMark === -1 ? "" : withoutHash.slice(questionMark + 1);
  const path = rawPath === "" ? "/" : rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return { path, query: new URLSearchParams(rawQuery) };
}

/**
 * Matches a path against a pattern such as `/backups/:storageId/:backupId`.
 * Returns the decoded parameters, or undefined when it does not match.
 * Trailing slashes are ignored; segments must match one-to-one.
 */
export function matchPath(
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(path);
  if (patternSegments.length !== pathSegments.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] ?? "";
    const actual = pathSegments[index] ?? "";
    if (expected.startsWith(":")) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        // A malformed escape (`%E0%A4%A`) cannot be a valid id; treat as no match.
        return undefined;
      }
    } else if (expected !== actual) {
      return undefined;
    }
  }
  return params;
}

function splitSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * Builds an `href` for a path and optional query: `buildHref("/jobs/a b")` → `#/jobs/a%20b`.
 * Pass path segments that may contain special characters through `segment()` first.
 */
export function buildHref(
  path: string,
  query?: Readonly<Record<string, string | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const queryString = search.toString();
  return queryString === "" ? `#${path}` : `#${path}?${queryString}`;
}

/** URL-encodes one path segment (ids may contain characters such as `:`). */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** Goes to another page, adding a history entry. */
export function navigate(path: string, query?: Readonly<Record<string, string | undefined>>): void {
  window.location.hash = buildHref(path, query);
}

/** Changes the query of the current page without adding a history entry (tabs, filters). */
export function replaceQuery(query: Readonly<Record<string, string | undefined>>): void {
  const { path } = parseLocation(window.location.hash);
  const href = buildHref(path, query);
  window.history.replaceState(null, "", href);
  // replaceState does not fire `hashchange`, so tell useLocation() ourselves.
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The current location; re-renders the component when the hash changes. */
export function useLocation(): AppLocation {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener("hashchange", update);
    // The hash may have changed between the first render and this effect.
    update();
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return parseLocation(hash);
}
