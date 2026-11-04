/**
 * A minimal in-process fake of the Dropbox API v2 and its OAuth endpoints, enough
 * for the `dropbox://` adapter and `loginDropbox` to run their full test suites
 * (including the storage conformance suite) without a real account:
 *
 *   const server = await startFakeDropboxServer();
 *   const storage = dropboxStorage({
 *     folder: "backups",
 *     refreshToken: server.issueRefreshToken(),
 *     clientId: server.clientId,
 *     endpoints: server.endpoints,
 *   });
 *   …
 *   await server.close();
 *
 * What it models, following Dropbox's documentation:
 * - RPC endpoints (JSON bodies) and content endpoints (`Dropbox-API-Arg` header,
 *   which must be pure ASCII: non-ASCII characters must arrive `\uXXXX`-escaped).
 * - Case-insensitive paths that keep the case they were created with; real folders
 *   that are created by uploads and stay behind when their files are deleted.
 * - `files/upload` and upload sessions (`start`, `append_v2`, `finish`) with offsets,
 *   content hashes per request, `mode: add|overwrite` and `strict_conflict`.
 * - `files/download` with HTTP ranges and `Dropbox-API-Result`, `get_metadata`,
 *   recursive `list_folder` with cursor paging (in no particular order),
 *   `delete_batch` with optional async jobs, `users/get_space_usage` and quotas.
 * - Access tokens that expire, refresh tokens, and the PKCE authorization code flow
 *   (`GET /oauth2/authorize` approves immediately, as if the user chose Allow).
 * - Injected faults: canned error answers (429 with Retry-After, 5xx, …), answers
 *   that are lost after the operation happened, and requests that never answer.
 *
 * It is not a general emulator: no revisions, sharing, search or team spaces.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Dropbox's hash block size (4 MiB). */
const BLOCK = 4 * 1024 * 1024;

interface StoredFile {
  readonly path: string;
  readonly name: string;
  readonly data: Buffer;
  readonly rev: string;
  readonly id: string;
  readonly serverModified: string;
}

interface StoredFolder {
  readonly path: string;
  readonly name: string;
  readonly id: string;
}

interface UploadSession {
  readonly chunks: Buffer[];
  received: number;
}

/** A canned answer for the next request(s) to an endpoint. */
export interface FakeDropboxFault {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Carry out the request first, then send this answer instead (a lost response). */
  readonly afterHandling?: boolean;
}

/** One request the fake received, for assertions. */
export interface RecordedDropboxRequest {
  /** Path after the host, e.g. `/2/files/upload` or `/oauth2/token`. */
  readonly endpoint: string;
  /** Parsed `Dropbox-API-Arg` (content endpoints) or JSON body (RPC endpoints). */
  readonly arg: unknown;
  /** The raw `Dropbox-API-Arg` header, to check its escaping. */
  readonly rawArg: string | undefined;
  readonly bodyBytes: number;
  readonly headers: IncomingMessage["headers"];
}

/** Options for {@link startFakeDropboxServer}. */
export interface FakeDropboxOptions {
  /** The app key the fake accepts. Default `"fake-app-key"`. */
  readonly clientId?: string;
  /** Entries per `list_folder` page (Dropbox's own limit is about 2000). Default 2000. */
  readonly pageSize?: number;
  /** Account quota in bytes. Default 2 GB (the free plan). */
  readonly allocated?: number;
  /** Lifetime of issued access tokens in seconds. Default 14400 (4 hours, like Dropbox). */
  readonly accessTokenSeconds?: number;
  /**
   * Mimic Dropbox's documented quirk that `path_display` may be correctly cased only
   * in its last component: parents are reported lower-cased.
   */
  readonly lowercaseParentsInDisplay?: boolean;
  /** Make `delete_batch` asynchronous; `delete_batch/check` says in_progress this many times. */
  readonly asyncDeletePolls?: number;
  /** Answer `files/download` with the whole file (200) even when a Range is sent. */
  readonly ignoreRange?: boolean;
  /** Replace the `allocation` of `get_space_usage`, e.g. to model a team account. */
  readonly spaceAllocation?: Record<string, unknown>;
}

