import { MongoClient, MongoNetworkError, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { generateIdentity } from "../crypto/index.ts";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { DeploymentInfo } from "../mongo/index.ts";
import { chooseConsistency, resolveConsistencyMode } from "./backup-consistency.ts";
import { toBackupError } from "./backup-errors.ts";
import {
  assertQueriesMatchNamespaces,
  DEFAULT_BACKUP_PARALLELISM,
  planEncryption,
  validateBackupOptions,
} from "./backup-options.ts";

/** Runs `action` and returns the error code it threw. */
function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return isMongoShieldError(error) ? error.code : "not a MongoShieldError";
  }
  return undefined;
}

const replicaSet: DeploymentInfo = {
  topology: "replicaSet",
  serverVersion: "7.0.12",
  clusterId: "0".repeat(32),
  supportsChangeStreams: true,
  supportsSnapshotReads: true,
  maxBsonObjectSize: 16 * 1024 * 1024,
};
const standalone: DeploymentInfo = {
  ...replicaSet,
  topology: "standalone",
  supportsChangeStreams: false,
  supportsSnapshotReads: false,
};

describe("validateBackupOptions", () => {
  it("defaults parallelism to 4", () => {
    expect(validateBackupOptions({})).toBe(DEFAULT_BACKUP_PARALLELISM);
    expect(DEFAULT_BACKUP_PARALLELISM).toBe(4);
  });

  it.each([0, -2, 2.5])("rejects a parallelism of %s", (parallelism) => {
    expect(codeOf(() => validateBackupOptions({ parallelism }))).toBe("MS_CONFIG_INVALID");
  });

  it("rejects malformed namespace patterns before touching the database", () => {
    expect(codeOf(() => validateBackupOptions({ include: ["bad db.x"] }))).toBe(
      "MS_CONFIG_INVALID",
    );
  });

  it("rejects a query entry that is not a filter document", () => {
    const query = { "app.users": [] } as unknown as Record<string, Record<string, never>>;
    expect(codeOf(() => validateBackupOptions({ query }))).toBe("MS_CONFIG_INVALID");
  });
});

describe("planEncryption", () => {
  it("returns nothing for unencrypted backups", () => {
    expect(planEncryption(undefined)).toBeUndefined();
  });

  it("plans to encrypt to the given recipients", () => {
    const { recipient } = generateIdentity();
    expect(planEncryption({ recipients: [recipient] })).toEqual({
      kind: "recipients",
      recipients: [recipient],
    });
  });

  it("plans a passphrase backup (which gets a key envelope)", () => {
    expect(planEncryption({ passphrase: "correct horse" })).toEqual({
      kind: "passphrase",
      passphrase: "correct horse",
    });
  });

  it("plans a KMS backup with recovery recipients, dropping repeated KMS keys", () => {
    const { recipient } = generateIdentity();
    const aws = { provider: "aws", key: "alias/backups" } as const;
    const gcp = {
      provider: "gcp",
      key: "projects/p/locations/l/keyRings/r/cryptoKeys/k",
    } as const;
    expect(planEncryption({ kms: [aws, gcp, aws], recipients: [recipient] })).toEqual({
      kind: "kms",
      kms: [aws, gcp],
      recipients: [recipient],
    });
  });

  it("plans a KMS-only backup", () => {
    const kms = [{ provider: "azure", key: "https://v.vault.azure.net/keys/k" }] as const;
    expect(planEncryption({ kms })).toEqual({ kind: "kms", kms, recipients: [] });
  });

  it("treats an empty KMS list like no KMS keys", () => {
    const { recipient } = generateIdentity();
    expect(planEncryption({ kms: [], recipients: [recipient] })).toEqual({
      kind: "recipients",
      recipients: [recipient],
    });
  });

  it.each([
    ["a KMS key of the wrong shape", { kms: [{ provider: "aws", key: "not a key" }] }],
    [
      "a passphrase with KMS keys",
      { passphrase: "x", kms: [{ provider: "aws", key: "alias/backups" }] },
    ],
    ["an empty KMS list alone", { kms: [] }],
  ] as const)("rejects %s", (_name, encryption) => {
    expect(codeOf(() => planEncryption(encryption))).toBe("MS_CONFIG_INVALID");
  });

  it.each([
    ["an invalid recipient", { recipients: ["age1notvalid"] }],
    ["an identity instead of a recipient", { recipients: [generateIdentity().identity] }],
    ["no recipient", { recipients: [] }],
    ["an empty passphrase", { passphrase: "" }],
    ["both kinds", { recipients: [generateIdentity().recipient], passphrase: "x" }],
  ])("rejects %s", (_name, encryption) => {
    expect(codeOf(() => planEncryption(encryption))).toBe("MS_CONFIG_INVALID");
  });
});

describe("assertQueriesMatchNamespaces", () => {
  it("accepts queries for included namespaces", () => {
    expect(
      codeOf(() => assertQueriesMatchNamespaces({ "app.users": {} }, ["app.users"])),
    ).toBeUndefined();
  });

  it("rejects a query for a namespace the backup does not include", () => {
    expect(codeOf(() => assertQueriesMatchNamespaces({ "app.user": {} }, ["app.users"]))).toBe(
      "MS_CONFIG_INVALID",
    );
  });
});

