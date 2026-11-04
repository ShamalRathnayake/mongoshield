/**
 * Dropbox storage adapter (`dropbox://<folder>`, entry point `mongoshield/storage/dropbox`).
 *
 *   import { dropboxStorage } from "mongoshield/storage/dropbox";
 *   const storage = dropboxStorage({
 *     folder: "backups",
 *     refreshToken: process.env.MONGOSHIELD_DROPBOX_TOKEN,
 *   });
 *
 * It talks to the Dropbox API v2 with plain `fetch` (no SDK). The token belongs to
 * an "App folder" app, so everything lives under `Apps/<app name>/<folder>/` in the
 * user's Dropbox, and key `a/b.bson` is the file `/<folder>/a/b.bson`. Get a refresh
 * token with `mongoshield login dropbox` (see ./dropbox-auth.ts); the adapter trades
 * it for short-lived access tokens itself and renews them before they expire.
 *
 * How the contract is met:
 * - Atomic writes. Objects up to `chunkSize` (default 8 MiB) go up in one
 *   `files/upload`. Larger ones use an upload session (`upload_session/start`,
 *   `append_v2`, `finish`), one chunk per request, read from the body only as each
 *   request completes (backpressure: at most one chunk is in memory). Nothing is
 *   visible until the commit in `finish`, so a failed or aborted upload leaves no
 *   file; Dropbox discards the abandoned session on its own.
 * - Conditional writes (`ifNoneMatch: "*"`) commit with `mode: "add"` and
 *   `strict_conflict: true`. Dropbox refuses the commit atomically if the path
 *   exists, even with identical content (that is what `strict_conflict` adds), and
 *   the refusal becomes MS_STORAGE_PRECONDITION_FAILED. So the normal storage lock
 *   works. If a commit had to be retried (a timeout or 5xx after Dropbox may already
 *   have written it), a conflict, or a finish that no longer finds its session, is
 *   double-checked: when the file there has exactly our content hash, the first
 *   attempt won and the put succeeds.
 *   Other writes use `mode: "overwrite"`.
 * - Integrity: every upload request carries the Dropbox content hash of its data,
 *   so Dropbox refuses corrupted chunks, and full downloads are checked against the
 *   content hash in the `Dropbox-API-Result` header (MS_INTEGRITY_FAILED).
 * - Range reads send an HTTP `Range` header to `files/download`.
 * - Listing uses `files/list_folder` with `recursive: true` and cursor paging,
 *   starting at the deepest folder the prefix names. Dropbox does not sort, so the
 *   entries are collected and sorted by key; only metadata is held in memory.
 *   Folders are real on Dropbox and stay behind when their files are deleted, so
 *   `listPrefixes` is derived from the files, never from folder entries.
 * - Paths are case-insensitive on Dropbox. Keys come back in the case they were
 *   written (from each entry's `name`, which Dropbox guarantees is correctly cased),
 *   but two keys that differ only in case are the same file. The backup layout
 *   already avoids such names (it is designed for case-insensitive disks).
 * - Deletes use `files/delete_batch` (up to 1000 paths per batch, polling
 *   `delete_batch/check`). Missing paths are ignored. Dropbox deletes are soft:
 *   files go to "deleted files", where the user can restore them for 30 days
 *   (longer on some plans) and where they do not count against the quota.
 *   Permanent delete is a Dropbox Business (team) feature, so it is not used.
 *   Empty folders are left in place: removing them could race with a concurrent
 *   writer (another run creating a lock file in the same folder), and Dropbox
 *   deletes a folder's contents with it.
 * - Retries: 429 (including `too_many_write_operations`, Dropbox's per-namespace
 *   write lock), 5xx, timeouts and network errors are retried with exponential
 *   backoff, waiting at least as long as `Retry-After` says.
 * - Errors: Dropbox's `error_summary` is matched by segment (`path/not_found/…`):
 *   `not_found` → MS_STORAGE_NOT_FOUND, `conflict` → MS_STORAGE_PRECONDITION_FAILED,
 *   `insufficient_space` → MS_STORAGE_INSUFFICIENT_SPACE, 401/403 and write-permission
 *   errors → MS_STORAGE_FORBIDDEN, anything else → MS_STORAGE_IO.
 * - Free space: `space()` reads `users/get_space_usage`.
 * - No write-once retention: anyone with the token can delete, so `objectLock` is
 *   false and a put with `retainUntil` fails with MS_CONFIG_INVALID.
 *
 * Tokens never appear in errors, `location` or logs (response text is scrubbed of
 * them before it is used in a message).
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as sleepFor } from "node:timers/promises";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import { redactSecrets } from "../redact.ts";
import {
  assertValidRange,
  chunk as batchesOf,
  compareBytes,
  destroyOnAbort,
  messageOf,
  normalizePrefix,
  toBuffer,
} from "./adapter-utils.ts";
import {
  DROPBOX_SECRET_NAME,
  refreshDropboxAccessToken,
  resolveDropboxClient,
} from "./dropbox-auth.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import { rejectRetention } from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** 1 MiB, for readable size constants. */
const MiB = 1024 * 1024;

/**
 * Dropbox hashes content in 4 MiB blocks (the "content hash": SHA-256 of the
 * concatenated SHA-256 of each block). Chunk sizes are multiples of it, so the
 * block hashes of each upload request are also the block hashes of the file.
 */
const HASH_BLOCK_SIZE = 4 * MiB;

/** Default upload chunk: small enough to retry cheaply, big enough to be fast. */
export const DROPBOX_DEFAULT_CHUNK_SIZE = 8 * MiB;

/** Dropbox accepts at most 150 MiB per upload request; 148 MiB is the largest multiple of 4 MiB below it. */
const MAX_CHUNK_SIZE = 148 * MiB;

/** `files/delete_batch` takes at most 1000 entries. */
const DELETE_BATCH_SIZE = 1000;

/** `files/list_folder` returns about this many entries per page (its maximum). */
const LIST_PAGE_LIMIT = 2000;

/** Renew the access token this long before Dropbox says it expires. */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;

/** Never wait longer than this for one retry, whatever `Retry-After` says. */
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** Give up polling a delete batch job after this long. */
const DELETE_JOB_TIMEOUT_MS = 10 * 60_000;

