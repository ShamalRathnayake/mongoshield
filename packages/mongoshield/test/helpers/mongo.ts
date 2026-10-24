import { randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, inject } from "vitest";

/** URI of the shared test replica set started in global-setup.ts. */
export function mongoUri(): string {
  return inject("mongoUri");
}

/** A unique database name so tests never interfere with each other. */
export function uniqueDb(prefix = "t"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/**
 * A connected client for the current test file, closed automatically after the file.
 * Call at the top level of a test file (not inside a test).
 */
export function useMongoClient(): () => MongoClient {
  const client = new MongoClient(mongoUri());
  let connected = false;
  afterAll(async () => {
    if (connected) await client.close();
  });
  return () => {
    connected = true;
    return client;
  };
}
