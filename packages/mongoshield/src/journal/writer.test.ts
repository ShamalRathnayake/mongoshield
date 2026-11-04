// Unit tests for the deployment checks `startJournal` makes before it takes the lease
// (writer.ts, "The deployment"): servers whose change streams cannot carry what the
// journal records are refused with a fatal error instead of being retried forever. A
// fake client stands in for servers the test replica set cannot be (MongoDB 5.0, a
// standalone server). The writer itself is tested against a real server in
// test/integration/journal-writer.test.ts.

import type { Document, MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError } from "../errors.ts";
import { memoryStorage } from "../storage/memory.ts";
import { startJournal } from "./writer.ts";

/** Just enough of a MongoClient for `describeDeployment`, answering with `hello`. */
function fakeClient(hello: Document, version: string): MongoClient {
  const fake = {
    options: { hosts: [{ toString: () => "db1:27017" }] },
    db: () => ({
      command: async (command: Document) => {
        if ("hello" in command) return hello;
        if ("buildInfo" in command) return { version };
        return {};
      },
      collection: () => ({ findOne: async () => null }),
    }),
  };
  return fake as unknown as MongoClient;
}

/** What `startJournal` fails with (or `undefined` when it starts). */
async function startFailure(client: MongoClient): Promise<unknown> {
  try {
    const handle = await startJournal({ client, storage: memoryStorage() });
    await handle.stop();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("startJournal on deployments that cannot be journaled", () => {
  it("refuses MongoDB before 6.0, whose change streams have no DDL events", async () => {
    const error = await startFailure(fakeClient({ setName: "rs0" }, "5.0.3"));
    expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(String(error)).toContain("5.0.3");
    expect(isMongoShieldError(error) && error.hint).toContain("6.0");
  });

  it("refuses a standalone server, which has no change streams", async () => {
    const error = await startFailure(fakeClient({ isWritablePrimary: true }, "8.0.0"));
    expect(isMongoShieldError(error, "MS_UNSUPPORTED_TOPOLOGY")).toBe(true);
    expect(String(error)).toContain("standalone");
  });
});