/** The Dropbox API hosts. RPC calls go to `api`, file bytes to `content`. */
const DEFAULT_API_URL = "https://api.dropboxapi.com";
const DEFAULT_CONTENT_URL = "https://content.dropboxapi.com";

/** The query parameters `dropbox://` URLs accept (none yet). Anything else is a typo. */
const URL_QUERY_PARAMETERS = new Set<string>();

/** Options for {@link dropboxStorage}. */
export interface DropboxStorageOptions {
  /**
   * Folder inside the app folder, e.g. `"backups"` or `"prod/mongo"`. Keys map to
   * `/<folder>/<key>`. Required, so backups never mix with other files there.
   */
  readonly folder: string;
  /**
   * Refresh token from `mongoshield login dropbox` (the `MONGOSHIELD_DROPBOX_TOKEN`
   * secret). The adapter exchanges it for access tokens as needed. Give this or
   * `accessToken`.
   */
  readonly refreshToken?: string;
  /**
   * A ready access token instead of a refresh token, e.g. one generated in the App
   * Console for a quick test. It is not renewed, so it stops working after a few hours.
   */
  readonly accessToken?: string;
  /**
   * The Dropbox app key the refresh token was issued to. Defaults to
   * `MONGOSHIELD_DROPBOX_CLIENT_ID`, then MongoShield's own app.
   */
  readonly clientId?: string;
  /** That app's secret. Only needed for apps that do not allow PKCE public clients. */
  readonly clientSecret?: string;
  /**
   * Upload chunk size in bytes: a multiple of 4 MiB, at most 148 MiB. Objects up to
   * this size go up in one request; larger ones in an upload session, one chunk per
   * request. Each chunk is held in memory once. Default 8 MiB.
   */
  readonly chunkSize?: number;
  /** How many times a failed request is retried (429, 5xx, timeouts). Default 6. */
  readonly maxRetries?: number;
  /** First backoff delay in ms, doubled per retry up to 30 s. Default 500. */
  readonly retryBaseDelayMs?: number;
  /**
   * How long one request may take until Dropbox starts answering, in ms (default
   * 180 000). For uploads this includes sending the chunk, so lower `chunkSize`
   * on very slow links. Streaming a download's body is not limited.
   */
  readonly requestTimeoutMs?: number;
  /** `fetch` implementation (default: the global one). */
  readonly fetch?: typeof fetch;
  /** API base URLs; only for tests and proxies. */
  readonly endpoints?: {
    readonly api?: string;
    readonly content?: string;
    readonly token?: string;
  };
}

/** Free-space figures in bytes, as returned by {@link DropboxStorage.space}. */
export interface DropboxSpace {
  readonly total?: number;
  readonly used?: number;
  readonly free?: number;
  readonly trash?: number;
}

/** The Dropbox adapter: a `StorageAdapter` plus `space()`. */
export interface DropboxStorage extends StorageAdapter {
  /**
   * The account's quota and usage from `users/get_space_usage`. For team accounts
   * the tighter of the member limit and the team pool. `trash` is not reported:
   * Dropbox's deleted files do not count against the quota.
   */
  space(options?: SignalOptions): Promise<DropboxSpace | undefined>;
}

/**
 * Creates the `dropbox://<folder>` adapter from a URL and the environment: the
 * refresh token from `MONGOSHIELD_DROPBOX_TOKEN`, the app from
 * `MONGOSHIELD_DROPBOX_CLIENT_ID` / `_CLIENT_SECRET` (or MongoShield's own app).
 * `dropbox://prod/mongo` → folder `prod/mongo`.
 */
export function dropboxStorageFromUrl(url: URL, env: NodeJS.ProcessEnv): DropboxStorage {
  if (url.protocol !== "dropbox:") {
    throw configError(`Not a dropbox:// URL: "${url.protocol}//".`);
  }
  if (url.username || url.password) {
    throw configError("dropbox:// URLs must not contain credentials.", {
      hint: `Put the refresh token in ${DROPBOX_SECRET_NAME} instead.`,
    });
  }
  for (const name of url.searchParams.keys()) {
    if (!URL_QUERY_PARAMETERS.has(name)) {
      throw configError(`Unknown dropbox:// URL parameter "${name}".`, {
        hint: "dropbox:// URLs take no parameters: dropbox://<folder>.",
      });
    }
  }
  const folder = decodeURIComponent(`${url.host}${url.pathname}`);
  const refreshToken = env[DROPBOX_SECRET_NAME]?.trim();
  if (!refreshToken) {
    throw configError(`${DROPBOX_SECRET_NAME} is not set.`, {
      hint: `Run \`mongoshield login dropbox\` and store the token it prints in ${DROPBOX_SECRET_NAME}.`,
    });
  }
  const client = resolveDropboxClient(env);
  return dropboxStorage({ folder, refreshToken, ...client });
}

