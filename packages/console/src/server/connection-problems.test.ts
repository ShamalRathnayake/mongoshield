/**
 * Tests for the plain-language connection errors: each kind is recognised from the
 * error the MongoDB driver really throws (shapes copied from driver 7 runs), and the
 * explanation carries the right fix and links without quoting the connection string.
 */

import { MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import { type ConnectionAttempt, classify, explainConnectionError } from "./connection-problems.ts";

const ATLAS: ConnectionAttempt = {
  atlas: true,
  hosts: ["cluster0.abcde.mongodb.net"],
  inContainer: true,
};
const LOCAL: ConnectionAttempt = { atlas: false, hosts: ["localhost"], inContainer: true };
const REMOTE: ConnectionAttempt = { atlas: false, hosts: ["db.example.com"], inContainer: false };

/** A network error as the driver nests it: name, message, cause with a code. */
function networkError(message: string, code: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new Error(message), { name: "MongoServerSelectionError", cause });
}

/** A server selection error whose per-server errors are in `reason.servers` (a Map). */
function selectionError(message: string, serverMessage: string): Error {
  const servers = new Map([["h:27017", { error: new Error(serverMessage) }]]);
  return Object.assign(new Error(message), {
    name: "MongoServerSelectionError",
    reason: { servers },
  });
}

/** Explains an error, using its message as the (already scrubbed) detail. */
function explain(error: Error, attempt: ConnectionAttempt) {
  return explainConnectionError(error, error.message, attempt);
}

