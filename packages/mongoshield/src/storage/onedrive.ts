/**
 * OneDrive storage adapter (entry point `mongoshield/storage/onedrive`, scheme
 * `onedrive://<folder>`), on Microsoft Graph with plain `fetch` and no SDK.
 *
 *   import { onedriveStorage } from "mongoshield/storage/onedrive";
 *   const storage = onedriveStorage({
 *     folder: "mongoshield-backups",
 *     token: process.env.MONGOSHIELD_ONEDRIVE_TOKEN ?? "",
 *     tokenStatePath: process.env.MONGOSHIELD_ONEDRIVE_TOKEN_STATE,
 *   });
 *
 * Everything lives inside the app's own folder (`Apps/<app name>/<folder>/` in the
 * user's OneDrive), which is all the `Files.ReadWrite.AppFolder` permission can reach.
 * Keys map to folders: `backups/<id>/app/users.bson` is the file `users.bson` in
 * `<folder>/backups/<id>/app/`. Items are addressed by path:
 * `/me/drive/special/approot:/<folder>/<key>:`.
 *
 * How the contract is met:
 * - Uploads: OneDrive needs an object's total size before an upload session starts,
 *   and a stream's size is unknown until it ends. So a stream is read into memory
 *   while it stays under 4 MiB and sent in one PUT; once it reaches 4 MiB it is
 *   written to a temp file instead (in `os.tmpdir()`, mode 0600, always removed
 *   afterwards), then sent through an upload session in fragments that are multiples
 *   of 320 KiB, read from the file one at a time (so memory stays at one fragment).
 *   Buffers of 4 MiB or more go straight to an upload session.
 * - Atomic writes: a single PUT replaces the file in one step; an upload session only
 *   creates (or replaces) the file when its last fragment arrives. A failed upload
 *   cancels its session, so nothing partial ever becomes visible.
 * - Conditional writes use `@microsoft.graph.conflictBehavior`: `fail` for
 *   `ifNoneMatch: "*"` (OneDrive refuses an existing name with 409 nameAlreadyExists,
 *   mapped to MS_STORAGE_PRECONDITION_FAILED), `replace` otherwise. The normal
 *   storage lock therefore works.
 * - Reads: `get` looks the file up and downloads from its pre-authenticated
 *   `@microsoft.graph.downloadUrl` (no bearer token is sent there), with a `Range`
 *   header for range reads. The byte count is checked against the file's size.
 * - Listing walks folders through `children` (following `@odata.nextLink` pages) and
 *   sorts the keys by their UTF-8 bytes, since OneDrive returns names in its own
 *   order. `listPrefixes` skips folders with no file anywhere below them.
 * - Deleting: only files are deleted (a key naming a folder is ignored, so a mistake
 *   can never remove a whole tree). Deleted files go to the OneDrive recycle bin,
 *   where they are kept up to 30 days and still count against the quota: the
 *   permanent delete API needs `Files.ReadWrite` (the whole drive), which the
 *   app-folder permission does not include. Folders left empty below the first level
 *   (`backups/<id>/…`) are removed afterwards, with `If-Match` on the folder's eTag so
 *   a folder that just gained a file is left alone.
 * - `space()` reads the drive quota (`/me/drive`: total, used, remaining, deleted).
 *   Graph documents that call for the `Files.Read` family, so with the app-folder
 *   permission alone it may be refused; then `space()` returns undefined.
 * - Retries: 429 and 5xx answers are retried with the `Retry-After` pause Graph asks
 *   for (exponential backoff when it names none), network errors too. A 401 refreshes
 *   the access token once.
 * - Sign-in: the secret is a refresh token (see onedrive-auth.ts); access tokens
 *   are refreshed as they expire, and each rotated refresh token is saved to the
 *   token state file when one is configured (see onedrive-token-state.ts, which also
 *   explains the day-75 warning reported by `warnings()`).
 *
 * Personal Microsoft accounts are supported. Work and school accounts are
 * experimental (`business: true`, `?business=true`): app folders on OneDrive for
 * Business are not consistently documented and have not been tested on a real tenant.
 *
 * Every HTTP call goes through the private `request()` below.
 */

import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { abortError, MongoShieldError, throwIfAborted } from "../errors.ts";
import {
  assertValidRange,
  compareBytes,
  destroyOnAbort,
  forEachWithConcurrency,
  messageOf,
  normalizePrefix,
  propertyOf,
  stringProperty,
  toBuffer,
  unquote,
} from "./adapter-utils.ts";
import { assertValidKey, assertValidPrefix } from "./keys.ts";
import {
  missingOneDriveClientError,
  ONEDRIVE_CLIENT_ENV,
  ONEDRIVE_SECRET_NAME,
  type OneDriveTenant,
  parseOneDriveSecret,
  SHIPPED_ONEDRIVE_CLIENT_ID,
} from "./onedrive-auth.ts";
import {
  createOneDriveTokenSource,
  ONEDRIVE_TOKEN_STATE_ENV,
  type OneDriveTokenSource,
} from "./onedrive-token-state.ts";
import { rejectRetention } from "./retention.ts";
import type {
  GetOptions,
  ObjectInfo,
  PutOptions,
  SignalOptions,
  StorageAdapter,
  StorageCapabilities,
} from "./types.ts";

