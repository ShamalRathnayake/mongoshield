// Unit tests for choosing a backup's consistency mode (backup-consistency.ts): which
// deployments allow which mode, what "auto" falls back to and why, the change stream
// probe, and pinning a snapshot. Fake clients stand in for servers the test replica
// set cannot be (standalone, old versions, users without privileges).

import { type Document, Long, type MongoClient, MongoServerError, Timestamp } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { silentLogger } from "../logger.ts";
import type { CollectionSpec, DeploymentInfo } from "../mongo/index.ts";
import {
  chooseConsistency,
  openReadConsistency,
  resolveConsistencyMode,
} from "./backup-consistency.ts";

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
const oldReplicaSet: DeploymentInfo = { ...replicaSet, serverVersion: "5.0.3" };

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return isMongoShieldError(error) ? error.code : "not a MongoShieldError";
  }
  return undefined;
}

/** A fake client whose admin commands and sessions are recorded. */
function fakeClient(reply: (command: Document) => Document) {
  const commands: string[] = [];
  let sessionsEnded = 0;
  let failEndSession = false;
  const fake = {
    startSession: () => ({
      endSession: async () => {
        sessionsEnded += 1;
        if (failEndSession) throw new Error("session already gone");
      },
    }),
    db: () => ({
      command: async (command: Document) => {
        commands.push(Object.keys(command)[0] ?? "");
        return reply(command);
      },
    }),
  };
  return {
    client: fake as unknown as MongoClient,
    commands,
    sessionsEnded: () => sessionsEnded,
    failEndSession: () => {
      failEndSession = true;
    },
  };
}

describe("resolveConsistencyMode", () => {
  it("lets auto converge where change streams exist, and use none elsewhere", () => {
    expect(resolveConsistencyMode(undefined, replicaSet)).toBe("converge");
    expect(resolveConsistencyMode("auto", standalone)).toBe("none");
    expect(resolveConsistencyMode("auto", oldReplicaSet)).toBe("none");
    expect(resolveConsistencyMode("none", standalone)).toBe("none");
  });

  it("refuses snapshot and converge where the deployment cannot do them", () => {
    expect(codeOf(() => resolveConsistencyMode("snapshot", standalone))).toBe(
      "MS_UNSUPPORTED_TOPOLOGY",
    );
    expect(codeOf(() => resolveConsistencyMode("converge", standalone))).toBe(
      "MS_UNSUPPORTED_TOPOLOGY",
    );
    expect(codeOf(() => resolveConsistencyMode("converge", oldReplicaSet))).toBe(
      "MS_UNSUPPORTED_TOPOLOGY",
    );
    expect(resolveConsistencyMode("snapshot", replicaSet)).toBe("snapshot");
  });

  it("refuses unknown modes from JavaScript callers", () => {
    const unknownMode = "eventual" as unknown as "auto";
    expect(codeOf(() => resolveConsistencyMode(unknownMode, replicaSet))).toBe("MS_CONFIG_INVALID");
  });
});

describe("chooseConsistency", () => {
  const unused = fakeClient(() => ({})).client;

  it("never warns about a mode chosen explicitly", async () => {
    expect(await chooseConsistency(unused, "none", replicaSet)).toEqual({
      mode: "none",
      warning: undefined,
    });
  });

  it("says why auto used none on a deployment without change streams", async () => {
    const choice = await chooseConsistency(unused, "auto", standalone);
    expect(choice.mode).toBe("none");
    expect(choice.warning).toMatch(/standalone deployment has no change streams/);
    const old = await chooseConsistency(unused, "auto", oldReplicaSet);
    expect(old.warning).toMatch(/6\.0/);
  });

  it("falls back to none when the user may not open a cluster-wide change stream", async () => {
    const choice = await chooseConsistency(unused, "auto", replicaSet, async () => false);
    expect(choice.mode).toBe("none");
    expect(choice.warning).toMatch(/cannot open a change stream/);
    expect(await chooseConsistency(unused, "auto", replicaSet, async () => true)).toEqual({
      mode: "converge",
      warning: undefined,
    });
  });

  it("probes with an empty change stream cursor and kills it", async () => {
    const fake = fakeClient((command) =>
      "aggregate" in command ? { cursor: { id: Long.fromNumber(42), firstBatch: [] } } : {},
    );
    const choice = await chooseConsistency(fake.client, "auto", replicaSet);
    expect(choice.mode).toBe("converge");
    expect(fake.commands).toEqual(["aggregate", "killCursors"]);
    expect(fake.sessionsEnded()).toBe(1);
  });

  it("does not kill a cursor the server already closed", async () => {
    const fake = fakeClient(() => ({ cursor: { id: 0, firstBatch: [] } }));
    fake.failEndSession();
    expect((await chooseConsistency(fake.client, "auto", replicaSet)).mode).toBe("converge");
    expect(fake.commands).toEqual(["aggregate"]);
  });

  it("treats only 'not authorized' as a no, and fails on anything else", async () => {
    const denied = fakeClient(() => {
      throw new MongoServerError({ message: "not authorized", code: 13 });
    });
    expect((await chooseConsistency(denied.client, "auto", replicaSet)).mode).toBe("none");

    const down = fakeClient(() => {
      throw new MongoServerError({ message: "interrupted at shutdown", code: 11600 });
    });
    const error: unknown = await chooseConsistency(down.client, "auto", replicaSet).catch(
      (caught: unknown) => caught,
    );
    expect(isMongoShieldError(error)).toBe(true);
    expect(down.sessionsEnded()).toBe(1);
  });
});

describe("openReadConsistency", () => {
  const spec = (name: string, type: CollectionSpec["type"]): CollectionSpec => ({
    ns: `app.${name}`,
    db: "app",
    name,
    type,
    options: {},
    indexes: [],
    estimatedDocuments: 0,
  });

  it("needs no session outside snapshot mode", async () => {
    const fake = fakeClient(() => ({}));
    const reads = await openReadConsistency(fake.client, "converge", [], silentLogger);
    expect(reads.session).toBeUndefined();
    await reads.close();
    expect(fake.commands).toEqual([]);
  });

  it("pins the snapshot with a read of the first collection (not a view)", async () => {
    const targets: unknown[] = [];
    const fake = fakeClient((command) => {
      targets.push(command.find);
      return { cursor: { atClusterTime: new Timestamp({ t: 100, i: 3 }), firstBatch: [] } };
    });
    const reads = await openReadConsistency(
      fake.client,
      "snapshot",
      [spec("aview", "view"), spec("orders", "collection")],
      silentLogger,
    );
    expect(reads.clusterTime).toEqual({ t: 100, i: 3 });
    expect(targets).toEqual(["orders"]);
    fake.failEndSession();
    // A failing endSession is only logged.
    await reads.close();
    expect(fake.sessionsEnded()).toBe(1);
  });

  it("pins nothing without namespaces", async () => {
    const fake = fakeClient(() => ({}));
    const reads = await openReadConsistency(fake.client, "snapshot", [], silentLogger);
    expect(reads.clusterTime).toBeUndefined();
    expect(fake.commands).toEqual([]);
    await reads.close();
  });

  it("fails, closing the session, when the server reports no snapshot time", async () => {
    for (const reply of [{ cursor: { firstBatch: [] } }, {}]) {
      const fake = fakeClient(() => reply);
      const error: unknown = await openReadConsistency(
        fake.client,
        "snapshot",
        [spec("orders", "collection")],
        silentLogger,
      ).catch((caught: unknown) => caught);
      expect(isMongoShieldError(error, "MS_INTERNAL")).toBe(true);
      expect(fake.sessionsEnded()).toBe(1);
    }
  });
});
