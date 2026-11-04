/**
 * An in-process fake of the Google Drive API v3 and Google's OAuth endpoints, just
 * enough for the `gdrive://` adapter (src/storage/gdrive.ts) and the device login
 * (src/storage/gdrive-auth.ts) to run against real HTTP without a Google account:
 *
 *   const server = await startFakeGdriveServer();
 *   const storage = gdriveStorage({ folder: "prod", ...server.adapterOptions() });
 *   …
 *   await server.close();
 *
 * What it models, because the adapter depends on it:
 * - Files and folders with ids, parents, `createdTime` (strictly increasing), and
 *   duplicate names (Drive never refuses one).
 * - `files.list` with the subset of the query language the adapter sends
 *   (`'id' in parents`, `name =`, `mimeType =` / `!=`, `trashed = false`,
 *   `appProperties has { key= and value= }`, `and`, `or`, parentheses), paged with a
 *   configurable page size and returned in no useful order (reverse creation order),
 *   so the adapter has to sort. An unknown query fails with 400, so a typo in the
 *   adapter's queries fails the tests instead of matching nothing.
 * - Multipart uploads, and resumable uploads with Drive's chunk rules: non-final
 *   chunks are only kept up to a multiple of 256 KiB (the rest is dropped and the
 *   308 `Range` answer says so), status queries (`bytes * /…`), and a file that
 *   appears only when the final chunk arrives.
 * - `alt=media` downloads with `Range` (206, and 416 past the end); permanent
 *   deletes that take a folder's descendants with them; `about.get` quotas, and a
 *   403 `storageQuotaExceeded` when an upload would not fit.
 * - Bearer tokens: every Drive call needs one the token endpoint issued.
 * - Injected faults (`failNext`): 403 `userRateLimitExceeded`, 429 with
 *   `Retry-After`, 5xx, or a chunk Drive only half keeps.
 *
 * It is not an emulator: no permissions, revisions, trash listing or export.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One stored file or folder. */
export interface FakeDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  readonly data: Buffer | undefined;
  readonly createdTime: string;
  readonly modifiedTime: string;
  readonly appProperties: Readonly<Record<string, string>>;
}

/** A fault to inject into the next matching request. */
export interface FakeDriveFault {
  /** Which requests it hits; default every Drive request (not the OAuth endpoints). */
  readonly match?: (request: FakeDriveRequest) => boolean;
  /** HTTP status to answer with, e.g. 403, 429, 503. */
  readonly status?: number;
  /** Drive error reason, e.g. `userRateLimitExceeded`. */
  readonly reason?: string;
  readonly retryAfter?: string;
  /** For upload chunks: keep only the first 256 KiB and answer 308, instead of failing. */
  readonly keepPartialChunk?: boolean;
  /** How many matching requests to hit (default 1). */
  readonly times?: number;
}

/** A device-login answer sequence for the fake token endpoint. */
export interface FakeDeviceLogin {
  /** How many polls answer `authorization_pending` before the outcome. */
  readonly pendingPolls?: number;
  /** Answer `slow_down` once, on the first poll. */
  readonly slowDownOnce?: boolean;
  /** `approve` (default) issues a refresh token; `deny` answers `access_denied`. */
  readonly outcome?: "approve" | "deny" | "expire";
}

/** A request the server saw (without its body). */
export interface FakeDriveRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingMessage["headers"];
}

