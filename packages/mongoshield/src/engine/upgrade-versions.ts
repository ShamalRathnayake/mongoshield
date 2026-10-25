/**
 * MongoDB server versions, for upgrade rehearsals: parsing `"8.0"` / `"7.0.32"`,
 * comparing them, and working out the in-place upgrade path.
 *
 * Why the path matters: an in-place upgrade (new binaries on the same data files)
 * can only move one major release at a time, and each step ends with
 * `setFeatureCompatibilityVersion` before the next one may start. MongoDB's own
 * upgrade guide says so for every release, e.g. for 8.0: "To upgrade an existing
 * MongoDB deployment to 8.0, you must be running a 7.0-series release"
 * (https://www.mongodb.com/docs/manual/release-notes/8.0-upgrade-replica-set/).
 * A rehearsal restores the backup logically into the target version, which skips
 * those steps, so the report lists them: production still has to walk through each.
 *
 * Release numbering (https://www.mongodb.com/docs/manual/reference/versioning/):
 * until 4.4 every `x.y` with an even `y` was a release series (3.6, 4.0, 4.2, 4.4);
 * since 5.0 only `x.0` is a long-term release and `x.1`–`x.3` are Rapid Releases,
 * which fold into the next `x.0` (7.0 includes 6.1, 6.2 and 6.3).
 */

import { MongoShieldError } from "../errors.ts";

/** A server version: major, minor and (when known) patch. */
export interface ServerVersion {
  readonly major: number;
  readonly minor: number;
  /** Undefined for `"8.0"`, which means "any 8.0 patch release". */
  readonly patch: number | undefined;
}

/**
 * Release series an in-place upgrade steps through, oldest first. Before 5.0 the
 * series were the even minor versions; from 5.0 on, each major's `.0` release.
 * Newer majors than the last one listed are added as `<major>.0` by `upgradePath`.
 */
export const RELEASE_SERIES: readonly string[] = [
  "3.6",
  "4.0",
  "4.2",
  "4.4",
  "5.0",
  "6.0",
  "7.0",
  "8.0",
];

/**
 * The newest release whose compatibility notes MongoShield encodes. A rehearsal
 * for a newer target still runs, with a warning that newer notes were not checked.
 */
export const NEWEST_KNOWN_RELEASE = "8.0";

/** `8`, `8.0`, `8.0.13`, optionally followed by `-rc1` or `+build` suffixes. */
const VERSION_PATTERN = /^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,4}))?(?:[-+][0-9A-Za-z.-]*)?$/;

/**
 * Parses a version string, or returns undefined when it is not one (manifests of
 * imported dumps may say `"unknown"`, servers report `"0.0.0"` when they cannot tell).
 */
export function parseServerVersion(text: string): ServerVersion | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? undefined : Number(match[3]);
  // "0.0.0" is the placeholder describeDeployment() uses for "no version reported".
  if (major === 0 && minor === 0) return undefined;
  return { major, minor, patch };
}

/**
 * Parses the target version of a rehearsal (`--target-version`).
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when it is not `x.y` or `x.y.z`.
 */
export function parseTargetVersion(text: string): ServerVersion {
  const parsed = parseServerVersion(text);
  if (parsed === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `"${text}" is not a MongoDB version (expected e.g. "8.0" or "8.0.13").`,
      { hint: "Pass the release you are upgrading to, e.g. --target-version 8.0." },
    );
  }
  return parsed;
}

/**
 * Orders two versions by major, then minor, then patch. A missing patch counts as
 * equal to any patch, so `"8.0"` and `"8.0.13"` compare as the same release.
 * Returns a negative number, zero or a positive number, like `Array.sort` expects.
 */
export function compareVersions(a: ServerVersion, b: ServerVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch === undefined || b.patch === undefined) return 0;
  return a.patch - b.patch;
}

/** True when `version` is `since` or newer (`since` is a release like `"5.1"`). */
export function isAtLeast(version: ServerVersion, since: string): boolean {
  return compareVersions(version, releaseOf(since)) >= 0;
}

/** `"8.0"` for 8.0.13: the release series a version belongs to, as text. */
export function releaseName(version: ServerVersion): string {
  return `${version.major}.${version.minor}`;
}

/** Formats a version as the user wrote it (`"8.0"` or `"8.0.13"`). */
export function formatVersion(version: ServerVersion): string {
  return version.patch === undefined
    ? releaseName(version)
    : `${releaseName(version)}.${version.patch}`;
}

/**
 * The releases an in-place upgrade from `source` to `target` steps through, ending
 * with the target's release: 6.0 → 8.0 gives `["7.0", "8.0"]`, 7.3 → 8.0 gives
 * `["8.0"]` (a Rapid Release upgrades to the next long-term release), 6.0 → 8.2
 * gives `["7.0", "8.0", "8.2"]`. Empty when the target is not newer than the source.
 */
export function upgradePath(source: ServerVersion, target: ServerVersion): string[] {
  const targetRelease = releaseOf(releaseName(target));
  const sourceRelease = releaseOf(releaseName(source));
  if (compareVersions(targetRelease, sourceRelease) <= 0) return [];

  // Every release series strictly between source and target…
  const series = [...RELEASE_SERIES];
  const lastKnownMajor = releaseOf(series.at(-1) ?? NEWEST_KNOWN_RELEASE).major;
  for (let major = lastKnownMajor + 1; major <= target.major; major += 1) series.push(`${major}.0`);
  const steps = series.filter((name) => {
    const release = releaseOf(name);
    return (
      compareVersions(release, sourceRelease) > 0 && compareVersions(release, targetRelease) < 0
    );
  });
  // …then the target itself (a long-term release or a Rapid Release).
  steps.push(releaseName(target));
  return steps;
}

/** Parses a release name this module itself defines (always valid). */
function releaseOf(name: string): ServerVersion {
  const [major, minor] = name.split(".").map(Number);
  return { major: major ?? 0, minor: minor ?? 0, patch: undefined };
}