/** A running fake. */
export interface FakeDropboxServer {
  /** Base URL, e.g. `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Ready for `dropboxStorage({ endpoints })`. */
  readonly endpoints: { readonly api: string; readonly content: string; readonly token: string };
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Every request so far (OAuth and API), oldest first. */
  readonly requests: RecordedDropboxRequest[];
  /** A refresh token the token endpoint accepts, as if a login had happened. */
  issueRefreshToken(): string;
  /** Revokes a refresh token (and stops it from issuing access tokens). */
  revokeRefreshToken(token: string): void;
  /** Marks every access token issued so far as expired. */
  expireAccessTokens(): void;
  /** The next `times` requests to `endpoint` (e.g. `files/upload`) get `fault`. */
  fail(endpoint: string, fault: FakeDropboxFault, times?: number): void;
  /** The next `times` requests to `endpoint` never get an answer. */
  stall(endpoint: string, times?: number): void;
  /** The next `times` deletes of `path` in a batch fail with `too_many_write_operations`. */
  lockPathForDeletes(path: string, times?: number): void;
  /** Makes the authorize page deny access, as if the user chose Cancel. */
  denyAuthorization(): void;
  /** Display paths of every stored file, sorted. */
  filePaths(): string[];
  /** Display paths of every folder (including empty ones), sorted. */
  folderPaths(): string[];
  /** A stored file's bytes, by path (any case), or undefined. */
  fileData(path: string): Buffer | undefined;
  /** Bytes used by stored files. */
  used(): number;
  close(): Promise<void>;
}

/** The Dropbox content hash: SHA-256 over the SHA-256 of each 4 MiB block. */
export function dropboxContentHash(data: Buffer): string {
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += BLOCK) {
    blocks.push(
      createHash("sha256")
        .update(data.subarray(offset, offset + BLOCK))
        .digest(),
    );
  }
  return createHash("sha256").update(Buffer.concat(blocks)).digest("hex");
}

