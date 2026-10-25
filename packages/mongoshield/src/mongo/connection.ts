/**
 * Opening (or adopting) a MongoDB connection.
 *
 * Every engine starts here: `openConnection` turns the user's `SourceOptions` into a
 * verified, connected `MongoClient` and remembers whether MongoShield owns it. Driver
 * failures are translated into `MongoShieldError`s with actionable hints, and the
 * connection string is always redacted before it appears in a message.
 */

import {
  MongoClient,
  type MongoClientOptions,
  MongoInvalidArgumentError,
  MongoMissingCredentialsError,
  MongoNetworkError,
  MongoParseError,
  MongoServerError,
  MongoServerSelectionError,
} from "mongodb";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { type Logger, silentLogger } from "../logger.ts";
import { redactMongoUri, redactSecrets } from "../redact.ts";
import type { SourceOptions } from "../types.ts";
import { version } from "../version.ts";

/** A connected client plus the knowledge of who is responsible for closing it. */
export interface MongoConnection {
  readonly client: MongoClient;
  /** `true` when MongoShield created the client from a URI and must close it. */
  readonly owned: boolean;
  /** Closes the client if MongoShield owns it; a user-supplied client is left open. */
  close(): Promise<void>;
}

/** Tuning for `openConnection`. Only applies to clients MongoShield creates. */
export interface OpenConnectionOptions {
  /** Reported to the server (visible in logs and `currentOp`). Defaults to `mongoshield/<version>`. */
  readonly appName?: string;
  readonly logger?: Logger;
  /** How long the driver waits for a usable server. The driver default is 30 000 ms. */
  readonly serverSelectionTimeoutMS?: number;
  /**
   * Cancels connecting (Ctrl-C, timeouts). Without it, an unreachable server keeps the
   * caller waiting for the whole server selection timeout.
   */
  readonly signal?: AbortSignal;
}

/** Server error code for a rejected SASL/SCRAM/X.509 handshake. */
const AUTHENTICATION_FAILED_CODE = 18;

/** Node/OS error codes that mean "the host name could not be resolved". */
const DNS_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL"]);

/**
 * Connects to MongoDB and verifies the connection with a `ping`.
 *
 * Pass exactly one of `source.uri` or `source.client`. A client created from a URI is
 * owned by MongoShield and closed by `close()`; a client passed in by the user is never
 * closed, because the application may still be using it.
 *
 * @throws MongoShieldError `MS_CONFIG_INVALID` for a bad source or connection string,
 *   `MS_AUTH_FAILED` when credentials are rejected, `MS_CONNECTION_FAILED` otherwise.
 */
export async function openConnection(
  source: SourceOptions,
  options: OpenConnectionOptions = {},
): Promise<MongoConnection> {
  const logger = options.logger ?? silentLogger;
  const { uri, client } = validateSource(source);
  throwIfAborted(options.signal);

  if (client !== undefined) {
    await verifyConnection(
      client,
      { location: "the provided MongoClient", secrets: [] },
      options.signal,
    );
    logger.debug("Using the MongoClient supplied by the caller");
    return borrowedConnection(client);
  }

  const location = redactMongoUri(uri);
  const secrets = passwordsInUri(uri);
  const created = createClient(uri, options, { location, secrets });
  try {
    await verifyConnection(created, { location, secrets }, options.signal);
  } catch (error) {
    // The client may hold sockets or monitors even though the ping failed.
    await created.close().catch(() => undefined);
    throw error;
  }
  logger.debug("Connected to MongoDB", { uri: location });
  return ownedConnection(created);
}

/** Narrows `SourceOptions` to exactly one of a URI or a client. */
function validateSource(source: SourceOptions):
  | { uri: string; client: undefined }
  | {
      uri: undefined;
      client: MongoClient;
    } {
  // `SourceOptions` forbids both at the type level, but JavaScript callers and config
  // files bypass the type checker, so check at runtime too.
  const hasUri = typeof source.uri === "string";
  const hasClient = source.client !== undefined;
  if (hasUri === hasClient) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "The MongoDB source must have exactly one of `uri` or `client`.",
      { hint: 'Pass `{ uri: "mongodb://…" }` or `{ client: existingMongoClient }`, not both.' },
    );
  }
  if (source.client !== undefined) {
    if (!(source.client instanceof MongoClient)) {
      throw new MongoShieldError("MS_CONFIG_INVALID", "`source.client` is not a MongoClient.", {
        hint: "Pass a client created with `new MongoClient(…)` from the `mongodb` package.",
      });
    }
    return { uri: undefined, client: source.client };
  }
  const uri = source.uri ?? "";
  if (uri.trim() === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "The MongoDB connection string is empty.", {
      hint: "Set `uri` to a connection string such as `mongodb://localhost:27017`.",
    });
  }
  return { uri, client: undefined };
}

/** Creates a client from a URI; the constructor parses the URI and can throw. */
function createClient(
  uri: string,
  options: OpenConnectionOptions,
  context: ErrorContext,
): MongoClient {
  const clientOptions: MongoClientOptions = {};
  // An `appName` already in the URI is the user's explicit choice, so keep it.
  if (options.appName !== undefined || !uriHasAppName(uri)) {
    clientOptions.appName = options.appName ?? `mongoshield/${version}`;
  }
  if (options.serverSelectionTimeoutMS !== undefined) {
    clientOptions.serverSelectionTimeoutMS = options.serverSelectionTimeoutMS;
  }
  try {
    return new MongoClient(uri, clientOptions);
  } catch (error) {
    throw toConnectionError(error, context);
  }
}