/** Creates a Dropbox storage adapter. See the file header for how it behaves. */
export function dropboxStorage(options: DropboxStorageOptions): DropboxStorage {
  const folder = normalizeFolder(options.folder);
  const basePath = `/${folder}`;
  const location = `dropbox://${folder}/`;
  const chunkSize = validChunkSize(options.chunkSize);
  const maxRetries = nonNegativeInteger(options.maxRetries, 6, "maxRetries");
  const retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs, 500, "retryBaseDelayMs");
  const requestTimeoutMs = nonNegativeInteger(
    options.requestTimeoutMs,
    180_000,
    "requestTimeoutMs",
  );
  const doFetch = options.fetch ?? fetch;
  const apiUrl = trimSlash(options.endpoints?.api ?? DEFAULT_API_URL);
  const contentUrl = trimSlash(options.endpoints?.content ?? DEFAULT_CONTENT_URL);
  const tokens = accessTokens(options, doFetch, {
    maxRetries,
    delay: (attempt) => backoffDelay(attempt),
  });
  const capabilities: StorageCapabilities = {
    conditionalWrites: true,
    rangeReads: true,
    objectLock: false,
  };

  /** `a/b.bson` → `/<folder>/a/b.bson`. */
  function pathOf(key: string): string {
    return `${basePath}/${key}`;
  }

  /** Response text with every token we hold replaced by `***`. */
  function scrub(text: string): string {
    return redactSecrets(text, tokens.secrets());
  }

  /**
   * The one place that talks HTTP. Sends a Dropbox API call, renews an expired
   * access token once, retries rate limits / 5xx / timeouts / network errors with
   * backoff, and returns the successful response (or throws a {@link DropboxApiError}
   * for an API error, a MongoShieldError otherwise).
   */
  async function request(call: ApiCall): Promise<Response> {
    let renewedToken = false;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(call.signal);
      const token = await tokens.get(call.signal);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), requestTimeoutMs);
      const signal = call.signal ? AbortSignal.any([call.signal, timeout.signal]) : timeout.signal;
      let response: Response;
      try {
        response = await doFetch(urlOf(call), {
          method: "POST",
          headers: headersOf(call, token),
          ...(call.data !== undefined
            ? { body: call.data }
            : call.host === "api"
              ? { body: JSON.stringify(call.json ?? null) }
              : {}),
          signal,
        });
      } catch (error) {
        if (call.signal?.aborted) throw abortError(call.signal);
        const reason = timeout.signal.aborted
          ? `no answer within ${requestTimeoutMs} ms`
          : scrub(messageOf(error));
        if (attempt < maxRetries) {
          await sleep(backoffDelay(attempt), call.signal);
          continue;
        }
        throw new MongoShieldError("MS_STORAGE_IO", `Dropbox ${call.endpoint} failed: ${reason}.`, {
          hint: "Check the network connection; the request was retried and kept failing.",
        });
      } finally {
        // Only the wait for the response is limited; a download body may stream for long.
        clearTimeout(timer);
      }
      if (response.ok) return response;

      const failure = await apiErrorOf(response, call.endpoint, attempt + 1, scrub);
      if (response.status === 401 && tokens.renewable && !renewedToken) {
        // Expired or revoked access token: get a fresh one from the refresh token once.
        renewedToken = true;
        tokens.invalidate(token);
        continue;
      }
      if (isRetryable(failure) && attempt < maxRetries) {
        await sleep(Math.max(failure.retryAfterMs ?? 0, backoffDelay(attempt)), call.signal);
        continue;
      }
      throw failure;
    }
  }

  function urlOf(call: ApiCall): string {
    return `${call.host === "api" ? apiUrl : contentUrl}/2/${call.endpoint}`;
  }

  /** Exponential backoff with jitter: base·2^attempt, capped at 30 s, between 50% and 100%. */
  function backoffDelay(attempt: number): number {
    const ceiling = Math.min(30_000, retryBaseDelayMs * 2 ** attempt);
    return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
  }

  /** An RPC call (JSON in, JSON out). */
  async function rpc(endpoint: string, json: unknown, signal: AbortSignal | undefined) {
    const response = await request({ host: "api", endpoint, json, signal });
    return jsonOf(response);
  }

  /** A content-upload call: arguments in `Dropbox-API-Arg`, `data` as the body. */
  async function upload(
    endpoint: string,
    arg: unknown,
    data: Uint8Array,
    signal: AbortSignal | undefined,
  ) {
    const response = await request({ host: "content", endpoint, arg, data, signal });
    return jsonOf(response);
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    assertValidKey(key);
    const { signal } = putOptions;
    throwIfAborted(signal);
    // Dropbox has no write-once retention, so a retained put is refused before the
    // body is read. See ./retention.ts.
    rejectRetention(putOptions, body, "dropbox", location);
    // Destroying the body also interrupts a source that is stalled waiting for data.
    if (body instanceof Readable) destroyOnAbort(body, signal);
    const target: UploadTarget = {
      key,
      path: pathOf(key),
      conditional: putOptions.ifNoneMatch === "*",
    };
    const reader =
      body instanceof Uint8Array ? bufferChunks(body, chunkSize) : streamChunks(body, chunkSize);
    try {
      return await uploadFrom(target, reader, signal);
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      throw storageError(error, `write "${key}" to`, target);
    }
  }

  /**
   * Uploads everything `reader` yields: one `files/upload` if the first read comes
   * back short (the whole object fits in one chunk), otherwise an upload session.
   */
  async function uploadFrom(
    target: UploadTarget,
    reader: ChunkReader,
    signal: AbortSignal | undefined,
  ): Promise<ObjectInfo> {
    const fileBlocks: Buffer[] = [];
    let data = await reader.read();
    let blocks = blockHashesOf(data);
    fileBlocks.push(...blocks);
    const commit = commitInfoOf(target);

    if (data.length < chunkSize) {
      throwIfAborted(signal);
      const metadata = await commitOnce(target, fileBlocks, signal, () =>
        upload("files/upload", { ...commit, content_hash: hashOfBlocks(blocks) }, data, signal),
      );
      return objectInfoOf(target.key, metadata);
    }

    const started = await upload(
      "files/upload_session/start",
      { close: false, content_hash: hashOfBlocks(blocks) },
      data,
      signal,
    );
    const sessionId = stringField(started, "session_id");
    if (!sessionId)
      throw new MongoShieldError("MS_STORAGE_IO", "Dropbox started no upload session.");
    let offset = data.length;
    for (;;) {
      data = await reader.read();
      blocks = blockHashesOf(data);
      fileBlocks.push(...blocks);
      if (data.length < chunkSize) break;
      await appendChunk(sessionId, offset, data, hashOfBlocks(blocks), signal);
      offset += data.length;
    }
    throwIfAborted(signal);
    const lastData = data;
    const lastHash = hashOfBlocks(blocks);
    const metadata = await commitOnce(target, fileBlocks, signal, () =>
      upload(
        "files/upload_session/finish",
        { cursor: { session_id: sessionId, offset }, commit, content_hash: lastHash },
        lastData,
        signal,
      ),
    );
    return objectInfoOf(target.key, metadata);
  }

  /**
   * Appends one chunk. The offset makes a retry safe: if an earlier attempt did
   * arrive, Dropbox answers `incorrect_offset` with the offset just past this chunk,
   * which means the data is already there.
   */
  async function appendChunk(
    sessionId: string,
    offset: number,
    data: Buffer,
    contentHash: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await upload(
        "files/upload_session/append_v2",
        { cursor: { session_id: sessionId, offset }, close: false, content_hash: contentHash },
        data,
        signal,
      );
    } catch (error) {
      const correctOffset = error instanceof DropboxApiError ? error.correctOffset : undefined;
      if (correctOffset !== undefined && correctOffset === offset + data.length) return;
      throw error;
    }
  }

  /**
   * Runs the committing request. When it fails only after a retry, in the way a
   * retry of an already-applied commit fails, checks whether the file there is ours
   * (same content hash): then an earlier attempt succeeded and only its answer was lost.
   */
  async function commitOnce(
    target: UploadTarget,
    fileBlocks: readonly Buffer[],
    signal: AbortSignal | undefined,
    send: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await send();
    } catch (error) {
      // A retried commit whose first attempt landed fails in one of two ways: a
      // conditional write conflicts with itself, and a session finish no longer
      // finds its (already committed) session.
      const maybeLanded =
        error instanceof DropboxApiError &&
        error.attempts > 1 &&
        ((target.conditional && error.has("conflict")) || error.has("lookup_failed"));
      if (!maybeLanded) throw error;
      const existing = await metadataOf(target.path, signal);
      if (existing && stringField(existing, "content_hash") === hashOfBlocks(fileBlocks)) {
        return existing;
      }
      throw error;
    }
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    assertValidKey(key);
    const { signal, range } = getOptions;
    if (range) assertValidRange(range, key);
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await request({
        host: "content",
        endpoint: "files/download",
        arg: { path: pathOf(key) },
        ...(range ? { range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
        signal,
      });
    } catch (error) {
      throw storageError(error, `read "${key}" from`);
    }
    const result = parseJsonHeader(response.headers.get("dropbox-api-result"));
    const source = response.body
      ? Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
      : Readable.from([]);
    let stream: Readable;
    if (range) {
      // 206 is the normal answer. A server that ignored the Range header sends the
      // whole file (200); cut the range out of it rather than return wrong bytes.
      stream = response.status === 206 ? source : Readable.from(sliceStream(source, range));
    } else {
      stream = Readable.from(verifiedStream(source, key, result));
    }
    destroyOnAbort(stream, signal);
    return stream;
  }

  async function head(key: string, options: SignalOptions = {}): Promise<ObjectInfo | undefined> {
    assertValidKey(key);
    throwIfAborted(options.signal);
    let metadata: Record<string, unknown> | undefined;
    try {
      metadata = await metadataOf(pathOf(key), options.signal);
    } catch (error) {
      throw storageError(error, `stat "${key}" in`);
    }
    // A folder is not an object (contract: head of a "directory" is undefined).
    if (metadata?.[".tag"] !== "file") return undefined;
    return objectInfoOf(key, metadata);
  }

  /** `files/get_metadata`, or undefined when nothing is at `path`. */
  async function metadataOf(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return recordOf(await rpc("files/get_metadata", { path }, signal));
    } catch (error) {
      if (error instanceof DropboxApiError && error.has("not_found")) return undefined;
      throw error;
    }
  }

  /**
   * Every file whose key starts with `prefix`, sorted by key. Lists recursively from
   * the deepest folder the prefix names (`backups/2026` → `/<folder>/backups`).
   */
  async function listFiles(prefix: string, signal: AbortSignal | undefined): Promise<ObjectInfo[]> {
    assertValidPrefix(prefix);
    throwIfAborted(signal);
    const folderKey = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const listPath = folderKey === "" ? basePath : pathOf(folderKey);
    const entries: Record<string, unknown>[] = [];
    try {
      let page = recordOf(
        await rpc(
          "files/list_folder",
          { path: listPath, recursive: true, include_deleted: false, limit: LIST_PAGE_LIMIT },
          signal,
        ),
      );
      for (;;) {
        for (const entry of arrayField(page, "entries")) entries.push(recordOf(entry));
        const cursor = stringField(page, "cursor");
        if (page.has_more !== true || !cursor) break;
        page = recordOf(await rpc("files/list_folder/continue", { cursor }, signal));
      }
    } catch (error) {
      // No folder yet (nothing was ever written there), or the prefix names a file.
      if (error instanceof DropboxApiError && (error.has("not_found") || error.has("not_folder"))) {
        return [];
      }
      throw storageError(error, "list");
    }
    const files = keyedFiles(entries, listPath)
      .filter((file) => file.key.startsWith(prefix))
      .sort((left, right) => compareBytes(left.key, right.key));
    return files;
  }

  /**
   * Turns listing entries into objects with storage keys. Each key segment comes
   * from the matching folder entry's `name` (Dropbox's correctly cased name; see the
   * header), falling back to the entry's `path_display`. Segments down to the listed
   * folder itself are ours (`listPath`), since its ancestors are not in the listing.
   */
  function keyedFiles(entries: readonly Record<string, unknown>[], listPath: string): ObjectInfo[] {
    const folderNames = new Map<string, string>();
    for (const entry of entries) {
      const lower = stringField(entry, "path_lower");
      const name = stringField(entry, "name");
      if (entry[".tag"] === "folder" && lower && name) folderNames.set(lower, name);
    }
    const baseDepth = basePath.split("/").length - 1;
    const listSegments = listPath.split("/");
    const files: ObjectInfo[] = [];
    for (const entry of entries) {
      if (entry[".tag"] !== "file") continue;
      const lowerSegments = (stringField(entry, "path_lower") ?? "").split("/");
      const displaySegments = (stringField(entry, "path_display") ?? "").split("/");
      const name = stringField(entry, "name");
      if (!name || lowerSegments.length <= baseDepth + 1) continue;
      const segments: string[] = [];
      for (let depth = baseDepth + 1; depth < lowerSegments.length - 1; depth++) {
        const folderLower = lowerSegments.slice(0, depth + 1).join("/");
        const segment =
          depth < listSegments.length
            ? listSegments[depth]
            : (folderNames.get(folderLower) ?? displaySegments[depth]);
        if (segment === undefined) break;
        segments.push(segment);
      }
      segments.push(name);
      const key = segments.join("/");
      if (!isValidKey(key)) continue;
      files.push(objectInfoOf(key, entry));
    }
    return files;
  }

  async function* list(prefix: string, options: SignalOptions = {}): AsyncIterable<ObjectInfo> {
    for (const file of await listFiles(prefix, options.signal)) yield file;
  }

  async function* listPrefixes(prefix: string, options: SignalOptions = {}): AsyncIterable<string> {
    assertValidPrefix(prefix);
    if (prefix !== "" && !prefix.endsWith("/")) {
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `listPrefixes needs a prefix ending in "/", got "${prefix}".`,
      );
    }
    const children = new Set<string>();
    for (const file of await listFiles(prefix, options.signal)) {
      const rest = file.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1) children.add(`${prefix}${rest.slice(0, slash + 1)}`);
    }
    for (const child of [...children].sort(compareBytes)) yield child;
  }

  async function remove(keys: readonly string[], options: SignalOptions = {}): Promise<void> {
    for (const key of keys) assertValidKey(key);
    const { signal } = options;
    throwIfAborted(signal);
    const paths = [...new Set(keys)].map(pathOf);
    try {
      for (const batch of batchesOf(paths, DELETE_BATCH_SIZE)) await deleteBatch(batch, signal);
    } catch (error) {
      throw storageError(error, "delete objects from");
    }
  }

  /**
   * Deletes up to 1000 paths with `files/delete_batch`, waiting for the job. Entries
   * that failed because of Dropbox's write lock (`too_many_write_operations`) are
   * sent again after a backoff; missing paths count as deleted.
   */
  async function deleteBatch(paths: readonly string[], signal: AbortSignal | undefined) {
    let pending = paths;
    for (let attempt = 0; pending.length > 0; attempt++) {
      const launch = recordOf(
        await rpc("files/delete_batch", { entries: pending.map((path) => ({ path })) }, signal),
      );
      const status = await settledDeleteJob(launch, signal);
      const retry: string[] = [];
      if (status[".tag"] === "failed") {
        // The whole job failed; the only documented reason is the write lock.
        if (!tagsOf(status.failed).includes("too_many_write_operations")) {
          throw new MongoShieldError(
            "MS_STORAGE_IO",
            `Dropbox could not delete ${pending.length} files.`,
          );
        }
        retry.push(...pending);
      } else {
        arrayField(status, "entries").forEach((entry, index) => {
          const record = recordOf(entry);
          if (record[".tag"] === "success") return;
          const tags = tagsOf(record.failure);
          const path = pending[index];
          if (tags.includes("not_found") || path === undefined) return;
          if (tags.includes("too_many_write_operations")) {
            retry.push(path);
            return;
          }
          throw failedEntryError(tags, path);
        });
      }
      if (retry.length > 0 && attempt >= maxRetries) {
        throw new MongoShieldError(
          "MS_STORAGE_IO",
          `Dropbox kept refusing to delete ${retry.length} files (too many write operations).`,
          { hint: "Another program may be writing to the same Dropbox; try again later." },
        );
      }
      pending = retry;
      if (pending.length > 0) await sleep(backoffDelay(attempt), signal);
    }
  }

  /** Polls `delete_batch/check` until an async delete job completes or fails. */
  async function settledDeleteJob(
    launch: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    if (launch[".tag"] !== "async_job_id") return launch;
    const jobId = stringField(launch, "async_job_id");
    const deadline = Date.now() + DELETE_JOB_TIMEOUT_MS;
    let delay = 100;
    while (Date.now() < deadline) {
      await sleep(delay, signal);
      const status = recordOf(
        await rpc("files/delete_batch/check", { async_job_id: jobId }, signal),
      );
      if (status[".tag"] !== "in_progress") return status;
      delay = Math.min(delay * 2, 2_000);
    }
    throw new MongoShieldError(
      "MS_STORAGE_IO",
      "A Dropbox delete job did not finish in 10 minutes.",
    );
  }

  /** Maps a failed delete entry (`DeleteError` tags) to a storage error. */
  function failedEntryError(tags: readonly string[], path: string): MongoShieldError {
    const summary = tags.join("/");
    if (tags.includes("no_write_permission") || tags.includes("access_restricted")) {
      return new MongoShieldError(
        "MS_STORAGE_FORBIDDEN",
        `Dropbox refused to delete "${path}" (${summary}).`,
      );
    }
    return new MongoShieldError(
      "MS_STORAGE_IO",
      `Dropbox could not delete "${path}" (${summary}).`,
    );
  }

  async function space(options: SignalOptions = {}): Promise<DropboxSpace | undefined> {
    throwIfAborted(options.signal);
    let usage: Record<string, unknown>;
    try {
      usage = recordOf(await rpc("users/get_space_usage", null, options.signal));
    } catch (error) {
      throw storageError(error, "read the free space of");
    }
    return spaceOf(usage);
  }

  /**
   * Turns any failure into a MongoShieldError naming the operation. API errors are
   * mapped by their `error_summary` segments (see the header); MongoShieldErrors
   * (aborts, our own checks) pass through unchanged.
   */
  function storageError(error: unknown, action: string, target?: UploadTarget): unknown {
    if (!(error instanceof DropboxApiError)) return error;
    const what = `Cannot ${action} ${location}: Dropbox said ${error.summary}`;
    const details = { status: error.status, endpoint: error.endpoint };
    if (error.status === 401) {
      return new MongoShieldError("MS_STORAGE_FORBIDDEN", `${what}.`, {
        details,
        hint: `The Dropbox token is invalid or was revoked. Run \`mongoshield login dropbox\` and update ${DROPBOX_SECRET_NAME}.`,
      });
    }
    if (
      error.status === 403 ||
      error.has("no_write_permission") ||
      error.has("access_restricted")
    ) {
      return new MongoShieldError("MS_STORAGE_FORBIDDEN", `${what}.`, { details });
    }
    if (error.has("insufficient_space")) {
      return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", `${what}.`, {
        details,
        hint: "Free up space in the Dropbox account (and empty its deleted files) or upgrade the plan.",
      });
    }
    if (error.has("content_hash_mismatch")) {
      return new MongoShieldError(
        "MS_INTEGRITY_FAILED",
        `${what}: the upload was corrupted in transit.`,
        {
          details,
        },
      );
    }
    if (error.has("conflict") && target?.conditional) {
      return new MongoShieldError(
        "MS_STORAGE_PRECONDITION_FAILED",
        `"${target.key}" already exists in ${location}.`,
        {
          details,
        },
      );
    }
    if (error.has("lookup_failed")) {
      // The upload session is gone or out of step: an I/O problem, not a missing object.
      return new MongoShieldError("MS_STORAGE_IO", `${what}.`, { details });
    }
    if (error.has("not_found") || error.has("not_file")) {
      return new MongoShieldError("MS_STORAGE_NOT_FOUND", `${what}.`, { details });
    }
    return new MongoShieldError("MS_STORAGE_IO", `${what}.`, {
      details,
      ...(error.status === 429
        ? { hint: "Dropbox kept rate-limiting the requests; try again later." }
        : {}),
    });
  }

  return {
    kind: "dropbox",
    location,
    capabilities,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: remove,
    space,
    async close() {
      // Nothing to release: fetch keeps no per-adapter connections we own.
    },
  };
}

