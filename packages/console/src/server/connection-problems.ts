/**
 * Turning a failed connection attempt into plain language plus a fix.
 *
 * The MongoDB driver's errors are precise but cryptic ("querySrv ENOTFOUND
 * _mongodb._tcp.cluster0.abcd.mongodb.net", "Client network socket disconnected before
 * secure TLS connection was established"). The onboarding flow and the connection test
 * show {@link explainConnectionError}'s answer instead: what is wrong, how to fix it,
 * and where to click (Atlas Network Access, Database Access, …).
 *
 * How each kind is recognised, from the errors the driver really throws (checked
 * against driver 7 and documented in test/integration/connection-check.test.ts):
 *
 *   dns-not-found       `querySrv ENOTFOUND|ENODATA|ESERVFAIL _mongodb._tcp.<host>`: the
 *                       SRV record does not exist (a typo in the cluster name, or a
 *                       deleted cluster), or `getaddrinfo ENOTFOUND <host>` for hosts
 *   network-blocked     an Atlas host, and the connection was closed, reset or timed out:
 *                       Atlas closes connections from addresses that are not on the
 *                       project's IP access list right after TCP connects, which shows up
 *                       as "socket disconnected before secure TLS connection was
 *                       established" or a server selection timeout
 *   paused-cluster      a message that says the cluster is paused (Atlas pauses Free
 *                       clusters after 60 days without connections)
 *   auth-failed         code 18 `AuthenticationFailed`, or Atlas's own proxy refusal
 *                       "bad auth : authentication failed" (code 8000 `AtlasError`)
 *   missing-privileges  code 13 `Unauthorized` ("not authorized on admin to execute")
 *   tls                 certificate errors (self-signed, unknown issuer, expired, wrong
 *                       host name) and TLS handshakes refused by a server without TLS
 *   connection-refused  `ECONNREFUSED`: nothing listens there; on localhost inside Docker
 *                       that is the console's own container
 *   timeout             any other server selection timeout
 *   unknown             everything else, with the driver's (scrubbed) message
 *
 * Messages never contain the connection string or password: the caller scrubs the
 * driver text it passes in (`detail`), and nothing here echoes the URI.
 */

import type { ConnectionProblem, ConnectionProblemKind } from "../shared/api.ts";

/** What {@link explainConnectionError} knows about the attempt besides the error. */
export interface ConnectionAttempt {
  /** Any host of the connection string is an Atlas host. */
  readonly atlas: boolean;
  /** The host names of the connection string (for messages; never credentials). */
  readonly hosts: readonly string[];
  /** The console runs in a container (localhost means the container, not the host). */
  readonly inContainer: boolean;
}

/** Atlas pages linked from the explanations. */
export const ATLAS_LINKS = {
  networkAccess: {
    label: "Atlas: Network Access (IP access list)",
    url: "https://cloud.mongodb.com/v2#/security/network/accessList",
  },
  databaseAccess: {
    label: "Atlas: Database Access (database users)",
    url: "https://cloud.mongodb.com/v2#/security/database/users",
  },
  clusters: { label: "Atlas: your clusters", url: "https://cloud.mongodb.com/v2#/clusters" },
  pausedDocs: {
    label: "Atlas docs: pause and resume clusters",
    url: "https://www.mongodb.com/docs/atlas/pause-terminate-cluster/",
  },
  tlsDocs: {
    label: "MongoDB docs: TLS options",
    url: "https://www.mongodb.com/docs/manual/reference/connection-string-options/#tls-options",
  },
  rolesDocs: {
    label: "MongoDB docs: backup and restore roles",
    url: "https://www.mongodb.com/docs/manual/reference/built-in-roles/#backup-and-restoration-roles",
  },
} as const;

/** Explains a connection error. `detail` is the driver's message, already scrubbed. */
export function explainConnectionError(
  error: unknown,
  detail: string,
  attempt: ConnectionAttempt,
): ConnectionProblem {
  const text = errorText(error, detail);
  const code = numericCode(error);
  return problemOf(classify(text, code, attempt), detail, attempt);
}