/** A running fake. */
export interface FakeGdriveServer {
  /** Origin, e.g. `http://127.0.0.1:53211`; use as `apiUrl`. */
  readonly endpoint: string;
  /** The OAuth token endpoint URL. */
  readonly tokenUrl: string;
  /** The device-code endpoint URL. */
  readonly deviceCodeUrl: string;
  /** Client id and secret the token endpoint accepts. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** A refresh token the token endpoint accepts. */
  readonly refreshToken: string;
  /** Options to spread into `gdriveStorage(…)`: endpoints, credentials, fast retries. */
  adapterOptions(): {
    apiUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    retryBaseMs: number;
  };
  /** Every stored file and folder. */
  readonly files: Map<string, FakeDriveFile>;
  /** Requests seen so far, oldest first. */
  readonly requests: FakeDriveRequest[];
  /** Largest page `files.list` returns (default 1000, as Drive). */
  pageSizeLimit: number;
  /** Quota settings for `about.get` and uploads. `limit` undefined = unlimited. */
  quota: { limit: number | undefined; otherUsage: number; trash: number };
  /** Queues a fault for upcoming requests. */
  failNext(fault: FakeDriveFault): void;
  /** Makes every access token issued so far invalid (the next call gets a 401). */
  expireAccessTokens(): void;
  /** Revokes the refresh token (the token endpoint answers `invalid_grant`). */
  revokeRefreshToken(): void;
  /** How the next device login goes. */
  deviceLogin: FakeDeviceLogin;
  /** Adds a file directly (e.g. a duplicate another process wrote). */
  addFile(file: {
    name: string;
    parents: readonly string[];
    data?: Buffer;
    mimeType?: string;
    appProperties?: Record<string, string>;
  }): FakeDriveFile;
  /** Path of names from My Drive to a file, e.g. `MongoShield/prod/a/b.bin`. */
  pathOf(id: string): string;
  close(): Promise<void>;
}

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
/** Drive's resumable chunk granularity. */
const CHUNK_GRANULARITY = 256 * 1024;
/** The id `parents: ["root"]` resolves to. */
const ROOT_ID = "root-folder";

/** An upload session in progress. */
interface UploadSession {
  readonly metadata: Record<string, unknown>;
  readonly chunks: Buffer[];
  received: number;
  finished: FakeDriveFile | undefined;
}

/** A pending device login. */
interface DeviceState {
  polls: number;
  slowedDown: boolean;
}