/** One Dropbox API call, as `request()` sends it. */
interface ApiCall {
  /** `api` for RPC endpoints, `content` for upload/download endpoints. */
  readonly host: "api" | "content";
  /** The endpoint after `/2/`, e.g. `files/upload`. */
  readonly endpoint: string;
  /** Content endpoints: the arguments, sent in the `Dropbox-API-Arg` header. */
  readonly arg?: unknown;
  /** RPC endpoints: the JSON body (`null` for endpoints without arguments). */
  readonly json?: unknown;
  /** Upload endpoints: the bytes. */
  readonly data?: Uint8Array;
  /** Download: the `Range` header value. */
  readonly range?: string;
  readonly signal?: AbortSignal | undefined;
}

/** Where a put writes, and whether it must not replace an existing file. */
interface UploadTarget {
  readonly key: string;
  readonly path: string;
  readonly conditional: boolean;
}

/** The request headers for a call. */
function headersOf(call: ApiCall, token: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (call.host === "api") headers["content-type"] = "application/json";
  if (call.arg !== undefined) headers["dropbox-api-arg"] = headerSafeJson(call.arg);
  if (call.data !== undefined) headers["content-type"] = "application/octet-stream";
  if (call.range) headers.range = call.range;
  return headers;
}

/**
 * JSON for the `Dropbox-API-Arg` header. HTTP headers must be ASCII, so Dropbox
 * requires every character from 0x7F up to be written as a JSON `\uXXXX` escape
 * (JSON.stringify leaves them as-is). Escaping UTF-16 code units one by one also
 * turns characters outside the BMP into the surrogate pairs JSON expects.
 */
