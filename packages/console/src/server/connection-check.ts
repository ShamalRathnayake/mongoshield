/**
 * The onboarding connection check: "does this connection string work, what is it, and
 * what should the defaults be?" (`POST /api/connections/check`, and the richer answer of
 * `POST /api/connections/:id/test`).
 *
 * On top of the plain test (mongo-inspect.ts: topology, version, missing privileges):
 *
 *   - failures are explained in plain words with a fix (connection-problems.ts);
 *   - Atlas clusters get their tier, Free/Flex ("shared") or dedicated, with the same
 *     one read-only probe the data browser uses (live/atlas-tier.ts, following the
 *     library's src/mongo/atlas.ts); the library adapts backups to the tier by itself;
 *   - users with per-database roles (common on Atlas) see which databases they can read,
 *     from `listDatabases` with `authorizedDatabases: true` and `nameOnly: true`, which
 *     works without the cluster-wide `listDatabases` privilege;
 *   - missing privileges come with advice on the roles to grant (a warning: the
 *     connection still works for what the user may do).
 *
 * Only metadata commands are sent (hello, buildInfo, connectionStatus, listDatabases,
 * getParameter on Atlas). No document is read.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { MongoClient } from "mongodb";
import type { ConnectionProblem, ConnectionTestResult } from "../shared/api.ts";
import {
  analyzeConnectionString,
  CONTAINER_HOST,
  ConnectionStringError,
  type ConnectionStringInfo,
  cleanPastedConnectionString,
  encodeCredentials,
  throughContainerHost,
} from "../shared/connection-string.ts";
import { scrubText } from "../state/redact.ts";
import type { DeploymentRecord } from "../state/types.ts";
import {
  ATLAS_LINKS,
  type ConnectionAttempt,
  explainConnectionError,
  privilegesMessage,
} from "./connection-problems.ts";
import { invalid } from "./errors.ts";
import { isSharedTier } from "./live/atlas-tier.ts";
import { describeConnected, withClient } from "./mongo-inspect.ts";

/** MongoDB's own databases: never offered for backup, never listed as "readable". */
const INTERNAL_DATABASES = new Set(["admin", "config", "local"]);

/**
 * True when the console runs in a container, where `localhost` is the container itself.
 * Docker creates `/.dockerenv`, Podman `/run/.containerenv`; Kubernetes sets
 * KUBERNETES_SERVICE_HOST in every pod.
 */
export function runsInContainer(): boolean {
  return (
    existsSync("/.dockerenv") ||
    existsSync("/run/.containerenv") ||
    process.env.KUBERNETES_SERVICE_HOST !== undefined
  );
}

/** Options for {@link inspectConnection}; tests replace the container check. */
export interface InspectOptions {
  readonly inContainer?: boolean;
  /**
   * The address to try when a loopback address is refused in a container. Defaults to
   * {@link throughContainerHost}; tests point it at their own database.
   */
  readonly containerAddress?: (uri: string) => string | undefined;
}

/**
 * Connects with `uri` and reports everything the onboarding page shows. Never throws:
 * failures come back as `ok: false` with `problem` (and the scrubbed `error`).
 *
 * In a container, `localhost` is the container itself. When a loopback address is
 * refused there, the console tries the machine it runs on (`host.docker.internal`)
 * by itself; if that connects, the result says so in `reachedThrough`, and the caller
 * uses {@link throughContainerHost} to get the address that worked.
 */
export async function inspectConnection(
  uri: string,
  options: InspectOptions = {},
): Promise<ConnectionTestResult> {
  const info = safeAnalyze(uri);
  const attempt: ConnectionAttempt = {
    atlas: info?.atlas ?? false,
    hosts: info?.hosts ?? [],
    inContainer: options.inContainer ?? runsInContainer(),
  };
  try {
    return await withClient(uri, (client) => describeWithExtras(client, attempt));
  } catch (error) {
    // Driver messages can contain the URI; scrub it before anything leaves the server.
    const detail = scrubText(error instanceof Error ? error.message : String(error), [uri]);
    const problem = explainConnectionError(error, detail, attempt);
    // "localhost" refused inside a container: the database is most likely on the host.
    const onHost = attempt.inContainer
      ? (options.containerAddress ?? throughContainerHost)(uri)
      : undefined;
    if (problem.kind === "connection-refused" && onHost !== undefined) {
      try {
        const viaHost = await withClient(onHost, (client) => describeWithExtras(client, attempt));
        return {
          ...viaHost,
          reachedThrough: { from: attempt.hosts.join(", "), to: CONTAINER_HOST },
        };
      } catch {
        // Not there either: report the original problem, which explains both options.
      }
    }
    return {
      ok: false,
      missingBackupPrivileges: [],
      missingRestorePrivileges: [],
      error: { code: "MS_CONNECTION_FAILED", message: detail, hint: problem.fix },
      problem,
    };
  }
}

/** The plain description plus the Atlas tier, readable databases and privilege advice. */
async function describeWithExtras(
  client: MongoClient,
  attempt: ConnectionAttempt,
): Promise<ConnectionTestResult> {
  const base = await describeConnected(client);
  const atlas = attempt.atlas
    ? { tier: (await isSharedTier(client)) ? ("shared" as const) : ("dedicated" as const) }
    : undefined;
  const limited = base.missingBackupPrivileges.length > 0;
  const readableDatabases = limited ? await authorizedDatabases(client) : undefined;
  const privilegeAdvice =
    limited || base.missingRestorePrivileges.length > 0
      ? adviceFor(base, readableDatabases, attempt.atlas)
      : undefined;
  return {
    ...base,
    ...(atlas === undefined ? {} : { atlas }),
    ...(readableDatabases === undefined ? {} : { readableDatabases }),
    ...(privilegeAdvice === undefined ? {} : { privilegeAdvice }),
  };
}