/** Which kind of problem the error text and code point to. */
export function classify(
  text: string,
  code: number | undefined,
  attempt: Pick<ConnectionAttempt, "atlas">,
): ConnectionProblemKind {
  if (/querySrv|queryTxt/i.test(text) || /_mongodb\._tcp\./i.test(text)) return "dns-not-found";
  if (/\bpaused\b/i.test(text)) return "paused-cluster";
  if (code === 18 || /authentication failed|bad auth/i.test(text)) return "auth-failed";
  if (code === 13 || /not authorized on|unauthorized/i.test(text)) return "missing-privileges";
  if (/getaddrinfo (?:ENOTFOUND|EAI_AGAIN)/i.test(text)) return "dns-not-found";
  // Certificate problems are TLS problems even on Atlas (e.g. an intercepting proxy).
  if (
    /certificate|self[- ]signed|CERT_|ERR_TLS|unable to (?:get|verify)|SSL routines|wrong version number/i.test(
      text,
    )
  ) {
    return "tls";
  }
  // Atlas drops connections from addresses that are not on the access list.
  if (
    attempt.atlas &&
    /ECONNRESET|socket disconnected|closed|timed out|ETIMEDOUT|Server selection/i.test(text)
  ) {
    return "network-blocked";
  }
  if (/secure TLS connection|ECONNRESET/i.test(text)) return "tls";
  if (/ECONNREFUSED/i.test(text)) return "connection-refused";
  if (/timed out|ETIMEDOUT|Server selection/i.test(text)) return "timeout";
  return "unknown";
}