/** Options for {@link onedriveStorage}. */
export interface OneDriveStorageOptions {
  /**
   * Folder inside the app folder that holds the backups, e.g. `"mongoshield-backups"`
   * or `"prod/app"`. Required.
   */
  readonly folder: string;
  /**
   * The sign-in: the value of `MONGOSHIELD_ONEDRIVE_TOKEN` printed by
   * `mongoshield login onedrive` (an `onedrive1.` envelope), or a bare refresh token.
   */
  readonly token: string;
  /**
   * File that keeps the newest (rotated) refresh token between runs, encrypted with a
   * key derived from `token`. Without it the sign-in stops working 90 days after
   * `token` was issued. The GitHub Action sets this up through the Actions cache.
   * Usually `MONGOSHIELD_ONEDRIVE_TOKEN_STATE`.
   */
  readonly tokenStatePath?: string;
  /**
   * Client id of the Microsoft app the token was issued to. Defaults to the one
   * recorded in the token, then MongoShield's own app.
   */
  readonly clientId?: string;
  /** Client secret, for confidential app registrations only (device login needs none). */
  readonly clientSecret?: string;
  /**
   * Allow a work or school (Entra ID) sign-in, refreshed through `/common` instead of
   * `/consumers`. Experimental; see docs/guides/onedrive.md.
   */
  readonly business?: boolean;
  /**
   * Upload session fragment size in bytes: a multiple of 320 KiB (327,680 bytes), at
   * most 60 MiB. Defaults to 10 MiB (32 × 320 KiB), Microsoft's recommendation.
   * Memory use per upload is one fragment.
   */
  readonly fragmentSize?: number;
  /** Where objects of 4 MiB or more are staged before upload. Defaults to `os.tmpdir()`. */
  readonly tempDirectory?: string;
  /** The fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Microsoft Graph base URL. Defaults to `https://graph.microsoft.com/v1.0`. Access
   * tokens are sent here, so only change it for tests (a local fake).
   */
  readonly graphUrl?: string;
  /** Sign-in base URL. Defaults to `https://login.microsoftonline.com`; for tests. */
  readonly authorityUrl?: string;
  /** The current time (token expiry and the day-75 warning). For tests. */
  readonly now?: () => Date;
}

/** Drive space in bytes, as `space()` reports it. */
export interface OneDriveSpace {
  readonly total?: number;
  readonly used?: number;
  readonly free?: number;
  /** Bytes in the recycle bin, which count against the quota. */
  readonly trash?: number;
}

/** The OneDrive adapter: a StorageAdapter plus `space()` and `warnings()`. */
export interface OneDriveStorage extends StorageAdapter {
  /** The drive's quota, or undefined when Graph does not report it to this app. */
  space(options?: SignalOptions): Promise<OneDriveSpace | undefined>;
  /** Problems worth fixing that did not fail anything (the day-75 sign-in warning). */
  warnings(): readonly string[];
}

/** Objects under this size are uploaded in one PUT from memory. */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload session fragments must be multiples of 320 KiB. */
export const FRAGMENT_GRANULARITY = 320 * 1024;
/** Graph refuses requests above 60 MiB. */
const MAX_FRAGMENT_SIZE = 60 * 1024 * 1024;
/** 10 MiB = 32 × 320 KiB: the size Microsoft recommends for stable connections. */
const DEFAULT_FRAGMENT_SIZE = 32 * FRAGMENT_GRANULARITY;

const DEFAULT_GRAPH_URL = "https://graph.microsoft.com/v1.0";

/** Deletes in flight at once. Graph throttles per user, so this stays modest. */
const DELETE_CONCURRENCY = 4;
/** Attempts per request for retryable failures (429, 5xx, network). */
const MAX_ATTEMPTS = 6;
/** Retryable answers. 507 (quota) is not: retrying cannot make room. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Longest Retry-After pause honoured, and the backoff ceiling. */
const MAX_RETRY_DELAY_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;
/** Time allowed until an answer (and its JSON body) arrives. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Fragments are up to 60 MiB, so they get longer. */
const FRAGMENT_TIMEOUT_MS = 10 * 60_000;
/** The item properties listing needs, to keep pages small. */
const CHILD_FIELDS = "id,name,size,lastModifiedDateTime,eTag,file,folder";

const CAPABILITIES: StorageCapabilities = {
  conditionalWrites: true,
  rangeReads: true,
  objectLock: false,
};

/** What an adapter call was doing, for error messages ("Could not read …"). */
type Operation = "read" | "write" | "stat" | "list" | "delete";

// Graph's JSON shapes, as far as this adapter reads them.
const driveItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().optional(),
  lastModifiedDateTime: z.string().optional(),
  eTag: z.string().optional(),
  file: z.object({}).optional(),
  folder: z.object({ childCount: z.number().optional() }).optional(),
  "@microsoft.graph.downloadUrl": z.string().optional(),
});
type DriveItem = z.infer<typeof driveItemSchema>;
const childrenPageSchema = z.object({
  value: z.array(driveItemSchema),
  "@odata.nextLink": z.string().optional(),
});
const uploadSessionSchema = z.object({
  uploadUrl: z.string(),
  nextExpectedRanges: z.array(z.string()).optional(),
});
const uploadStatusSchema = z.object({ nextExpectedRanges: z.array(z.string()).optional() });
const driveSchema = z.object({
  quota: z
    .object({
      total: z.number().optional(),
      used: z.number().optional(),
      remaining: z.number().optional(),
      deleted: z.number().optional(),
    })
    .optional(),
});

/** A failed Graph answer, before it is mapped to a MongoShieldError. */
class GraphError extends Error {
  constructor(
    /** HTTP status, or 0 for a network error or timeout. */
    readonly status: number,
    /** Graph's `error.code` (`itemNotFound`, …), or "" when there was none. */
    readonly graphCode: string,
    message: string,
  ) {
    super(message);
  }
}