/** Runs `ping` on `admin`, which needs no privileges and forces server selection + auth. */
async function verifyConnection(
  client: MongoClient,
  context: ErrorContext,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ping = client.db("admin").command({ ping: 1 });
  try {
    await (signal === undefined ? ping : raceWithAbort(ping, signal));
  } catch (error) {
    if (signal?.aborted) {
      // The abandoned ping fails once the caller closes the client; don't let it surface.
      ping.catch(() => undefined);
      throw abortError(signal);
    }
    throw toConnectionError(error, context);
  }
}

/** Resolves like `promise`, or rejects as soon as `signal` aborts, whichever is first. */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function ownedConnection(client: MongoClient): MongoConnection {
  let closed = false;
  return {
    client,
    owned: true,
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

function borrowedConnection(client: MongoClient): MongoConnection {
  return {
    client,
    owned: false,
    // The application owns this client; closing it would break the host program.
    async close() {},
  };
}

/** What an error message may say about the connection, already free of secrets. */
interface ErrorContext {
  /** Redacted URI, or a description such as "the provided MongoClient". */
  readonly location: string;
  /** Strings that must never appear in a message (passwords from the URI). */
  readonly secrets: readonly string[];
}

/**
 * Translates a driver error raised while connecting into a `MongoShieldError`.
 * Exported for the engines, which may hit the same failures on a later operation.
 */
export function toConnectionError(
  error: unknown,
  context: { readonly location: string; readonly secrets?: readonly string[] },
): MongoShieldError {
  if (error instanceof MongoShieldError) return error;
  const secrets = context.secrets ?? [];
  const detail = redactSecrets(errorMessage(error), secrets);

  if (isAuthenticationFailure(error)) {
    return new MongoShieldError(
      "MS_AUTH_FAILED",
      `MongoDB rejected the credentials for ${context.location}: ${detail}`,
      {
        cause: error,
        hint: "Check the user name and password, and the authSource (the database the user was created in, usually `admin`).",
      },
    );
  }

  // Parse errors and bad option values are configuration mistakes, not network problems.
  if (
    isParseError(error) ||
    error instanceof MongoInvalidArgumentError ||
    error instanceof MongoMissingCredentialsError
  ) {
    return new MongoShieldError(
      "MS_CONFIG_INVALID",
      `The MongoDB connection settings are invalid: ${detail}`,
      {
        cause: error,
        hint: "Check the connection string format: mongodb://user:password@host:port/?options or mongodb+srv://….",
      },
    );
  }

  return new MongoShieldError(
    "MS_CONNECTION_FAILED",
    `Could not connect to MongoDB at ${context.location}: ${detail}`,
    { cause: error, hint: connectionHint(error) },
  );
}

/** Picks the most useful hint by looking at the root cause of a connection failure. */
function connectionHint(error: unknown): string {
  const codes = errorCodesInChain(error);
  const text = messagesInChain(error).join(" ");

  if (codes.some((code) => DNS_ERROR_CODES.has(code)) || /querySrv|getaddrinfo/i.test(text)) {
    return "The host name could not be resolved. Check the host in the connection string and your DNS; for mongodb+srv:// URIs the SRV record must exist.";
  }
  if (codes.some(isTlsErrorCode) || /certificate|tls|ssl|self[- ]signed/i.test(text)) {
    return "The TLS handshake failed. Check `tls=true`, the CA file (`tlsCAFile`) and that the certificate matches the host name.";
  }
  if (codes.includes("ECONNREFUSED")) {
    return "Nothing is accepting connections at that address. Check that mongod is running and the host and port are correct.";
  }
  if (error instanceof MongoServerSelectionError) {
    return "No suitable server responded in time. Check that the server is running, reachable from this machine (firewalls, Atlas IP access list) and that `replicaSet` matches the deployment.";
  }
  if (error instanceof MongoNetworkError) {
    return "The network connection to MongoDB failed. Check connectivity and firewalls between this machine and the server.";
  }
  return "Check that the server is running and reachable from this machine.";
}

/** Authentication failures arrive as a server error with code 18 (AuthenticationFailed). */
function isAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  // Walk the cause chain: some driver versions wrap the server error in a selection error.
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof MongoServerError && current.code === AUTHENTICATION_FAILED_CODE) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * A malformed connection string. The driver checks the scheme and URI syntax with the
 * `mongodb-connection-string-url` package, which throws its OWN `MongoParseError` class
 * (not the driver's), so `instanceof` alone misses "not-a-uri" or "mongo://…".
 */
function isParseError(error: unknown): boolean {
  return (
    error instanceof MongoParseError || (error instanceof Error && error.name === "MongoParseError")
  );
}

/** Node's TLS failures use codes such as `CERT_HAS_EXPIRED` or `ERR_TLS_CERT_ALTNAME_INVALID`. */
function isTlsErrorCode(code: string): boolean {
  return (
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.includes("CERT") ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  );
}

/** Collects `code` values (strings only) from an error and its causes. */
function errorCodesInChain(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return codes;
}

function messagesInChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Matches the `user:password@` part of a connection string. */
const URI_USERINFO = /^mongodb(?:\+srv)?:\/\/([^@/]+)@/i;

/**
 * Returns the password from a URI in both raw and percent-decoded form, so either
 * spelling can be scrubbed from driver messages that might echo it.
 */
function passwordsInUri(uri: string): string[] {
  const userinfo = URI_USERINFO.exec(uri)?.[1];
  if (userinfo === undefined) return [];
  const separator = userinfo.indexOf(":");
  if (separator === -1) return [];
  const raw = userinfo.slice(separator + 1);
  try {
    return [raw, decodeURIComponent(raw)];
  } catch {
    return [raw];
  }
}

function uriHasAppName(uri: string): boolean {
  return /[?&]appname=/i.test(uri);
}