/** The words and links for each kind. */
function problemOf(
  kind: ConnectionProblemKind,
  detail: string,
  attempt: ConnectionAttempt,
): ConnectionProblem {
  const host = attempt.hosts[0] ?? "the server";
  const base = { kind, detail };
  switch (kind) {
    case "dns-not-found":
      return {
        ...base,
        title: "That server name does not exist",
        message: attempt.atlas
          ? `The cluster address ${host} could not be found. There may be a typo in the cluster name, or the cluster was deleted.`
          : `The address ${host} could not be found.`,
        fix: attempt.atlas
          ? "Copy the connection string again from Atlas (Clusters → Connect → Drivers) and paste it unchanged."
          : attempt.inContainer && isLocalName(host)
            ? "The console runs in Docker: use the database's container name on the same Docker network, or host.docker.internal for a database on this computer."
            : "Check the host name for typos and that this server can resolve it (DNS).",
        links: attempt.atlas ? [ATLAS_LINKS.clusters] : [],
      };
    case "network-blocked":
      return {
        ...base,
        title: "Atlas did not let this console in",
        message:
          "The connection was closed before it was set up. Atlas does this when the console's IP address is not on the project's IP access list. (A paused cluster looks the same.)",
        fix: "In Atlas, open Network Access and add the console's public IP address (or 0.0.0.0/0 to allow any address, which is less safe). If the cluster is paused, resume it.",
        links: [ATLAS_LINKS.networkAccess, ATLAS_LINKS.clusters],
        offerPublicIp: true,
      };
    case "paused-cluster":
      return {
        ...base,
        title: "The cluster is paused",
        message:
          "Atlas paused this cluster (Free clusters pause after 60 days without connections).",
        fix: "Resume it in Atlas (Clusters → … → Resume), wait until it is running, then try again.",
        links: [ATLAS_LINKS.clusters, ATLAS_LINKS.pausedDocs],
      };
    case "auth-failed":
      return {
        ...base,
        title: "Wrong user name or password",
        message: "The database refused the user name and password in the connection string.",
        fix: attempt.atlas
          ? "Check the database user in Atlas → Database Access (it is not your Atlas login), reset its password there if needed, and type it again. Special characters are encoded for you."
          : "Check the user name and password, and the authSource option if the user was created in another database than admin.",
        links: attempt.atlas ? [ATLAS_LINKS.databaseAccess] : [],
      };
    case "missing-privileges":
      return {
        ...base,
        title: "The user is not allowed to do this",
        message: privilegesMessage(attempt.atlas),
        fix: attempt.atlas
          ? 'In Atlas → Database Access, give the user the built-in role "readAnyDatabase" for backups, plus "readWriteAnyDatabase" (or readWrite on the target databases) for restores.'
          : "Grant the user the backup role (or readAnyDatabase) for backups, and the restore role (or readWrite on the target databases) for restores.",
        links: attempt.atlas
          ? [ATLAS_LINKS.databaseAccess, ATLAS_LINKS.rolesDocs]
          : [ATLAS_LINKS.rolesDocs],
      };
    case "tls":
      return {
        ...base,
        title: "The secure connection (TLS) failed",
        message:
          "The console and the database could not agree on an encrypted connection: the certificate is not trusted, is for another name, or TLS is on for one side only.",
        fix: "For a certificate from your own authority, mount its CA file into the container and add tlsCAFile=/path/to/ca.pem to the connection string. For a server without TLS, remove tls=true.",
        links: [ATLAS_LINKS.tlsDocs],
      };
    case "connection-refused":
      return {
        ...base,
        title: "Nothing is listening there",
        message: `The console reached ${host}, but no database accepted the connection on that port.`,
        fix:
          attempt.inContainer && isLocalName(host)
            ? "The console runs in Docker, where localhost is the console's own container. Use host.docker.internal for a database on this computer (on Linux, start the console with --add-host=host.docker.internal:host-gateway), or the database's container name on a shared Docker network."
            : "Check the port, and that the database is running and listens on that address (bindIp).",
        links: [],
      };
    case "timeout":
      return {
        ...base,
        title: "The database did not answer in time",
        message: `No server of ${host} answered within the time limit.`,
        fix: "Check that the host and port are right and that a firewall lets this console through. For a replica set, the console must reach every member under the names the set uses.",
        links: [],
      };
    case "unknown":
      return {
        ...base,
        title: "The connection failed",
        message: detail,
        fix: "Check the connection string, the network path and the user's rights.",
        links: [],
      };
  }
}

/** What backups and restores need, in plain words (used for errors and warnings). */
export function privilegesMessage(atlas: boolean): string {
  const base =
    "Backups need to read every collection (the readAnyDatabase role, or a custom role with find, listCollections, listIndexes and changeStream), and restores need to write the target databases (readWrite).";
  return atlas
    ? `${base} Atlas manages database users itself: change roles in Atlas → Database Access, not with database commands.`
    : base;
}

/** The error's text: its message, its causes, and every server's error in a selection failure. */
function errorText(error: unknown, detail: string): string {
  const parts: string[] = [detail];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    for (const field of ["message", "code", "codeName", "syscall"]) {
      const part: unknown = Reflect.get(value, field);
      if (typeof part === "string" || typeof part === "number") parts.push(String(part));
    }
    visit(Reflect.get(value, "cause"), depth + 1);
    // MongoServerSelectionError.reason.servers: a Map of server descriptions with errors.
    const reason: unknown = Reflect.get(value, "reason");
    if (typeof reason === "object" && reason !== null) {
      const servers: unknown = Reflect.get(reason, "servers");
      if (servers instanceof Map) {
        for (const server of servers.values()) {
          visit(
            typeof server === "object" && server !== null
              ? Reflect.get(server, "error")
              : undefined,
            depth + 1,
          );
        }
      }
    }
  };
  visit(error, 0);
  return parts.join(" | ");
}

/** A numeric MongoDB error code (18, 13, 8000), if the error has one. */
function numericCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "number" ? code : undefined;
}

/** localhost and friends: inside a container they mean the container itself. */
function isLocalName(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