/** Starts the fake on a random port on 127.0.0.1. */
export async function startFakeGdriveServer(): Promise<FakeGdriveServer> {
  const files = new Map<string, FakeDriveFile>();
  const sessions = new Map<string, UploadSession>();
  const devices = new Map<string, DeviceState>();
  const accessTokens = new Set<string>();
  const requests: FakeDriveRequest[] = [];
  const faults: { fault: FakeDriveFault; remaining: number }[] = [];
  const clientId = "fake-client-id.apps.googleusercontent.com";
  const clientSecret = "fake-client-secret";
  let refreshToken = `1//fake-refresh-${randomBytes(6).toString("hex")}`;
  let clock = Date.parse("2026-11-05T00:00:00.000Z");
  let nextId = 1;
  let endpoint = "";

  /** Strictly increasing timestamps, so "newest" is never a tie. */
  function now(): string {
    clock += 1000;
    return new Date(clock).toISOString();
  }

  function newId(): string {
    return `f${String(nextId++).padStart(6, "0")}${randomBytes(3).toString("hex")}`;
  }

  function storeFile(file: Omit<FakeDriveFile, "id" | "createdTime" | "modifiedTime">) {
    const time = now();
    const stored: FakeDriveFile = { ...file, id: newId(), createdTime: time, modifiedTime: time };
    files.set(stored.id, stored);
    return stored;
  }

  function resource(file: FakeDriveFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: file.parents,
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      ...(file.data === undefined
        ? {}
        : {
            size: String(file.data.length),
            md5Checksum: createHash("md5").update(file.data).digest("hex"),
          }),
    };
  }

  function usedBytes(): number {
    let total = server.quota.otherUsage;
    for (const file of files.values()) total += file.data?.length ?? 0;
    return total;
  }

  function server_takeFault(request: FakeDriveRequest): FakeDriveFault | undefined {
    const index = faults.findIndex(({ fault }) => (fault.match ? fault.match(request) : true));
    if (index < 0) return undefined;
    const entry = faults[index];
    if (!entry) return undefined;
    entry.remaining--;
    if (entry.remaining <= 0) faults.splice(index, 1);
    return entry.fault;
  }

  const http = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      sendError(response, 500, String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", endpoint);
    const method = request.method ?? "GET";
    const seen: FakeDriveRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: request.headers,
    };
    requests.push(seen);
    const body = await readBody(request);

    if (url.pathname === "/token")
      return tokenEndpoint(response, new URLSearchParams(body.toString()));
    if (url.pathname === "/device/code") {
      return deviceCodeEndpoint(response, new URLSearchParams(body.toString()));
    }

    const auth = request.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !accessTokens.has(auth.slice(7))) {
      return sendError(
        response,
        401,
        "Request had invalid authentication credentials.",
        "authError",
      );
    }

    const fault = server_takeFault(seen);
    if (fault && !fault.keepPartialChunk) {
      if (fault.retryAfter) response.setHeader("retry-after", fault.retryAfter);
      return sendError(response, fault.status ?? 503, "Injected fault", fault.reason);
    }

    if (url.pathname === "/drive/v3/about" && method === "GET") return about(response, url);
    if (url.pathname === "/drive/v3/files" && method === "GET") return listFiles(response, url);
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      return createMetadataOnly(response, parseJson(body));
    }
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch?.[1]) {
      const id = decodeURIComponent(fileMatch[1]);
      if (method === "DELETE") return deleteFile(response, id);
      if (method === "GET" && url.searchParams.get("alt") === "media") {
        return download(response, id, request.headers.range);
      }
    }
    if (url.pathname === "/upload/drive/v3/files") {
      const uploadType = url.searchParams.get("uploadType");
      const uploadId = url.searchParams.get("upload_id");
      if (method === "POST" && uploadType === "multipart") {
        return multipart(response, request.headers["content-type"] ?? "", body);
      }
      if (method === "POST" && uploadType === "resumable") {
        return startSession(response, parseJson(body));
      }
      if (method === "PUT" && uploadId) {
        return uploadChunk(response, uploadId, request.headers["content-range"] ?? "", body, fault);
      }
    }
    sendError(response, 404, `No fake route for ${method} ${url.pathname}`);
  }

  // --- OAuth -------------------------------------------------------------

  function deviceCodeEndpoint(response: ServerResponse, form: URLSearchParams) {
    if (form.get("client_id") !== clientId)
      return sendJson(response, 401, { error: "invalid_client" });
    if (!form.get("scope")) return sendJson(response, 400, { error: "invalid_scope" });
    const deviceCode = `device-${randomBytes(6).toString("hex")}`;
    devices.set(deviceCode, { polls: 0, slowedDown: false });
    sendJson(response, 200, {
      device_code: deviceCode,
      user_code: "ABCD-EFGH",
      verification_url: "https://www.google.com/device",
      expires_in: 1800,
      interval: 5,
    });
  }

  function tokenEndpoint(response: ServerResponse, form: URLSearchParams) {
    if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) {
      return sendJson(response, 401, { error: "invalid_client" });
    }
    const grant = form.get("grant_type");
    if (grant === "refresh_token") {
      if (form.get("refresh_token") !== refreshToken) {
        return sendJson(response, 400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      return sendJson(response, 200, issueAccessToken());
    }
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      const state = devices.get(form.get("device_code") ?? "");
      if (!state) return sendJson(response, 400, { error: "invalid_grant" });
      const login = server.deviceLogin;
      state.polls++;
      if (login.slowDownOnce && !state.slowedDown) {
        state.slowedDown = true;
        return sendJson(response, 403, { error: "slow_down" });
      }
      if (state.polls <= (login.pendingPolls ?? 0) + (state.slowedDown ? 1 : 0)) {
        return sendJson(response, 428, { error: "authorization_pending" });
      }
      if (login.outcome === "deny") return sendJson(response, 403, { error: "access_denied" });
      if (login.outcome === "expire") return sendJson(response, 400, { error: "expired_token" });
      devices.delete(form.get("device_code") ?? "");
      return sendJson(response, 200, { ...issueAccessToken(), refresh_token: refreshToken });
    }
    sendJson(response, 400, { error: "unsupported_grant_type" });
  }

  function issueAccessToken() {
    const token = `ya29.fake-${randomBytes(8).toString("hex")}`;
    accessTokens.add(token);
    return {
      access_token: token,
      expires_in: 3599,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/drive.file",
    };
  }

  // --- Drive -------------------------------------------------------------

  function about(response: ServerResponse, url: URL) {
    if (!url.searchParams.get("fields")) {
      return sendError(
        response,
        400,
        "The 'fields' parameter is required for this method.",
        "required",
      );
    }
    const { limit, trash } = server.quota;
    sendJson(response, 200, {
      storageQuota: {
        ...(limit === undefined ? {} : { limit: String(limit) }),
        usage: String(usedBytes() + trash),
        usageInDrive: String(usedBytes() - server.quota.otherUsage + trash),
        usageInDriveTrash: String(trash),
      },
    });
  }

  function listFiles(response: ServerResponse, url: URL) {
    let predicate: (file: FakeDriveFile) => boolean;
    try {
      predicate = parseQuery(url.searchParams.get("q") ?? "");
    } catch (error) {
      return sendError(response, 400, `Invalid Value: ${String(error)}`, "invalid");
    }
    // Reverse creation order: deliberately not key order.
    const matches = [...files.values()].filter(predicate).reverse();
    const requested = Number(url.searchParams.get("pageSize") ?? "100");
    const pageSize = Math.min(requested, server.pageSizeLimit);
    const offset = Number(url.searchParams.get("pageToken") ?? "0");
    const page = matches.slice(offset, offset + pageSize);
    const next = offset + pageSize < matches.length ? String(offset + pageSize) : undefined;
    sendJson(response, 200, {
      files: page.map(resource),
      ...(next === undefined ? {} : { nextPageToken: next }),
    });
  }

  function parentsOf(metadata: Record<string, unknown>): string[] | undefined {
    const parents = metadata.parents;
    const list = Array.isArray(parents) ? parents.map(String) : [ROOT_ID];
    const resolved = list.map((id) => (id === "root" ? ROOT_ID : id));
    for (const id of resolved) {
      if (id === ROOT_ID) continue;
      const parent = files.get(id);
      if (!parent || parent.mimeType !== FOLDER_MIME_TYPE) return undefined;
    }
    return resolved;
  }

  function createMetadataOnly(response: ServerResponse, metadata: Record<string, unknown>) {
    const parents = parentsOf(metadata);
    if (!parents) return sendError(response, 404, "File not found: parent.", "notFound");
    const appProperties = metadata.appProperties;
    const stored = storeFile({
      name: String(metadata.name ?? "Untitled"),
      mimeType: String(metadata.mimeType ?? "application/octet-stream"),
      parents,
      data: metadata.mimeType === FOLDER_MIME_TYPE ? undefined : Buffer.alloc(0),
      appProperties:
        typeof appProperties === "object" && appProperties !== null
          ? (appProperties as Record<string, string>)
          : {},
    });
    sendJson(response, 200, resource(stored));
  }

  function createWithData(
    response: ServerResponse,
    metadata: Record<string, unknown>,
    data: Buffer,
  ): FakeDriveFile | undefined {
    const parents = parentsOf(metadata);
    if (!parents) {
      sendError(response, 404, "File not found: parent.", "notFound");
      return undefined;
    }
    const { limit } = server.quota;
    if (limit !== undefined && usedBytes() + server.quota.trash + data.length > limit) {
      sendError(
        response,
        403,
        "The user's Drive storage quota has been exceeded.",
        "storageQuotaExceeded",
      );
      return undefined;
    }
    const stored = storeFile({
      name: String(metadata.name ?? "Untitled"),
      mimeType: String(metadata.mimeType ?? "application/octet-stream"),
      parents,
      data,
      appProperties: {},
    });
    sendJson(response, 200, resource(stored));
    return stored;
  }

  function multipart(response: ServerResponse, contentType: string, body: Buffer) {
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
    if (!contentType.startsWith("multipart/related") || !boundary) {
      return sendError(response, 400, "Expected multipart/related.", "badContent");
    }
    const delimiter = Buffer.from(`--${boundary}\r\n`);
    const closing = Buffer.from(`\r\n--${boundary}--`);
    const firstPart = body.indexOf(delimiter);
    const metadataStart = body.indexOf("\r\n\r\n", firstPart) + 4;
    const secondPart = body.indexOf(Buffer.from(`\r\n--${boundary}\r\n`), metadataStart);
    const dataStart = body.indexOf("\r\n\r\n", secondPart + 2) + 4;
    const dataEnd = body.lastIndexOf(closing);
    if (firstPart !== 0 || secondPart < 0 || dataEnd < dataStart) {
      return sendError(response, 400, "Malformed multipart body.", "badContent");
    }
    const metadata = parseJson(body.subarray(metadataStart, secondPart));
    createWithData(response, metadata, Buffer.from(body.subarray(dataStart, dataEnd)));
  }

  function startSession(response: ServerResponse, metadata: Record<string, unknown>) {
    if (!parentsOf(metadata))
      return sendError(response, 404, "File not found: parent.", "notFound");
    const uploadId = randomBytes(8).toString("hex");
    sessions.set(uploadId, { metadata, chunks: [], received: 0, finished: undefined });
    response.setHeader(
      "location",
      `${endpoint}/upload/drive/v3/files?uploadType=resumable&upload_id=${uploadId}`,
    );
    response.writeHead(200).end();
  }

  function uploadChunk(
    response: ServerResponse,
    uploadId: string,
    contentRange: string,
    body: Buffer,
    fault: FakeDriveFault | undefined,
  ) {
    const session = sessions.get(uploadId);
    if (!session) return sendError(response, 404, "Upload session not found.", "notFound");
    const status = /^bytes \*\/(\d+|\*)$/.exec(contentRange);
    const chunk = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    const total = status?.[1] ?? chunk?.[3];
    if (session.finished) return sendJson(response, 200, resource(session.finished));
    if (status) {
      if (total !== "*" && Number(total) === session.received)
        return finish(response, uploadId, session);
      return sendIncomplete(response, session.received);
    }
    if (!chunk)
      return sendError(response, 400, `Bad Content-Range "${contentRange}".`, "badRequest");
    const start = Number(chunk[1]);
    const end = Number(chunk[2]);
    if (start !== session.received || end - start + 1 !== body.length) {
      return sendError(
        response,
        400,
        "Content-Range does not match what was received.",
        "badRequest",
      );
    }
    const isFinal = total !== "*" && end + 1 === Number(total);
    let kept = body;
    if (fault?.keepPartialChunk) kept = body.subarray(0, Math.min(body.length, CHUNK_GRANULARITY));
    else if (!isFinal) kept = body.subarray(0, body.length - (body.length % CHUNK_GRANULARITY));
    session.chunks.push(Buffer.from(kept));
    session.received += kept.length;
    if (isFinal && kept.length === body.length) return finish(response, uploadId, session);
    sendIncomplete(response, session.received);
  }

  function finish(response: ServerResponse, uploadId: string, session: UploadSession) {
    const stored = createWithData(response, session.metadata, Buffer.concat(session.chunks));
    if (stored) session.finished = stored;
    else sessions.delete(uploadId);
  }

  function sendIncomplete(response: ServerResponse, received: number) {
    if (received > 0) response.setHeader("range", `bytes=0-${received - 1}`);
    response.writeHead(308).end();
  }

  function download(response: ServerResponse, id: string, range: string | undefined) {
    const file = files.get(id);
    if (!file?.data) return sendError(response, 404, `File not found: ${id}.`, "notFound");
    if (!range) {
      response.writeHead(200, {
        "content-type": file.mimeType,
        "content-length": file.data.length,
      });
      response.end(file.data);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) return sendError(response, 400, "Bad Range.", "badRequest");
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), file.data.length - 1) : file.data.length - 1;
    if (start >= file.data.length) {
      return sendError(
        response,
        416,
        "Request range not satisfiable",
        "requestedRangeNotSatisfiable",
      );
    }
    const slice = file.data.subarray(start, end + 1);
    response.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${file.data.length}`,
      "content-length": slice.length,
    });
    response.end(slice);
  }

  function deleteFile(response: ServerResponse, id: string) {
    if (!files.has(id)) return sendError(response, 404, `File not found: ${id}.`, "notFound");
    // Deleting a folder deletes everything below it, as Drive does.
    const doomed = [id];
    while (doomed.length > 0) {
      const next = doomed.pop() ?? "";
      files.delete(next);
      for (const file of files.values()) if (file.parents.includes(next)) doomed.push(file.id);
    }
    response.writeHead(204).end();
  }

  const server: FakeGdriveServer = {
    get endpoint() {
      return endpoint;
    },
    get tokenUrl() {
      return `${endpoint}/token`;
    },
    get deviceCodeUrl() {
      return `${endpoint}/device/code`;
    },
    clientId,
    clientSecret,
    get refreshToken() {
      return refreshToken;
    },
    adapterOptions() {
      return {
        apiUrl: endpoint,
        tokenUrl: `${endpoint}/token`,
        clientId,
        clientSecret,
        refreshToken,
        retryBaseMs: 1,
      };
    },
    files,
    requests,
    pageSizeLimit: 1000,
    quota: { limit: undefined, otherUsage: 0, trash: 0 },
    failNext(fault) {
      faults.push({ fault, remaining: fault.times ?? 1 });
    },
    expireAccessTokens() {
      accessTokens.clear();
    },
    revokeRefreshToken() {
      refreshToken = `1//revoked-${randomBytes(6).toString("hex")}`;
    },
    deviceLogin: {},
    addFile(file) {
      return storeFile({
        name: file.name,
        mimeType:
          file.mimeType ??
          (file.data === undefined ? FOLDER_MIME_TYPE : "application/octet-stream"),
        parents: file.parents,
        data: file.data,
        appProperties: file.appProperties ?? {},
      });
    },
    pathOf(id) {
      const names: string[] = [];
      let current = files.get(id);
      while (current) {
        names.unshift(current.name);
        current = files.get(current.parents[0] ?? "");
      }
      return names.join("/");
    },
    close() {
      return new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
    },
  };

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return server;

  // --- Query language subset ------------------------------------------------

  /** Parses the subset of Drive's query language described in the header. */
  function parseQuery(query: string): (file: FakeDriveFile) => boolean {
    const tokens = tokenize(query);
    let position = 0;
    const peek = () => tokens[position];
    const take = (expected?: string) => {
      const token = tokens[position++];
      if (token === undefined || (expected !== undefined && token.text !== expected)) {
        throw new Error(`expected ${expected ?? "a token"} at ${position} in ${query}`);
      }
      return token;
    };
    const stringToken = () => {
      const token = take();
      if (token.kind !== "string") throw new Error(`expected a string in ${query}`);
      return token.text;
    };

    function orExpression(): (file: FakeDriveFile) => boolean {
      const parts = [andExpression()];
      while (peek()?.text === "or") {
        take("or");
        parts.push(andExpression());
      }
      return (file) => parts.some((part) => part(file));
    }
    function andExpression(): (file: FakeDriveFile) => boolean {
      const parts = [atom()];
      while (peek()?.text === "and") {
        take("and");
        parts.push(atom());
      }
      return (file) => parts.every((part) => part(file));
    }
    function atom(): (file: FakeDriveFile) => boolean {
      const token = peek();
      if (token?.text === "(" && token.kind === "symbol") {
        take("(");
        const inner = orExpression();
        take(")");
        return inner;
      }
      if (token?.kind === "string") {
        const id = stringToken();
        take("in");
        take("parents");
        return (file) => file.parents.includes(id === "root" ? ROOT_ID : id);
      }
      const field = take().text;
      if (field === "trashed") {
        take("=");
        take("false");
        return () => true;
      }
      if (field === "appProperties") {
        take("has");
        take("{");
        take("key");
        take("=");
        const key = stringToken();
        take("and");
        take("value");
        take("=");
        const value = stringToken();
        take("}");
        return (file) => file.appProperties[key] === value;
      }
      if (field === "name" || field === "mimeType") {
        const operator = take().text;
        const value = stringToken();
        const read = (file: FakeDriveFile) => (field === "name" ? file.name : file.mimeType);
        if (operator === "=") return (file) => read(file) === value;
        if (operator === "!=") return (file) => read(file) !== value;
      }
      throw new Error(`unsupported query term "${field}" in ${query}`);
    }

    const predicate = orExpression();
    if (position !== tokens.length) throw new Error(`trailing tokens in ${query}`);
    return predicate;
  }
}

