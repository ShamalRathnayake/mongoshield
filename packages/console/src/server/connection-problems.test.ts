/**
 * Tests for the plain-language connection errors: each kind is recognised from the
 * error the MongoDB driver really throws (shapes copied from driver 7 runs), and the
 * explanation carries the right fix and links without quoting the connection string.
 */

import { MongoServerError } from "mongodb";
import { describe, expect, it } from "vitest";
import type { ContainerEnvironment } from "../shared/api.ts";
import { type ConnectionAttempt, classify, explainConnectionError } from "./connection-problems.ts";

/** Linux Docker Engine started without --add-host: host.docker.internal does not resolve. */
const DOCKER_ENGINE: ContainerEnvironment = {
  kind: "docker-engine",
  hostAlias: "host.docker.internal",
  hostAliasResolves: false,
};
/** Docker Desktop: host.docker.internal resolves. */
const DOCKER_DESKTOP: ContainerEnvironment = {
  kind: "docker-desktop",
  hostAlias: "host.docker.internal",
  hostAliasResolves: true,
};
const NO_CONTAINER: ContainerEnvironment = { kind: "none" };

const ATLAS: ConnectionAttempt = {
  atlas: true,
  hosts: ["cluster0.abcde.mongodb.net"],
  container: DOCKER_ENGINE,
};
const LOCAL: ConnectionAttempt = { atlas: false, hosts: ["localhost"], container: DOCKER_ENGINE };
const REMOTE: ConnectionAttempt = {
  atlas: false,
  hosts: ["db.example.com"],
  container: NO_CONTAINER,
};
/** The quick fill's address for "this computer" from inside a container. */
const ON_HOST: ConnectionAttempt = {
  atlas: false,
  hosts: ["host.docker.internal"],
  container: DOCKER_ENGINE,
};

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

  it("says the name does not exist only when DNS says so (ENOTFOUND, ENODATA)", () => {
    for (const message of [
      "querySrv ENOTFOUND _mongodb._tcp.x.mongodb.net",
      "querySrv ENODATA _mongodb._tcp.x.mongodb.net",
      "queryTxt ENODATA x.mongodb.net",
    ]) {
      expect(classify(message, undefined, ATLAS), message).toBe("dns-not-found");
    }
  });

  it("blames the DNS resolver, not the cluster, when an SRV or TXT lookup fails otherwise", () => {
    for (const message of [
      "querySrv ETIMEOUT _mongodb._tcp.x.mongodb.net",
      "querySrv ESERVFAIL _mongodb._tcp.x.mongodb.net",
      "querySrv ECONNREFUSED _mongodb._tcp.x.mongodb.net",
      "querySrv EREFUSED _mongodb._tcp.x.mongodb.net",
      "queryTxt ETIMEOUT x.mongodb.net",
      "queryTxt ECANCELLED x.mongodb.net",
    ]) {
      expect(classify(message, undefined, ATLAS), message).toBe("dns-resolver");
    }
    const error = Object.assign(new Error("querySrv ETIMEOUT _mongodb._tcp.cluster0.x.net"), {
      code: "ETIMEOUT",
      syscall: "querySrv",
    });
    const problem = explain(error, ATLAS);
    expect(problem.kind).toBe("dns-resolver");
    // Not "the cluster may be deleted": the resolver failed, and the standard
    // (non-SRV) connection string avoids the SRV lookup altogether.
    expect(problem.message).not.toMatch(/deleted/);
    expect(problem.fix).toMatch(/standard connection string/);
    expect(problem.fix).toMatch(/mongodb:\/\/host1:27017,host2:27017/);
    // getaddrinfo EAI_AGAIN ("temporary failure in name resolution") is the resolver too.
    expect(classify("getaddrinfo EAI_AGAIN db.example.com", undefined, REMOTE)).toBe(
      "dns-resolver",
    );
  });

  it("recognises unknown host names, with Docker advice for local names", () => {
    const problem = explain(networkError("getaddrinfo ENOTFOUND mongo", "ENOTFOUND"), {
      atlas: false,
      hosts: ["localhost"],
      container: DOCKER_DESKTOP,
    });
    expect(problem.kind).toBe("dns-not-found");
    expect(problem.fix).toMatch(/host\.docker\.internal/);
    expect(explain(networkError("getaddrinfo ENOTFOUND db", "ENOTFOUND"), REMOTE).fix).toMatch(
      /typos/,
    );
  });

  it("explains a missing host.docker.internal with the Linux --add-host fix", () => {
    const problem = explain(
      networkError("getaddrinfo ENOTFOUND host.docker.internal", "ENOTFOUND"),
      ON_HOST,
    );
    expect(problem.kind).toBe("dns-not-found");
    expect(problem.message).toContain("host.docker.internal");
    expect(problem.fix).toContain("--add-host=host.docker.internal:host-gateway");
    expect(problem.fix).toContain('extra_hosts: ["host.docker.internal:host-gateway"]');
    expect(problem.fix).not.toMatch(/typos/);
    // The same when the resolver itself gave up on the name.
    expect(
      explain(networkError("getaddrinfo EAI_AGAIN host.docker.internal", "EAI_AGAIN"), ON_HOST).fix,
    ).toContain("--add-host=host.docker.internal:host-gateway");
    // Under Podman, the name to use is host.containers.internal.
    const podman = explain(
      networkError("getaddrinfo ENOTFOUND host.docker.internal", "ENOTFOUND"),
      {
        ...ON_HOST,
        container: {
          kind: "podman",
          hostAlias: "host.containers.internal",
          hostAliasResolves: true,
        },
      },
    );
    expect(podman.fix).toContain("host.containers.internal");
    // Outside a container the name never exists: use localhost.
    expect(
      explain(networkError("getaddrinfo ENOTFOUND host.docker.internal", "ENOTFOUND"), {
        ...ON_HOST,
        container: NO_CONTAINER,
      }).fix,
    ).toMatch(/use localhost/);
  });

  it("points a refused host.docker.internal at mongod's bindIp", () => {
    const problem = explain(networkError("connect ECONNREFUSED 172.17.0.1:27017", "ECONNREFUSED"), {
      ...ON_HOST,
      container: DOCKER_DESKTOP,
    });
    expect(problem.kind).toBe("connection-refused");
    expect(problem.message).toContain("the machine it runs on");
    expect(problem.fix).toMatch(/bindIp/);
    expect(problem.fix).toMatch(/127\.0\.0\.1/);
  });

  it("keeps localhost advice right for Kubernetes and host networking", () => {
    const refused = networkError("connect ECONNREFUSED 127.0.0.1:27017", "ECONNREFUSED");
    const kubernetes = explain(refused, { ...LOCAL, container: { kind: "kubernetes" } });
    expect(kubernetes.fix).toMatch(/localhost is this pod/);
    expect(kubernetes.fix).toMatch(/svc\.cluster\.local/);
    expect(kubernetes.fix).not.toMatch(/host\.docker\.internal/);
    const hostNetwork = explain(refused, { ...LOCAL, container: { kind: "host-network" } });
    expect(hostNetwork.fix).toMatch(/bindIp/);
    expect(hostNetwork.fix).not.toMatch(/host\.docker\.internal/);
  });

  it("suggests host.containers.internal for localhost under Podman", () => {
    const problem = explain(networkError("connect ECONNREFUSED 127.0.0.1:27017", "ECONNREFUSED"), {
      ...LOCAL,
      container: {
        kind: "podman",
        hostAlias: "host.containers.internal",
        hostAliasResolves: true,
      },
    });
    expect(problem.fix).toMatch(/runs in Podman/);
    expect(problem.fix).toContain("host.containers.internal");
    // The alias resolves, so there is nothing to add.
    expect(problem.fix).not.toMatch(/--add-host/);
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
    const timeout = explain(new Error("Server selection timed out after 10000 ms"), REMOTE);
    expect(timeout.kind).toBe("timeout");
    // A single-node replica set behind Docker or a tunnel needs directConnection.
    expect(timeout.fix).toMatch(/directConnection=true/);
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
