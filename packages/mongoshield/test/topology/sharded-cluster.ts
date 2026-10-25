// A real sharded cluster in Docker for the topology suite, built from the official
// `mongo` image with Testcontainers:
//
//   network "mongoshield-…"
//     cfg      mongod --configsvr  (replica set "cfg", one member)
//     shard1   mongod --shardsvr   (replica set "shard1", one member)
//     shard2   mongod --shardsvr   (replica set "shard2", one member)
//     mongos   mongos --configdb cfg/cfg:27017   ← the only port published to the host
//
// Every member is addressed by its network alias inside Docker, and the tests only
// ever talk to mongos (as applications do), so the host never needs to resolve the
// aliases. Single-member shards keep start-up around half a minute; what the suite
// tests (routing, cluster-wide change streams, chunk placement) does not depend on
// the shards having secondaries. Use `isDockerAvailable()` (test/helpers/docker.ts)
// to skip cleanly without Docker.

import { MongoClient } from "mongodb";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";

/** The official image; MONGO_IMAGE overrides it (e.g. `mongo:7.0`). */
export const MONGO_IMAGE = process.env.MONGO_IMAGE ?? "mongo:8.0";

/** Every member listens on the default port inside its own container. */
const PORT = 27017;

/** mongod/mongos print this once they accept connections. */
const READY = Wait.forLogMessage(/Waiting for connections/);

/** A running cluster. */
export interface ShardedCluster {
  /** Connection string of mongos, as seen from the host. */
  readonly uri: string;
  /** A client connected to mongos, closed by `stop()`. */
  readonly client: MongoClient;
  /** Names of the shards (`shard1`, `shard2`). */
  readonly shards: readonly string[];
  stop(): Promise<void>;
}

/** Starts a mongod container that will be member 0 of replica set `name`. */
function startMember(
  network: StartedNetwork,
  name: string,
  role: "--configsvr" | "--shardsvr",
): Promise<StartedTestContainer> {
  return new GenericContainer(MONGO_IMAGE)
    .withNetwork(network)
    .withNetworkAliases(name)
    .withCommand(["mongod", role, "--replSet", name, "--port", String(PORT), "--bind_ip_all"])
    .withWaitStrategy(READY)
    .withStartupTimeout(180_000)
    .start();
}

/**
 * Initiates a one-member replica set inside its container (with mongosh, which the
 * image ships) and waits until that member is primary.
 */
async function initiate(
  container: StartedTestContainer,
  name: string,
  configServer: boolean,
): Promise<void> {
  const config = JSON.stringify({
    _id: name,
    ...(configServer ? { configsvr: true } : {}),
    members: [{ _id: 0, host: `${name}:${PORT}` }],
  });
  await mongosh(container, `rs.initiate(${config})`);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const output = await mongosh(container, "db.hello().isWritablePrimary");
    if (output.trim().endsWith("true")) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`replica set ${name} has no primary`);
}

/** Runs a mongosh expression in a container and returns its output. */
async function mongosh(container: StartedTestContainer, script: string): Promise<string> {
  const result = await container.exec([
    "mongosh",
    "--quiet",
    "--port",
    String(PORT),
    "--eval",
    script,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`mongosh failed (${result.exitCode}): ${result.output}`);
  }
  return result.output;
}

/**
 * Starts the cluster described in the header and adds both shards. Takes about
 * 20–60 seconds, plus the image pull the first time.
 */
export async function startShardedCluster(): Promise<ShardedCluster> {
  const network = await new Network().start();
  const started: StartedTestContainer[] = [];
  const stopAll = async (): Promise<void> => {
    for (const container of started.reverse()) {
      await container.stop().catch(() => undefined);
    }
    await network.stop().catch(() => undefined);
  };
  try {
    const shards = ["shard1", "shard2"];
    const members = await Promise.all([
      startMember(network, "cfg", "--configsvr"),
      ...shards.map((shard) => startMember(network, shard, "--shardsvr")),
    ]);
    started.push(...members);
    await Promise.all(
      members.map((member, index) =>
        index === 0
          ? initiate(member, "cfg", true)
          : initiate(member, shards[index - 1] ?? "", false),
      ),
    );

    const mongos = await new GenericContainer(MONGO_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("mongos")
      .withCommand([
        "mongos",
        "--configdb",
        `cfg/cfg:${PORT}`,
        "--port",
        String(PORT),
        "--bind_ip_all",
      ])
      .withExposedPorts(PORT)
      .withWaitStrategy(READY)
      .withStartupTimeout(180_000)
      .start();
    started.push(mongos);

    const uri = `mongodb://${mongos.getHost()}:${mongos.getMappedPort(PORT)}/`;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 60_000 });
    for (const shard of shards) {
      await client.db("admin").command({ addShard: `${shard}/${shard}:${PORT}`, name: shard });
    }
    return {
      uri,
      client,
      shards,
      async stop() {
        await client.close().catch(() => undefined);
        await stopAll();
      },
    };
  } catch (error) {
    await stopAll();
    throw error;
  }
}
