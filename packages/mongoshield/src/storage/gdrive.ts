/**
 * Google Drive storage adapter (`gdrive://<folder>`), on the Drive API v3 with plain `fetch`.
 *
 *   import { gdriveStorage } from "mongoshield/storage/gdrive";
 *   const storage = gdriveStorage({ folder: "prod", refreshToken, clientId, clientSecret });
 *
 * Where objects live: in My Drive, MongoShield creates one app folder ("MongoShield")
 * the first time it is used, and finds it again by a private `appProperties` marker
 * rather than by name, so a user renaming or moving it does not break anything.
 * `folder` is a path inside it, and every storage key maps to nested folders plus a
 * file: `backups/<id>/app/users.bson.zst` becomes the folders `backups`, `<id>`, `app`
 * and the file `users.bson.zst`. A person browsing their drive sees the usual layout.
 *
 * Permissions: the `drive.file` scope only, so MongoShield can see and change the files
 * it created and nothing else in the drive.
 *
 * How the contract is met:
 * - Atomic writes. Objects up to 5 MiB go up in one multipart request; larger ones
 *   use a resumable upload in chunks of a multiple of 256 KiB (Drive's rule), read
 *   from the body as they are sent, so at most one chunk is held in memory. Drive
 *   only creates the file when the last chunk arrives, so a failed upload leaves no
 *   file behind (the session expires unseen after a week).
 * - Overwrites. Drive allows several files with the same name in a folder and has no
 *   create-if-absent, so `put` uploads the new file first, then deletes every older
 *   file with that name. Readers always pick the newest file of a name, so they see
 *   the old object until the new one is complete and the new one from then on, never
 *   two. Concurrent puts to one key leave the newest.
 * - No conditional writes (`capabilities.conditionalWrites = false`): a put with
 *   `ifNoneMatch` fails with the "conditional writes unsupported" error, and the
 *   scheduler's storage lock cannot work here. Use `schedule.lock: "none"` and let the
 *   scheduler (GitHub Actions `concurrency:`) keep runs apart. The adapter says so with
 *   the extra capability `storageLock: false`.
 * - Integrity: an MD5 is computed while uploading and compared with the
 *   `md5Checksum` Drive reports; a mismatch deletes the new file and fails with
 *   MS_INTEGRITY_FAILED.
 * - Range reads use `alt=media` with a `Range` header.
 * - Listing walks the folder tree with `files.list` (paged, 1000 per page) and sorts
 *   each folder's children by their full key, so keys come out in byte order: a
 *   folder `a` sorts as `a/`, after `a-c` and `a.b/`, exactly as flat keys would.
 *   `listPrefixes` reports only folders that hold at least one file somewhere below.
 * - Deletes are permanent (`files.delete`, not the trash). Folders left empty by a
 *   delete are removed too, except the first level under `folder` (`backups/`, …),
 *   which other runs may be writing into at the same moment.
 * - Duplicate folders (two runs creating `backups` at once) are read as one: children
 *   of every same-named folder are merged. New files go into the oldest of them.
 * - Folder ids are cached per adapter instance (they never change while a folder
 *   exists); the cache is only an optimisation and is dropped on `close()`.
 * - Rate limits: 429, 5xx and 403 `rateLimitExceeded` / `userRateLimitExceeded` are
 *   retried with truncated exponential backoff (honouring `Retry-After`), as Google's
 *   Drive limits page recommends. Every HTTP call goes through one `request()` here.
 * - `space()` reports the account's quota from `about.get` (`storageQuota`), with the
 *   trash counted separately, because trashed files still use quota.
 *
 * The access token is never logged or put in an error, a `location` or a manifest.
 */

import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  assertValidRange,
  compareBytes,
  destroyOnAbort,
  forEachWithConcurrency,
  messageOf,
  toBuffer,
} from "./adapter-utils.ts";
import { conditionalWritesUnsupportedError } from "./conditional-writes.ts";
import {
  abortableSleep,
  exchangeGdriveRefreshToken,
  GDRIVE_TOKEN_SECRET,
  type GdriveAccessToken,
  gdriveClientCredentials,
} from "./gdrive-auth.ts";
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

/** Options for {@link gdriveStorage}. */
export interface GdriveStorageOptions {
  /**
   * Folder path inside the MongoShield app folder, e.g. `"prod"` or `"acme/prod"`.
   * Created on first use.
   */
  readonly folder: string;
  /** The refresh token from `mongoshield login gdrive` (MONGOSHIELD_GDRIVE_TOKEN). */
  readonly refreshToken?: string;
  /** OAuth client the refresh token belongs to. */
  readonly clientId?: string;
  readonly clientSecret?: string;
  /**
   * An access token, or a function returning one, instead of a refresh token (tokens
   * minted elsewhere, tests). A function is called again after a 401.
   */
  readonly accessToken?: string | ((options: { signal?: AbortSignal }) => Promise<string>);
  /**
   * Resumable upload chunk size in bytes: a multiple of 256 KiB, default 8 MiB. One
   * chunk per upload is held in memory, so it can be resent after a network error.
   */
  readonly chunkSize?: number;
  /** Name of the app folder created in My Drive. Defaults to `"MongoShield"`. */
  readonly appFolderName?: string;
  /** How many files `delete()` removes in parallel (default 8). */
  readonly deleteConcurrency?: number;
  /** Retries after a rate limit, 5xx or network error (default 7). */
  readonly retries?: number;
  /** First retry delay in milliseconds, doubled each time up to 32 s (default 1000). */
  readonly retryBaseMs?: number;
  /** How long one request may wait for response headers (default 60 s). */
  readonly requestTimeoutMs?: number;
  /** Drive API origin, default `https://www.googleapis.com` (tests use a fake server). */
  readonly apiUrl?: string;
  /** OAuth token endpoint, default Google's (tests use a fake server). */
  readonly tokenUrl?: string;
  /** A `fetch` to use instead of the global one. */
  readonly fetch?: typeof fetch;
}

/** What `space()` reports, in bytes. Fields the provider does not report are absent. */
export interface StorageSpace {
  readonly total?: number;
  readonly used?: number;
  readonly free?: number;
  readonly trash?: number;
}

/**
 * Capabilities plus `storageLock`, a flag proposed for `StorageCapabilities`: `false`
 * means no storage lock can ever work here, so `schedule.lock` should default to "none".
 */
export interface GdriveCapabilities extends StorageCapabilities {
  readonly storageLock: false;
}