/** One HTTP request for {@link request}. */
interface RequestSpec {
  readonly method: "GET" | "PUT" | "POST" | "DELETE";
  readonly url: string;
  /** Send the bearer token (Graph). Off for pre-authenticated upload and download URLs. */
  readonly auth: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  /** Return the response with its body unread (downloads). */
  readonly stream?: boolean;
}

/** What {@link request} returns: the response, and its parsed JSON unless streamed. */
interface RequestResult {
  readonly response: Response;
  readonly json: unknown;
}

/** A source of upload bytes that can be read at any offset (a buffer or a temp file). */
interface FragmentSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/** Creates a storage adapter in the app folder of a OneDrive. */
export function onedriveStorage(options: OneDriveStorageOptions): OneDriveStorage {
  const basePrefix = normalizePrefix(options.folder, "OneDrive folder");
  if (basePrefix === "") {
    throw new MongoShieldError("MS_CONFIG_INVALID", "A OneDrive folder is required.", {
      hint: 'Name a folder inside the app folder, e.g. onedrive://mongoshield-backups or { folder: "mongoshield-backups" }.',
    });
  }
  const folderSegments = basePrefix.slice(0, -1).split("/");
  const location = `onedrive://${basePrefix}`;
  const fragmentSize = validFragmentSize(options.fragmentSize);
  const graphUrl = (options.graphUrl ?? DEFAULT_GRAPH_URL).replace(/\/+$/, "");
  const tempDirectory = options.tempDirectory ?? tmpdir();
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const business = options.business === true;
  const tokens = tokenSourceFor(options, business, now);

  /** The Graph URL of an item by path, `…/approot:/<folder>/<relative>[:/<action>]`. */
  function pathUrl(relative: string, action?: string): string {
    const segments = [...folderSegments, ...relative.split("/").filter((part) => part !== "")];
    const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
    return `${graphUrl}/me/drive/special/approot:/${path}${action === undefined ? "" : `:/${action}`}`;
  }

  /** The Graph URL of an item's children by id. */
  function childrenUrl(id: string): string {
    return `${graphUrl}/me/drive/items/${encodeURIComponent(id)}/children?$select=${CHILD_FIELDS}`;
  }

  function fail(error: unknown, operation: Operation, key: string, signal?: AbortSignal) {
    return oneDriveError(error, operation, `${location}${key}`, signal);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * Sends one request, retrying 429/5xx (honouring Retry-After) and network errors,
   * and refreshing the access token once on 401. Returns 2xx answers; throws
   * GraphError for anything else.
   */
  async function request(spec: RequestSpec): Promise<RequestResult> {
    let forceRefresh = false;
    let refreshedAfter401 = false;
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(spec.signal);
      const headers: Record<string, string> = { ...spec.headers };
      if (spec.auth) {
        const signalOption = spec.signal === undefined ? {} : { signal: spec.signal };
        const accessToken = await tokens.accessToken({ ...signalOption, forceRefresh });
        headers.Authorization = `Bearer ${accessToken}`;
        forceRefresh = false;
      }
      // Our own timeout, cleared once the answer (and, unless streamed, its body) is in.
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), spec.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const signal = spec.signal ? AbortSignal.any([spec.signal, timer.signal]) : timer.signal;
      let response: Response;
      try {
        response = await fetchImpl(spec.url, {
          method: spec.method,
          headers,
          ...(spec.body === undefined ? {} : { body: spec.body }),
          signal,
          // Never follow a redirect with our bearer token. Pre-authenticated download
          // URLs may redirect; they carry no token of ours.
          redirect: spec.auth ? "error" : "follow",
        });
      } catch (error) {
        clearTimeout(timeout);
        if (spec.signal?.aborted) throw abortError(spec.signal);
        // A network error or our timeout. fetch's messages never include the URL.
        const problem = timer.signal.aborted ? "the request timed out" : messageOf(error);
        if (attempt < MAX_ATTEMPTS) {
          await pause(backoffMs(attempt), spec.signal);
          continue;
        }
        throw new GraphError(0, "", problem);
      }

      if (response.ok) {
        if (spec.stream === true) {
          clearTimeout(timeout);
          return { response, json: undefined };
        }
        try {
          const text = await response.text();
          return { response, json: text === "" ? undefined : parseJson(text) };
        } catch (error) {
          if (spec.signal?.aborted) throw abortError(spec.signal);
          throw new GraphError(0, "", messageOf(error));
        } finally {
          clearTimeout(timeout);
        }
      }

      const errorText = await response.text().catch(() => "");
      clearTimeout(timeout);
      if (response.status === 401 && spec.auth && !refreshedAfter401) {
        // The access token was refused (revoked or expired early): get a new one once.
        refreshedAfter401 = true;
        forceRefresh = true;
        continue;
      }
      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        const delay = retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt);
        await pause(delay, spec.signal);
        continue;
      }
      const graphError = propertyOf(parseJson(errorText), "error");
      throw new GraphError(
        response.status,
        stringProperty(graphError, "code") ?? "",
        stringProperty(graphError, "message") ?? `HTTP ${response.status}`,
      );
    }
  }

  /** GET a Graph URL and parse the JSON answer with `schema`. */
  async function getJson<T>(
    url: string,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const { json } = await request({ method: "GET", url, auth: true, signal });
    return parseWith(schema, json);
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /** The item at `key`, or undefined when there is none. */
  async function itemAt(
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<DriveItem | undefined> {
    try {
      return await getJson(pathUrl(key), driveItemSchema, signal);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** The file at `key`; a missing key, or a folder, is "not found". */
  async function fileAt(key: string, signal: AbortSignal | undefined): Promise<DriveItem> {
    const item = await itemAt(key, signal);
    if (item === undefined || item.file === undefined) {
      throw new GraphError(404, "itemNotFound", "The file does not exist.");
    }
    return item;
  }

  /**
   * Every child of a folder, following `@odata.nextLink`. `url` is the first page.
   * A missing folder has no children.
   */
  async function children(url: string, signal: AbortSignal | undefined): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    let next: string | undefined = url;
    while (next !== undefined) {
      let page: z.infer<typeof childrenPageSchema>;
      try {
        page = await getJson(next, childrenPageSchema, signal);
      } catch (error) {
        if (isNotFound(error) && items.length === 0) return [];
        throw error;
      }
      items.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return items;
  }

  /** Adds every file below folder `id` to `found`, keys starting with `keyPrefix`. */
  async function collectFiles(
    id: string,
    keyPrefix: string,
    found: ObjectInfo[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const child of await children(childrenUrl(id), signal)) {
      const key = validKeyOrUndefined(keyPrefix + child.name);
      if (key === undefined) continue;
      if (child.folder !== undefined) {
        if (child.folder.childCount !== 0) await collectFiles(child.id, `${key}/`, found, signal);
      } else if (child.file !== undefined) {
        found.push(itemInfo(key, child));
      }
    }
  }

  /** True when folder `id` has a file anywhere below it. */
  async function containsFile(id: string, signal: AbortSignal | undefined): Promise<boolean> {
    const items = await children(childrenUrl(id), signal);
    if (items.some((child) => child.file !== undefined)) return true;
    for (const child of items) {
      if (child.folder !== undefined && child.folder.childCount !== 0) {
        if (await containsFile(child.id, signal)) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  /** One PUT with the whole body (objects under 4 MiB). */
  async function simpleUpload(
    key: string,
    data: Buffer,
    conflict: "fail" | "replace",
    signal: AbortSignal | undefined,
  ): Promise<ObjectInfo> {
    const { json } = await request({
      method: "PUT",
      url: `${pathUrl(key, "content")}?@microsoft.graph.conflictBehavior=${conflict}`,
      auth: true,
      headers: { "Content-Type": "application/octet-stream" },
      body: data,
      signal,
    });
    return itemInfo(key, parseWith(driveItemSchema, json), data.length);
  }

  /**
   * An upload session: create it with the conflict behaviour (and, on personal
   * accounts, the size, so a full drive is refused before any byte is sent), then send
   * the fragments in order. The file appears when the last one arrives. A failed
   * upload cancels the session.
   */
  async function sessionUpload(
    key: string,
    source: FragmentSource,
    conflict: "fail" | "replace",
    signal: AbortSignal | undefined,
  ): Promise<ObjectInfo> {
    const { json } = await request({
      method: "POST",
      url: pathUrl(key, "createUploadSession"),
      auth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item: {
          "@microsoft.graph.conflictBehavior": conflict,
          // `fileSize` is only documented for OneDrive personal.
          ...(business ? {} : { fileSize: source.size }),
        },
      }),
      signal,
    });
    const { uploadUrl } = parseWith(uploadSessionSchema, json);
    let completed = false;
    try {
      let offset = 0;
      // Each round sends one fragment. Rounds that make no progress three times in a
      // row mean the two sides disagree, so the loop is bounded instead of trusting
      // the server's `nextExpectedRanges` forever.
      let stalled = 0;
      while (stalled < 3) {
        const length = Math.min(fragmentSize, source.size - offset);
        const fragment = await source.read(offset, length);
        let result: RequestResult;
        try {
          result = await request({
            method: "PUT",
            url: uploadUrl,
            // The upload URL is pre-authenticated; Graph may answer 401 to a bearer token.
            auth: false,
            headers: { "Content-Range": `bytes ${offset}-${offset + length - 1}/${source.size}` },
            body: fragment,
            signal,
            timeoutMs: FRAGMENT_TIMEOUT_MS,
          });
        } catch (error) {
          // 416: the server already has this range (a retried fragment that had in fact
          // arrived). Ask where it wants to continue.
          if (!(error instanceof GraphError) || error.status !== 416) throw error;
          const status = await request({ method: "GET", url: uploadUrl, auth: false, signal });
          const resumeAt = nextOffset(
            parseWith(uploadStatusSchema, status.json).nextExpectedRanges,
          );
          stalled = resumeAt === undefined || resumeAt <= offset ? stalled + 1 : 0;
          if (resumeAt !== undefined && resumeAt < source.size) offset = resumeAt;
          continue;
        }
        if (result.response.status === 200 || result.response.status === 201) {
          completed = true;
          return itemInfo(key, parseWith(driveItemSchema, result.json), source.size);
        }
        // 202 Accepted: more to send, from where the server says.
        const resumeAt =
          nextOffset(parseWith(uploadStatusSchema, result.json).nextExpectedRanges) ??
          offset + length;
        stalled = resumeAt <= offset || resumeAt >= source.size ? stalled + 1 : 0;
        if (resumeAt < source.size) offset = resumeAt;
      }
      throw new GraphError(0, "", "the upload session stopped making progress");
    } finally {
      if (!completed) await cancelSession(uploadUrl);
    }
  }

  /** Cancels an upload session (best effort; an abandoned one expires on its own). */
  async function cancelSession(uploadUrl: string): Promise<void> {
    try {
      await request({ method: "DELETE", url: uploadUrl, auth: false, timeoutMs: 30_000 });
    } catch {
      // Expired or already gone: either way nothing partial is visible.
    }
  }

  async function put(
    key: string,
    body: Readable | Uint8Array,
    putOptions: PutOptions = {},
  ): Promise<ObjectInfo> {
    assertValidKey(key);
    rejectRetention(putOptions, body, "onedrive", location);
    const { signal } = putOptions;
    const conflict = putOptions.ifNoneMatch === "*" ? "fail" : "replace";
    let staged: StagedBody | undefined;
    try {
      throwIfAborted(signal);
      if (body instanceof Uint8Array) {
        const data = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        if (data.length < SIMPLE_UPLOAD_LIMIT)
          return await simpleUpload(key, data, conflict, signal);
        return await sessionUpload(key, bufferSource(data), conflict, signal);
      }
      staged = await stage(body, tempDirectory, signal);
      if (staged.kind === "memory") return await simpleUpload(key, staged.data, conflict, signal);
      return await sessionUpload(key, staged.source, conflict, signal);
    } catch (error) {
      if (body instanceof Readable) body.destroy();
      throw fail(error, "write", key, signal);
    } finally {
      if (staged?.kind === "file") await staged.cleanup();
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async function get(key: string, getOptions: GetOptions = {}): Promise<Readable> {
    assertValidKey(key);
    const { signal, range } = getOptions;
    if (range) assertValidRange(range, key);
    try {
      throwIfAborted(signal);
      const item = await fileAt(key, signal);
      const size = item.size ?? 0;
      // Nothing to read: an empty file, or a range starting past the end (other
      // adapters return an empty stream there too).
      if (size === 0 || (range !== undefined && range.start >= size)) return Readable.from([]);
      const start = range?.start ?? 0;
      const end = Math.min(range?.end ?? size - 1, size - 1);
      const downloadUrl = item["@microsoft.graph.downloadUrl"];
      if (downloadUrl === undefined) {
        throw new GraphError(0, "", "Graph returned no download URL for the file.");
      }
      const { response } = await request({
        method: "GET",
        url: downloadUrl,
        auth: false,
        headers: range === undefined ? {} : { Range: `bytes=${start}-${end}` },
        signal,
        stream: true,
      });
      if (response.body === null) return Readable.from([]);
      const raw = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
      // A 200 to a ranged request means the Range header was ignored: skip to `start`.
      const skip = range !== undefined && response.status === 200 ? start : 0;
      const stream = Readable.from(exactBytes(raw, skip, end - start + 1, `${location}${key}`));
      destroyOnAbort(stream, signal);
      return stream;
    } catch (error) {
      throw fail(error, "read", key, signal);
    }
  }

  async function head(key: string, headOptions: SignalOptions = {}) {
    assertValidKey(key);
    const { signal } = headOptions;
    try {
      throwIfAborted(signal);
      const item = await itemAt(key, signal);
      // A folder is not an object ("directories" do not exist in the contract).
      return item === undefined || item.file === undefined ? undefined : itemInfo(key, item);
    } catch (error) {
      throw fail(error, "stat", key, signal);
    }
  }

  async function* list(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    const found: ObjectInfo[] = [];
    try {
      throwIfAborted(signal);
      // "backups/2026" → look in the folder "backups/" for names starting with "2026".
      const directory = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      const namePrefix = prefix.slice(directory.length);
      const firstPage = `${pathUrl(directory, "children")}?$select=${CHILD_FIELDS}`;
      for (const child of await children(firstPage, signal)) {
        if (!child.name.startsWith(namePrefix)) continue;
        const key = validKeyOrUndefined(directory + child.name);
        if (key === undefined) continue;
        if (child.folder !== undefined) {
          if (child.folder.childCount !== 0) await collectFiles(child.id, `${key}/`, found, signal);
        } else if (child.file !== undefined) {
          found.push(itemInfo(key, child));
        }
      }
    } catch (error) {
      throw fail(error, "list", prefix, signal);
    }
    // Folders are walked one level at a time, but "a-c" sorts before "a/b" by bytes,
    // so the order is only right once everything is collected.
    found.sort((left, right) => compareBytes(left.key, right.key));
    yield* found;
  }

  async function* listPrefixes(prefix: string, listOptions: SignalOptions = {}) {
    assertValidPrefix(prefix);
    const { signal } = listOptions;
    const prefixes: string[] = [];
    try {
      throwIfAborted(signal);
      const firstPage = `${pathUrl(prefix, "children")}?$select=${CHILD_FIELDS}`;
      for (const child of await children(firstPage, signal)) {
        if (child.folder === undefined || child.folder.childCount === 0) continue;
        const key = validKeyOrUndefined(prefix + child.name);
        if (key === undefined) continue;
        // A folder whose files were all deleted still exists on OneDrive; it is not a
        // "directory" in the storage contract, which only knows objects.
        if (await containsFile(child.id, signal)) prefixes.push(`${key}/`);
      }
    } catch (error) {
      throw fail(error, "list", prefix, signal);
    }
    prefixes.sort(compareBytes);
    yield* prefixes;
  }

  // -------------------------------------------------------------------------
  // Deletes
  // -------------------------------------------------------------------------

  async function deleteObjects(keys: readonly string[], deleteOptions: SignalOptions = {}) {
    const { signal } = deleteOptions;
    // Validate everything first so an invalid key cannot leave a half-done delete.
    for (const key of keys) assertValidKey(key);
    throwIfAborted(signal);
    const unique = [...new Set(keys)];
    if (unique.length === 0) return;
    await forEachWithConcurrency(unique, DELETE_CONCURRENCY, async (key) => {
      try {
        throwIfAborted(signal);
        // Look the item up first: deleting by path would remove a whole folder tree
        // if a key ever named a folder. Missing keys are ignored, as the contract says.
        const item = await itemAt(key, signal);
        if (item === undefined || item.file === undefined) return;
        await request({
          method: "DELETE",
          url: `${graphUrl}/me/drive/items/${encodeURIComponent(item.id)}`,
          auth: true,
          signal,
        });
      } catch (error) {
        if (isNotFound(error)) return;
        throw fail(error, "delete", key, signal);
      }
    });
    await removeEmptyFolders(unique, signal);
  }

  /**
   * Removes folders the delete left empty, deepest first, but never a first-level
   * folder (`backups/`, `locks/`): those are shared by concurrent runs, while deeper
   * ones (`backups/<id>/…`) belong to a single backup. `If-Match` on the folder's
   * eTag makes OneDrive refuse (412) if anything changed since it was looked at.
   * Best effort: a folder left behind is only skipped by listings.
   */
  async function removeEmptyFolders(keys: readonly string[], signal: AbortSignal | undefined) {
    const folders = new Set<string>();
    for (const key of keys) {
      const segments = key.split("/");
      for (let depth = segments.length - 1; depth >= 2; depth--) {
        folders.add(segments.slice(0, depth).join("/"));
      }
    }
    const deepestFirst = [...folders].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    );
    for (const folder of deepestFirst) {
      throwIfAborted(signal);
      try {
        const item = await itemAt(folder, signal);
        if (item?.folder === undefined || item.folder.childCount !== 0) continue;
        await request({
          method: "DELETE",
          url: `${graphUrl}/me/drive/items/${encodeURIComponent(item.id)}`,
          auth: true,
          headers: item.eTag === undefined ? {} : { "If-Match": item.eTag },
          signal,
        });
      } catch {
        if (signal?.aborted) throw abortError(signal);
        // Changed, gone or refused: leave it.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Space
  // -------------------------------------------------------------------------

  async function space(spaceOptions: SignalOptions = {}): Promise<OneDriveSpace | undefined> {
    const { signal } = spaceOptions;
    try {
      throwIfAborted(signal);
      const drive = await getJson(`${graphUrl}/me/drive?$select=quota`, driveSchema, signal);
      const quota = drive.quota;
      if (quota === undefined) return undefined;
      return {
        ...(quota.total === undefined ? {} : { total: quota.total }),
        ...(quota.used === undefined ? {} : { used: quota.used }),
        ...(quota.remaining === undefined ? {} : { free: quota.remaining }),
        ...(quota.deleted === undefined ? {} : { trash: quota.deleted }),
      };
    } catch (error) {
      // The app-folder permission may not cover the drive resource: not reported.
      if (error instanceof GraphError && [401, 403, 404].includes(error.status)) return undefined;
      throw fail(error, "stat", "", signal);
    }
  }

  return {
    kind: "onedrive",
    location,
    capabilities: CAPABILITIES,
    put,
    get,
    head,
    list,
    listPrefixes,
    delete: deleteObjects,
    space,
    warnings: () => tokens.warnings(),
    async close() {
      // fetch keeps no connections that need closing; nothing else is held.
    },
  };
}

/** URL query parameters accepted on `onedrive://` URLs. */
const URL_PARAMETERS = new Set(["business", "fragmentSizeMiB"]);

/**
 * Builds the adapter for `onedrive://<folder>[?business=true&fragmentSizeMiB=10]`,
 * reading the sign-in from `MONGOSHIELD_ONEDRIVE_TOKEN`, the token state file from
 * `MONGOSHIELD_ONEDRIVE_TOKEN_STATE`, and a custom app from
 * `MONGOSHIELD_ONEDRIVE_CLIENT_ID` / `_CLIENT_SECRET`.
 */
export function onedriveStorageFromUrl(url: URL, env: NodeJS.ProcessEnv): OneDriveStorage {
  if (url.protocol !== "onedrive:") {
    throw new MongoShieldError("MS_CONFIG_INVALID", `Not a onedrive:// URL: ${url.protocol}//…`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      "onedrive:// URLs cannot contain credentials.",
      {
        hint: `Put the sign-in in ${ONEDRIVE_SECRET_NAME} instead.`,
      },
    );
  }
  for (const name of url.searchParams.keys()) {
    if (!URL_PARAMETERS.has(name)) {
      throw new MongoShieldError(
        "MS_CONFIG_INVALID",
        `Unknown onedrive:// URL parameter "${name}".`,
        { hint: `Supported: ${[...URL_PARAMETERS].join(", ")}.` },
      );
    }
  }
  const folder = [url.host, ...url.pathname.split("/")]
    .filter((segment) => segment !== "")
    .map((segment) => decodeSegment(segment))
    .join("/");
  const token = env[ONEDRIVE_SECRET_NAME]?.trim() ?? "";
  if (token === "") {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `onedrive:// storage needs the ${ONEDRIVE_SECRET_NAME} environment variable.`,
      { hint: "Run `npx mongoshield login onedrive` and store what it prints in that secret." },
    );
  }
  const statePath = env[ONEDRIVE_TOKEN_STATE_ENV]?.trim() ?? "";
  const clientId = env[ONEDRIVE_CLIENT_ENV.clientId]?.trim() ?? "";
  const clientSecret = env[ONEDRIVE_CLIENT_ENV.clientSecret]?.trim() ?? "";
  const fragmentSizeMiB = url.searchParams.get("fragmentSizeMiB");
  return onedriveStorage({
    folder,
    token,
    ...(statePath === "" ? {} : { tokenStatePath: statePath }),
    ...(clientId === "" ? {} : { clientId }),
    ...(clientSecret === "" ? {} : { clientSecret }),
    ...(booleanParameter(url, "business") ? { business: true } : {}),
    ...(fragmentSizeMiB === null ? {} : { fragmentSize: mibParameter(fragmentSizeMiB) }),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parses the secret and builds the token source, checking the business opt-in. */
function tokenSourceFor(
  options: OneDriveStorageOptions,
  business: boolean,
  now: () => Date,
): OneDriveTokenSource {
  const credential = parseOneDriveSecret(options.token);
  if (credential.tenant === "common" && !business) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `${ONEDRIVE_SECRET_NAME} holds a work or school sign-in, which is experimental for OneDrive.`,
      {
        hint: "Opt in with ?business=true on the onedrive:// URL (or business: true), or sign in with a personal Microsoft account.",
      },
    );
  }
  const clientId = options.clientId ?? credential.clientId ?? SHIPPED_ONEDRIVE_CLIENT_ID;
  if (clientId === "") throw missingOneDriveClientError();
  const tenant: OneDriveTenant = business ? "common" : "consumers";
  return createOneDriveTokenSource({
    secret: options.token,
    credential,
    clientId,
    tenant,
    now,
    ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }),
    ...(options.tokenStatePath === undefined ? {} : { statePath: options.tokenStatePath }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.authorityUrl === undefined ? {} : { authorityUrl: options.authorityUrl }),
  });
}

/** A stream body after staging: in memory (under 4 MiB) or in a temp file. */
type StagedBody =
  | { readonly kind: "memory"; readonly data: Buffer }
  | {
      readonly kind: "file";
      readonly source: FragmentSource;
      readonly cleanup: () => Promise<void>;
    };

/**
 * Reads a stream body, keeping it in memory while it is under 4 MiB, and moving it
 * to a temp file (written chunk by chunk, so the source is paused while the disk
 * catches up) once it reaches that. The temp folder is removed by `cleanup`, or here
 * if staging fails.
 */
async function stage(
  body: Readable,
  tempDirectory: string,
  signal: AbortSignal | undefined,
): Promise<StagedBody> {
  const detach = destroyOnAbort(body, signal);
  const chunks: Buffer[] = [];
  let size = 0;
  let directory: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const cleanup = async () => {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  };
  try {
    for await (const piece of body) {
      const chunk = toBuffer(piece);
      if (handle === undefined) {
        chunks.push(chunk);
        size += chunk.length;
        if (size < SIMPLE_UPLOAD_LIMIT) continue;
        // 4 MiB reached: too big for one PUT, so the total size must be known first.
        directory = await mkdtemp(join(tempDirectory, "mongoshield-onedrive-"));
        handle = await open(join(directory, "upload.bin"), "wx+", 0o600);
        await writeAll(handle, Buffer.concat(chunks), 0);
        chunks.length = 0;
      } else {
        await writeAll(handle, chunk, size);
        size += chunk.length;
      }
    }
    throwIfAborted(signal);
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw abortError(signal);
    throw error;
  } finally {
    detach();
  }
  if (handle === undefined) return { kind: "memory", data: Buffer.concat(chunks) };
  const file = handle;
  const total = size;
  return {
    kind: "file",
    cleanup,
    source: { size: total, read: (offset, length) => readExactly(file, offset, length) },
  };
}

/** Writes all of `data` at `position` (a single write may be short). */
async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  data: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written);
    written += result.bytesWritten;
  }
}

/** Reads exactly `length` bytes at `offset` from the temp file. */
async function readExactly(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) throw new Error("The staged upload file is shorter than expected.");
    filled += bytesRead;
  }
  return buffer;
}

/** A fragment source over an in-memory buffer. */
function bufferSource(data: Buffer): FragmentSource {
  return {
    size: data.length,
    read: async (offset, length) => data.subarray(offset, offset + length),
  };
}

/**
 * Yields exactly `length` bytes of `source` after skipping `skip` bytes, and fails
 * with MS_INTEGRITY_FAILED if the download ends early (a cut connection).
 */
async function* exactBytes(
  source: Readable,
  skip: number,
  length: number,
  target: string,
): AsyncGenerator<Buffer> {
  let toSkip = skip;
  let remaining = length;
  for await (const piece of source) {
    let chunk = toBuffer(piece);
    if (toSkip > 0) {
      const skipped = Math.min(toSkip, chunk.length);
      chunk = chunk.subarray(skipped);
      toSkip -= skipped;
    }
    if (chunk.length === 0) continue;
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    remaining -= kept.length;
    yield kept;
    if (remaining === 0) break;
  }
  if (remaining > 0) {
    throw new MongoShieldError(
      "MS_INTEGRITY_FAILED",
      `The download of ${target} ended ${remaining} bytes early.`,
      { hint: "The connection was cut. Retry the operation." },
    );
  }
}

/** The start of the first range in `nextExpectedRanges` ("26-" or "26-99" → 26). */
function nextOffset(ranges: readonly string[] | undefined): number | undefined {
  const first = ranges?.[0];
  if (first === undefined) return undefined;
  const start = Number(first.split("-")[0]);
  return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
}

/** ObjectInfo from a drive item. `fallbackSize` covers answers without a size. */
function itemInfo(key: string, item: DriveItem, fallbackSize = 0): ObjectInfo {
  const modified = item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : new Date();
  const etag = unquote(item.eTag);
  return {
    key,
    size: item.size ?? fallbackSize,
    lastModified: Number.isNaN(modified.getTime()) ? new Date() : modified,
    ...(etag ? { etag } : {}),
  };
}

/** A name from a listing as a storage key, or undefined if it is not a valid one. */
function validKeyOrUndefined(key: string): string | undefined {
  try {
    assertValidKey(key);
    return key;
  } catch {
    return undefined;
  }
}

/** Parses a Graph JSON answer, turning a surprise into MS_STORAGE_IO (via GraphError). */
function parseWith<T>(schema: z.ZodType<T>, json: unknown): T {
  const result = schema.safeParse(json);
  if (!result.success) throw new GraphError(0, "", "Microsoft Graph sent an unexpected answer.");
  return result.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof GraphError && (error.status === 404 || error.graphCode === "itemNotFound")
  );
}