/** A query token: a quoted string (unescaped), a word, or a symbol. */
interface Token {
  readonly kind: "string" | "word" | "symbol";
  readonly text: string;
}

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index] ?? "";
    if (/\s/.test(char)) {
      index++;
    } else if (char === "'") {
      let text = "";
      index++;
      while (index < query.length && query[index] !== "'") {
        if (query[index] === "\\") index++;
        text += query[index] ?? "";
        index++;
      }
      if (query[index] !== "'") throw new Error(`unterminated string in ${query}`);
      index++;
      tokens.push({ kind: "string", text });
    } else if (char === "!" && query[index + 1] === "=") {
      tokens.push({ kind: "symbol", text: "!=" });
      index += 2;
    } else if ("()={}".includes(char)) {
      tokens.push({ kind: "symbol", text: char });
      index++;
    } else {
      const word = /^[A-Za-z]+/.exec(query.slice(index))?.[0];
      if (!word) throw new Error(`unexpected "${char}" in ${query}`);
      tokens.push({ kind: "word", text: word });
      index += word.length;
    }
  }
  return tokens;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): Record<string, unknown> {
  if (body.length === 0) return {};
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  const text = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=UTF-8" });
  response.end(text);
}

/** Drive's error shape: `{ error: { code, message, errors: [{ domain, reason, message }] } }`. */
function sendError(response: ServerResponse, status: number, message: string, reason?: string) {
  if (response.headersSent) {
    response.end();
    return;
  }
  sendJson(response, status, {
    error: {
      code: status,
      message,
      errors: [{ domain: "global", reason: reason ?? "backendError", message }],
    },
  });
}
