import { describe, expect, it } from "vitest";
import { backupTuningFromConfig } from "./backup-tuning.ts";

describe("backupTuningFromConfig", () => {
  it("turns backup.usersAndRoles into includeUsersAndRoles", () => {
    expect(backupTuningFromConfig({ usersAndRoles: true })).toEqual({ includeUsersAndRoles: true });
    expect(backupTuningFromConfig({ usersAndRoles: false })).toEqual({
      includeUsersAndRoles: false,
    });
  });

  it("sets nothing for settings that are not configured", () => {
    expect(backupTuningFromConfig({})).toEqual({});
    expect(backupTuningFromConfig(undefined)).toEqual({});
  });
});
