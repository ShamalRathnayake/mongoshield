/**
 * MongoDB clients for the live data browser, one per connection, reused between
 * requests (opening a client per page would mean a TLS handshake and an authentication
 * round trip for every click).
 *
 * - A client is rebuilt when the connection's stored URI changes (the cache is keyed by
 *   the sealed URI, which changes with every save).
 * - Idle clients are closed after {@link IDLE_CLOSE_MS}, so a console that browsed a
 *   database once does not keep connections to it forever.
 * - `closeAll()` runs at shutdown (services.ts).
 */

import { MongoClient } from "mongodb";
import { openConnectionUri } from "../../state/secrets.ts";
import type { StateStore } from "../../state/store.ts";
import type { ConnectionRecord } from "../../state/types.ts";

/** How long to wait for a server before a browse request fails. */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;
/** Clients unused for this long are closed: 5 minutes. */
export const IDLE_CLOSE_MS = 5 * 60_000;

/** One cached client. */
interface CachedClient {
  /** The sealed URI it was opened with; a different one means the URI changed. */
  readonly sealedUri: string;
  readonly client: Promise<MongoClient>;
  idleTimer: NodeJS.Timeout | undefined;
}

/** The client cache; see the file header. */
export class LiveClients {
  readonly #store: StateStore;
  readonly #idleMs: number;
  readonly #cache = new Map<string, CachedClient>();

  constructor(store: StateStore, idleMs = IDLE_CLOSE_MS) {
    this.#store = store;
    this.#idleMs = idleMs;
  }

  /** A connected client for a connection (opened on first use). */
  async clientFor(connection: ConnectionRecord): Promise<MongoClient> {
    const cached = this.#cache.get(connection.id);
    if (cached !== undefined && cached.sealedUri === connection.uri) {
      this.#touch(connection.id, cached);
      return cached.client;
    }
    if (cached !== undefined) this.#drop(connection.id, cached);
    const entry: CachedClient = {
      sealedUri: connection.uri,
      client: connect(openConnectionUri(this.#store, connection)),
      idleTimer: undefined,
    };
    this.#cache.set(connection.id, entry);
    // A failed connect must not stay cached: the next request tries again.
    entry.client.catch(() => {
      if (this.#cache.get(connection.id) === entry) this.#cache.delete(connection.id);
    });
    this.#touch(connection.id, entry);
    return entry.client;
  }

  /** Closes every client (shutdown). */
  async closeAll(): Promise<void> {
    const entries = [...this.#cache.entries()];
    this.#cache.clear();
    await Promise.all(entries.map(([, entry]) => closeEntry(entry)));
  }

  /** Restarts the idle timer of a client. */
  #touch(id: string, entry: CachedClient): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.#cache.get(id) === entry) this.#drop(id, entry);
    }, this.#idleMs);
    // An idle timer must never keep the process alive.
    entry.idleTimer.unref();
  }

  /** Removes and closes one client. */
  #drop(id: string, entry: CachedClient): void {
    this.#cache.delete(id);
    void closeEntry(entry);
  }
}

/** Opens a client with the console's timeout (unless the URI sets its own). */
async function connect(uri: string): Promise<MongoClient> {
  const ownTimeout = /[?&]serverSelectionTimeoutMS=/i.test(uri);
  const client = new MongoClient(uri, {
    ...(ownTimeout ? {} : { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS }),
    appName: "mongoshield-console-live",
  });
  await client.connect();
  return client;
}

/** Closes a cached client, ignoring errors (it may never have connected). */
async function closeEntry(entry: CachedClient): Promise<void> {
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  try {
    await (await entry.client).close();
  } catch {
    // A client that failed to connect has nothing to close.
  }
}