export function headerSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The `CommitInfo` for a put: add-only for conditional writes, overwrite otherwise. */
function commitInfoOf(target: UploadTarget): Record<string, unknown> {
  return {
    path: target.path,
    mode: target.conditional ? "add" : "overwrite",
    autorename: false,
    // No "file added" notifications on the user's devices for every backup object.
    mute: true,
    // Makes `add` conflict even when the existing file has identical content.
    strict_conflict: target.conditional,
  };
}

/** An object's info from a Dropbox `FileMetadata` record. */
function objectInfoOf(key: string, metadata: unknown): ObjectInfo {
  const record = recordOf(metadata);
  const size = typeof record.size === "number" ? record.size : 0;
  const modified = stringField(record, "server_modified");
  const rev = stringField(record, "rev");
  return {
    key,
    size,
    lastModified: modified ? new Date(modified) : new Date(),
    ...(rev ? { etag: rev } : {}),
  };
}

/** Free space from a `users/get_space_usage` answer; undefined for unknown allocation kinds. */
function spaceOf(usage: Record<string, unknown>): DropboxSpace | undefined {
  const used = numberField(usage, "used");
  const allocation = recordOf(usage.allocation);
  const allocated = numberField(allocation, "allocated");
  if (allocation[".tag"] === "individual" && allocated !== undefined && used !== undefined) {
    return { total: allocated, used, free: Math.max(0, allocated - used) };
  }
  if (allocation[".tag"] === "team" && allocated !== undefined) {
    // Team members share the team pool and may also have their own limit (0 = none).
    const teamUsed = numberField(allocation, "used") ?? 0;
    const teamFree = Math.max(0, allocated - teamUsed);
    const memberLimit = numberField(allocation, "user_within_team_space_allocated") ?? 0;
    if (memberLimit > 0 && used !== undefined) {
      const memberFree = Math.max(0, memberLimit - used);
      return { total: memberLimit, used, free: Math.min(memberFree, teamFree) };
    }
    return { total: allocated, used: teamUsed, free: teamFree };
  }
  return used === undefined ? undefined : { used };
}