/** The pause Retry-After asks for (seconds or an HTTP date), capped; undefined if absent. */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY_MS);
}

/** Exponential backoff with jitter for retry `attempt` (1-based): ~1 s, 2 s, 4 s … 30 s. */
function backoffMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return base / 2 + Math.random() * (base / 2);
}

/** Waits, turning an abort into MS_ABORTED. */
async function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, signal ? { signal } : {});
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw error;
  }
}

function validFragmentSize(size: number | undefined): number {
  if (size === undefined) return DEFAULT_FRAGMENT_SIZE;
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size % FRAGMENT_GRANULARITY !== 0 ||
    size > MAX_FRAGMENT_SIZE
  ) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `OneDrive fragmentSize must be a multiple of 320 KiB (327680 bytes) up to 60 MiB, got ${size}.`,
      { hint: "With fragmentSizeMiB on a URL, use a multiple of 5 (5, 10, … 60)." },
    );
  }
  return size;
}

function booleanParameter(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === "false") return false;
  if (value === "true" || value === "") return true;
  throw new MongoShieldError(
    "MS_CONFIG_INVALID",
    `onedrive:// URL parameter ${name} must be true or false, got "${value}".`,
  );
}

function mibParameter(value: string): number {
  const mib = Number(value);
  if (!Number.isFinite(mib) || mib <= 0) {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `onedrive:// URL parameter fragmentSizeMiB must be a positive number, got "${value}".`,
    );
  }
  return Math.round(mib * 1024 * 1024);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new MongoShieldError(
      "MS_CONFIG_INVALID",
      `Invalid percent-encoding in onedrive:// URL: "${segment}".`,
    );
  }
}

