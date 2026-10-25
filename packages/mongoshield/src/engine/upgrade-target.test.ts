// The rehearsal target: version checks of a connected server, and how the ephemeral
// server is started (mongodb-memory-server is replaced by a recording fake here; the
// real one runs in test/integration/upgrade-rehearsal.test.ts).

import type { MongoClient } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { silentLogger } from "../logger.ts";
import { assertServerVersion, startEphemeralServer } from "./upgrade-target.ts";
import { parseTargetVersion } from "./upgrade-versions.ts";

/** What the fake mongodb-memory-server was asked to do. */
const memoryServer = vi.hoisted(() => ({
  created: [] as unknown[],
  stopped: [] as unknown[],
  failWith: undefined as Error | undefined,
}));

vi.mock("mongodb-memory-server", () => ({
  MongoMemoryReplSet: {
    create: async (options: unknown) => {
      if (memoryServer.failWith !== undefined) throw memoryServer.failWith;
      memoryServer.created.push(options);
      return {
        waitUntilRunning: async () => undefined,
        getUri: () => "mongodb://127.0.0.1:1/?replicaSet=fake",
        stop: async (stopOptions: unknown) => {
          memoryServer.stopped.push(stopOptions);
          return true;
        },
      };
    },
  },
}));

beforeEach(() => {
  memoryServer.created.length = 0;
  memoryServer.stopped.length = 0;
  memoryServer.failWith = undefined;
});

/** A client whose buildInfo reports `version`. */
function clientReporting(version: unknown): MongoClient {
  return {
    db: () => ({ command: async () => ({ version }) }),
  } as unknown as MongoClient;
}

/** Runs `run` and returns what it threw. */
async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("assertServerVersion", () => {
  it("returns the version when the release (and the patch, if given) match", async () => {
    expect(
      await assertServerVersion(clientReporting("8.0.13"), parseTargetVersion("8.0"), "x"),
    ).toBe("8.0.13");
    expect(
      await assertServerVersion(clientReporting("8.0.13"), parseTargetVersion("8.0.13"), "x"),
    ).toBe("8.0.13");
  });

  it("refuses another release, another patch, or no version at all", async () => {
    for (const [reported, target, shown] of [
      ["7.0.32", "8.0", "7.0.32"],
      ["8.0.12", "8.0.13", "8.0.12"],
      [undefined, "8.0", "unknown"],
    ] as const) {
      const error = await thrown(() =>
        assertServerVersion(clientReporting(reported), parseTargetVersion(target), "--target-uri"),
      );
      expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      expect((error as Error).message).toBe(
        `The rehearsal target (--target-uri) runs MongoDB ${shown}, not ${target}.`,
      );
    }
  });
});

describe("startEphemeralServer", () => {
  it("downloads the exact version into a uniquely named single-node replica set", async () => {
    const server = await startEphemeralServer({
      version: parseTargetVersion("8.0.13"),
      logger: silentLogger,
    });
    expect(server.uri).toBe("mongodb://127.0.0.1:1/?replicaSet=fake");
    expect(memoryServer.created).toEqual([
      {
        replSet: {
          name: expect.stringMatching(/^msrehearsal-[0-9a-f]{8}$/),
          count: 1,
          storageEngine: "wiredTiger",
        },
        binary: { version: "8.0.13" },
      },
    ]);
    await server.stop();
    expect(memoryServer.stopped).toEqual([{ doCleanup: true, force: false }]);
  });

  it("runs a given binary, which then decides the patch version", async () => {
    await startEphemeralServer({
      version: parseTargetVersion("8.0"),
      binary: "/opt/mongod",
      logger: silentLogger,
    });
    expect(memoryServer.created).toEqual([
      expect.objectContaining({ binary: { systemBinary: "/opt/mongod" } }),
    ]);
  });

  it("needs an exact version to download", async () => {
    const error = await thrown(() =>
      startEphemeralServer({ version: parseTargetVersion("8.0"), logger: silentLogger }),
    );
    expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
    expect(isMongoShieldError(error) && error.hint).toContain("--target-version 8.0.0");
    expect(memoryServer.created).toEqual([]);
  });

  it("explains a server that could not start", async () => {
    memoryServer.failWith = new Error("download failed: 404");
    const error = await thrown(() =>
      startEphemeralServer({ version: parseTargetVersion("8.0.99"), logger: silentLogger }),
    );
    expect(isMongoShieldError(error, "MS_CONNECTION_FAILED")).toBe(true);
    expect((error as Error).message).toBe(
      "Could not start an ephemeral MongoDB 8.0.99 server: download failed: 404",
    );
  });
});
