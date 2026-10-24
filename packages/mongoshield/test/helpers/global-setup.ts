import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { TestProject } from "vitest/node";

/**
 * Starts one single-node replica set for the whole integration run.
 * Tests isolate themselves by using unique database names (see `uniqueDb()`).
 *
 * Locally, set MONGOMS_SYSTEM_BINARY to an installed mongod to skip the download.
 * In CI, MONGOMS_VERSION selects the server version for the matrix.
 */

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

let replSet: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await replSet.waitUntilRunning();
  project.provide("mongoUri", replSet.getUri());
}

export async function teardown(): Promise<void> {
  await replSet?.stop();
}