describe("explainConnectionError", () => {
  it("recognises an SRV record that does not exist (a typo in the Atlas cluster name)", () => {
    const error = Object.assign(
      new Error("querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net"),
      { code: "ENOTFOUND", syscall: "querySrv" },
    );
    const problem = explain(error, ATLAS);
    expect(problem.kind).toBe("dns-not-found");
    expect(problem.message).toContain("cluster0.abcde.mongodb.net");
    expect(problem.fix).toMatch(/Copy the connection string again/);
    expect(problem.links.map((link) => link.url)).toContain(
      "https://cloud.mongodb.com/v2#/clusters",
    );
  });

  it("recognises SRV lookups that fail in other ways (no data, server failure, TXT)", () => {
    for (const message of [
      "querySrv ENODATA _mongodb._tcp.x.mongodb.net",
      "querySrv ESERVFAIL _mongodb._tcp.x.mongodb.net",
      "queryTxt ETIMEOUT x.mongodb.net",
    ]) {
      expect(classify(message, undefined, ATLAS), message).toBe("dns-not-found");
    }
  });

  it("recognises unknown host names, with Docker advice for local names", () => {
    const problem = explain(networkError("getaddrinfo ENOTFOUND mongo", "ENOTFOUND"), {
      atlas: false,
      hosts: ["localhost"],
      inContainer: true,
    });
    expect(problem.kind).toBe("dns-not-found");
    expect(problem.fix).toMatch(/host\.docker\.internal/);
    expect(explain(networkError("getaddrinfo ENOTFOUND db", "ENOTFOUND"), REMOTE).fix).toMatch(
      /typos/,
    );
  });

  it("explains Atlas closing the connection as the IP access list, and offers the public IP", () => {
    const problem = explain(
      networkError(
        "Client network socket disconnected before secure TLS connection was established",
        "ECONNRESET",
      ),
      ATLAS,
    );
    expect(problem.kind).toBe("network-blocked");
    expect(problem.offerPublicIp).toBe(true);
    expect(problem.fix).toMatch(/Network Access/);
    expect(problem.links[0]?.url).toBe("https://cloud.mongodb.com/v2#/security/network/accessList");
    // A server selection timeout to Atlas means the same.
    expect(
      explain(
        selectionError("Server selection timed out after 10000 ms", "connection closed"),
        ATLAS,
      ).kind,
    ).toBe("network-blocked");
  });

  it("recognises a paused cluster", () => {
    const problem = explain(new Error("cluster is paused"), ATLAS);
    expect(problem.kind).toBe("paused-cluster");
    expect(problem.fix).toMatch(/Resume/);
  });

  it("recognises wrong credentials, from mongod (18) and from Atlas's proxy (8000)", () => {
    const mongod = new MongoServerError({
      message: "Authentication failed.",
      code: 18,
      codeName: "AuthenticationFailed",
    });
    expect(explain(mongod, REMOTE).kind).toBe("auth-failed");
    expect(explain(mongod, REMOTE).fix).toMatch(/authSource/);
    const atlas = new MongoServerError({
      message: "bad auth : authentication failed",
      code: 8000,
      codeName: "AtlasError",
    });
    const problem = explain(atlas, ATLAS);
    expect(problem.kind).toBe("auth-failed");
    expect(problem.fix).toMatch(/Database Access/);
    expect(problem.links[0]?.url).toBe("https://cloud.mongodb.com/v2#/security/database/users");
  });

  it("explains missing privileges with the roles to grant, and that Atlas manages users", () => {
    const error = new MongoServerError({
      message: "not authorized on admin to execute command { listDatabases: 1 }",
      code: 13,
      codeName: "Unauthorized",
    });
    const atlas = explain(error, ATLAS);
    expect(atlas.kind).toBe("missing-privileges");
    expect(atlas.message).toMatch(/readAnyDatabase/);
    expect(atlas.message).toMatch(/changeStream/);
    expect(atlas.message).toMatch(/readWrite/);
    expect(atlas.message).toMatch(/Atlas manages database users/);
    expect(explain(error, REMOTE).message).not.toMatch(/Atlas/);
  });

  it("recognises TLS problems: untrusted certificates and one-sided TLS", () => {
    for (const message of [
      "self-signed certificate in certificate chain",
      "unable to verify the first certificate",
      "unable to get local issuer certificate",
      "certificate has expired",
      "Hostname/IP does not match certificate's altnames: ERR_TLS_CERT_ALTNAME_INVALID",
      "SSL routines:ssl3_get_record:wrong version number",
    ]) {
      expect(
        explain(selectionError("Server selection timed out", message), REMOTE).kind,
        message,
      ).toBe("tls");
    }
    // A TLS client talking to a server without TLS: the server hangs up.
    const oneSided = explain(
      networkError(
        "Client network socket disconnected before secure TLS connection was established",
        "ECONNRESET",
      ),
      REMOTE,
    );
    expect(oneSided.kind).toBe("tls");
    expect(oneSided.fix).toMatch(/tlsCAFile/);
    // Certificate errors stay TLS errors on Atlas too (an intercepting proxy, say).
    expect(explain(new Error("self-signed certificate in certificate chain"), ATLAS).kind).toBe(
      "tls",
    );
  });

  it("explains a refused connection to localhost inside Docker", () => {
    const problem = explain(
      networkError("connect ECONNREFUSED 127.0.0.1:27017", "ECONNREFUSED"),
      LOCAL,
    );
    expect(problem.kind).toBe("connection-refused");
    expect(problem.fix).toMatch(/localhost is the console's own container/);
    expect(problem.fix).toMatch(/host-gateway/);
    expect(
      explain(networkError("connect ECONNREFUSED 10.0.0.1:27017", "ECONNREFUSED"), REMOTE).fix,
    ).toMatch(/bindIp/);
  });

  it("recognises other timeouts and falls back to the driver's message", () => {
    expect(explain(new Error("Server selection timed out after 10000 ms"), REMOTE).kind).toBe(
      "timeout",
    );
    const unknown = explain(new Error("something odd"), REMOTE);
    expect(unknown.kind).toBe("unknown");
    expect(unknown.message).toBe("something odd");
    expect(unknown.detail).toBe("something odd");
  });

  it("copes with values that are not errors, and with cycles in causes", () => {
    expect(explainConnectionError("boom", "boom", REMOTE).kind).toBe("unknown");
    const looping: Error & { cause?: unknown } = new Error("Server selection timed out");
    looping.cause = looping;
    expect(explain(looping, REMOTE).kind).toBe("timeout");
  });
});