/** An API error answer from Dropbox: status, `error_summary` and the parsed body. */
class DropboxApiError extends Error {
  /** The `error_summary` split into its tags, without the trailing dots. */
  private readonly segments: readonly string[];

  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly summary: string,
    readonly body: Record<string, unknown>,
    /** How many attempts `request()` made, so a retried commit can be double-checked. */
    readonly attempts: number,
    /** From `Retry-After` or the body's `retry_after`, in ms. */
    readonly retryAfterMs: number | undefined,
  ) {
    super(`Dropbox ${endpoint} failed with HTTP ${status}: ${summary}`);
    this.segments = summary.replace(/\.+$/, "").split("/").filter(Boolean);
  }

  /** True when `tag` appears anywhere in the error (summary or nested `.tag`s). */
  has(tag: string): boolean {
    return this.segments.includes(tag) || tagsOf(this.body.error).includes(tag);
  }

  /** For `incorrect_offset` upload errors: where Dropbox's copy of the session ends. */
  get correctOffset(): number | undefined {
    const error = recordOf(this.body.error);
    const direct = numberField(error, "correct_offset");
    if (direct !== undefined) return direct;
    // finish wraps it: { ".tag": "lookup_failed", lookup_failed: { ".tag": "incorrect_offset", … } }
    return numberField(recordOf(error.lookup_failed), "correct_offset");
  }
}