/**
 * The databases this user may use, without needing `listDatabases` on the cluster:
 * `authorizedDatabases: true` makes the server list exactly the databases the user's
 * roles cover. A failure (very old servers) means "unknown", not "none".
 */
async function authorizedDatabases(client: MongoClient): Promise<string[] | undefined> {
  try {
    const { databases } = await client
      .db("admin")
      .admin()
      .listDatabases({ nameOnly: true, authorizedDatabases: true });
    return databases
      .map((database) => database.name)
      .filter((name) => !INTERNAL_DATABASES.has(name))
      .sort();
  } catch {
    return undefined;
  }
}

/** A warning that says what is missing and which roles fix it. */
function adviceFor(
  result: ConnectionTestResult,
  readable: readonly string[] | undefined,
  atlas: boolean,
): ConnectionProblem {
  const canBackUpAll = result.missingBackupPrivileges.length === 0;
  const scope =
    readable === undefined || canBackUpAll
      ? ""
      : readable.length === 0
        ? " This user cannot read any database yet."
        : ` Backups will include only the databases this user can read: ${readable.join(", ")}.`;
  return {
    kind: "missing-privileges",
    title: canBackUpAll
      ? "Backups will work; restores need more rights"
      : "This user can back up only part of the data",
    message: `${privilegesMessage(atlas)}${scope}`,
    fix: atlas
      ? 'In Atlas → Database Access, edit the user: "readAnyDatabase" for backups, "readWriteAnyDatabase" (or readWrite on chosen databases) for restores.'
      : "Grant the backup role (or readAnyDatabase) for backups and the restore role (or readWrite on the target databases) for restores.",
    links: atlas ? [ATLAS_LINKS.databaseAccess, ATLAS_LINKS.rolesDocs] : [ATLAS_LINKS.rolesDocs],
    detail: [...result.missingBackupPrivileges, ...result.missingRestorePrivileges].join("; "),
  };
}

/** The connection string's parts, or undefined when it cannot be parsed (the driver says why). */
function safeAnalyze(uri: string): ConnectionStringInfo | undefined {
  try {
    return analyzeConnectionString(uri);
  } catch {
    return undefined;
  }
}

/**
 * A pasted connection string made ready to store: cleaned (quotes, a `mongosh "…"`
 * wrapper, wrapped lines), raw special characters in the user name and password
 * percent-encoded, and refused while it still holds a placeholder such as
 * `<db_password>` (Atlas copy-paste) or is not a MongoDB connection string at all.
 *
 * @throws ConsoleError 400 with a message that never quotes the password.
 */
export function normalizeConnectionUri(text: string): string {
  const cleaned = cleanPastedConnectionString(text);
  let info: ConnectionStringInfo;
  try {
    info = analyzeConnectionString(cleaned);
  } catch (error) {
    throw invalid(
      error instanceof ConnectionStringError
        ? error.message
        : '"uri" must start with mongodb:// or mongodb+srv://.',
    );
  }
  if (info.usernamePlaceholder !== undefined) {
    throw invalid(
      `Replace ${info.usernamePlaceholder} in the connection string with the database user's name.`,
    );
  }
  if (info.passwordPlaceholder !== undefined) {
    throw invalid(
      `Replace ${info.passwordPlaceholder} in the connection string with the password.`,
      "The console's form asks for it separately and encodes special characters for you.",
    );
  }
  return encodeCredentials(cleaned).uri;
}

// ---------------------------------------------------------------------------
// Remembering checks until the connection is saved
// ---------------------------------------------------------------------------

/**
 * How long a successful check's findings (Atlas tier, version) wait for the connection
 * to be saved: the welcome page saves right after checking, so a few minutes is plenty.
 */
const CHECK_MEMORY_MS = 10 * 60_000;

/** At most this many remembered checks per console; the oldest are forgotten first. */
const MAX_REMEMBERED_CHECKS = 50;

/** A remembered check: when, and what it found. */
interface RememberedCheck {
  readonly at: number;
  readonly deployment: DeploymentRecord;
}

/**
 * Remembered checks per console, keyed by the SHA-256 of the URI (never the URI). A
 * WeakMap keyed by the services object: each console (and each test) has its own, and
 * it goes away with the console.
 */
const rememberedChecks = new WeakMap<object, Map<string, RememberedCheck>>();

/** Remembers what a successful check found out about `uri`. */
export function rememberCheck(
  services: { readonly now: () => Date },
  uri: string,
  deployment: DeploymentRecord,
): void {
  const now = services.now().getTime();
  let checks = rememberedChecks.get(services);
  if (checks === undefined) {
    checks = new Map();
    rememberedChecks.set(services, checks);
  }
  for (const [key, entry] of checks) {
    if (now - entry.at > CHECK_MEMORY_MS) checks.delete(key);
  }
  checks.delete(hashUri(uri));
  checks.set(hashUri(uri), { at: now, deployment });
  while (checks.size > MAX_REMEMBERED_CHECKS) {
    const oldest = checks.keys().next().value;
    if (oldest === undefined) break;
    checks.delete(oldest);
  }
}

/** What a recent check of `uri` found out, while it is fresh. */
export function recallCheck(
  services: { readonly now: () => Date },
  uri: string,
): DeploymentRecord | undefined {
  const entry = rememberedChecks.get(services)?.get(hashUri(uri));
  if (entry === undefined || services.now().getTime() - entry.at > CHECK_MEMORY_MS) {
    return undefined;
  }
  return entry.deployment;
}

function hashUri(uri: string): string {
  return createHash("sha256").update(uri, "utf8").digest("hex");
}
