// Unit tests for how backups and restores adapt to MongoDB Atlas (atlas-adapt.ts):
// the shared-tier defaults, that explicit settings always win, and the refusals of
// users and roles. The deployments are written by hand, as describeDeployment
// reports them for an Atlas Free cluster, a dedicated Atlas cluster and a local server.

import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import type { LogFields, Logger } from "../logger.ts";
import { ATLAS_SHARED_TIER_TUNING, type DeploymentInfo } from "../mongo/index.ts";
import {
  adaptBackupReads,
  adaptRestoreConcurrency,
  assertUsersAndRolesBackupSupported,
  assertUsersAndRolesRestoreSupported,
  logBackupAdaptation,
} from "./atlas-adapt.ts";

const local: DeploymentInfo = {
  topology: "replicaSet",
  serverVersion: "8.0.15",
  clusterId: "0".repeat(32),
  supportsChangeStreams: true,
  supportsSnapshotReads: true,
  maxBsonObjectSize: 16 * 1024 * 1024,
};
const atlasFree: DeploymentInfo = {
  ...local,
  atlas: { tier: "shared", signals: ["host cluster0.abcde.mongodb.net"] },
};
const atlasDedicated: DeploymentInfo = {
  ...local,
  atlas: { tier: "dedicated", signals: ["host cluster0.abcde.mongodb.net"] },
};

/** A logger that keeps every message with its level. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (message: string, _fields?: LogFields): void => {
      lines.push(`${level}: ${message}`);
    };
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

describe("adaptBackupReads", () => {
  it("changes nothing off the shared tiers", () => {
    for (const deployment of [local, atlasDedicated]) {
      expect(adaptBackupReads({ maxBytesPerSecond: 10 }, 4, deployment)).toEqual({
        parallelism: 4,
        rateLimits: { maxDocumentsPerSecond: undefined, maxBytesPerSecond: 10 },
        adjustments: [],
      });
    }
  });

  it("lowers the default parallelism and limits reads on a shared tier", () => {
    expect(adaptBackupReads({}, 4, atlasFree)).toEqual({
      parallelism: ATLAS_SHARED_TIER_TUNING.parallelism,
      rateLimits: { maxBytesPerSecond: ATLAS_SHARED_TIER_TUNING.maxBytesPerSecond },
      adjustments: ["parallelism 2", "reads limited to 4 MiB/s"],
    });
  });

  it("keeps an explicit parallelism, even a higher one", () => {
    const adapted = adaptBackupReads({ parallelism: 8 }, 8, atlasFree);
    expect(adapted.parallelism).toBe(8);
    expect(adapted.adjustments).toEqual(["reads limited to 4 MiB/s"]);
  });

  it("never raises a parallelism that is already lower", () => {
    expect(adaptBackupReads({}, 1, atlasFree).parallelism).toBe(1);
  });

  it("keeps any explicit read limit as it is, and adds no other", () => {
    const byDocuments = adaptBackupReads({ maxDocumentsPerSecond: 500 }, 4, atlasFree);
    expect(byDocuments.rateLimits).toEqual({
      maxDocumentsPerSecond: 500,
      maxBytesPerSecond: undefined,
    });
    expect(byDocuments.adjustments).toEqual(["parallelism 2"]);
    const byBytes = adaptBackupReads({ maxBytesPerSecond: 1024 }, 4, atlasFree);
    expect(byBytes.rateLimits.maxBytesPerSecond).toBe(1024);
  });
});

describe("logBackupAdaptation", () => {
  it("logs nothing off Atlas", () => {
    const logger = recordingLogger();
    logBackupAdaptation(logger, adaptBackupReads({}, 4, local), local);
    expect(logger.lines).toEqual([]);
  });

  it("logs the detection, and the adjustments with how to override them", () => {
    const logger = recordingLogger();
    logBackupAdaptation(logger, adaptBackupReads({}, 4, atlasFree), atlasFree);
    expect(logger.lines).toEqual([
      "debug: MongoDB Atlas detected",
      expect.stringMatching(
        /^info: Atlas Free\/Flex tier detected: parallelism 2, reads limited to 4 MiB\/s .*override/,
      ),
    ]);
  });

  it("only logs the detection when nothing had to change", () => {
    const logger = recordingLogger();
    logBackupAdaptation(logger, adaptBackupReads({}, 4, atlasDedicated), atlasDedicated);
    expect(logger.lines).toEqual(["debug: MongoDB Atlas detected"]);
  });
});

describe("assertUsersAndRolesBackupSupported", () => {
  it("refuses users and roles from a shared tier with the Atlas hint", () => {
    let caught: unknown;
    try {
      assertUsersAndRolesBackupSupported({ includeUsersAndRoles: true }, atlasFree);
    } catch (error) {
      caught = error;
    }
    expect(isMongoShieldError(caught, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(isMongoShieldError(caught) && caught.hint).toContain("atlas dbusers list");
  });

  it("allows them elsewhere, and allows backups without them everywhere", () => {
    expect(() =>
      assertUsersAndRolesBackupSupported({ includeUsersAndRoles: true }, atlasDedicated),
    ).not.toThrow();
    expect(() =>
      assertUsersAndRolesBackupSupported({ includeUsersAndRoles: true }, local),
    ).not.toThrow();
    expect(() => assertUsersAndRolesBackupSupported({}, atlasFree)).not.toThrow();
  });
});

describe("assertUsersAndRolesRestoreSupported", () => {
  it.each(["create", "replace"] as const)("refuses usersAndRoles %s on any Atlas tier", (mode) => {
    for (const deployment of [atlasFree, atlasDedicated]) {
      expect(() =>
        assertUsersAndRolesRestoreSupported({ usersAndRoles: mode }, deployment),
      ).toThrow(/cannot be restored into MongoDB Atlas/);
    }
  });

  it("allows skipping them on Atlas, and restoring them elsewhere", () => {
    expect(() => assertUsersAndRolesRestoreSupported({}, atlasFree)).not.toThrow();
    expect(() =>
      assertUsersAndRolesRestoreSupported({ usersAndRoles: "skip" }, atlasDedicated),
    ).not.toThrow();
    expect(() =>
      assertUsersAndRolesRestoreSupported({ usersAndRoles: "create" }, local),
    ).not.toThrow();
  });
});

describe("adaptRestoreConcurrency", () => {
  const defaults = { parallelism: 4, insertWorkers: 2 };

  it("changes nothing off the shared tiers", () => {
    expect(adaptRestoreConcurrency({}, defaults, atlasDedicated)).toEqual({
      ...defaults,
      adjustments: [],
    });
  });

  it("lowers the defaults on a shared tier", () => {
    expect(adaptRestoreConcurrency({}, defaults, atlasFree)).toEqual({
      parallelism: 2,
      insertWorkers: 1,
      adjustments: ["parallelism 2", "1 insert worker per collection"],
    });
  });

  it("keeps explicit settings and never raises low ones", () => {
    expect(
      adaptRestoreConcurrency(
        { parallelism: 6, insertWorkers: 3 },
        { parallelism: 6, insertWorkers: 3 },
        atlasFree,
      ),
    ).toEqual({ parallelism: 6, insertWorkers: 3, adjustments: [] });
    expect(adaptRestoreConcurrency({}, { parallelism: 1, insertWorkers: 1 }, atlasFree)).toEqual({
      parallelism: 1,
      insertWorkers: 1,
      adjustments: [],
    });
  });
});
