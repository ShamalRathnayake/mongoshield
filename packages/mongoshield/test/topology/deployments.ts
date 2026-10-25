// Deployments for the topology suites: multi-node replica sets and replica sets with
// access control, started with mongodb-memory-server (the sharded cluster, which
// needs Docker, lives in sharded-cluster.ts).
//
// Each test file starts its own deployment in `beforeAll` and stops it in `afterAll`,
// so the normal integration run (one single-node replica set shared by every file)
// stays fast. Locally, MONGOMS_SYSTEM_BINARY=$(which mongod) skips the download; in CI
// MONGOMS_VERSION picks the server version.

import { setTimeout as sleep } from "node:timers/promises";
import { type Document, MongoClient, type MongoClientOptions, MongoServerError } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/** `replSet.configSettings` of mongodb-memory-server (its type is not exported). */
type ReplicaSetSettings = NonNullable<
  NonNullable<
    NonNullable<Parameters<typeof MongoMemoryReplSet.create>[0]>["replSet"]
  >["configSettings"]
>;

/** A running replica set. */
export interface ReplicaSetDeployment {
  /** Connection string without credentials (`mongodb://h1,h2,h3/?replicaSet=…`). */
  readonly uri: string;
  /** Host:port of every member, in the order mongodb-memory-server started them. */
  readonly hosts: readonly string[];
  /** A client with full privileges (the root user when auth is on), closed by `stop()`. */
  readonly admin: MongoClient;
  /** The connection string for `user` / `password`, authenticating against `authSource`. */
  uriFor(user: string, password: string, authSource?: string): string;
  /** A new client opened by this helper and closed by `stop()`. */
  client(options?: MongoClientOptions & { readonly uri?: string }): MongoClient;
  /** Host:port of the current primary, as the members report it. */
  primary(): Promise<string>;
  /** Steps the primary down and waits until another member is primary. Returns the old one. */
  stepDown(): Promise<string>;
  stop(): Promise<void>;
}

/** Credentials of the root user the harness creates when access control is on. */
export const ROOT_USER = "topology-root";
export const ROOT_PASSWORD = "root-pw-Z3q8vX1t";

/** Options for {@link startReplicaSet}. */
export interface ReplicaSetOptions {
  /** Number of data-bearing members. */
  readonly members: number;
  /** Turn on access control (`--auth` + keyfile) and create {@link ROOT_USER}. */
  readonly auth?: boolean;
  /** Replica set settings (heartbeat interval, election timeout, …). */
  readonly settings?: ReplicaSetSettings;
}

/**
 * Starts a replica set of `members` members and waits until it has a primary.
 *
 * `enableTestCommands` is set so tests can use the server's `failCommand` fail point:
 * it makes a command fail exactly the way a real election makes it fail, which a
 * test cannot otherwise time reliably.
 */
export async function startReplicaSet(options: ReplicaSetOptions): Promise<ReplicaSetDeployment> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: {
      count: options.members,
      storageEngine: "wiredTiger",
      args: ["--setParameter", "enableTestCommands=1"],
      ...(options.settings === undefined ? {} : { configSettings: options.settings }),
      ...(options.auth === true
        ? { auth: { enable: true, customRootName: ROOT_USER, customRootPwd: ROOT_PASSWORD } }
        : {}),
    },
  });
  await replSet.waitUntilRunning();
  const uri = replSet.getUri();
  const { hosts, query } = splitUri(uri);
  const clients: MongoClient[] = [];

  const uriFor = (user: string, password: string, authSource = "admin"): string => {
    const params = new URLSearchParams(query);
    params.set("authSource", authSource);
    const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
    return `mongodb://${credentials}${hosts.join(",")}/?${params.toString()}`;
  };
  const client = (clientOptions: MongoClientOptions & { readonly uri?: string } = {}) => {
    const { uri: clientUri, ...rest } = clientOptions;
    const created = new MongoClient(clientUri ?? uri, rest);
    clients.push(created);
    return created;
  };
  const admin = client(
    options.auth === true ? { uri: uriFor(ROOT_USER, ROOT_PASSWORD) } : { uri: uri },
  );
  await admin.db("admin").command({ ping: 1 });

  const primary = async (): Promise<string> => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const hello: Document = await admin.db("admin").command({ hello: 1 });
      if (typeof hello.primary === "string") return hello.primary;
      await sleep(100);
    }
    throw new Error("the replica set has no primary");
  };

  const stepDown = async (): Promise<string> => {
    const old = await primary();
    // `secondaryCatchUpPeriodSecs` gives a secondary time to catch up; under heavy
    // writes on a busy machine that can still fail with "No electable secondaries
    // caught up" (ExceededTimeLimit, 262), so try a few times. `force` would allow the
    // loss of acknowledged writes, which would make every comparison meaningless.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await admin.db("admin").command({ replSetStepDown: 30, secondaryCatchUpPeriodSecs: 10 });
        break;
      } catch (error) {
        if (error instanceof MongoServerError && error.code === 262 && attempt < 6) continue;
        // Some driver / server combinations close the connection that ran the command.
        if (error instanceof Error && /closed|network/i.test(error.message)) break;
        throw error;
      }
    }
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = await primary().catch(() => old);
      if (current !== old) return old;
      await sleep(100);
    }
    throw new Error("no new primary after the step-down");
  };

  return {
    uri,
    hosts,
    admin,
    uriFor,
    client,
    primary,
    stepDown,
    async stop() {
      for (const opened of clients) await opened.close().catch(() => undefined);
      await replSet.stop();
    },
  };
}