/** The adapter, with the extra `space()` method. */
export interface GdriveStorage extends StorageAdapter {
  readonly capabilities: GdriveCapabilities;
  /** The account's storage quota (see the file header). */
  space(options?: SignalOptions): Promise<StorageSpace | undefined>;
}

const CAPABILITIES: GdriveCapabilities = {
  conditionalWrites: false,
  rangeReads: true,
  objectLock: false,
  storageLock: false,
};

/** Drive's resumable uploads need chunks in multiples of 256 KiB (except the last). */
const CHUNK_GRANULARITY = 256 * 1024;
/** 8 MiB: few requests per object, modest memory. */
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** Drive's limit for a multipart (single-request) upload: 5 MB. */
const MULTIPART_LIMIT = 5 * 1024 * 1024;
/** `files.list` returns at most 1000 files per page. */
const LIST_PAGE_SIZE = 1000;
const DEFAULT_DELETE_CONCURRENCY = 8;
const DEFAULT_RETRIES = 7;
const DEFAULT_RETRY_BASE_MS = 1000;
/** Google recommends capping the backoff at 32 or 64 seconds. */
const MAX_BACKOFF_MS = 32_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Refresh the access token this long before Google says it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const DEFAULT_API_URL = "https://www.googleapis.com";
const DEFAULT_APP_FOLDER_NAME = "MongoShield";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * The private marker on the app folder. `appProperties` are visible only to the
 * OAuth client that set them, so nobody else's folder can match.
 */
const APP_FOLDER_MARKER = { key: "mongoshield", value: "app-folder" } as const;

/** The file fields every request asks for. */
const FILE_FIELDS = "id,name,mimeType,size,createdTime,modifiedTime,md5Checksum";

/** Rate-limit reasons Drive returns with a 403 that are worth retrying. */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/** The hint for a token Drive refuses. */
const TOKEN_HINT = `Run \`mongoshield login gdrive\` and store the token as ${GDRIVE_TOKEN_SECRET}.`;

/** What an adapter call was doing, used in error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete" | "space";

/** The parts of a Drive file resource we use. */
interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: string;
  readonly createdTime?: string;
  readonly modifiedTime?: string;
  readonly md5Checksum?: string;
}

/** A child of a (possibly duplicated) folder, after duplicates are merged. */
type Child =
  | { readonly kind: "file"; readonly name: string; readonly file: DriveFile }
  | { readonly kind: "folder"; readonly name: string; readonly ids: readonly string[] };

