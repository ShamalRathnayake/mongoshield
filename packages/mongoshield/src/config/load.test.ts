import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { readEnvironmentConfig } from "./env.ts";
import { loadConfig, mergeConfigs, validateConfig } from "./load.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-config-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a TypeScript config file found in the working directory", async () => {
    await writeFile(
      join(directory, "mongoshield.config.ts"),
      `const config: { storage: string; compression: "gzip" } = { storage: "./backups", compression: "gzip" };
       export default config;`,
    );

    const { config, configFile } = await loadConfig({ cwd: directory, env: {} });

    expect(configFile).toBe(join(directory, "mongoshield.config.ts"));
    expect(config.storage).toBe("./backups");
    expect(config.compression).toBe("gzip");
  });

  it("lets environment variables override the file, and flags override both", async () => {
    await writeFile(
      join(directory, "mongoshield.config.json"),
      JSON.stringify({ storage: "./from-file", source: { uri: "mongodb://file" } }),
    );

    const { config } = await loadConfig({
      cwd: directory,
      env: { MONGOSHIELD_STORAGE: "./from-env", MONGODB_URI: "mongodb://env" },
      overrides: { storage: "./from-flag" },
    });

    expect(config.storage).toBe("./from-flag");
    expect(config.source?.uri).toBe("mongodb://env");
  });

  it("works without any config file when the environment provides what is needed", async () => {
    const { config, configFile } = await loadConfig({
      cwd: directory,
      env: { MONGOSHIELD_STORAGE: "s3://bucket/prefix" },
    });
    expect(configFile).toBeUndefined();
    expect(config.storage).toBe("s3://bucket/prefix");
  });

  it("fails clearly when an explicit --config path does not exist", async () => {
    const error = await loadConfig({ cwd: directory, configPath: "missing.ts", env: {} }).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("Config file not found");
  });

  it("reports a config file with a syntax error", async () => {
    await writeFile(join(directory, "mongoshield.config.ts"), "export default {");
    const error = await loadConfig({ cwd: directory, env: {} }).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
  });
});

describe("validateConfig", () => {
  it("treats undefined values (unset environment variables) as missing", () => {
    expect(() =>
      validateConfig({ storage: "./backups", source: { uri: undefined }, compression: undefined }),
    ).toThrow(/source/);
  });

  it("names the missing field when storage is not set", () => {
    const error = (() => {
      try {
        validateConfig({});
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).toContain("storage");
  });

  it("rejects combining encryption recipients with a passphrase", () => {
    expect(() =>
      validateConfig({
        storage: "./b",
        encryption: { recipients: ["age1abc"], passphrase: "correct horse" },
      }),
    ).toThrow(/cannot be combined/);
  });

  it("rejects unknown keys so typos do not pass silently", () => {
    expect(() => validateConfig({ storage: "./b", retension: { last: 3 } })).toThrow(/retension/);
  });

  it("accepts a storage adapter object", () => {
    const storage = memoryStorage();
    expect(validateConfig({ storage }).storage).toBe(storage);
  });
});

describe("mergeConfigs", () => {
  it("merges nested objects key by key and replaces arrays", () => {
    const merged = mergeConfigs(
      { storage: "./a", backup: { include: ["app.*"], parallelism: 2 } },
      { backup: { include: ["other.*"] } },
    );
    expect(merged).toEqual({ storage: "./a", backup: { include: ["other.*"], parallelism: 2 } });
  });

  it("never lets undefined erase a lower-priority value", () => {
    expect(mergeConfigs({ storage: "./a" }, { storage: undefined })).toEqual({ storage: "./a" });
  });

  it("keeps adapter objects intact instead of merging into them", () => {
    const storage = memoryStorage();
    const merged = mergeConfigs({ storage: "./a" }, { storage });
    expect(merged.storage).toBe(storage);
  });
});

describe("readEnvironmentConfig", () => {
  it("prefers MONGOSHIELD_URI over MONGODB_URI and splits recipient lists", () => {
    const layer = readEnvironmentConfig({
      MONGOSHIELD_URI: "mongodb://a",
      MONGODB_URI: "mongodb://b",
      MONGOSHIELD_RECIPIENTS: "age1one, age1two,,",
    });
    expect(layer.source?.uri).toBe("mongodb://a");
    expect(layer.encryption?.recipients).toEqual(["age1one", "age1two"]);
  });

  it("ignores empty variables", () => {
    expect(readEnvironmentConfig({ MONGOSHIELD_STORAGE: "  " }).storage).toBeUndefined();
  });

  it("maps identity variables to decryption settings", () => {
    const layer = readEnvironmentConfig({
      MONGOSHIELD_IDENTITY: "AGE-SECRET-KEY-1XYZ",
      MONGOSHIELD_IDENTITY_FILE: "/run/secrets/age.key",
    });
    expect(layer.decryption?.identities).toEqual(["AGE-SECRET-KEY-1XYZ"]);
    expect(layer.decryption?.identityFiles).toEqual(["/run/secrets/age.key"]);
  });
});
