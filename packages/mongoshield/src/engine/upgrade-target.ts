/**
 * The server an upgrade rehearsal restores into, and proof that it runs the
 * version being rehearsed.
 *
 * Two ways to get one:
 *
 *   --target-uri   a scratch deployment you run yourself (the closest to production:
 *                  same topology, same storage, same settings). The rehearsal checks
 *                  its version, and the drill's guard refuses the backup's own source.
 *   ephemeral      a throwaway single-node replica set started for this rehearsal
 *                  by mongodb-memory-server, an optional dependency: it downloads the
 *                  exact `mongod` version (cached in ~/.cache/mongodb-binaries), or
 *                  runs the binary you point it to, on a temporary data directory
 *                  that is deleted afterwards. Good for CI and laptops.
 *
 * Either way the server's `buildInfo` version must match the target: a rehearsal
 * that silently ran on the old version would prove nothing.
 */

import { randomBytes } from "node:crypto";
import type { MongoClient } from "mongodb";
import { MongoShieldError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { missingPackageError } from "../storage/adapter-utils.ts";
import {
  compareVersions,
  formatVersion,
  parseServerVersion,
  releaseName,
  type ServerVersion,
} from "./upgrade-versions.ts";

/** How to install the optional package that starts ephemeral servers. */
export const EPHEMERAL_INSTALL_HINT = "npm install --save-dev mongodb-memory-server";

/** A running throwaway server. */
export interface EphemeralServer {
  /** Connection string of the single-node replica set. */
  readonly uri: string;
  /** Stops the server and deletes its data directory. */
  stop(): Promise<void>;
}

/** Options of `startEphemeralServer`. */
export interface EphemeralServerOptions {
  /** The version to run. Needs a patch number unless `binary` is given. */
  readonly version: ServerVersion;
  /** A `mongod` binary to run instead of downloading one. */
  readonly binary?: string | undefined;
  readonly logger: Logger;
}

/** The module, loaded lazily: it is an optional peer dependency. */
type MemoryServerModule = typeof import("mongodb-memory-server");

/** Loads mongodb-memory-server, or explains how to install it. */
async function loadMemoryServer(): Promise<MemoryServerModule> {
  try {
    return await import("mongodb-memory-server");
  } catch (error) {
    throw missingPackageError(
      error,
      "An upgrade rehearsal without --target-uri (an ephemeral mongod)",
      EPHEMERAL_INSTALL_HINT,
    );
  }
}

/**
 * Starts a single-node replica set of the requested version. A replica set rather
 * than a standalone because production almost always is one, and some collection
 * options (pre- and post-images) only exist there.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` when the version has no patch number
 *   and no binary is given (a download needs an exact version), or when
 *   mongodb-memory-server is not installed.
 */
export async function startEphemeralServer(
  options: EphemeralServerOptions,
): Promise<EphemeralServer> {
  const { version, binary, logger } = options;
  if (version.patch === undefined && binary === undefined) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `An ephemeral MongoDB ${releaseName(version)} server needs an exact version to download.`,
      {
        hint: `Pass the patch release too, e.g. --target-version ${releaseName(version)}.0 (see https://www.mongodb.com/try/download/community), point --mongod-binary at a ${releaseName(version)} mongod, or use --target-uri.`,
      },
    );
  }
  const { MongoMemoryReplSet } = await loadMemoryServer();
  logger.info("Upgrade rehearsal: starting an ephemeral mongod", {
    version: formatVersion(version),
    ...(binary === undefined ? {} : { binary }),
  });
  let replSet: InstanceType<MemoryServerModule["MongoMemoryReplSet"]>;
  try {
    replSet = await MongoMemoryReplSet.create({
      // A unique replica set name: the drill's same-deployment guard identifies
      // replica sets by name, and mongodb-memory-server names them all "testset".
      replSet: {
        name: `msrehearsal-${randomBytes(4).toString("hex")}`,
        count: 1,
        storageEngine: "wiredTiger",
      },
      binary: {
        // Without a patch the binary decides; its version is checked once it runs.
        ...(version.patch === undefined ? {} : { version: formatVersion(version) }),
        ...(binary === undefined ? {} : { systemBinary: binary }),
      },
    });
    await replSet.waitUntilRunning();
  } catch (error) {
    // A failed download (no network, no build for this platform) or a binary that
    // does not start: nothing was rehearsed, and the reason is in the message.
    throw new MongoShieldError(
      "MS_CONNECTION_FAILED",
      `Could not start an ephemeral MongoDB ${formatVersion(version)} server: ${error instanceof Error ? error.message : String(error)}`,
      {
        hint: "Check the version exists for this platform, or pass --mongod-binary, or use --target-uri.",
        cause: error,
      },
    );
  }
  return {
    uri: replSet.getUri(),
    stop: async () => {
      await replSet.stop({ doCleanup: true, force: false });
    },
  };
}

/**
 * Reads the server's version and checks it is the target: same release series,
 * and the same patch when the target names one.
 *
 * @returns The server's version, e.g. `"8.0.13"`.
 * @throws MongoShieldError `MS_CONFIG_INVALID` when it is another version.
 */
export async function assertServerVersion(
  client: MongoClient,
  target: ServerVersion,
  where: string,
): Promise<string> {
  const buildInfo = await client.db("admin").command({ buildInfo: 1 });
  const reported = typeof buildInfo.version === "string" ? buildInfo.version : "unknown";
  const actual = parseServerVersion(reported);
  const matches =
    actual !== undefined &&
    compareVersions({ ...actual, patch: undefined }, { ...target, patch: undefined }) === 0 &&
    (target.patch === undefined || actual.patch === target.patch);
  if (!matches) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The rehearsal target (${where}) runs MongoDB ${reported}, not ${formatVersion(target)}.`,
      {
        hint: "Point --target-uri at a scratch deployment of the version you are upgrading to, or leave it out to start an ephemeral one (with MONGOMS_SYSTEM_BINARY unset or pointing at that version).",
      },
    );
  }
  return reported;
}