/** Creates a storage adapter that keeps objects in the user's Google Drive. */
export function gdriveStorage(options: GdriveStorageOptions): GdriveStorage {
  const baseSegments = folderSegments(options.folder);
  const chunkSize = validChunkSize(options.chunkSize);
  const deleteConcurrency = positiveInteger(
    options.deleteConcurrency,
    DEFAULT_DELETE_CONCURRENCY,
    "deleteConcurrency",
  );
  const retries = nonNegativeInteger(options.retries, DEFAULT_RETRIES, "retries");
  const retryBaseMs = nonNegativeInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, "retryBaseMs");
  const requestTimeoutMs = positiveInteger(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
  );
  const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const appFolderName = options.appFolderName ?? DEFAULT_APP_FOLDER_NAME;
  const doFetch = options.fetch ?? fetch;
  const location = `gdrive://${baseSegments.join("/")}/`;
  const tokens = accessTokenSource(options, doFetch);

  // Folder ids by path relative to the app folder ("" is the app folder itself). A
  // path can map to several ids when duplicate folders exist; the first is the one
  // new files go into. Only folders that exist are cached.
  const folderCache = new Map<string, readonly string[]>();
  // Folder creations in flight, so concurrent puts in this process create each folder once.
  const creating = new Map<string, Promise<readonly string[]>>();
  // Folders with a put in progress, counted, so `delete` never removes them as empty.
  const busyFolders = new Map<string, number>();

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /** Options for {@link request}. */
  interface RequestOptions {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | Buffer;
    readonly signal?: AbortSignal | undefined;
    /** Retry rate limits and 5xx (default true). Upload chunks handle retries themselves. */
    readonly retry?: boolean;
  }

  /**
   * The one place this module calls Drive. Adds the bearer token, applies a timeout
   * to the wait for response headers (not to reading the body), retries rate limits,
   * 5xx and network failures with backoff, and refreshes the token once on a 401.
   * Returns the response for any status; callers decide what a status means.
   */
  async function request(url: string, requestOptions: RequestOptions = {}): Promise<Response> {
    const { signal } = requestOptions;
    const retryAllowed = requestOptions.retry ?? true;
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const token = await tokens.get(signal);
      const headerTimeout = new AbortController();
      const timer = setTimeout(
        () => headerTimeout.abort(new Error("request timed out")),
        requestTimeoutMs,
      );
      const requestSignal = signal
        ? AbortSignal.any([signal, headerTimeout.signal])
        : headerTimeout.signal;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: requestOptions.method ?? "GET",
          headers: { ...requestOptions.headers, authorization: `Bearer ${token}` },
          ...(requestOptions.body === undefined ? {} : { body: requestOptions.body }),
          signal: requestSignal,
        });
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (!retryAllowed || attempt >= retries) throw networkError(error);
        await abortableSleep(backoffMs(attempt, undefined), signal);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 401 && !refreshedAfter401) {
        // Access tokens can expire early (revoked, clock skew); get a fresh one once.
        refreshedAfter401 = true;
        await discard(response);
        tokens.invalidate();
        continue;
      }
      if (retryAllowed && attempt < retries && (await isRetryable(response))) {
        const delay = backoffMs(attempt, response.headers.get("retry-after"));
        await discard(response);
        await abortableSleep(delay, signal);
        continue;
      }
      return response;
    }
  }

  /** Exponential backoff with jitter, or the server's `Retry-After` when it gives one. */
  function backoffMs(attempt: number, retryAfter: string | null | undefined): number {
    const fromServer = retryAfterMs(retryAfter);
    if (fromServer !== undefined) return Math.min(fromServer, MAX_BACKOFF_MS * 2);
    const exponential = retryBaseMs * 2 ** attempt;
    const jitter = retryBaseMs === 0 ? 0 : Math.floor(Math.random() * Math.min(1000, retryBaseMs));
    return Math.min(MAX_BACKOFF_MS, exponential + jitter);
  }

  /** GETs or sends JSON and returns the parsed answer, or throws the mapped error. */
  async function requestJson(
    url: string,
    operation: Operation,
    target: string,
    requestOptions: RequestOptions = {},
  ): Promise<unknown> {
    const response = await request(url, requestOptions);
    if (!response.ok) throw await driveError(response, operation, target, requestOptions.signal);
    const text = await response.text();
    return text === "" ? {} : (JSON.parse(text) as unknown);
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  /** Escapes a value for a single-quoted string in a Drive query. */
  function quote(value: string): string {
    return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  }

  /** One `files.list` call for `query`, following every page. */
  async function* listFiles(
    query: string,
    target: string,
    signal: AbortSignal | undefined,
    pageSize = LIST_PAGE_SIZE,
  ): AsyncGenerator<DriveFile> {
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({
        q: query,
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: String(pageSize),
        spaces: "drive",
      });
      if (pageToken) parameters.set("pageToken", pageToken);
      const page = await requestJson(`${apiUrl}/drive/v3/files?${parameters}`, "list", target, {
        signal,
      });
      throwIfAborted(signal);
      for (const file of filesOf(page)) yield file;
      pageToken = stringOf(page, "nextPageToken");
    } while (pageToken);
  }

  /** All of a query's files (folder listings are small: one entry per child). */
  async function allFiles(
    query: string,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    for await (const file of listFiles(query, target, signal)) files.push(file);
    return files;
  }

  /** `('a' in parents or 'b' in parents)`, for reading duplicate folders as one. */
  function inParents(parentIds: readonly string[]): string {
    return `(${parentIds.map((id) => `${quote(id)} in parents`).join(" or ")})`;
  }

  /** Finds the app folder by its marker, creating it in My Drive the first time. */
  const appFolder = memoizeSuccess(async (signal: AbortSignal | undefined) => {
    const query =
      `mimeType = '${FOLDER_MIME_TYPE}' and trashed = false and appProperties has ` +
      `{ key=${quote(APP_FOLDER_MARKER.key)} and value=${quote(APP_FOLDER_MARKER.value)} }`;
    const found = await allFiles(query, location, signal);
    if (found.length > 0) return sortFoldersOldestFirst(found).map((folder) => folder.id);
    await createFolder(appFolderName, "root", signal, {
      [APP_FOLDER_MARKER.key]: APP_FOLDER_MARKER.value,
    });
    // Look again: if another process created one at the same moment, everyone
    // settles on the oldest, and both are read as one.
    return sortFoldersOldestFirst(await allFiles(query, location, signal)).map(
      (folder) => folder.id,
    );
  });

  /** Creates a folder and returns it. */
  async function createFolder(
    name: string,
    parentId: string,
    signal: AbortSignal | undefined,
    appProperties?: Record<string, string>,
  ): Promise<DriveFile> {
    const metadata = {
      name,
      mimeType: FOLDER_MIME_TYPE,
      parents: [parentId],
      ...(appProperties ? { appProperties } : {}),
    };
    const created = await requestJson(
      `${apiUrl}/drive/v3/files?fields=${FILE_FIELDS}`,
      "write",
      `${location}${name}`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify(metadata),
        signal,
      },
    );
    return fileOf(created);
  }

  /** Child folders named `name` under any of `parentIds`, oldest first. */
  async function childFolders(
    parentIds: readonly string[],
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<string[]> {
    const query = `${inParents(parentIds)} and name = ${quote(name)} and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
    const found = await allFiles(query, `${location}${name}`, signal);
    return sortFoldersOldestFirst(found).map((folder) => folder.id);
  }

  /**
   * The folder ids of a path relative to the app folder (`["prod", "backups"]`), or
   * `undefined` when some folder on the way does not exist. Never creates anything.
   */
  async function findFolders(
    segments: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<readonly string[] | undefined> {
    let ids: readonly string[] = await appFolder(signal);
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join("/");
      const cached = folderCache.get(path);
      if (cached) {
        ids = cached;
        continue;
      }
      const found = await childFolders(ids, segments[depth - 1] ?? "", signal);
      if (found.length === 0) return undefined;
      folderCache.set(path, found);
      ids = found;
    }
    return ids;
  }

  /** Like {@link findFolders}, creating missing folders. Returns the folder to write into. */
  async function ensureFolder(
    segments: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let ids: readonly string[] = await appFolder(signal);
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join("/");
      const parents = ids;
      const name = segments[depth - 1] ?? "";
      ids = folderCache.get(path) ?? (await ensureChildFolder(path, parents, name, signal));
    }
    const target = ids[0];
    if (target === undefined) throw new MongoShieldError("MS_INTERNAL", "Folder lookup failed.");
    return target;
  }

  /** Finds or creates one folder level, at most once at a time per path in this process. */
  function ensureChildFolder(
    path: string,
    parents: readonly string[],
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> {
    const pending = creating.get(path);
    if (pending) return pending;
    const work = (async () => {
      const existing = await childFolders(parents, name, signal);
      if (existing.length > 0) return existing;
      const parentId = parents[0];
      if (parentId === undefined) throw new MongoShieldError("MS_INTERNAL", "No parent folder.");
      await createFolder(name, parentId, signal);
      // Re-read, so a folder another process created at the same moment is seen too.
      return childFolders(parents, name, signal);
    })();
    creating.set(path, work);
    work.then(
      (ids) => {
        folderCache.set(path, ids);
        creating.delete(path);
      },
      () => creating.delete(path),
    );
    return work;
  }

  /** Every child of a folder (merged across duplicates), sorted by full key order. */
  async function childrenOf(
    folderIds: readonly string[],
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<Child[]> {
    const files = await allFiles(`${inParents(folderIds)} and trashed = false`, target, signal);
    return mergeChildren(files);
  }

  /** True when any file exists in the folder or anywhere below it. */
  async function holdsFiles(
    folderIds: readonly string[],
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const children = await childrenOf(folderIds, target, signal);
    if (children.some((child) => child.kind === "file")) return true;
    for (const child of children) {
      if (child.kind === "folder" && (await holdsFiles(child.ids, target, signal))) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  /** Splits a key into its folder path (relative to the app folder) and file name. */
  function placeOf(key: string): { folders: string[]; name: string; folderKey: string } {
    const parts = key.split("/");
    const name = parts.pop() ?? key;
    return { folders: [...baseSegments, ...parts], name, folderKey: parts.join("/") };
  }

  /** Every file stored under `key` (normally one), newest first. */
  async function filesAt(key: string, signal: AbortSignal | undefined): Promise<DriveFile[]> {
    const { folders, name } = placeOf(key);
    const folderIds = await findFolders(folders, signal);
    if (!folderIds) return [];
    const query = `${inParents(folderIds)} and name = ${quote(name)} and mimeType != '${FOLDER_MIME_TYPE}' and trashed = false`;
    const files = await allFiles(query, `${location}${key}`, signal);
    return files.sort(newestFirst);
  }

  /** Deletes one file permanently. A file that is already gone is not an error. */
  async function deleteFile(
    id: string,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const response = await request(`${apiUrl}/drive/v3/files/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
    if (response.ok || response.status === 404) {
      await discard(response);
      return;
    }
    throw await driveError(response, "delete", target, signal);
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    assertValidKey(key);
    rejectRetention(putOptions, body, "gdrive", location);
    const { signal } = putOptions;
    const target = `${location}${key}`;
    if (putOptions.ifNoneMatch === "*") {
      if (body instanceof Readable) body.destroy();
      throw conditionalWritesUnsupportedError(target);
    }
    const { folders, name, folderKey } = placeOf(key);
    markBusy(folderKey, +1);
    try {
      throwIfAborted(signal);
      const parentId = await ensureFolder(folders, signal);
      const metadata = {
        name,
        parents: [parentId],
        mimeType: putOptions.contentType ?? DEFAULT_CONTENT_TYPE,
      };
      const uploaded = await uploadFile(metadata, body, target, signal);
      await removeOlderCopies(key, uploaded, signal);
      return objectInfo(key, uploaded.file, uploaded.size);
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      throw asStorageError(error, "write", target, signal);
    } finally {
      markBusy(folderKey, -1);
    }
  }

  /** Counts puts in progress per folder key ("" for the storage root). */
  function markBusy(folderKey: string, change: 1 | -1): void {
    const count = (busyFolders.get(folderKey) ?? 0) + change;
    if (count <= 0) busyFolders.delete(folderKey);
    else busyFolders.set(folderKey, count);
  }

  /** Deletes the files an overwrite replaced: same name, created before `uploaded`. */
  async function removeOlderCopies(
    key: string,
    uploaded: UploadResult,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const copies = await filesAt(key, signal);
    for (const copy of copies) {
      if (copy.id === uploaded.file.id) continue;
      // Only older copies: of two overwrites racing, the newer must survive the older's cleanup.
      if (newestFirst(copy, uploaded.file) < 0) continue;
      await deleteFile(copy.id, `${location}${key}`, signal);
    }
  }

  /** Uploads one file: multipart when it is small, resumable otherwise. */
  async function uploadFile(
    metadata: Record<string, unknown>,
    body: Readable | Uint8Array,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<UploadResult> {
    const source = new ChunkSource(body);
    const md5 = createHash("md5");
    const first = await source.next(chunkSize, signal);
    let result: UploadResult;
    if (first.final && first.data.length <= MULTIPART_LIMIT) {
      md5.update(first.data);
      result = {
        file: await multipartUpload(metadata, first.data, target, signal),
        size: first.data.length,
      };
    } else {
      result = await resumableUpload(metadata, source, first, md5, target, signal);
    }
    throwIfAborted(signal);
    await checkIntegrity(result, md5.digest("hex"), target, signal);
    return result;
  }

  /** Compares Drive's MD5 with ours; on a mismatch the new file is deleted. */
  async function checkIntegrity(
    result: UploadResult,
    expectedMd5: string,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const reported = result.file.md5Checksum;
    const reportedSize = result.file.size === undefined ? undefined : Number(result.file.size);
    const sizeMismatch = reportedSize !== undefined && reportedSize !== result.size;
    if ((reported === undefined || reported === expectedMd5) && !sizeMismatch) return;
    await deleteFile(result.file.id, target, signal).catch(() => {});
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `Could not write ${target}: Google Drive stored different bytes than were sent.`,
      { hint: "The data was corrupted in transit. Retry the operation." },
    );
  }

  /** A single-request upload of metadata and content (Drive allows up to 5 MB). */
  async function multipartUpload(
    metadata: Record<string, unknown>,
    data: Buffer,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<DriveFile> {
    const boundary = `mongoshield-${randomBytes(12).toString("hex")}`;
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n--${boundary}\r\n` +
      `Content-Type: ${String(metadata.mimeType ?? DEFAULT_CONTENT_TYPE)}\r\n\r\n`;
    const payload = Buffer.concat([
      Buffer.from(head),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = await requestJson(
      `${apiUrl}/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`,
      "write",
      target,
      {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body: payload,
        signal,
      },
    );
    return fileOf(created);
  }

  /**
   * A resumable upload: start a session, then send chunks as they are read from the
   * body. The total size is only known with the last chunk, so earlier chunks say
   * `bytes a-b/*`. After each chunk Drive's `Range` answer says how much it really
   * has; anything it lacks is sent again.
   */
  async function resumableUpload(
    metadata: Record<string, unknown>,
    source: ChunkSource,
    first: SourceChunk,
    md5: ReturnType<typeof createHash>,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<UploadResult> {
    const start = await request(
      `${apiUrl}/upload/drive/v3/files?uploadType=resumable&fields=${FILE_FIELDS}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": String(metadata.mimeType ?? DEFAULT_CONTENT_TYPE),
        },
        body: JSON.stringify(metadata),
        signal,
      },
    );
    if (!start.ok) throw await driveError(start, "write", target, signal);
    const sessionUrl = start.headers.get("location");
    await discard(start);
    if (!sessionUrl) {
      throw new MongoShieldError(
        "MS_STORAGE_IO",
        `Could not write ${target}: Drive sent no upload session.`,
      );
    }
    let offset = 0;
    let chunk = first;
    for (;;) {
      md5.update(chunk.data);
      const file = await sendChunk(sessionUrl, chunk, offset, target, signal);
      offset += chunk.data.length;
      if (chunk.final) {
        if (!file) {
          throw new MongoShieldError(
            "MS_STORAGE_IO",
            `Could not write ${target}: Drive did not finish the upload.`,
          );
        }
        return { file, size: offset };
      }
      chunk = await source.next(chunkSize, signal);
    }
  }

  /**
   * Sends one chunk, resending whatever part Drive did not keep. Returns the file once
   * the final chunk is accepted. On a retryable failure it asks Drive how much it has
   * (`Content-Range: bytes * /…`) and continues from there.
   */
  async function sendChunk(
    sessionUrl: string,
    chunk: SourceChunk,
    offset: number,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<DriveFile | undefined> {
    const end = offset + chunk.data.length;
    const total = chunk.final ? String(end) : "*";
    let confirmed = offset;
    for (let failures = 0; ; ) {
      throwIfAborted(signal);
      const remaining = chunk.data.subarray(confirmed - offset);
      const contentRange =
        remaining.length === 0 ? `bytes */${total}` : `bytes ${confirmed}-${end - 1}/${total}`;
      let response: Response;
      try {
        response = await request(sessionUrl, {
          method: "PUT",
          headers: { "content-range": contentRange },
          body: Buffer.from(remaining),
          signal,
          retry: false,
        });
      } catch (error) {
        if (signal?.aborted || failures >= retries) throw error;
        failures++;
        await abortableSleep(backoffMs(failures - 1, undefined), signal);
        confirmed = await uploadedBytes(sessionUrl, total, offset, target, signal);
        continue;
      }
      if (response.status === 200 || response.status === 201) {
        return fileOf(JSON.parse(await response.text()) as unknown);
      }
      if (response.status === 308) {
        confirmed = Math.max(confirmed, receivedBytes(response.headers.get("range")));
        await discard(response);
        if (confirmed >= end && !chunk.final) return undefined;
        // Drive kept less than was sent: send the rest again (it never asks for bytes
        // before what it confirmed). A final chunk is resent until Drive answers with
        // the file, but not forever.
        if (confirmed > end) confirmed = end;
        if (confirmed === end && ++failures > retries) {
          throw new MongoShieldError(
            "MS_STORAGE_IO",
            `Could not write ${target}: Drive did not finish the upload.`,
          );
        }
        continue;
      }
      if (failures < retries && (await isRetryable(response))) {
        failures++;
        const delay = backoffMs(failures - 1, response.headers.get("retry-after"));
        await discard(response);
        await abortableSleep(delay, signal);
        confirmed = await uploadedBytes(sessionUrl, total, offset, target, signal);
        continue;
      }
      throw await driveError(response, "write", target, signal);
    }
  }

  /** Asks an upload session how many bytes it has (an empty PUT with `bytes * /total`). */
  async function uploadedBytes(
    sessionUrl: string,
    total: string,
    floor: number,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const response = await request(sessionUrl, {
      method: "PUT",
      headers: { "content-range": `bytes */${total}` },
      body: Buffer.alloc(0),
      signal,
    });
    if (response.status === 308) {
      const received = receivedBytes(response.headers.get("range"));
      await discard(response);
      return Math.max(received, floor);
    }
    throw await driveError(response, "write", target, signal);
  }

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    assertValidKey(key);
    const { signal, range } = getOptions;
    throwIfAborted(signal);
    if (range) assertValidRange(range, key);
    const target = `${location}${key}`;
    try {
      const [file] = await filesAt(key, signal);
      if (!file)
        throw new MongoShieldError(
          "MS_STORAGE_NOT_FOUND",
          `Could not read ${target}: no such object.`,
        );
      const size = Number(file.size ?? "0");
      // Drive answers 416 for a range past the end; other adapters return nothing there.
      if (range && range.start >= size) return Readable.from([]);
      const headers: Record<string, string> = {};
      if (range) headers.range = `bytes=${range.start}-${range.end ?? ""}`;
      const response = await request(
        `${apiUrl}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
        { headers, signal },
      );
      if (response.status === 416) {
        await discard(response);
        return Readable.from([]);
      }
      if (!response.ok) throw await driveError(response, "read", target, signal);
      const stream = response.body
        ? Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
        : Readable.from([]);
      // A server that ignored the Range header sent everything; cut out the range.
      const result = range && response.status === 200 ? sliceStream(stream, range) : stream;
      destroyOnAbort(result, signal);
      return result;
    } catch (error) {
      throw asStorageError(error, "read", target, signal);
    }
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    assertValidKey(key);
    const { signal } = headOptions;
    throwIfAborted(signal);
    try {
      const [file] = await filesAt(key, signal);
      throwIfAborted(signal);
      return file ? objectInfo(key, file) : undefined;
    } catch (error) {
      throw asStorageError(error, "stat", `${location}${key}`, signal);
    }
  }

  /**
   * Walks a folder depth-first in key order, yielding its files. `namePrefix` filters
   * the first level only (for prefixes that end in a partial name, like `backups/2026`).
   */
  async function* walk(
    folderIds: readonly string[],
    folderKey: string,
    namePrefix: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ObjectInfo> {
    const children = await childrenOf(folderIds, `${location}${folderKey}`, signal);
    for (const child of children) {
      if (!child.name.startsWith(namePrefix)) continue;
      const key = `${folderKey}${child.name}`;
      if (!isValidKey(key)) continue;
      if (child.kind === "file") yield objectInfo(key, child.file);
      else yield* walk(child.ids, `${key}/`, "", signal);
    }
  }

  /** The folders of a listing prefix (everything up to its last `/`) and the rest. */
  function splitPrefix(prefix: string): { folderKey: string; namePrefix: string } {
    const slash = prefix.lastIndexOf("/");
    return { folderKey: prefix.slice(0, slash + 1), namePrefix: prefix.slice(slash + 1) };
  }

  /** The folder ids of a folder key such as `backups/` (`""` is the storage root). */
  function folderPathOf(folderKey: string): string[] {
    return [...baseSegments, ...folderKey.split("/").filter((segment) => segment !== "")];
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    const { folderKey, namePrefix } = splitPrefix(prefix);
    try {
      const folderIds = await findFolders(folderPathOf(folderKey), signal);
      if (!folderIds) return;
      yield* walk(folderIds, folderKey, namePrefix, signal);
    } catch (error) {
      throw asStorageError(error, "list", `${location}${prefix}`, signal);
    }
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    throwIfAborted(signal);
    try {
      const { folderKey, namePrefix } = splitPrefix(prefix);
      const folderIds = await findFolders(folderPathOf(folderKey), signal);
      if (!folderIds) return;
      const children = await childrenOf(folderIds, `${location}${prefix}`, signal);
      for (const child of children) {
        if (child.kind !== "folder" || !child.name.startsWith(namePrefix)) continue;
        const key = `${folderKey}${child.name}`;
        if (!isValidKey(key)) continue;
        // Empty folders (left by a failed upload, say) are not "directories" of objects.
        if (await holdsFiles(child.ids, `${location}${key}/`, signal)) yield `${key}/`;
      }
    } catch (error) {
      throw asStorageError(error, "list", `${location}${prefix}`, signal);
    }
  }

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    throwIfAborted(signal);
    // Validate everything first so an invalid key cannot leave a half-done delete.
    for (const key of keys) assertValidKey(key);
    if (keys.length === 0) return;
    const emptiedFolders = new Set<string>();
    await forEachWithConcurrency(keys, deleteConcurrency, async (key) => {
      throwIfAborted(signal);
      const target = `${location}${key}`;
      try {
        for (const file of await filesAt(key, signal)) await deleteFile(file.id, target, signal);
      } catch (error) {
        throw asStorageError(error, "delete", target, signal);
      }
      emptiedFolders.add(placeOf(key).folderKey);
    });
    await removeEmptyFolders(emptiedFolders, signal);
  }

  /**
   * Removes folders a delete left empty, deepest first, walking up while parents are
   * empty too. Skipped: the storage root and its first level (shared by every run),
   * and folders with a put in progress in this process. Deleting a Drive folder
   * deletes everything in it, so each one is checked to be empty right before.
   */
  async function removeEmptyFolders(
    folderKeys: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const candidates = new Set<string>();
    for (const folderKey of folderKeys) {
      const parts = folderKey.split("/").filter((part) => part !== "");
      for (let depth = parts.length; depth >= 2; depth--) {
        candidates.add(parts.slice(0, depth).join("/"));
      }
    }
    const deepestFirst = [...candidates].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    );
    for (const folderKey of deepestFirst) {
      throwIfAborted(signal);
      if (isBusy(folderKey)) continue;
      const path = folderPathOf(folderKey);
      const folderIds = await findFolders(path, signal).catch(() => undefined);
      if (!folderIds) continue;
      const target = `${location}${folderKey}/`;
      const children = await allFiles(
        `${inParents(folderIds)} and trashed = false`,
        target,
        signal,
      ).catch(() => undefined);
      if (children === undefined || children.length > 0 || isBusy(folderKey)) continue;
      for (const id of folderIds) await deleteFile(id, target, signal).catch(() => {});
      forgetFolder(path.join("/"));
    }
  }

  /** True when a put in progress writes into `folderKey` or below it. */
  function isBusy(folderKey: string): boolean {
    for (const busy of busyFolders.keys()) {
      if (busy === folderKey || busy.startsWith(`${folderKey}/`)) return true;
    }
    return false;
  }

  /** Drops a folder and everything below it from the id cache. */
  function forgetFolder(path: string): void {
    for (const cached of [...folderCache.keys()]) {
      if (cached === path || cached.startsWith(`${path}/`)) folderCache.delete(cached);
    }
  }

  async function space(spaceOptions: SignalOptions = {}): Promise<StorageSpace | undefined> {
    const { signal } = spaceOptions;
    throwIfAborted(signal);
    try {
      const about = await requestJson(
        `${apiUrl}/drive/v3/about?fields=storageQuota`,
        "space",
        location,
        { signal },
      );
      return quotaOf(about);
    } catch (error) {
      throw asStorageError(error, "space", location, signal);
    }
  }

  return {
    kind: "gdrive",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    space,
    async close() {
      folderCache.clear();
      appFolder.reset();
    },
  };
}

/**
 * Builds the adapter for a `gdrive://<folder>[/<more>]?chunkSizeMiB=…` URL. The
 * refresh token comes from MONGOSHIELD_GDRIVE_TOKEN, and the OAuth client from
 * MONGOSHIELD_GDRIVE_CLIENT_ID / _CLIENT_SECRET (or the shipped client).
 */
export function gdriveStorageFromUrl(url: URL, env: NodeJS.ProcessEnv): GdriveStorage {
  if (url.username || url.password) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "gdrive:// URLs must not contain credentials.",
      {
        hint: `Put the token in ${GDRIVE_TOKEN_SECRET} instead.`,
      },
    );
  }
  for (const name of url.searchParams.keys()) {
    if (name !== "chunkSizeMiB") {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Unknown gdrive:// URL parameter "${name}".`,
        {
          hint: "Supported parameters: chunkSizeMiB.",
        },
      );
    }
  }
  const folder = decodeURIComponent(`${url.host}${url.pathname}`);
  const refreshToken = env[GDRIVE_TOKEN_SECRET]?.trim();
  if (!refreshToken) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Google Drive storage needs a token in ${GDRIVE_TOKEN_SECRET}.`,
      { hint: TOKEN_HINT },
    );
  }
  const { clientId, clientSecret } = gdriveClientCredentials(env);
  const chunkSizeMiB = url.searchParams.get("chunkSizeMiB");
  return gdriveStorage({
    folder,
    refreshToken,
    clientId,
    clientSecret,
    ...(chunkSizeMiB === null ? {} : { chunkSize: mebibytes(chunkSizeMiB) }),
  });
}

// ---------------------------------------------------------------------------
// Helpers (no adapter state)
// ---------------------------------------------------------------------------

/** What an upload produced: Drive's file resource and the bytes we sent. */
interface UploadResult {
  readonly file: DriveFile;
  readonly size: number;
}

/** One piece of the body to upload, and whether the body ends with it. */
interface SourceChunk {
  readonly data: Buffer;
  readonly final: boolean;
}

/**
 * Reads a body (stream or buffer) in chunks of an exact size. It pulls from the
 * stream only when a chunk is asked for, which is what keeps memory bounded and
 * lets backpressure reach the producer. To know whether a chunk is the last one it
 * reads one piece ahead.
 */
class ChunkSource {
  readonly #iterator: AsyncIterator<unknown> | undefined;
  #buffered: Buffer[] = [];
  #bufferedBytes = 0;
  #ended: boolean;

  constructor(body: Readable | Uint8Array) {
    if (body instanceof Readable) {
      this.#iterator = body[Symbol.asyncIterator]();
      this.#ended = false;
    } else {
      this.#iterator = undefined;
      this.#buffered = [Buffer.from(body.buffer, body.byteOffset, body.byteLength)];
      this.#bufferedBytes = body.byteLength;
      this.#ended = true;
    }
  }

  /** The next `size` bytes (fewer only for the last chunk). */
  async next(size: number, signal: AbortSignal | undefined): Promise<SourceChunk> {
    // One byte more than needed tells us whether anything follows this chunk.
    while (!this.#ended && this.#bufferedBytes <= size) {
      throwIfAborted(signal);
      const step = await this.#iterator?.next();
      throwIfAborted(signal);
      if (!step || step.done) {
        this.#ended = true;
        break;
      }
      const piece = toBuffer(step.value);
      this.#buffered.push(piece);
      this.#bufferedBytes += piece.length;
    }
    const all =
      this.#buffered.length === 1 ? (this.#buffered[0] as Buffer) : Buffer.concat(this.#buffered);
    const data = all.subarray(0, Math.min(size, all.length));
    const rest = all.subarray(data.length);
    this.#buffered = rest.length > 0 ? [rest] : [];
    this.#bufferedBytes = rest.length;
    return { data, final: this.#ended && rest.length === 0 };
  }
}

/** The folder option as path segments, validated like a storage key. */
function folderSegments(folder: string): string[] {
  const trimmed = (typeof folder === "string" ? folder : "").replace(/^\/+|\/+$/g, "");
  try {
    assertValidKey(trimmed);
  } catch (error) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid Google Drive folder "${String(folder)}".`,
      {
        cause: error,
        hint: 'Use a folder name such as gdrive://backups or gdrive://acme/prod, without ".." or empty segments.',
      },
    );
  }
  return trimmed.split("/");
}