/** Starts the fake on a random port on 127.0.0.1. */
export async function startFakeDropboxServer(
  options: FakeDropboxOptions = {},
): Promise<FakeDropboxServer> {
  const clientId = options.clientId ?? "fake-app-key";
  const pageSize = options.pageSize ?? 2000;
  const allocated = options.allocated ?? 2 * 1000 ** 3;
  const accessTokenSeconds = options.accessTokenSeconds ?? 14_400;
  const files = new Map<string, StoredFile>();
  const folders = new Map<string, StoredFolder>();
  const sessions = new Map<string, UploadSession>();
  const cursors = new Map<string, { entries: unknown[]; offset: number }>();
  const deleteJobs = new Map<string, { polls: number; result: unknown }>();
  const accessTokens = new Map<string, { expired: boolean }>();
  const refreshTokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirectUri: string | undefined }>();
  const faults = new Map<string, FakeDropboxFault[]>();
  const stalls = new Map<string, number>();
  const deleteLocks = new Map<string, number>();
  const requests: RecordedDropboxRequest[] = [];
  let denyNext = false;
  let revision = 0;

  // ---- paths ---------------------------------------------------------------

  function lower(path: string): string {
    return path.toLowerCase();
  }

  function parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
  }

  function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  /** A path Dropbox accepts: `/a/b`, no trailing slash or whitespace, no empty segments. */
  function isValidPath(path: unknown): path is string {
    return (
      typeof path === "string" &&
      path.startsWith("/") &&
      !path.endsWith("/") &&
      !/\s$/.test(path) &&
      !path.slice(1).split("/").includes("")
    );
  }

  /** Display path as reported, optionally with the "only the last part is cased" quirk. */
  function displayOf(path: string): string {
    if (!options.lowercaseParentsInDisplay) return path;
    return `${lower(parentOf(path))}/${nameOf(path)}`;
  }

  function fileMetadata(file: StoredFile): Record<string, unknown> {
    return {
      ".tag": "file",
      name: file.name,
      id: file.id,
      path_lower: lower(file.path),
      path_display: displayOf(file.path),
      client_modified: file.serverModified,
      server_modified: file.serverModified,
      rev: file.rev,
      size: file.data.length,
      is_downloadable: true,
      content_hash: dropboxContentHash(file.data),
    };
  }

  function folderMetadata(folder: StoredFolder): Record<string, unknown> {
    return {
      ".tag": "folder",
      name: folder.name,
      id: folder.id,
      path_lower: lower(folder.path),
      path_display: displayOf(folder.path),
    };
  }

  function used(): number {
    let total = 0;
    for (const file of files.values()) total += file.data.length;
    return total;
  }

  // ---- writes --------------------------------------------------------------

  /** A Dropbox 409 answer with the given error_summary and error union. */
  function conflict(summary: string, error: unknown): Answer {
    return { status: 409, body: { error_summary: `${summary}..`, error } };
  }

  /**
   * Commits `data` at `path` the way Dropbox does. `wrap` builds the endpoint's error
   * union around a `WriteError` (`UploadError` keeps it in `reason`, finish in `path`).
   */
  function commit(
    commitInfo: Record<string, unknown>,
    data: Buffer,
    wrap: (writeError: unknown) => unknown,
  ): Answer {
    const path = commitInfo.path;
    const writeError = (summary: string, error: unknown) =>
      conflict(`path/${summary}/`, wrap(error));
    if (!isValidPath(path)) {
      return writeError("malformed_path", { ".tag": "malformed_path" });
    }
    const mode = commitInfo.mode ?? "add";
    const tag = typeof mode === "string" ? mode : (mode as { ".tag"?: string })[".tag"];
    if (folders.has(lower(path))) {
      return writeError("conflict/folder", { ".tag": "conflict", conflict: { ".tag": "folder" } });
    }
    for (let parent = parentOf(path); parent !== ""; parent = parentOf(parent)) {
      if (files.has(lower(parent))) {
        return writeError("conflict/file_ancestor", {
          ".tag": "conflict",
          conflict: { ".tag": "file_ancestor" },
        });
      }
    }
    const existing = files.get(lower(path));
    if (existing && tag === "add") {
      const identical = existing.data.equals(data);
      if (commitInfo.strict_conflict === true || !identical) {
        return writeError("conflict/file", { ".tag": "conflict", conflict: { ".tag": "file" } });
      }
      return { status: 200, body: fileMetadata(existing) };
    }
    if (tag !== "add" && tag !== "overwrite") {
      return { status: 400, text: `fake: unsupported write mode ${JSON.stringify(mode)}` };
    }
    if (used() - (existing?.data.length ?? 0) + data.length > allocated) {
      return writeError("insufficient_space", { ".tag": "insufficient_space" });
    }
    createParents(path);
    revision++;
    const file: StoredFile = {
      // An overwrite keeps the existing name's case, like Dropbox.
      path: existing?.path ?? path,
      name: existing?.name ?? nameOf(path),
      data,
      rev: `${revision.toString(16).padStart(9, "0")}`,
      id: existing?.id ?? `id:${randomUUID()}`,
      serverModified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    };
    files.set(lower(path), file);
    return { status: 200, body: fileMetadata(file) };
  }

  /** Creates the missing parent folders of `path`, keeping the case of existing ones. */
  function createParents(path: string): void {
    const segments = path.split("/").slice(1, -1);
    let display = "";
    for (const segment of segments) {
      const candidate = `${display}/${segment}`;
      const existing = folders.get(lower(candidate));
      if (existing) {
        display = existing.path;
      } else {
        display = candidate;
        folders.set(lower(candidate), { path: candidate, name: segment, id: `id:${randomUUID()}` });
      }
    }
  }

  /** Refuses a request whose data does not match its `content_hash` argument. */
  function hashMismatch(arg: Record<string, unknown>, data: Buffer): Answer | undefined {
    const expected = arg.content_hash;
    if (typeof expected !== "string" || expected === dropboxContentHash(data)) return undefined;
    return conflict("content_hash_mismatch/", { ".tag": "content_hash_mismatch" });
  }

  // ---- endpoints -----------------------------------------------------------

  /** What a handler answers: a JSON `body`, plain `text`, or file bytes in `stream`. */
  interface Answer {
    readonly status: number;
    readonly body?: unknown;
    readonly text?: string;
    readonly stream?: Buffer;
    readonly headers?: Record<string, string>;
  }

  function upload(arg: Record<string, unknown>, data: Buffer): Answer {
    return (
      hashMismatch(arg, data) ??
      commit(arg, data, (reason) => ({
        ".tag": "path",
        reason,
        upload_session_id: "unused",
      }))
    );
  }

  function sessionStart(arg: Record<string, unknown>, data: Buffer): Answer {
    const mismatch = hashMismatch(arg, data);
    if (mismatch) return mismatch;
    const sessionId = `session-${randomUUID()}`;
    sessions.set(sessionId, { chunks: [data], received: data.length });
    return { status: 200, body: { session_id: sessionId } };
  }

  /** Finds a session and checks the cursor offset; `wrap` adapts the error union. */
  function lookupSession(
    cursor: unknown,
    wrap: (summary: string, error: Record<string, unknown>) => Answer,
  ): UploadSession | Answer {
    const { session_id: sessionId, offset } = (cursor ?? {}) as Record<string, unknown>;
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!session) return wrap("not_found/", { ".tag": "not_found" });
    if (offset !== session.received) {
      return wrap("incorrect_offset/", {
        ".tag": "incorrect_offset",
        correct_offset: session.received,
      });
    }
    return session;
  }

  function sessionAppend(arg: Record<string, unknown>, data: Buffer): Answer {
    const session = lookupSession(arg.cursor, (summary, error) => conflict(summary, error));
    if (!("chunks" in session)) return session;
    const mismatch = hashMismatch(arg, data);
    if (mismatch) return mismatch;
    session.chunks.push(data);
    session.received += data.length;
    return { status: 200, body: null };
  }

  function sessionFinish(arg: Record<string, unknown>, data: Buffer): Answer {
    const session = lookupSession(arg.cursor, (summary, error) =>
      conflict(`lookup_failed/${summary}`, { ".tag": "lookup_failed", lookup_failed: error }),
    );
    if (!("chunks" in session)) return session;
    const mismatch = hashMismatch(arg, data);
    if (mismatch) return mismatch;
    const whole = Buffer.concat([...session.chunks, data]);
    const answer = commit(recordOf(arg.commit), whole, (writeError) => ({
      ".tag": "path",
      path: writeError,
    }));
    const { session_id: sessionId } = recordOf(arg.cursor);
    if (answer.status === 200 && typeof sessionId === "string") sessions.delete(sessionId);
    return answer;
  }

  function lookupError(): Answer {
    return conflict("path/not_found/", { ".tag": "path", path: { ".tag": "not_found" } });
  }

  function download(arg: Record<string, unknown>, rangeHeader: string | undefined): Answer {
    const path = arg.path;
    if (!isValidPath(path)) return lookupError();
    const file = files.get(lower(path));
    if (!file) {
      if (folders.has(lower(path))) {
        return conflict("path/not_file/", { ".tag": "path", path: { ".tag": "not_file" } });
      }
      return lookupError();
    }
    const headers = { "dropbox-api-result": asciiJson(fileMetadata(file)) };
    const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? "");
    if (!range || options.ignoreRange) return { status: 200, stream: file.data, headers };
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), file.data.length - 1) : file.data.length - 1;
    if (start >= file.data.length) return { status: 416, text: "range not satisfiable" };
    return {
      status: 206,
      stream: file.data.subarray(start, end + 1),
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${file.data.length}` },
    };
  }

  function getMetadata(arg: Record<string, unknown>): Answer {
    const path = arg.path;
    if (!isValidPath(path)) return lookupError();
    const file = files.get(lower(path));
    if (file) return { status: 200, body: fileMetadata(file) };
    const folder = folders.get(lower(path));
    if (folder) return { status: 200, body: folderMetadata(folder) };
    return lookupError();
  }

  function listFolder(arg: Record<string, unknown>): Answer {
    const path = arg.path;
    const listError = (tag: string) =>
      conflict(`path/${tag}/`, { ".tag": "path", path: { ".tag": tag } });
    if (path !== "" && !isValidPath(path)) return listError("malformed_path");
    if (typeof path !== "string") return listError("malformed_path");
    const root = lower(path);
    if (root !== "" && !folders.has(root))
      return listError(files.has(root) ? "not_folder" : "not_found");
    const recursive = arg.recursive === true;
    const inside = (entryPath: string) => {
      if (!lower(entryPath).startsWith(`${root}/`)) return false;
      return (
        recursive ||
        !lower(entryPath)
          .slice(root.length + 1)
          .includes("/")
      );
    };
    const entries: unknown[] = [];
    // Real Dropbox lists the folder itself first in a recursive listing of a non-root path.
    const self = folders.get(root);
    if (recursive && self) entries.push(folderMetadata(self));
    // No particular order, like Dropbox: newest first here, so nothing comes out sorted.
    for (const folder of [...folders.values()].reverse()) {
      if (inside(folder.path)) entries.push(folderMetadata(folder));
    }
    for (const file of [...files.values()].reverse()) {
      if (inside(file.path)) entries.push(fileMetadata(file));
    }
    const limit = typeof arg.limit === "number" ? Math.min(arg.limit, pageSize) : pageSize;
    return { status: 200, body: page(entries, 0, limit) };
  }

  function page(entries: unknown[], offset: number, limit: number): Record<string, unknown> {
    const cursor = `cursor-${randomUUID()}`;
    const next = offset + limit;
    cursors.set(cursor, { entries, offset: next });
    return { entries: entries.slice(offset, next), cursor, has_more: next < entries.length };
  }

  function listFolderContinue(arg: Record<string, unknown>): Answer {
    const state = typeof arg.cursor === "string" ? cursors.get(arg.cursor) : undefined;
    if (!state) return conflict("reset/", { ".tag": "reset" });
    return { status: 200, body: page(state.entries, state.offset, pageSize) };
  }

  /** Deletes one path (a file, or a folder with everything in it). */
  function deleteOne(path: unknown): unknown {
    if (!isValidPath(path)) {
      return {
        ".tag": "failure",
        failure: { ".tag": "path_lookup", path_lookup: { ".tag": "malformed_path" } },
      };
    }
    const key = lower(path);
    const locks = deleteLocks.get(key) ?? 0;
    if (locks > 0) {
      deleteLocks.set(key, locks - 1);
      return { ".tag": "failure", failure: { ".tag": "too_many_write_operations" } };
    }
    const file = files.get(key);
    if (file) {
      files.delete(key);
      return { ".tag": "success", metadata: fileMetadata(file) };
    }
    const folder = folders.get(key);
    if (folder) {
      for (const name of [...files.keys()]) if (name.startsWith(`${key}/`)) files.delete(name);
      for (const name of [...folders.keys()])
        if (name === key || name.startsWith(`${key}/`)) folders.delete(name);
      return { ".tag": "success", metadata: folderMetadata(folder) };
    }
    return {
      ".tag": "failure",
      failure: { ".tag": "path_lookup", path_lookup: { ".tag": "not_found" } },
    };
  }

  function deleteBatch(arg: Record<string, unknown>): Answer {
    const list = Array.isArray(arg.entries) ? arg.entries : [];
    if (list.length > 1000) return { status: 400, text: "fake: more than 1000 entries" };
    const result = {
      ".tag": "complete",
      entries: list.map((entry) => deleteOne(recordOf(entry).path)),
    };
    if (options.asyncDeletePolls === undefined) return { status: 200, body: result };
    const jobId = `job-${randomUUID()}`;
    deleteJobs.set(jobId, { polls: options.asyncDeletePolls, result });
    return { status: 200, body: { ".tag": "async_job_id", async_job_id: jobId } };
  }

  function deleteBatchCheck(arg: Record<string, unknown>): Answer {
    const job = typeof arg.async_job_id === "string" ? deleteJobs.get(arg.async_job_id) : undefined;
    if (!job) return conflict("invalid_async_job_id/", { ".tag": "invalid_async_job_id" });
    if (job.polls > 0) {
      job.polls--;
      return { status: 200, body: { ".tag": "in_progress" } };
    }
    return { status: 200, body: job.result };
  }

  function spaceUsage(): Answer {
    return {
      status: 200,
      body: {
        used: used(),
        allocation: options.spaceAllocation ?? { ".tag": "individual", allocated },
      },
    };
  }

  // ---- OAuth ---------------------------------------------------------------

  function issueAccessToken(): string {
    const token = `sl.fake-${randomBytes(12).toString("hex")}`;
    accessTokens.set(token, { expired: false });
    return token;
  }

  function issueRefreshToken(): string {
    const token = `refresh-${randomBytes(12).toString("hex")}`;
    refreshTokens.add(token);
    return token;
  }

  /** `GET /oauth2/authorize`: approves at once (or denies after `denyAuthorization`). */
  function authorize(url: URL): Answer {
    const query = url.searchParams;
    if (query.get("client_id") !== clientId) return { status: 400, text: "Invalid client_id" };
    if (query.get("response_type") !== "code") return { status: 400, text: "Bad response_type" };
    if (query.get("code_challenge_method") !== "S256") return { status: 400, text: "Use S256" };
    if (query.get("token_access_type") !== "offline") return { status: 400, text: "No offline" };
    const challenge = query.get("code_challenge") ?? "";
    if (challenge.length < 43) return { status: 400, text: "Bad code_challenge" };
    const redirectUri = query.get("redirect_uri") ?? undefined;
    const state = query.get("state");
    if (denyNext && redirectUri) {
      denyNext = false;
      const target = new URL(redirectUri);
      target.searchParams.set("error", "access_denied");
      if (state) target.searchParams.set("state", state);
      return { status: 302, text: "", headers: { location: target.toString() } };
    }
    const code = `code-${randomBytes(8).toString("hex")}`;
    codes.set(code, { challenge, redirectUri });
    if (!redirectUri) {
      // Dropbox shows the code on its own page for the user to copy.
      return { status: 200, body: { code }, headers: { "x-fake-code": code } };
    }
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return { status: 302, body: null, headers: { location: target.toString() } };
  }

  /** `POST /oauth2/token`: authorization_code (PKCE) and refresh_token grants. */
  function token(form: URLSearchParams): Answer {
    const invalid = (error: string) => ({
      status: 400,
      body: { error, error_description: `fake: ${error}` },
    });
    if (form.get("client_id") !== clientId) return invalid("invalid_client");
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      if (!pending) return invalid("invalid_grant");
      codes.delete(code);
      if ((form.get("redirect_uri") ?? undefined) !== pending.redirectUri)
        return invalid("invalid_grant");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== pending.challenge) return invalid("invalid_grant");
      return {
        status: 200,
        body: {
          access_token: issueAccessToken(),
          expires_in: accessTokenSeconds,
          token_type: "bearer",
          refresh_token: issueRefreshToken(),
          scope: "account_info.read files.content.read files.content.write files.metadata.read",
          account_id: "dbid:fake",
        },
      };
    }
    if (grant === "refresh_token") {
      if (!refreshTokens.has(form.get("refresh_token") ?? "")) return invalid("invalid_grant");
      return {
        status: 200,
        body: {
          access_token: issueAccessToken(),
          expires_in: accessTokenSeconds,
          token_type: "bearer",
        },
      };
    }
    return invalid("unsupported_grant_type");
  }

  /** Checks the bearer token; returns a 401 answer when it is missing, unknown or expired. */
  function unauthorized(request: IncomingMessage): Answer | undefined {
    const header = request.headers.authorization ?? "";
    const state = accessTokens.get(header.replace(/^Bearer /, ""));
    if (state && !state.expired) return undefined;
    const tag = state ? "expired_access_token" : "invalid_access_token";
    return { status: 401, body: { error_summary: `${tag}/..`, error: { ".tag": tag } } };
  }

  // ---- HTTP plumbing -------------------------------------------------------

  const handlers: Record<
    string,
    (arg: Record<string, unknown>, data: Buffer, range?: string) => Answer
  > = {
    "files/upload": upload,
    "files/upload_session/start": sessionStart,
    "files/upload_session/append_v2": sessionAppend,
    "files/upload_session/finish": sessionFinish,
    "files/download": (arg, _data, range) => download(arg, range),
    "files/get_metadata": getMetadata,
    "files/list_folder": listFolder,
    "files/list_folder/continue": listFolderContinue,
    "files/delete_batch": deleteBatch,
    "files/delete_batch/check": deleteBatchCheck,
    "users/get_space_usage": spaceUsage,
  };
  const contentEndpoints = new Set([
    "files/upload",
    "files/upload_session/start",
    "files/upload_session/append_v2",
    "files/upload_session/finish",
    "files/download",
  ]);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);
    if (request.method === "GET" && url.pathname === "/oauth2/authorize") {
      requests.push({
        endpoint: url.pathname,
        arg: Object.fromEntries(url.searchParams),
        rawArg: undefined,
        bodyBytes: 0,
        headers: request.headers,
      });
      send(response, authorize(url));
      return;
    }
    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(body.toString("utf8"));
      requests.push({
        endpoint: url.pathname,
        arg: Object.fromEntries(form),
        rawArg: undefined,
        bodyBytes: body.length,
        headers: request.headers,
      });
      send(response, token(form));
      return;
    }
    const endpoint = url.pathname.replace(/^\/2\//, "");
    const handler = handlers[endpoint];
    if (request.method !== "POST" || !handler) {
      send(response, { status: 404, text: "fake: unknown endpoint" });
      return;
    }
    const rawArg = request.headers["dropbox-api-arg"];
    const rawArgText = typeof rawArg === "string" ? rawArg : undefined;
    let arg: Record<string, unknown>;
    try {
      if (contentEndpoints.has(endpoint)) {
        if (rawArgText === undefined) throw new Error("missing Dropbox-API-Arg");
        // HTTP headers carry bytes; anything outside printable ASCII must have been escaped.
        if (/[^\x20-\x7e]/.test(rawArgText)) throw new Error("Dropbox-API-Arg must be ASCII");
        arg = recordOf(JSON.parse(rawArgText));
      } else {
        if (request.headers["content-type"] !== "application/json")
          throw new Error("bad content-type");
        arg = recordOf(JSON.parse(body.toString("utf8")));
      }
    } catch (error) {
      send(response, {
        status: 400,
        text: `Error in call to API function "${endpoint}": ${String(error)}`,
      });
      return;
    }
    requests.push({
      endpoint,
      arg,
      rawArg: rawArgText,
      bodyBytes: body.length,
      headers: request.headers,
    });
    const denied = unauthorized(request);
    if (denied) {
      send(response, denied);
      return;
    }
    const stalled = stalls.get(endpoint) ?? 0;
    if (stalled > 0) {
      stalls.set(endpoint, stalled - 1);
      return; // never answer; the client must time out
    }
    const fault = faults.get(endpoint)?.shift();
    if (fault && !fault.afterHandling) {
      send(response, faultAnswer(fault));
      return;
    }
    const range = typeof request.headers.range === "string" ? request.headers.range : undefined;
    const answer = handler(arg, body, range);
    send(response, fault ? faultAnswer(fault) : answer);
  }

  function faultAnswer(fault: FakeDropboxFault): Answer {
    return { status: fault.status, body: fault.body ?? null, headers: { ...fault.headers } };
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      send(response, { status: 500, text: `fake: ${String(error)}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    endpoints: { api: url, content: url, token: `${url}/oauth2/token` },
    authorizeUrl: `${url}/oauth2/authorize`,
    tokenUrl: `${url}/oauth2/token`,
    clientId,
    requests,
    issueRefreshToken,
    revokeRefreshToken: (value) => {
      refreshTokens.delete(value);
    },
    expireAccessTokens: () => {
      for (const state of accessTokens.values()) state.expired = true;
    },
    fail: (endpoint, fault, times = 1) => {
      const queue = faults.get(endpoint) ?? [];
      for (let index = 0; index < times; index++) queue.push(fault);
      faults.set(endpoint, queue);
    },
    stall: (endpoint, times = 1) => {
      stalls.set(endpoint, (stalls.get(endpoint) ?? 0) + times);
    },
    lockPathForDeletes: (path, times = 1) => {
      deleteLocks.set(lower(path), times);
    },
    denyAuthorization: () => {
      denyNext = true;
    },
    filePaths: () => [...files.values()].map((file) => file.path).sort(),
    folderPaths: () => [...folders.values()].map((folder) => folder.path).sort(),
    fileData: (path) => files.get(lower(path))?.data,
    used,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Writes an answer: JSON body, plain text, or file bytes. */
function send(
  response: ServerResponse,
  answer: {
    readonly status: number;
    readonly body?: unknown;
    readonly text?: string;
    readonly stream?: Buffer;
    readonly headers?: Record<string, string>;
  },
): void {
  if (response.headersSent) return;
  const headers = answer.headers ?? {};
  if (Buffer.isBuffer(answer.stream)) {
    response.writeHead(answer.status, { ...headers, "content-type": "application/octet-stream" });
    response.end(answer.stream);
    return;
  }
  if (typeof answer.text === "string") {
    response.writeHead(answer.status, { ...headers, "content-type": "text/plain; charset=utf-8" });
    response.end(answer.text);
    return;
  }
  response.writeHead(answer.status, { ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(answer.body ?? null));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** JSON with every non-ASCII character escaped, as Dropbox sends `Dropbox-API-Result`. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
