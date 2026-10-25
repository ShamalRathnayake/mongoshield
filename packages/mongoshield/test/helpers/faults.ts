// Fault injection for tests that need a real server to misbehave in one precise way:
//
// - `clientWithFaults` wraps a connected client so that chosen `db.command()` calls
//   fail with an error the test builds (a dropped connection, a killed cursor, lost
//   history); every other call reaches the real server.
// - `startTcpProxy` forwards TCP connections to the test mongod, and can cut every open
//   connection at once, which is what a network blip looks like to the driver.

import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Db, DbOptions, Document, MongoClient, RunCommandOptions } from "mongodb";

/**
 * Decides whether a command fails: an error to throw, or `undefined` to run it. It may
 * also be async, to hold a command back until the test has changed something.
 */
export type FaultInjector = (
  command: Document,
  database: string,
) => Error | undefined | Promise<Error | undefined>;

/**
 * The client, with `db(name).command(…)` routed through `inject` first. Collections,
 * sessions and everything else are the real client's.
 */
export function clientWithFaults(client: MongoClient, inject: FaultInjector): MongoClient {
  const wrapDb = (db: Db): Db =>
    new Proxy(db, {
      get(target, property) {
        if (property !== "command") return bound(target, property);
        return async (command: Document, options?: RunCommandOptions) => {
          const fault = await inject(command, target.databaseName);
          if (fault !== undefined) throw fault;
          return target.command(command, options);
        };
      },
    });
  return new Proxy(client, {
    get(target, property) {
      if (property !== "db") return bound(target, property);
      return (name?: string, options?: DbOptions) => wrapDb(target.db(name, options));
    },
  });
}

/** True for the `getMore` of a change stream opened with `aggregate: 1`. */
export function isChangeStreamGetMore(command: Document): boolean {
  return command.getMore !== undefined && command.collection === "$cmd.aggregate";
}

/** The `$changeStream` stage of an `aggregate` command, if it is one. */
export function changeStreamStage(command: Document): Document | undefined {
  const pipeline: unknown = command.pipeline;
  if (command.aggregate !== 1 || !Array.isArray(pipeline)) return undefined;
  const stage: unknown = pipeline[0]?.$changeStream;
  return typeof stage === "object" && stage !== null ? stage : undefined;
}

/** A running TCP proxy in front of a server. */
export interface TcpProxy {
  /** `host:port` to connect to instead of the server. */
  readonly address: string;
  /** Destroys every open connection (both directions); new ones are accepted. */
  dropConnections(): number;
  close(): Promise<void>;
}

/** Starts a proxy on localhost that forwards every connection to `target` (`host:port`). */
export async function startTcpProxy(target: string): Promise<TcpProxy> {
  const [host = "127.0.0.1", port = "27017"] = target.split(":");
  const open = new Set<Socket>();
  const server: Server = createServer((client) => {
    const upstream = createConnection({ host, port: Number(port) });
    for (const socket of [client, upstream]) {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no proxy address");
  return {
    address: `127.0.0.1:${address.port}`,
    dropConnections() {
      const count = open.size;
      for (const socket of open) socket.destroy();
      return count;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The `host:port` of the first host in a MongoDB connection string. */
export function firstHostOf(uri: string): string {
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^,/?]+)/.exec(uri);
  if (match?.[1] === undefined) throw new Error(`cannot read a host from ${uri}`);
  return match[1];
}

/** A property of `target`, with methods bound to it (proxies must not rebind `this`). */
function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}
