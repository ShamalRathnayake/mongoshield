// Unit tests for topology classification from `hello` replies, and for describing a
// deployment through a fake client (the real topologies are in test/topology). Replies for topologies
// the test server cannot be (mongos, uninitiated replica set) are written by hand from
// the MongoDB documentation.

import { type Document, type MongoClient, MongoServerError, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  type DeploymentInfo,
  deploymentIdentityWarning,
  describeDeployment,
  sameDeployment,
  topologyFromHello,
} from "./deployment.ts";

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
  /** The `replSetGetConfig` reply, or a function that throws (no clusterMonitor). */
  readonly replSetConfig?: Document | (() => Document);
  /** `local.system.replset`, or a function that throws (no access to `local`). */
  readonly localReplset?: Document | null | (() => Document | null);
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
    db: (database: string) => ({
      command: async (command: Document) => {
        const name = Object.keys(command)[0] ?? "";
        commands.push(name);
        if (name === "hello") return reply(server.hello);
        if (name === "isMaster") return reply(server.isMaster);
        if (name === "replSetGetConfig") return reply(server.replSetConfig);
        return reply(server.buildInfo);
      },
      collection: () => ({
        findOne: async () => {
          const value = database === "local" ? server.localReplset : server.configVersion;
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

describe("instanceId: telling apart replica sets with the same name", () => {
  const unauthorized = () => {
    throw new MongoServerError({ message: "not authorized", code: 13 });
  };
  const replicaSetWith = (server: Partial<FakeServer>) =>
    describeDeployment(
      fakeClient({ hello: { setName: "rs0" }, buildInfo: { version: "8.0.0" }, ...server }).client,
    );

  it("derives it from replSetGetConfig's settings.replicaSetId", async () => {
    const id = new ObjectId();
    const first = await replicaSetWith({
      replSetConfig: { config: { settings: { replicaSetId: id } } },
    });
    const again = await replicaSetWith({
      replSetConfig: { config: { settings: { replicaSetId: id } } },
    });
    const other = await replicaSetWith({
      replSetConfig: { config: { settings: { replicaSetId: new ObjectId() } } },
    });
    expect(first.instanceId).toMatch(/^[0-9a-f]{32}$/);
    expect(again.instanceId).toBe(first.instanceId);
    // Same set name, so the same clusterId, but a different deployment.
    expect(other.clusterId).toBe(first.clusterId);
    expect(other.instanceId).not.toBe(first.instanceId);
  });

  it("falls back to local.system.replset, then to no instanceId at all", async () => {
    const id = new ObjectId();
    const viaCommand = await replicaSetWith({
      replSetConfig: { config: { settings: { replicaSetId: id } } },
    });
    const viaLocal = await replicaSetWith({
      replSetConfig: unauthorized,
      localReplset: { settings: { replicaSetId: id } },
    });
    expect(viaLocal.instanceId).toBe(viaCommand.instanceId);
    const unknown = await replicaSetWith({
      replSetConfig: unauthorized,
      localReplset: unauthorized,
    });
    expect(unknown.instanceId).toBeUndefined();
    expect(unknown.clusterId).toBe(viaCommand.clusterId);
  });

  it("is never read for other topologies", async () => {
    const { client, commands } = fakeClient({
      hello: { isWritablePrimary: true },
      buildInfo: { version: "7.0.0" },
    });
    expect((await describeDeployment(client)).instanceId).toBeUndefined();
    expect(commands).not.toContain("replSetGetConfig");
  });

  it("matches deployments on clusterId, and on instanceId only when both know it", () => {
    const a = { clusterId: "c1", instanceId: "i1" };
    expect(sameDeployment(a, { clusterId: "c1", instanceId: "i1" })).toBe(true);
    expect(sameDeployment(a, { clusterId: "c1", instanceId: "i2" })).toBe(false);
    // Old manifests (and users without the privilege) record no instanceId.
    expect(sameDeployment(a, { clusterId: "c1" })).toBe(true);
    expect(sameDeployment({ clusterId: "c1" }, a)).toBe(true);
    expect(sameDeployment(a, { clusterId: "c2", instanceId: "i1" })).toBe(false);
    expect(sameDeployment({}, {})).toBe(false);
  });

  it("warns when a replica set outside Atlas is known by its name alone", () => {
    const base: DeploymentInfo = {
      topology: "replicaSet",
      serverVersion: "8.0.0",
      clusterId: "c1",
      supportsChangeStreams: true,
      supportsSnapshotReads: true,
      maxBsonObjectSize: 16 * 1024 * 1024,
    };
    expect(deploymentIdentityWarning(base)).toContain("clusterMonitor");
    expect(deploymentIdentityWarning({ ...base, instanceId: "i1" })).toBeUndefined();
    expect(
      deploymentIdentityWarning({ ...base, atlas: { tier: "dedicated", signals: [] } }),
    ).toBeUndefined();
    expect(deploymentIdentityWarning({ ...base, topology: "sharded" })).toBeUndefined();
  });
});

describe("compatible engines", () => {
  it("recognises FerretDB by buildInfo and DocumentDB and Cosmos DB by host name", async () => {
    const ferret = await describeDeployment(
      fakeClient({
        hello: { setName: "rs0" },
        buildInfo: { version: "7.0.77", ferretdb: { version: "v2.0.0" } },
      }).client,
    );
    expect(ferret.engine).toBe("ferretdb");
    const documentdb = await describeDeployment(
      fakeClient({
        hello: { setName: "rs0" },
        buildInfo: { version: "5.0.0" },
        hosts: ["docs.cluster-abc.eu-west-1.docdb.amazonaws.com:27017"],
      }).client,
    );
    expect(documentdb.engine).toBe("documentdb");
    const cosmos = await describeDeployment(
      fakeClient({
        hello: { setName: "globaldb" },
        buildInfo: { version: "7.0.0" },
        hosts: ["acct.mongo.cosmos.azure.com:10255"],
      }).client,
    );
    expect(cosmos.engine).toBe("cosmosdb");
    const mongo = await describeDeployment(
      fakeClient({ hello: { setName: "rs0" }, buildInfo: { version: "8.0.0" } }).client,
    );
    expect(mongo.engine).toBeUndefined();
  });
});