/**
 * Maps a failure to a MongoShieldError: itemNotFound/404 → NOT_FOUND,
 * nameAlreadyExists/409 → PRECONDITION_FAILED, quotaLimitReached/507 →
 * INSUFFICIENT_SPACE, accessDenied/401/403 → FORBIDDEN, anything else → IO.
 * Messages name the storage location, never a URL (upload and download URLs carry
 * their own credentials).
 */
function oneDriveError(
  error: unknown,
  operation: Operation,
  target: string,
  signal: AbortSignal | undefined,
): MongoShieldError {
  if (signal?.aborted) return abortError(signal);
  if (error instanceof MongoShieldError) return error;
  if (!(error instanceof GraphError)) {
    return new MongoShieldError(
      "MS_STORAGE_IO",
      `Could not ${operation} ${target}: ${messageOf(error)}`,
      {
        cause: error,
      },
    );
  }
  const { status, graphCode } = error;
  const what = graphCode !== "" ? `${graphCode}: ${error.message}` : error.message;
  const message = `Could not ${operation} ${target}: ${what}`;
  const base = {
    cause: error,
    details: {
      ...(status === 0 ? {} : { httpStatus: status }),
      ...(graphCode === "" ? {} : { graphCode }),
    },
  };
  if (graphCode === "itemNotFound" || status === 404) {
    return new MongoShieldError("MS_STORAGE_NOT_FOUND", message, base);
  }
  if (graphCode === "nameAlreadyExists" || status === 409) {
    return new MongoShieldError("MS_STORAGE_PRECONDITION_FAILED", message, base);
  }
  if (graphCode === "quotaLimitReached" || status === 507) {
    return new MongoShieldError("MS_STORAGE_INSUFFICIENT_SPACE", message, {
      ...base,
      hint:
        "The OneDrive is full. Deleted backups stay in the OneDrive recycle bin for up to 30 days " +
        "and still count against the quota: empty it at onedrive.live.com, keep fewer backups, or add storage.",
    });
  }
  if (graphCode === "accessDenied" || status === 401 || status === 403) {
    return new MongoShieldError("MS_STORAGE_FORBIDDEN", message, {
      ...base,
      hint:
        "MongoShield may only use its own app folder (Files.ReadWrite.AppFolder). Sign in again with " +
        `\`npx mongoshield login onedrive\` and update ${ONEDRIVE_SECRET_NAME}.`,
    });
  }
  if (status === 429 || status === 503) {
    return new MongoShieldError("MS_STORAGE_IO", message, {
      ...base,
      hint: "Microsoft Graph kept throttling the requests. Try again later.",
    });
  }
  return new MongoShieldError("MS_STORAGE_IO", message, base);
}