function validChunkSize(chunkSize: number | undefined): number {
  if (chunkSize === undefined) return DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Google Drive chunkSize must be a positive multiple of 256 KiB (262144 bytes), got ${chunkSize}.`,
    );
  }
  return chunkSize;
}

/** `chunkSizeMiB` from a URL: a positive whole number of MiB (always a multiple of 256 KiB). */
function mebibytes(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `gdrive:// chunkSizeMiB must be a positive whole number, got "${value}".`,
    );
  }
  return number * 1024 * 1024;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Google Drive ${name} must be a positive integer, got ${value}.`,
    );
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Google Drive ${name} must be 0 or more, got ${value}.`,
    );
  }
  return value;
}

/** The token source: a fixed token, a callback, or a refresh token exchanged (and cached). */
function accessTokenSource(
  options: GdriveStorageOptions,
  doFetch: typeof fetch,
): { get(signal: AbortSignal | undefined): Promise<string>; invalidate(): void } {
  const given = options.accessToken;
  if (typeof given === "string") return { get: async () => given, invalidate() {} };
  if (typeof given === "function") {
    return { get: (signal) => given(signal ? { signal } : {}), invalidate() {} };
  }
  const { refreshToken, clientId } = options;
  if (!refreshToken || !clientId) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "Google Drive storage needs a refreshToken and a clientId (or an accessToken).",
      { hint: TOKEN_HINT },
    );
  }
  let current: Promise<GdriveAccessToken> | undefined;
  return {
    async get(signal) {
      if (current) {
        const token = await current.catch(() => undefined);
        if (token && token.expiresAt.getTime() - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
          return token.accessToken;
        }
      }
      current = exchangeGdriveRefreshToken({
        clientId,
        refreshToken,
        fetch: doFetch,
        ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
        ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
        ...(signal ? { signal } : {}),
      });
      const pending = current;
      // A failed exchange is not cached; the next call tries again.
      pending.catch(() => {
        if (current === pending) current = undefined;
      });
      return (await pending).accessToken;
    },
    invalidate() {
      current = undefined;
    },
  };
}