/** Builds a DropboxApiError from a failed response. Bodies are JSON (409, 429, 401) or text (400, 5xx). */
async function apiErrorOf(
  response: Response,
  endpoint: string,
  attempts: number,
  scrub: (text: string) => string,
): Promise<DropboxApiError> {
  const text = scrub(await response.text().catch(() => ""));
  let body: Record<string, unknown> = {};
  try {
    body = recordOf(JSON.parse(text));
  } catch {
    // Not JSON: keep the (scrubbed, shortened) text as the summary.
  }
  const summary =
    stringField(body, "error_summary") ?? (text.trim().slice(0, 300) || `HTTP ${response.status}`);
  return new DropboxApiError(
    response.status,
    endpoint,
    summary,
    body,
    attempts,
    retryAfterOf(response, body),
  );
}

/** `Retry-After` (seconds or an HTTP date), else the body's `error.retry_after`, capped. */
function retryAfterOf(response: Response, body: Record<string, unknown>): number | undefined {
  const header = response.headers.get("retry-after");
  let ms: number | undefined;
  if (header !== null) {
    const seconds = Number(header);
    ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  } else {
    const seconds = numberField(recordOf(body.error), "retry_after");
    if (seconds !== undefined) ms = seconds * 1000;
  }
  if (ms === undefined || Number.isNaN(ms)) return undefined;
  return Math.min(Math.max(0, ms), MAX_RETRY_DELAY_MS);
}

/** Rate limits (429, or Dropbox's write lock reported as a 409) and server errors. */
function isRetryable(error: DropboxApiError): boolean {
  return (
    error.status === 429 ||
    error.status >= 500 ||
    error.has("too_many_write_operations") ||
    error.has("too_many_requests")
  );
}

/**
 * The tags of a nested Dropbox union, outermost first:
 * `{".tag":"path_lookup","path_lookup":{".tag":"not_found"}}` → `["path_lookup","not_found"]`.
 * The inner value is usually under the tag's own name, but some unions use another
 * field (`UploadError.path` keeps it in `reason`), so any nested union is followed.
 */
function tagsOf(value: unknown): string[] {
  const tags: string[] = [];
  let current: unknown = value;
  for (let depth = 0; depth < 8; depth++) {
    const record = recordOf(current);
    const tag = stringField(record, ".tag");
    if (!tag) break;
    tags.push(tag);
    const inner = record[tag];
    current =
      typeof inner === "object" && inner !== null
        ? inner
        : Object.values(record).find(
            (field) => typeof field === "object" && field !== null && ".tag" in field,
          );
  }
  return tags;
}

/** Reads chunks of exactly `chunkSize` bytes; a shorter chunk means the body ended. */
interface ChunkReader {
  read(): Promise<Buffer>;
}

/** Chunks of an in-memory body, as views (no copies). */
function bufferChunks(body: Uint8Array, chunkSize: number): ChunkReader {
  const all = toBuffer(body);
  let offset = 0;
  return {
    async read() {
      const piece = all.subarray(offset, offset + chunkSize);
      offset += piece.length;
      return piece;
    },
  };
}

/**
 * Chunks of a stream. Pulling from the stream only when a chunk is needed is the
 * backpressure: while a chunk uploads, the source is not read.
 */
function streamChunks(body: Readable, chunkSize: number): ChunkReader {
  const iterator = body[Symbol.asyncIterator]();
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let ended = false;
  return {
    async read() {
      while (!ended && pendingBytes < chunkSize) {
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          break;
        }
        const piece = toBuffer(next.value);
        pending.push(piece);
        pendingBytes += piece.length;
      }
      const joined = Buffer.concat(pending, pendingBytes);
      const taken = joined.subarray(0, Math.min(chunkSize, joined.length));
      const rest = joined.subarray(taken.length);
      pending = rest.length > 0 ? [rest] : [];
      pendingBytes = rest.length;
      return taken;
    },
  };
}

/** SHA-256 of each 4 MiB block of `data` (the inputs of a Dropbox content hash). */
function blockHashesOf(data: Buffer): Buffer[] {
  const hashes: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += HASH_BLOCK_SIZE) {
    hashes.push(
      createHash("sha256")
        .update(data.subarray(offset, offset + HASH_BLOCK_SIZE))
        .digest(),
    );
  }
  return hashes;
}

/** The Dropbox content hash from block hashes: hex SHA-256 of their concatenation. */
function hashOfBlocks(blocks: readonly Buffer[]): string {
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
}

/**
 * Streams a full download through, computing its Dropbox content hash, and fails
 * with MS_INTEGRITY_FAILED at the end if it (or the size) differs from what
 * Dropbox reported in `Dropbox-API-Result`.
 */
