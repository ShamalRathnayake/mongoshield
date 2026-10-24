// Config edge cases: config files that do not export an object, the process
// defaults for cwd and env, environment variables that only set some decryption
// keys, encryption via KMS, prototype-less objects in merges, and every backup
// tuning setting.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { backupTuningFromConfig } from "./backup-tuning.ts";
import { defineConfig } from "./define.ts";
import { readEnvironmentConfig } from "./env.ts";
import { loadConfig, mergeConfigs, validateConfig } from "./load.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-config-edges-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadConfig edge cases", () => {
  it("refuses a config file whose default export is not an object", async () => {
    await writeFile(join(directory, "mongoshield.config.ts"), "export default 5;");
    const error = await loadConfig({ cwd: directory, env: {} }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("must export an object");
  });

  it("uses the process environment and working directory by default", async () => {
    const file = join(directory, "explicit.json");
    await writeFile(file, JSON.stringify({ storage: "./from-explicit-file" }));
    const { config, configFile } = await loadConfig({ configPath: file });
    expect(configFile).toBe(file);
    expect(config.storage).toBeDefined();
  });

  it("returns its argument unchanged from defineConfig", () => {
    const config = { storage: "./backups" };
    expect(defineConfig(config)).toBe(config);
  });
});

describe("readEnvironmentConfig edge cases", () => {
  it("sets only the decryption keys that are given", () => {
    expect(readEnvironmentConfig({ MONGOSHIELD_IDENTITY_FILE: "/keys/id.txt" }).decryption).toEqual(
      { identities: undefined, identityFiles: ["/keys/id.txt"], passphrase: undefined },
    );
    expect(readEnvironmentConfig({ MONGOSHIELD_IDENTITY: "AGE-SECRET-KEY-1X" }).decryption).toEqual(
      { identities: ["AGE-SECRET-KEY-1X"], identityFiles: undefined, passphrase: undefined },
    );
  });

  it("passes compression through, leaving unknown values to validation", () => {
    expect(readEnvironmentConfig({ MONGOSHIELD_COMPRESSION: "gzip" }).compression).toBe("gzip");
    const env = readEnvironmentConfig({ MONGOSHIELD_COMPRESSION: "lz4", MONGOSHIELD_STORAGE: "x" });
    expect(() => validateConfig(env)).toThrow(/compression/);
  });
});

describe("validateConfig: encryption", () => {
  it("accepts KMS keys on their own", () => {
    const config = validateConfig({
      storage: "./backups",
      encryption: { kms: [{ provider: "aws", key: "alias/backups" }] },
    });
    expect(config.encryption?.kms).toEqual([{ provider: "aws", key: "alias/backups" }]);
  });

  it("rejects a passphrase combined with KMS keys", () => {
    expect(() =>
      validateConfig({
        storage: "./backups",
        encryption: {
          passphrase: "correct horse battery staple",
          kms: [{ provider: "gcp", key: "projects/p/locations/l/keyRings/r/cryptoKeys/k" }],
        },
      }),
    ).toThrow(/passphrase cannot be combined/);
  });

  it("rejects an encryption section without any key", () => {
    expect(() => validateConfig({ storage: "./backups", encryption: {} })).toThrow(
      /set recipients, passphrase or kms/,
    );
  });
});

describe("mergeConfigs edge cases", () => {
  it("merges objects without a prototype key by key", () => {
    const lower: Record<string, unknown> = Object.create(null);
    lower.uri = "mongodb://lower";
    lower.appName = "lower";
    expect(mergeConfigs({ source: lower }, { source: { uri: "mongodb://higher" } })).toEqual({
      source: { uri: "mongodb://higher", appName: "lower" },
    });
  });
});

describe("backupTuningFromConfig: every setting", () => {
  it("copies each configured setting under its option name", () => {
    expect(
      backupTuningFromConfig({
        partSizeBytes: 1024,
        maxDurationMs: 60_000,
        readPreference: "secondary",
        readPreferenceTags: [{ region: "eu" }],
        maxDocumentsPerSecond: 500,
        maxBytesPerSecond: 1_000_000,
        retainDays: 7,
        usersAndRoles: true,
      }),
    ).toEqual({
      partSizeBytes: 1024,
      maxDurationMs: 60_000,
      readPreference: "secondary",
      readPreferenceTags: [{ region: "eu" }],
      maxDocumentsPerSecond: 500,
      maxBytesPerSecond: 1_000_000,
      retainDays: 7,
      includeUsersAndRoles: true,
    });
  });
});
