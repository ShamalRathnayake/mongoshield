import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { readEnvironmentConfig } from "./env.ts";
import { loadConfig, mergeConfigs, mongoshieldAliases, validateConfig } from "./load.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mongoshield-config-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("config files that import mongoshield", () => {
  /**
   * A stand-in for an installed copy of the package (like npx's cache): a
   * package.json named "mongoshield" whose exports point at small modules that
   * tag what they return, so the test can tell which copy a config imported.
   */
  async function fakeInstalledPackage(): Promise<string> {
    const root = join(directory, "npx-cache", "node_modules", "mongoshield");
    await mkdir(join(root, "dist", "storage"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "mongoshield",
        type: "module",
        exports: {
          ".": "./dist/index.mjs",
          "./storage/memory": "./dist/storage/memory.mjs",
          "./storage/missing": "./dist/storage/missing.mjs",
          "./package.json": "./package.json",
        },
      }),
    );
    await writeFile(
      join(root, "dist", "index.mjs"),
      'export const defineConfig = (config) => ({ ...config, labels: { from: "running copy" } });\n',
    );
    await writeFile(join(root, "dist", "storage", "memory.mjs"), "export const tag = 1;\n");
    return root;
  }

  it("maps the package and its subpath exports to the running copy's files", async () => {
    const root = await fakeInstalledPackage();
    const aliases = await mongoshieldAliases(join(root, "dist"));
    expect(aliases).toEqual({
      mongoshield: join(root, "dist", "index.mjs"),
      "mongoshield/storage/memory": join(root, "dist", "storage", "memory.mjs"),
      "mongoshield/package.json": join(root, "package.json"),
    });
  });

  it("maps nothing when no package named mongoshield is found above the module", async () => {
    expect(await mongoshieldAliases(directory)).toEqual({});
  });

  it("loads a config importing mongoshield from a folder without node_modules", async () => {
    // This module's own package (packages/mongoshield) is the running copy here.
    const aliases = await mongoshieldAliases(import.meta.dirname);
    if (aliases.mongoshield === undefined) return; // not built yet: nothing to resolve to
    await writeFile(
      join(directory, "mongoshield.config.ts"),
      'import { defineConfig } from "mongoshield";\nexport default defineConfig({ storage: "./backups" });\n',
    );
    const { config } = await loadConfig({ cwd: directory, env: {} });
    expect(config.storage).toBe("./backups");
  });
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

describe("notify and heartbeat URLs from the environment or a secret file", () => {
  /** Writes a JSON config (like the Helm chart's ConfigMap) and loads it with `env`. */
  async function loadJson(config: unknown, env: NodeJS.ProcessEnv = {}) {
    // A new folder each time: an imported JSON file is cached by its path.
    const folder = await mkdtemp(join(directory, "json-"));
    await writeFile(join(folder, "mongoshield.config.json"), JSON.stringify(config));
    return loadConfig({ cwd: folder, env });
  }

  it("reads { env } and { file } references, trimming the file's final newline", async () => {
    const secretFile = join(directory, "heartbeat-url");
    await writeFile(secretFile, "https://hc-ping.com/secret-uuid\n");
    const { config } = await loadJson(
      {
        storage: "./backups",
        notify: [
          { type: "slack", url: { env: "SLACK_URL" } },
          { type: "webhook", url: "https://hooks.example.com/plain" },
        ],
        heartbeat: { file: secretFile },
      },
      { SLACK_URL: "https://hooks.slack.com/services/T/B/secret" },
    );
    expect(config.notify?.map((target) => target.url)).toEqual([
      "https://hooks.slack.com/services/T/B/secret",
      "https://hooks.example.com/plain",
    ]);
    expect(config.heartbeat).toBe("https://hc-ping.com/secret-uuid");
  });

  it("takes the heartbeat from MONGOSHIELD_HEARTBEAT_URL", async () => {
    const { config } = await loadJson(
      { storage: "./backups" },
      { MONGOSHIELD_HEARTBEAT_URL: "https://hc-ping.com/from-env" },
    );
    expect(config.heartbeat).toBe("https://hc-ping.com/from-env");
  });

  it("names a missing variable or an unreadable file without showing any value", async () => {
    const missingVariable = await loadJson({
      storage: "./backups",
      notify: [{ type: "slack", url: { env: "NOT_SET_ANYWHERE" } }],
    }).catch((error: unknown) => error);
    expect(isMongoShieldError(missingVariable, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(missingVariable)).toContain("notify[0].url");
    expect(String(missingVariable)).toContain("NOT_SET_ANYWHERE");

    const missingFile = await loadJson({
      storage: "./backups",
      heartbeat: { file: join(directory, "nope") },
    }).catch((error: unknown) => error);
    expect(isMongoShieldError(missingFile, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(missingFile)).toContain("heartbeat");
  });

  it("still validates the URL it read, without repeating it", async () => {
    const error = await loadJson(
      { storage: "./backups", heartbeat: { env: "BAD_URL" } },
      { BAD_URL: "not a url" },
    ).catch((caught: unknown) => caught);
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(String(error)).not.toContain("not a url");
  });
});