async function* verifiedStream(
  source: Readable,
  key: string,
  result: Record<string, unknown>,
): AsyncGenerator<Buffer> {
  const expectedHash = stringField(result, "content_hash");
  const expectedSize = numberField(result, "size");
  const blocks: Buffer[] = [];
  let block = createHash("sha256");
  let blockBytes = 0;
  let size = 0;
  for await (const piece of source) {
    const data = toBuffer(piece);
    size += data.length;
    // Feed the block hasher, closing a block at every 4 MiB boundary.
    for (let offset = 0; offset < data.length; ) {
      const take = Math.min(HASH_BLOCK_SIZE - blockBytes, data.length - offset);
      block.update(data.subarray(offset, offset + take));
      blockBytes += take;
      offset += take;
      if (blockBytes === HASH_BLOCK_SIZE) {
        blocks.push(block.digest());
        block = createHash("sha256");
        blockBytes = 0;
      }
    }
    yield data;
  }
  if (blockBytes > 0) blocks.push(block.digest());
  const sizeMatches = expectedSize === undefined || expectedSize === size;
  const hashMatches = expectedHash === undefined || expectedHash === hashOfBlocks(blocks);
  if (!sizeMatches || !hashMatches) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The download of "${key}" from Dropbox does not match its content hash.`,
      { hint: "Retry the read; if it keeps failing, the stored file is damaged." },
    );
  }
}

/** Cuts an inclusive byte range out of a full-file stream. */
async function* sliceStream(
  source: Readable,
  range: { readonly start: number; readonly end?: number },
): AsyncGenerator<Buffer> {
  const end = range.end ?? Number.POSITIVE_INFINITY;
  let position = 0;
  for await (const piece of source) {
    const data = toBuffer(piece);
    const from = Math.max(0, range.start - position);
    const to = Math.min(data.length, end + 1 - position);
    if (from < to) yield data.subarray(from, to);
    position += data.length;
    if (position > end) return;
  }
}

/**
 * Access tokens: either the fixed `accessToken` option, or ones obtained from the
 * refresh token, cached until shortly before they expire. Concurrent callers share
 * one refresh. This is a credential cache, not per-run state.
 */
function accessTokens(
  options: DropboxStorageOptions,
  doFetch: typeof fetch,
  retry: { readonly maxRetries: number; readonly delay: (attempt: number) => number },
) {
  const fixed = options.accessToken?.trim();
  const refreshToken = options.refreshToken?.trim();
  if (fixed && refreshToken) {
    throw configError("Give the Dropbox adapter a refreshToken or an accessToken, not both.");
  }
  if (!fixed && !refreshToken) {
    throw configError("The Dropbox adapter needs a refresh token.", {
      hint: `Run \`mongoshield login dropbox\` and pass the token (or set ${DROPBOX_SECRET_NAME}).`,
    });
  }
  // Only resolved when needed, so an accessToken works without any app key.
  const client = refreshToken
    ? options.clientId
      ? {
          clientId: options.clientId,
          ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
        }
      : resolveDropboxClient(process.env)
    : undefined;
  let current: { token: string; renewAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  const issued: string[] = [];

  async function refresh(): Promise<string> {
    if (!refreshToken || !client) throw new MongoShieldError("MS_INTERNAL", "No refresh token.");
    let fresh: Awaited<ReturnType<typeof refreshDropboxAccessToken>>;
    for (let attempt = 0; ; attempt++) {
      try {
        fresh = await refreshDropboxAccessToken({
          ...client,
          refreshToken,
          fetch: doFetch,
          ...(options.endpoints?.token ? { tokenUrl: options.endpoints.token } : {}),
        });
        break;
      } catch (error) {
        // A nightly backup must not fail on one network blip at the token endpoint.
        // A rejected token (MS_STORAGE_FORBIDDEN) is final, so only I/O errors retry.
        const transient = error instanceof MongoShieldError && error.code === "MS_STORAGE_IO";
        if (!transient || attempt >= retry.maxRetries) throw error;
        await sleep(retry.delay(attempt), undefined);
      }
    }
    issued.push(fresh.accessToken);
    current = {
      token: fresh.accessToken,
      renewAt: fresh.expiresAt.getTime() - TOKEN_RENEWAL_MARGIN_MS,
    };
    return fresh.accessToken;
  }

  return {
    /** True when an expired token can be replaced (a refresh token was given). */
    renewable: Boolean(refreshToken),
    async get(signal: AbortSignal | undefined): Promise<string> {
      if (fixed) return fixed;
      if (current && Date.now() < current.renewAt) return current.token;
      if (!refreshing) {
        // The shared refresh must not be cancelled by one caller's signal.
        refreshing = refresh().finally(() => {
          refreshing = undefined;
        });
      }
      return signal ? raceAbort(refreshing, signal) : refreshing;
    },
    /** Forgets `token` (Dropbox rejected it) so the next `get` refreshes. */
    invalidate(token: string): void {
      if (current?.token === token) current = undefined;
    },
    /** Every secret this adapter holds, for scrubbing error text. */
    secrets(): string[] {
      return [fixed, refreshToken, client?.clientSecret, ...issued].filter(
        (value): value is string => typeof value === "string",
      );
    },
  };
}

/** Waits for `promise`, but rejects with MS_ABORTED as soon as `signal` fires. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
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

/** Sleeps, rejecting with MS_ABORTED if the signal fires first. */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleepFor(ms, undefined, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}

/** `folder` option → `prod/mongo` (no leading/trailing slashes, validated, required). */
function normalizeFolder(folder: string): string {
  const normalized = normalizePrefix(folder, "Dropbox folder").replace(/\/$/, "");
  if (normalized === "") {
    throw configError("The Dropbox folder is empty.", {
      hint: "Name a folder inside the app folder, e.g. dropbox://backups.",
    });
  }
  return normalized;
}

/** Validates `chunkSize`: a multiple of 4 MiB between 4 and 148 MiB. */
function validChunkSize(value: number | undefined): number {
  if (value === undefined) return DROPBOX_DEFAULT_CHUNK_SIZE;
  if (
    !Number.isSafeInteger(value) ||
    value < HASH_BLOCK_SIZE ||
    value > MAX_CHUNK_SIZE ||
    value % HASH_BLOCK_SIZE !== 0
  ) {
    throw configError(`Invalid Dropbox chunkSize ${value}.`, {
      hint: "Use a multiple of 4 MiB (4194304) between 4 MiB and 148 MiB.",
    });
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw configError(`Invalid Dropbox ${name} ${value}: use a whole number of 0 or more.`);
  }
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isValidKey(key: string): boolean {
  try {
    assertValidKey(key);
    return true;
  } catch {
    return false;
  }
}

function configError(message: string, options: { hint?: string } = {}): MongoShieldError {
  return new MongoShieldError("MS_CONFIG_INVALID", message, options);
}

/** Parses a successful response's JSON body (`null` for endpoints that return nothing). */
async function jsonOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MongoShieldError("MS_STORAGE_IO", "Dropbox sent a response that is not JSON.");
  }
}

/** Parses the JSON in a `Dropbox-API-Result` header; `{}` when missing or malformed. */
function parseJsonHeader(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    return recordOf(JSON.parse(value));
  } catch {
    return {};
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: unknown, field: string): string | undefined {
  const value = recordOf(record)[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: unknown, field: string): number | undefined {
  const value = recordOf(record)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayField(record: unknown, field: string): unknown[] {
  const value = recordOf(record)[field];
  return Array.isArray(value) ? value : [];
}