/** Commands seen by a monitored client, with the member each one was sent to. */
export interface SeenCommand {
  readonly name: string;
  readonly database: string;
  readonly address: string;
  readonly command: Document;
}

/**
 * A client with command monitoring on, recording every command it sends. This is how
 * the tests see which member a backup really read from: the driver reports the
 * address of the server each command went to.
 */
export function monitoredClient(
  deployment: ReplicaSetDeployment,
  options: MongoClientOptions & { readonly uri?: string } = {},
): { client: MongoClient; commands: SeenCommand[] } {
  const commands: SeenCommand[] = [];
  const client = deployment.client({ ...options, monitorCommands: true });
  client.on("commandStarted", (event) => {
    commands.push({
      name: event.commandName,
      database: event.databaseName,
      address: event.address,
      command: event.command,
    });
  });
  return { client, commands };
}

/**
 * Makes the commands named in `commands` fail on every member with `errorCode` (the
 * next `times` of them on each member, or all of them until the returned function
 * turns the fail point off), through the server's `failCommand` fail point (needs
 * `enableTestCommands`, which {@link startReplicaSet} sets). `appName` limits it to
 * clients with that application name, so the harness's own commands are unaffected.
 */
export async function failCommandsOnEveryMember(
  deployment: ReplicaSetDeployment,
  failure: {
    readonly commands: readonly string[];
    readonly errorCode: number;
    readonly times?: number;
    readonly appName: string;
    readonly errorLabels?: readonly string[];
  },
): Promise<() => Promise<void>> {
  const members = deployment.hosts.map((host) =>
    deployment.client({ uri: memberUri(deployment, host), directConnection: true }),
  );
  const data: Document = {
    failCommands: failure.commands,
    errorCode: failure.errorCode,
    appName: failure.appName,
  };
  if (failure.errorLabels !== undefined) data.errorLabels = failure.errorLabels;
  for (const member of members) {
    await member.db("admin").command({
      configureFailPoint: "failCommand",
      mode: failure.times === undefined ? "alwaysOn" : { times: failure.times },
      data,
    });
  }
  return async () => {
    for (const member of members) {
      await member.db("admin").command({ configureFailPoint: "failCommand", mode: "off" });
    }
  };
}

/**
 * Stops the secondaries from fetching new oplog entries (the server's
 * `stopReplProducer` fail point), so they fall behind the primary for as long as the
 * test wants: a lagging secondary, on demand. Returns the function that lets them
 * catch up again.
 */
export async function pauseReplication(
  deployment: ReplicaSetDeployment,
): Promise<() => Promise<void>> {
  const primary = await deployment.primary();
  const secondaries = deployment.hosts
    .filter((host) => host !== primary)
    .map((host) => deployment.client({ uri: memberUri(deployment, host), directConnection: true }));
  for (const secondary of secondaries) {
    await secondary
      .db("admin")
      .command({ configureFailPoint: "stopReplProducer", mode: "alwaysOn" });
  }
  return async () => {
    for (const secondary of secondaries) {
      await secondary.db("admin").command({ configureFailPoint: "stopReplProducer", mode: "off" });
    }
  };
}

/** A direct connection string to one member, with the admin client's credentials. */
function memberUri(deployment: ReplicaSetDeployment, host: string): string {
  const credentials = deployment.admin.options.credentials;
  if (credentials === undefined || credentials.username === "") return `mongodb://${host}/`;
  const user = `${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}`;
  return `mongodb://${user}@${host}/?authSource=${encodeURIComponent(credentials.source)}`;
}

/**
 * The hosts and query string of a `mongodb://h1,h2,h3/?…` URI. (WHATWG `URL` cannot
 * parse a list of hosts.)
 */
function splitUri(uri: string): { hosts: string[]; query: string } {
  const match = /^mongodb:\/\/([^/?]+)\/?[^?]*\??(.*)$/.exec(uri);
  if (match === null) throw new Error(`unexpected replica set URI ${uri}`);
  return { hosts: (match[1] ?? "").split(","), query: match[2] ?? "" };
}
