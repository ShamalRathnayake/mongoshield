// Unit tests for turning driver failures into MongoShield errors with useful hints,
// and for keeping passwords out of them. Connecting to a real server is tested in
// test/integration/mongo-connection.test.ts.

import {
  MongoClient,
  MongoMissingCredentialsError,
  MongoNetworkError,
  MongoParseError,
  MongoServerError,
  MongoServerSelectionError,
  type TopologyDescription,
} from "mongodb";
import { describe, expect, it } from "vitest";
import { isMongoShieldError, MongoShieldError } from "../errors.ts";
import type { SourceOptions } from "../types.ts";
import { openConnection, toConnectionError } from "./connection.ts";

const context = { location: "mongodb://db.example.com:27017" };

/** An error with a Node-style string `code`, optionally wrapping a cause. */
function codedError(message: string, code: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? {} : { cause });
  Object.assign(error, { code });
  return error;
}

function hintOf(error: unknown): string {
  return toConnectionError(error, context).hint ?? "";
}

describe("toConnectionError", () => {
  it("passes MongoShield errors through unchanged", () => {
    const original = new MongoShieldError("MS_ABORTED", "stopped");
    expect(toConnectionError(original, context)).toBe(original);
  });

  it("reports rejected credentials, also when wrapped in another error", () => {
    const rejected = new MongoServerError({ message: "Authentication failed.", code: 18 });
    expect(toConnectionError(rejected, context).code).toBe("MS_AUTH_FAILED");
    const wrapped = new Error("selection failed", { cause: rejected });
    expect(toConnectionError(wrapped, context).code).toBe("MS_AUTH_FAILED");
  });

  it("reports parse and credential mistakes as configuration errors", () => {
    expect(toConnectionError(new MongoParseError("bad uri"), context).code).toBe(
      "MS_CONFIG_INVALID",
    );
    expect(toConnectionError(new MongoMissingCredentialsError("no user"), context).code).toBe(
      "MS_CONFIG_INVALID",
    );
  });

  it("hints at DNS for unresolvable hosts", () => {
    expect(hintOf(codedError("getaddrinfo ENOTFOUND db", "ENOTFOUND"))).toMatch(/resolved/);
    expect(hintOf(new Error("querySrv ESERVFAIL _mongodb._tcp.x"))).toMatch(/SRV record/);
  });

  it("hints at TLS for certificate failures, by code or message", () => {
    expect(hintOf(codedError("expired", "CERT_HAS_EXPIRED"))).toMatch(/TLS/);
    expect(hintOf(codedError("x", "ERR_TLS_CERT_ALTNAME_INVALID"))).toMatch(/TLS/);
    expect(hintOf(codedError("x", "ERR_SSL_WRONG_VERSION_NUMBER"))).toMatch(/TLS/);
    expect(hintOf(codedError("x", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toMatch(/TLS/);
    expect(hintOf(new Error("self-signed certificate in chain"))).toMatch(/TLS/);
  });

  it("hints at a stopped server for refused connections, found in the cause chain", () => {
    const refused = codedError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED");
    expect(hintOf(new Error("outer", { cause: refused }))).toMatch(/Nothing is accepting/);
  });

  it("hints at reachability for selection timeouts and network errors", () => {
    const description = { type: "Unknown", servers: new Map() } as unknown as TopologyDescription;
    const selection = new MongoServerSelectionError("timed out", description);
    expect(hintOf(selection)).toMatch(/No suitable server/);
    expect(hintOf(new MongoNetworkError("connection reset"))).toMatch(/network connection/);
    expect(hintOf("a thrown string")).toMatch(/running and reachable/);
    expect(toConnectionError("a thrown string", context).message).toContain("a thrown string");
  });

  it("removes the given secrets from the message", () => {
    const error = toConnectionError(new Error("auth with hunter2 failed"), {
      ...context,
      secrets: ["hunter2"],
    });
    expect(error.code).toBe("MS_CONNECTION_FAILED");
    expect(error.message).not.toContain("hunter2");
  });
});

describe("openConnection", () => {
  it("refuses a source with both or neither of uri and client, or an empty uri", async () => {
    const client = new MongoClient("mongodb://127.0.0.1:1");
    try {
      const sources = [
        {},
        { uri: "mongodb://x", client },
        { uri: "  " },
      ] as unknown as SourceOptions[];
      for (const source of sources) {
        const error: unknown = await openConnection(source).catch((caught: unknown) => caught);
        expect(isMongoShieldError(error, "MS_CONFIG_INVALID")).toBe(true);
      }
      const notAClient: unknown = await openConnection({
        client: {} as unknown as MongoClient,
      }).catch((caught: unknown) => caught);
      expect(isMongoShieldError(notAClient, "MS_CONFIG_INVALID")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reports a malformed connection string as a configuration error", async () => {
    // A wrong scheme is rejected by mongodb-connection-string-url, whose MongoParseError
    // is not the driver's class; a bad option value by the driver itself.
    for (const uri of ["not-a-uri", "mongo://localhost", "mongodb://localhost/?tls=maybe"]) {
      const error: unknown = await openConnection({ uri }).catch((caught: unknown) => caught);
      expect(isMongoShieldError(error) && error.code).toBe("MS_CONFIG_INVALID");
    }
  });

  it("keeps the password out of the error, even when it is not valid percent-encoding", async () => {
    // `%E0%A4%A` does not decode, so only the raw spelling can be scrubbed.
    for (const password of ["s3cr3t-pass", "bad%E0%A4%Apass"]) {
      const uri = `mongodb://ada:${password}@127.0.0.1:1/?directConnection=true&appName=mine`;
      const error: unknown = await openConnection({ uri }, { serverSelectionTimeoutMS: 200 }).catch(
        (caught: unknown) => caught,
      );
      expect(isMongoShieldError(error)).toBe(true);
      if (!isMongoShieldError(error)) continue;
      expect(["MS_CONNECTION_FAILED", "MS_CONFIG_INVALID"]).toContain(error.code);
      expect(error.message).not.toContain(password);
      expect(error.hint ?? "").not.toContain(password);
    }
  });
});
