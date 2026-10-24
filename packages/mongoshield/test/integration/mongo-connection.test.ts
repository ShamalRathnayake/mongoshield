// Integration tests for openConnection and describeDeployment against the shared
// single-node replica set.
//
// The test server runs WITHOUT access control. mongod still verifies credentials that a
// client presents (SCRAM runs even when auth is disabled), so wrong passwords are
// rejected and MS_AUTH_FAILED can be tested; what cannot be tested here is a server
// refusing an unauthenticated client.

import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../../src/errors.ts";
import { describeDeployment } from "../../src/mongo/deployment.ts";
import { openConnection } from "../../src/mongo/index.ts";
import type { SourceOptions } from "../../src/types.ts";
import { version } from "../../src/version.ts";
import { mongoUri, uniqueDb, useMongoClient } from "../helpers/mongo.ts";

const adminClient = useMongoClient();

/** The shared test URI with credentials and an authSource added. */
function uriWithCredentials(user: string, password: string, authSource: string): string {
  const url = new URL(mongoUri());
  url.username = user;
  url.password = password;
  url.searchParams.set("authSource", authSource);
  return url.toString();
}

/** Runs `action` and returns the MongoShieldError it throws (fails the test otherwise). */
async function captureError(action: () => Promise<unknown>): Promise<MongoShieldError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MongoShieldError) return error;
    throw error;
  }
  throw new Error("expected the action to throw");
}