/**
 * Wraps a lookup so that its result is computed once and shared, unless it fails
 * (a failure is not remembered, so the next call tries again).
 */
function memoizeSuccess<T>(
  compute: (signal: AbortSignal | undefined) => Promise<T>,
): ((signal: AbortSignal | undefined) => Promise<T>) & { reset(): void } {
  let cached: Promise<T> | undefined;
  const memoized = (signal: AbortSignal | undefined) => {
    if (!cached) {
      const pending = compute(signal);
      cached = pending;
      pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
    }
    return cached;
  };
  return Object.assign(memoized, {
    reset() {
      cached = undefined;
    },
  });
}

/** Groups a folder listing into children: newest file per name, folders merged by name. */
function mergeChildren(entries: readonly DriveFile[]): Child[] {
  const files = new Map<string, DriveFile>();
  const folders = new Map<string, DriveFile[]>();
  for (const entry of entries) {
    if (entry.mimeType === FOLDER_MIME_TYPE) {
      const group = folders.get(entry.name) ?? [];
      group.push(entry);
      folders.set(entry.name, group);
      continue;
    }
    const known = files.get(entry.name);
    if (!known || newestFirst(entry, known) < 0) files.set(entry.name, entry);
  }
  const children: Child[] = [];
  for (const [name, file] of files) children.push({ kind: "file", name, file });
  for (const [name, group] of folders) {
    children.push({ kind: "folder", name, ids: sortFoldersOldestFirst(group).map((f) => f.id) });
  }
  // A folder's keys all start with "<name>/", so it sorts as that string.
  return children.sort((left, right) => compareBytes(sortKey(left), sortKey(right)));
}

