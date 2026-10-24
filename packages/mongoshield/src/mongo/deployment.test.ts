// Unit tests for topology classification from `hello` replies, and for describing a
// deployment through a fake client (the real topologies are in test/topology). Replies for topologies
// the test server cannot be (mongos, uninitiated replica set) are written by hand from
// the MongoDB documentation.

import { type Document, type MongoClient, MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { describeDeployment, topologyFromHello } from "./deployment.ts";

describe("topologyFromHello", () => {
  it("recognises a mongos router by msg: isdbgrid", () => {
    expect(topologyFromHello({ msg: "isdbgrid", isWritablePrimary: true })).toBe("sharded");
  });

  it("recognises a replica set member by its setName", () => {
    expect(topologyFromHello({ setName: "rs0", isWritablePrimary: false, secondary: true })).toBe(
      "replicaSet",
    );
  });

  it("recognises a standalone server from hello or legacy isMaster replies", () => {
    expect(topologyFromHello({ isWritablePrimary: true })).toBe("standalone");
    expect(topologyFromHello({ ismaster: true })).toBe("standalone");
  });

  it("reports an uninitiated replica set member as unknown", () => {
    expect(topologyFromHello({ isreplicaset: true, isWritablePrimary: false })).toBe("unknown");
  });

  it("reports anything else as unknown", () => {
    expect(topologyFromHello({})).toBe("unknown");
  });
});

/** What the fake server answers; a function reply may throw. */
interface FakeServer {
  readonly hello?: Document | (() => Document);
  readonly isMaster?: Document;
  readonly buildInfo?: Document;
  /** `config.version`, or a function that throws (no privileges). */
  readonly configVersion?: Document | null | (() => Document | null);
  readonly hosts?: readonly string[];
}

/**
 * Just enough of a MongoClient for `describeDeployment`: `db().command()`,
 * `db("config").collection("version").findOne()` and `options.hosts`.
 */
function fakeClient(server: FakeServer): { client: MongoClient; commands: string[] } {
  const commands: string[] = [];
  const reply = (value: Document | (() => Document) | undefined): Document =>
    typeof value === "function" ? value() : (value ?? {});
  const fake = {
    options: { hosts: (server.hosts ?? ["db1:27017"]).map((host) => ({ toString: () => host })) },
    db: () => ({
      command: async (command: Document) => {
        const name = Object.keys(command)[0] ?? "";
        commands.push(name);
        if (name === "hello") return reply(server.hello);
        if (name === "isMaster") return reply(server.isMaster);
        return reply(server.buildInfo);
      },
      collection: () => ({
        findOne: async () => {
          const value = server.configVersion;
          return typeof value === "function" ? value() : (value ?? null);
        },
      }),
    }),
  };
  return { client: fake as unknown as MongoClient, commands };
}

describe("describeDeployment", () => {
  it("describes a replica set by its set name, with snapshot reads from 5.0", async () => {
    const { client } = fakeClient({
      hello: { setName: "rs0", isWritablePrimary: true, maxBsonObjectSize: 1024 },
      buildInfo: { version: "7.0.12" },
    });
    const info = await describeDeployment(client);
    expect(info).toMatchObject({
      topology: "replicaSet",
      serverVersion: "7.0.12",
      supportsChangeStreams: true,
      supportsSnapshotReads: true,
      maxBsonObjectSize: 1024,
    });
    expect(info.clusterId).toMatch(/^[0-9a-f]{32}$/);
    // The same set name on other hosts is the same deployment.
    const moved = fakeClient({
      hello: { setName: "rs0" },
      buildInfo: { version: "7.0.12" },
      hosts: ["other:1"],
    });
    expect((await describeDeployment(moved.client)).clusterId).toBe(info.clusterId);
  });

  it("refuses snapshot reads before 5.0 and on unparseable versions", async () => {
    for (const version of ["4.4.9", "garbage", undefined]) {
      const { client } = fakeClient({
        hello: { setName: "rs0" },
        buildInfo: version === undefined ? {} : { version },
      });
      const info = await describeDeployment(client);
      expect(info.supportsChangeStreams).toBe(true);
      expect(info.supportsSnapshotReads).toBe(false);
      expect(info.serverVersion).toBe(version ?? "0.0.0");
    }
  });

  it("falls back to isMaster on servers without hello", async () => {
    const { client, commands } = fakeClient({
      hello: () => {
        throw new MongoServerError({ message: "no such command: 'hello'", code: 59 });
      },
      isMaster: { ismaster: true },
      buildInfo: { version: "4.2.0" },
    });
    const info = await describeDeployment(client);
    expect(commands).toEqual(["hello", "isMaster", "buildInfo"]);
    expect(info).toMatchObject({
      topology: "standalone",
      supportsChangeStreams: false,
      supportsSnapshotReads: false,
      // `hello` omitted it: the documented maximum.
      maxBsonObjectSize: 16 * 1024 * 1024,
    });
  });

  it("passes other hello errors on", async () => {
    const { client } = fakeClient({
      hello: () => {
        throw new MongoServerError({ message: "unauthorized", code: 13 });
      },
    });
    await expect(describeDeployment(client)).rejects.toThrow(/unauthorized/);
    const network = fakeClient({
      hello: () => {
        throw new Error("socket closed");
      },
    });
    await expect(describeDeployment(network.client)).rejects.toThrow(/socket closed/);
  });

  it("identifies a sharded cluster by config.version's clusterId when readable", async () => {
    const sharded = (configVersion: Document | null | (() => Document | null), hosts?: string[]) =>
      describeDeployment(
        fakeClient({
          hello: { msg: "isdbgrid" },
          buildInfo: { version: "8.0.0" },
          configVersion,
          ...(hosts === undefined ? {} : { hosts }),
        }).client,
      );
    const byId = await sharded({ clusterId: "65f0c0ffee" }, ["a:1"]);
    expect(byId.topology).toBe("sharded");
    expect(byId.supportsSnapshotReads).toBe(true);
    expect((await sharded({ clusterId: "65f0c0ffee" }, ["b:2"])).clusterId).toBe(byId.clusterId);

    // Without the id (missing, null or unreadable), the mongos hosts identify it.
    const missing = await sharded(null, ["B:2", "a:1"]);
    const nullId = await sharded({ clusterId: null }, ["a:1", "b:2"]);
    const denied = await sharded(() => {
      throw new MongoServerError({ message: "not authorized", code: 13 });
    }, ["a:1", "b:2"]);
    expect(missing.clusterId).not.toBe(byId.clusterId);
    // Host order and case do not change the id.
    expect(nullId.clusterId).toBe(missing.clusterId);
    expect(denied.clusterId).toBe(missing.clusterId);
  });

  it("identifies a standalone or unknown server by its hosts", async () => {
    const standalone = await describeDeployment(
      fakeClient({ hello: { isWritablePrimary: true }, buildInfo: { version: "7.0.0" } }).client,
    );
    const unknown = await describeDeployment(
      fakeClient({ hello: { isreplicaset: true }, buildInfo: { version: "7.0.0" } }).client,
    );
    expect(standalone.topology).toBe("standalone");
    expect(unknown.topology).toBe("unknown");
    expect(unknown.supportsChangeStreams).toBe(false);
    expect(standalone.clusterId).not.toBe(unknown.clusterId);
  });
});