describe("openConnection", () => {
  it("connects from a URI, owns the client and closes it on close()", async () => {
    const connection = await openConnection({ uri: mongoUri() });
    expect(connection.owned).toBe(true);
    const reply = await connection.client.db("admin").command({ ping: 1 });
    expect(reply.ok).toBe(1);

    await connection.close();
    await expect(connection.client.db("admin").command({ ping: 1 })).rejects.toThrow();
    // close() is idempotent.
    await connection.close();
  });

  it("identifies itself to the server as mongoshield/<version> by default", async () => {
    const connection = await openConnection({ uri: mongoUri() });
    try {
      expect(connection.client.options.appName).toBe(`mongoshield/${version}`);
    } finally {
      await connection.close();
    }
  });

  it("uses an explicit appName, and keeps an appName already in the URI", async () => {
    const explicit = await openConnection({ uri: mongoUri() }, { appName: "nightly-job" });
    const url = new URL(mongoUri());
    url.searchParams.set("appName", "from-uri");
    const fromUri = await openConnection({ uri: url.toString() });
    try {
      expect(explicit.client.options.appName).toBe("nightly-job");
      expect(fromUri.client.options.appName).toBe("from-uri");
    } finally {
      await explicit.close();
      await fromUri.close();
    }
  });

  it("never closes a client supplied by the caller", async () => {
    const userClient = new MongoClient(mongoUri());
    try {
      const connection = await openConnection({ client: userClient });
      expect(connection.owned).toBe(false);
      expect(connection.client).toBe(userClient);

      await connection.close();
      const reply = await userClient.db("admin").command({ ping: 1 });
      expect(reply.ok).toBe(1);
    } finally {
      await userClient.close();
    }
  });

  it.each([
    ["both uri and client", () => ({ uri: mongoUri(), client: adminClient() })],
    ["neither uri nor client", () => ({})],
    ["an empty uri", () => ({ uri: "  " })],
    ["a client that is not a MongoClient", () => ({ client: { fake: true } })],
  ])("rejects a source with %s as MS_CONFIG_INVALID", async (_label, makeSource) => {
    // Runtime validation protects JavaScript callers, so bypass the static type here.
    const source = makeSource() as unknown as SourceOptions;
    const error = await captureError(() => openConnection(source));
    expect(error.code).toBe("MS_CONFIG_INVALID");
  });

  it("reports a malformed connection string as MS_CONFIG_INVALID without the password", async () => {
    const error = await captureError(() =>
      openConnection({ uri: "mongodb://user:s3cret-pw@host/?authMechanism=BOGUS" }),
    );
    expect(error.code).toBe("MS_CONFIG_INVALID");
    expect(error.message).not.toContain("s3cret-pw");
  });

  it("reports a refused connection as MS_CONNECTION_FAILED with a redacted URI and a hint", async () => {
    // Port 1 is privileged and never has mongod on it, so the connection is refused fast.
    const uri = "mongodb://admin:hunter2-secret@127.0.0.1:1/?directConnection=true";
    const error = await captureError(() =>
      openConnection({ uri }, { serverSelectionTimeoutMS: 1_000 }),
    );
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(error.message).toContain("mongodb://admin:***@127.0.0.1:1");
    expect(error.message).not.toContain("hunter2-secret");
    expect(error.hint).toMatch(/mongod is running/);
  });

  it("explains DNS failures for hosts that do not resolve", async () => {
    // `.invalid` is reserved (RFC 2606) and never resolves.
    const error = await captureError(() =>
      openConnection(
        { uri: "mongodb://no-such-host.invalid:27017/" },
        { serverSelectionTimeoutMS: 2_000 },
      ),
    );
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(error.hint).toMatch(/could not be resolved/);
  });

  it("explains SRV lookup failures for mongodb+srv URIs", async () => {
    const error = await captureError(() =>
      openConnection(
        { uri: "mongodb+srv://u:p4ss-word@no-such-host.invalid/" },
        { serverSelectionTimeoutMS: 2_000 },
      ),
    );
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(error.hint).toMatch(/SRV record/);
    expect(error.message).not.toContain("p4ss-word");
  });

  describe("with a database user", () => {
    const database = uniqueDb("auth");
    const user = `u_${database}`;
    const password = "correct-horse-battery";

    beforeAll(async () => {
      await adminClient()
        .db(database)
        .command({ createUser: user, pwd: password, roles: [{ role: "read", db: database }] });
    });

    afterAll(async () => {
      await adminClient().db(database).command({ dropAllUsersFromDatabase: 1 });
    });

    it("connects with the right credentials", async () => {
      const connection = await openConnection({
        uri: uriWithCredentials(user, password, database),
      });
      await connection.close();
    });

    it("reports wrong credentials as MS_AUTH_FAILED without leaking the password", async () => {
      const error = await captureError(() =>
        openConnection(
          { uri: uriWithCredentials(user, "wrong-password-123", database) },
          { serverSelectionTimeoutMS: 5_000 },
        ),
      );
      expect(isMongoShieldError(error, "MS_AUTH_FAILED")).toBe(true);
      expect(error.hint).toMatch(/authSource/);
      expect(error.message).not.toContain("wrong-password-123");
    });

    it("reports a wrong authSource as MS_AUTH_FAILED", async () => {
      const error = await captureError(() =>
        openConnection({ uri: uriWithCredentials(user, password, "admin") }),
      );
      expect(error.code).toBe("MS_AUTH_FAILED");
    });
  });
});

describe("describeDeployment", () => {
  it("describes the test replica set", async () => {
    const info = await describeDeployment(adminClient());
    const buildInfo = await adminClient().db("admin").command({ buildInfo: 1 });

    expect(info.topology).toBe("replicaSet");
    expect(info.serverVersion).toBe(buildInfo.version);
    expect(info.supportsChangeStreams).toBe(true);
    // The test server is 5.0+, where snapshot reads work outside transactions.
    expect(info.supportsSnapshotReads).toBe(Number(info.serverVersion.split(".")[0]) >= 5);
    expect(info.maxBsonObjectSize).toBe(16 * 1024 * 1024);
    expect(info.clusterId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("derives the same cluster id from every connection to the same deployment", async () => {
    const connection = await openConnection({ uri: mongoUri() });
    try {
      const first = await describeDeployment(adminClient());
      const second = await describeDeployment(connection.client);
      expect(second.clusterId).toBe(first.clusterId);
    } finally {
      await connection.close();
    }
  });

  it("does not expose the replica set name in the cluster id", async () => {
    const hello = await adminClient().db("admin").command({ hello: 1 });
    const info = await describeDeployment(adminClient());
    expect(info.clusterId).not.toContain(String(hello.setName));
  });
});