function sortKey(child: Child): string {
  return child.kind === "folder" ? `${child.name}/` : child.name;
}

/** Newest first: later `createdTime`, then larger id, so every reader picks the same file. */
function newestFirst(left: DriveFile, right: DriveFile): number {
  const byTime = timeOf(right.createdTime) - timeOf(left.createdTime);
  if (byTime !== 0) return byTime;
  return compareBytes(right.id, left.id);
}

/** Oldest first, the order in which duplicate folders are preferred. */
function sortFoldersOldestFirst(folders: readonly DriveFile[]): DriveFile[] {
  return [...folders].sort((left, right) => newestFirst(right, left));
}

function timeOf(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

function isValidKey(key: string): boolean {
  try {
    assertValidKey(key);
    return true;
  } catch {
    return false;
  }
}

/** An `ObjectInfo` from a file resource. Drive sends sizes as int64 strings. */
function objectInfo(key: string, file: DriveFile, fallbackSize = 0): ObjectInfo {
  const size = file.size === undefined ? fallbackSize : Number(file.size);
  const modified = new Date(file.modifiedTime ?? file.createdTime ?? Date.now());
  return {
    key,
    size: Number.isFinite(size) ? size : fallbackSize,
    lastModified: Number.isNaN(modified.getTime()) ? new Date() : modified,
    ...(file.md5Checksum ? { etag: file.md5Checksum } : {}),
  };
}

/** The `files` array of a `files.list` answer. */
function filesOf(page: unknown): DriveFile[] {
  const files = propertyOf(page, "files");
  return Array.isArray(files) ? files.map(fileOf) : [];
}

/** Narrows one file resource from Drive's JSON. */
function fileOf(value: unknown): DriveFile {
  const id = stringOf(value, "id");
  if (!id) throw new MongoShieldError("MS_STORAGE_IO", "Google Drive sent a file without an id.");
  const optional = (name: string) => {
    const field = stringOf(value, name);
    return field === undefined ? {} : { [name]: field };
  };
  return {
    id,
    name: stringOf(value, "name") ?? "",
    mimeType: stringOf(value, "mimeType") ?? DEFAULT_CONTENT_TYPE,
    ...optional("size"),
    ...optional("createdTime"),
    ...optional("modifiedTime"),
    ...optional("md5Checksum"),
  };
}

/** The quota from an `about.get` answer, or `undefined` when Drive reports none. */
function quotaOf(about: unknown): StorageSpace | undefined {
  const quota = propertyOf(about, "storageQuota");
  if (quota === undefined) return undefined;
  const number = (name: string) => {
    const value = Number(stringOf(quota, name) ?? Number.NaN);
    return Number.isFinite(value) ? value : undefined;
  };
  // `limit` is absent for unlimited accounts; `usage` counts Gmail and Photos too,
  // because they share the 15 GB of a free account.
  const total = number("limit");
  const used = number("usage");
  const trash = number("usageInDriveTrash");
  return {
    ...(total === undefined ? {} : { total }),
    ...(used === undefined ? {} : { used }),
    ...(total !== undefined && used !== undefined ? { free: Math.max(0, total - used) } : {}),
    ...(trash === undefined ? {} : { trash }),
  };
}

function propertyOf(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[name];
}

function stringOf(value: unknown, name: string): string | undefined {
  const field = propertyOf(value, name);
  if (typeof field === "string") return field;
  return typeof field === "number" ? String(field) : undefined;
}

/** `Range: bytes=0-N` of a 308 answer → N + 1 bytes received; no header → none. */
function receivedBytes(range: string | null): number {
  const match = range ? /bytes=\d+-(\d+)/.exec(range) : null;
  return match ? Number(match[1]) + 1 : 0;
}

/** `Retry-After` in seconds or as an HTTP date, in milliseconds. */
function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Drive's error body: `{ error: { code, message, errors: [{ reason }] } }`. */
interface DriveErrorBody {
  readonly message: string | undefined;
  readonly reasons: readonly string[];
}

/** Reads (a copy of) an error response's body without consuming the original. */
async function errorBody(response: Response): Promise<DriveErrorBody> {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = propertyOf(parsed, "error");
  const errors = propertyOf(error, "errors");
  const reasons = Array.isArray(errors)
    ? errors.map((item) => stringOf(item, "reason")).filter((item): item is string => !!item)
    : [];
  return { message: stringOf(error, "message"), reasons };
}

/** 429, 5xx, and 403 with a rate-limit reason are worth retrying. */
async function isRetryable(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status >= 500) return true;
  if (response.status !== 403) return false;
  const { reasons } = await errorBody(response);
  return reasons.some((reason) => RATE_LIMIT_REASONS.has(reason));
}

