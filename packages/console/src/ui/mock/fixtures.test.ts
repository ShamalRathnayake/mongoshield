/**
 * Tests for the mock fixtures: they must look the same at any time of day, because the
 * UI tests depend on their shape (the newest backup is unverified, and so on).
 */

import { describe, expect, it } from "vitest";
import { createFixtures } from "./fixtures.ts";

/** The newest complete backup in `st-s3`, as the backup detail tests pick it. */
function newestComplete(now: number) {
  const backups = createFixtures(now).backups.filter(
    (backup) => backup.storageId === "st-s3" && backup.status === "complete",
  );
  backups.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return backups[0];
}

describe("createFixtures", () => {
  it.each([
    ["just after midnight UTC", "2026-11-05T00:10:00Z"],
    ["just before the 02:00 UTC backup", "2026-11-05T01:59:00Z"],
    ["just after it", "2026-11-05T02:00:05Z"],
    ["in the afternoon", "2026-11-05T15:30:00Z"],
  ])("keeps the newest backup unverified %s", (_, at) => {
    const newest = newestComplete(Date.parse(at));
    expect(newest?.verification).toBeUndefined();
    expect(Date.parse(newest?.startedAt ?? "")).toBeLessThanOrEqual(Date.parse(at));
  });
});