describe("resolveConsistencyMode", () => {
  it("resolves auto (the default) to converge where change streams can provide it", () => {
    expect(resolveConsistencyMode(undefined, replicaSet)).toBe("converge");
    expect(resolveConsistencyMode("auto", replicaSet)).toBe("converge");
  });

  it("resolves auto to none on standalone servers and before MongoDB 6.0", () => {
    expect(resolveConsistencyMode("auto", standalone)).toBe("none");
    expect(resolveConsistencyMode("auto", { ...replicaSet, serverVersion: "5.0.20" })).toBe("none");
  });

  it("uses plain reads for none", () => {
    expect(resolveConsistencyMode("none", replicaSet)).toBe("none");
    expect(resolveConsistencyMode("none", standalone)).toBe("none");
  });

  it("allows snapshot on a replica set but not on a standalone server", () => {
    expect(resolveConsistencyMode("snapshot", replicaSet)).toBe("snapshot");
    expect(codeOf(() => resolveConsistencyMode("snapshot", standalone))).toBe(
      "MS_UNSUPPORTED_TOPOLOGY",
    );
  });

  it("rejects snapshot on servers older than 5.0", () => {
    const old = { ...replicaSet, serverVersion: "4.4.0", supportsSnapshotReads: false };
    expect(codeOf(() => resolveConsistencyMode("snapshot", old))).toBe("MS_UNSUPPORTED_TOPOLOGY");
  });

  it("accepts converge on a replica set running MongoDB 6.0+", () => {
    expect(resolveConsistencyMode("converge", replicaSet)).toBe("converge");
  });

  it("refuses converge on a standalone server, with a hint", () => {
    const standaloneServer = {
      ...replicaSet,
      topology: "standalone" as const,
      supportsChangeStreams: false,
    };
    expect(codeOf(() => resolveConsistencyMode("converge", standaloneServer))).toBe(
      "MS_UNSUPPORTED_TOPOLOGY",
    );
  });

  it("refuses converge before MongoDB 6.0", () => {
    const old = { ...replicaSet, serverVersion: "5.0.20" };
    expect(codeOf(() => resolveConsistencyMode("converge", old))).toBe("MS_UNSUPPORTED_TOPOLOGY");
  });
});

describe("chooseConsistency", () => {
  // Never connected: the change stream probe is injected, so no server is needed.
  const client = new MongoClient("mongodb://127.0.0.1:1");
  const allowed = async () => true;
  const refused = async () => false;

  it("uses converge for auto when the user may open a cluster-wide change stream", async () => {
    expect(await chooseConsistency(client, "auto", replicaSet, allowed)).toEqual({
      mode: "converge",
      warning: undefined,
    });
  });

  it("falls back to none with a warning when the user may not", async () => {
    const choice = await chooseConsistency(client, undefined, replicaSet, refused);
    expect(choice.mode).toBe("none");
    expect(choice.warning).toMatch(/backup role .*changeStream and find/);
  });

  it("falls back to none with a warning on a standalone server, without probing", async () => {
    let probed = false;
    const choice = await chooseConsistency(client, "auto", standalone, async () => {
      probed = true;
      return true;
    });
    expect(choice.mode).toBe("none");
    expect(choice.warning).toMatch(/standalone deployment has no change streams/);
    expect(probed).toBe(false);
  });

  it("never probes or warns for explicit modes", async () => {
    expect(await chooseConsistency(client, "converge", replicaSet, refused)).toEqual({
      mode: "converge",
      warning: undefined,
    });
    expect(await chooseConsistency(client, "none", replicaSet, refused)).toEqual({
      mode: "none",
      warning: undefined,
    });
  });
});

describe("toBackupError", () => {
  it("passes MongoShieldErrors through unchanged", () => {
    const original = new MongoShieldError("MS_STORAGE_IO", "disk full");
    expect(toBackupError(original)).toBe(original);
  });

  it("explains an expired snapshot and suggests consistency none", () => {
    const error = toBackupError(
      new MongoServerError({ code: 239, codeName: "SnapshotTooOld", errmsg: "too old" }),
      { ns: "app.users" },
    );
    expect(error.code).toBe("MS_SNAPSHOT_TOO_OLD");
    expect(error.message).toContain("app.users");
    expect(error.message).toContain("snapshot window");
    expect(error.hint).toContain('consistency "none"');
  });

  it("maps authorization failures to MS_PERMISSION_DENIED", () => {
    const error = toBackupError(
      new MongoServerError({ code: 13, codeName: "Unauthorized", errmsg: "not authorized" }),
    );
    expect(error.code).toBe("MS_PERMISSION_DENIED");
  });

  it("maps network failures to MS_CONNECTION_FAILED", () => {
    expect(toBackupError(new MongoNetworkError("socket closed")).code).toBe("MS_CONNECTION_FAILED");
  });

  it("wraps anything else as MS_INTERNAL, keeping the cause", () => {
    const cause = new Error("weird");
    const error = toBackupError(cause);
    expect(error.code).toBe("MS_INTERNAL");
    expect(error.cause).toBe(cause);
  });
});