/** Reads and drops a response body so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/** The error for a request that never got an answer. */
function networkError(error: unknown): MongoShieldError {
  return new MongoShieldError(
    "MS_STORAGE_IO",
    `Could not reach Google Drive: ${messageOf(error)}`,
    {
      cause: error,
      hint: "Check the network connection and try again.",
    },
  );
}

/**
 * Maps a failed Drive response: 404 → NOT_FOUND, 401/403 → FORBIDDEN (403
 * `storageQuotaExceeded` → INSUFFICIENT_SPACE), anything else → IO. Messages carry
 * Drive's own message, which never contains the token.
 */
async function driveError(
  response: Response,
  operation: Operation,
  target: string,
  signal: AbortSignal | undefined,
): Promise<MongoShieldError> {
  if (signal?.aborted) return abortError(signal);
  const { message, reasons } = await errorBody(response);
  await discard(response);
  const status = response.status;
  const text = `Could not ${operation === "space" ? "read the quota of" : operation} ${target}: ${message ?? `HTTP ${status}`}`;
  const base = { details: { httpStatus: status, ...(reasons.length > 0 ? { reasons } : {}) } };
  if (reasons.includes("storageQuotaExceeded")) {
    return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", text, {
      ...base,
      hint: "The Google account is out of storage (it is shared with Gmail and Photos). Free some space, empty the trash, or prune old backups.",
    });
  }
  if (status === 404) return new MongoShieldError("MS_STORAGE_NOT_FOUND", text, base);
  if (status === 401) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", text, { ...base, hint: TOKEN_HINT });
  }
  if (status === 403) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", text, {
      ...base,
      hint: reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))
        ? "Google's API quota is used up for now. Try again later, or use your own OAuth client (MONGOSHIELD_GDRIVE_CLIENT_ID) for a quota of your own."
        : `Check that the Drive API is enabled for the OAuth client and that the token is current. ${TOKEN_HINT}`,
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", text, base);
}

/** Wraps anything thrown inside an adapter call as a MongoShieldError. */
function asStorageError(
  error: unknown,
  operation: Operation,
  target: string,
  signal: AbortSignal | undefined,
): MongoShieldError {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;
  return new MongoShieldError(
    "MS_STORAGE_IO",
    `Could not ${operation} ${target}: ${messageOf(error)}`,
    {
      cause: error,
    },
  );
}

/** Cuts `range` (inclusive) out of a stream that starts at byte 0. */
function sliceStream(stream: Readable, range: { start: number; end?: number }): Readable {
  async function* slice() {
    let position = 0;
    const end = range.end === undefined ? Number.POSITIVE_INFINITY : range.end + 1;
    for await (const piece of stream) {
      const buffer = toBuffer(piece);
      const from = Math.max(range.start - position, 0);
      const to = Math.min(buffer.length, end - position);
      if (to > from) yield buffer.subarray(from, to);
      position += buffer.length;
      if (position >= end) break;
    }
  }
  return Readable.from(slice());
}
