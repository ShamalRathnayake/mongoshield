/**
 * A minimal in-process fake of the parts of Microsoft Graph (OneDrive app folder)
 * and the Microsoft identity platform that the OneDrive adapter uses, so the adapter
 * runs the storage conformance suite and the token-rotation tests without a real
 * account:
 *
 *   const server = await startFakeOneDriveServer({ now: () => clock.now });
 *   const storage = onedriveStorage({
 *     folder: "backups", token: server.secret(),
 *     graphUrl: server.graphUrl, authorityUrl: server.authorityUrl, now: () => clock.now,
 *   });
 *   …
 *   await server.close();
 *
 * What it checks, the way the real services do (or stricter):
 * - Sign-in: the device code flow (pending polls, slow_down, declined) and the
 *   refresh grant. Refresh tokens expire 90 days after issue on the given clock and
 *   every refresh returns a new one; old ones are not revoked (Microsoft does not
 *   revoke them either). Access tokens last an hour; Graph calls without a valid one
 *   get 401.
 * - Simple uploads honour `@microsoft.graph.conflictBehavior` (`fail` → 409
 *   nameAlreadyExists) and create missing parent folders.
 * - Upload sessions: the total size in every Content-Range must match (and match
 *   `fileSize` when given), fragments must arrive in order, every fragment but the
 *   last must be a multiple of 320 KiB and at most 60 MiB, the pre-authenticated URL
 *   must NOT get an Authorization header (Graph may answer 401), a re-sent range gets
 *   416, and the conflict behaviour and quota are checked when the last fragment
 *   commits the file. `fileSize` above the free space is refused up front with 507.
 * - Listing pages (`pageSize`, default 200) with `@odata.nextLink`.
 * - Deletes move items to a recycle bin that still counts against the quota;
 *   `If-Match` is checked against the item's eTag (folders change eTag whenever a
 *   child is added or removed).
 * - `throttle(n)` makes the next n Graph requests answer 429 (or 503) with Retry-After.
 *
 * It is not a general emulator: names are case-sensitive, there are no versions,
 * sharing, thumbnails or deltas.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeOneDriveSecret, type OneDriveTenant } from "../../src/storage/onedrive-auth.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FRAGMENT_GRANULARITY = 320 * 1024;
const MAX_FRAGMENT = 60 * 1024 * 1024;
const ACCESS_TOKEN_SECONDS = 3600;
const REFRESH_LIFETIME_MS = 90 * DAY_MS;

/** A file or folder in the fake drive. Paths are relative to the app folder. */
interface DriveNode {
  readonly id: string;
  readonly path: string;
  readonly kind: "file" | "folder";
  data: Buffer;
  version: number;
  modified: Date;
}

interface UploadSession {
  readonly path: string;
  readonly conflict: string;
  readonly fileSize: number | undefined;
  total: number | undefined;
  readonly chunks: Buffer[];
  received: number;
}

interface RefreshTokenRecord {
  readonly issuedAt: Date;
  readonly tenant: string;
  readonly clientId: string;
}

/** Counters the tests look at. */
export interface FakeOneDriveStats {
  simplePuts: number;
  sessionsCreated: number;
  /** Byte length of every fragment received, in order. */
  fragments: number[];
  sessionsCancelled: number;
  refreshes: number;
  throttled: number;
  /** Requests to pre-authenticated (upload/download) URLs that carried a bearer token. */
  bearerOnPreauthenticatedUrls: number;
  /** Every Graph request: method and decoded path, for tests that check addressing. */
  graphRequests: string[];
}

/** Controls for the device code flow. */
export interface FakeDeviceFlow {
  /** How many polls answer authorization_pending before approval. Default 1. */
  pendingPolls: number;
  /** Answer one slow_down before the pending polls. */
  slowDownOnce: boolean;
  /** Decline instead of approving. */
  decline: boolean;
  /** Answer expired_token (the user never entered the code in time). */
  expire: boolean;
  /** The tenant of the last devicecode request (`consumers` or `common`). */
  lastTenant: string | undefined;
}

/** Options for {@link startFakeOneDriveServer}. */
export interface FakeOneDriveServerOptions {
  /** The clock used for token issue and expiry. Defaults to real time. */
  readonly now?: () => Date;
  /** Drive size in bytes. Default 5 GiB (OneDrive's free tier). */
  readonly quotaTotal?: number;
  /** Children per page. Default 200, like Graph. */
  readonly pageSize?: number;
  /** The client id the fake accepts. Default "test-client". */
  readonly clientId?: string;
}

/** A running fake. */
export interface FakeOneDriveServer {
  readonly endpoint: string;
  /** `graphUrl` for the adapter. */
  readonly graphUrl: string;
  /** `authorityUrl` for the adapter and login. */
  readonly authorityUrl: string;
  readonly clientId: string;
  readonly stats: FakeOneDriveStats;
  readonly device: FakeDeviceFlow;
  /** Children per page (changeable at any time). */
  pageSize: number;
  /** Total drive size in bytes (changeable at any time). */
  quotaTotal: number;
  /** When true, GET /me/drive answers 403 accessDenied (the app-folder scope case). */
  driveForbidden: boolean;
  /** The next n fragment PUTs are stored but answered 500, as if the answer was lost. */
  loseFragmentAnswers: number;
  /** Issues a refresh token directly (as if a login happened at `issuedAt`). */
  issueRefreshToken(options?: { issuedAt?: Date; tenant?: OneDriveTenant }): string;
  /** A `MONGOSHIELD_ONEDRIVE_TOKEN` value: an envelope around a fresh refresh token. */
  secret(options?: { issuedAt?: Date; tenant?: OneDriveTenant }): string;
  /** Revokes every refresh token (a password change). */
  revokeAllRefreshTokens(): void;
  /** Makes the next `count` Graph requests fail with `status` and Retry-After. */
  throttle(count: number, status?: 429 | 503, retryAfter?: string): void;
  /** Paths of every file, sorted. */
  files(): string[];
  /** Paths of every folder, sorted. */
  folders(): string[];
  /** The content of a file, or undefined. */
  read(path: string): Buffer | undefined;
  /** Items in the recycle bin. */
  recycleBin(): readonly { readonly path: string; readonly size: number }[];
  /** Number of open upload sessions. */
  openSessions(): number;
  close(): Promise<void>;
}

/** Starts the fake on a random port on 127.0.0.1. */
export async function startFakeOneDriveServer(
  options: FakeOneDriveServerOptions = {},
): Promise<FakeOneDriveServer> {
  const now = options.now ?? (() => new Date());
  const clientId = options.clientId ?? "test-client";
  const nodes = new Map<string, DriveNode>();
  const byId = new Map<string, string>();
  const sessions = new Map<string, UploadSession>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const accessTokens = new Map<string, number>();
  const deviceCodes = new Map<string, { tenant: string; polls: number; slowedDown: boolean }>();
  const recycle: { path: string; size: number }[] = [];
  let throttleLeft = 0;
  let throttleStatus = 429;
  let throttleRetryAfter = "0";
  let endpoint = "";

  const stats: FakeOneDriveStats = {
    simplePuts: 0,
    sessionsCreated: 0,
    fragments: [],
    sessionsCancelled: 0,
    refreshes: 0,
    throttled: 0,
    bearerOnPreauthenticatedUrls: 0,
    graphRequests: [],
  };
  const device: FakeDeviceFlow = {
    pendingPolls: 1,
    slowDownOnce: false,
    decline: false,
    expire: false,
    lastTenant: undefined,
  };

  // --- drive model ---------------------------------------------------------

  function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
  }

  function childrenOf(path: string): DriveNode[] {
    return [...nodes.values()].filter((node) => parentOf(node.path) === path && node.path !== "");
  }

  /** Bumps a folder's version (and so its eTag), as OneDrive does when children change. */
  function touchParent(path: string): void {
    const parent = nodes.get(parentOf(path));
    if (parent !== undefined && parent.path !== path) parent.version++;
  }

  /** Creates the folder at `path` and its parents if missing. */
  function ensureFolder(path: string): DriveNode {
    const existing = nodes.get(path);
    if (existing !== undefined) return existing;
    if (path !== "") ensureFolder(parentOf(path));
    const node: DriveNode = {
      id: randomUUID(),
      path,
      kind: "folder",
      data: Buffer.alloc(0),
      version: 1,
      modified: now(),
    };
    nodes.set(path, node);
    byId.set(node.id, path);
    if (path !== "") touchParent(path);
    return node;
  }
  ensureFolder("");

  function usedBytes(): number {
    let used = 0;
    for (const node of nodes.values()) used += node.data.length;
    for (const item of recycle) used += item.size;
    return used;
  }

  /** Writes a file, honouring the conflict behaviour. Returns the status and item. */
  function writeFile(path: string, data: Buffer, conflict: string): [number, unknown] {
    const existing = nodes.get(path);
    if (existing !== undefined && conflict === "fail") {
      return [409, graphError("nameAlreadyExists", "An item with the same name already exists.")];
    }
    if (existing?.kind === "folder") {
      return [409, graphError("nameAlreadyExists", "A folder with that name exists.")];
    }
    const growth = data.length - (existing?.data.length ?? 0);
    if (usedBytes() + growth > server.quotaTotal) {
      return [507, graphError("quotaLimitReached", "Insufficient Space Available")];
    }
    ensureFolder(parentOf(path));
    if (existing !== undefined) {
      existing.data = data;
      existing.version++;
      existing.modified = now();
      return [200, itemJson(existing)];
    }
    const node: DriveNode = {
      id: randomUUID(),
      path,
      kind: "file",
      data,
      version: 1,
      modified: now(),
    };
    nodes.set(path, node);
    byId.set(node.id, path);
    touchParent(path);
    return [201, itemJson(node)];
  }

  /** Moves an item (and everything below it) to the recycle bin. */
  function deleteNode(node: DriveNode): void {
    for (const path of [...nodes.keys()]) {
      if (path === node.path || path.startsWith(`${node.path}/`)) {
        const removed = nodes.get(path);
        if (removed === undefined) continue;
        nodes.delete(path);
        byId.delete(removed.id);
        recycle.push({ path, size: removed.data.length });
      }
    }
    touchParent(node.path);
  }

  function etagOf(node: DriveNode): string {
    return `"{${node.id}},${node.version}"`;
  }

  function itemJson(node: DriveNode): Record<string, unknown> {
    const name = node.path.split("/").pop() ?? "";
    const base = {
      id: node.id,
      name,
      size: node.kind === "file" ? node.data.length : folderSize(node.path),
      lastModifiedDateTime: node.modified.toISOString(),
      eTag: etagOf(node),
      cTag: `"c:{${node.id}},${node.version}"`,
      parentReference: { path: `/drive/special/approot:/${parentOf(node.path)}` },
    };
    if (node.kind === "folder")
      return { ...base, folder: { childCount: childrenOf(node.path).length } };
    return {
      ...base,
      file: { mimeType: "application/octet-stream" },
      "@microsoft.graph.downloadUrl": `${endpoint}/download/${node.id}?tempauth=${randomBytes(8).toString("hex")}`,
    };
  }

  function folderSize(path: string): number {
    let size = 0;
    for (const node of nodes.values()) {
      if (node.kind === "file" && node.path.startsWith(`${path}/`)) size += node.data.length;
    }
    return size;
  }

  // --- tokens --------------------------------------------------------------

  function issueRefreshToken(
    issueOptions: { issuedAt?: Date; tenant?: OneDriveTenant } = {},
  ): string {
    const token = `rt-${randomBytes(24).toString("hex")}`;
    refreshTokens.set(token, {
      issuedAt: issueOptions.issuedAt ?? now(),
      tenant: issueOptions.tenant ?? "consumers",
      clientId,
    });
    return token;
  }

  function issueAccessToken(): string {
    const token = `at-${randomBytes(24).toString("hex")}`;
    accessTokens.set(token, now().getTime() + ACCESS_TOKEN_SECONDS * 1000);
    return token;
  }

  function validBearer(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match?.[1]) return false;
    const expiresAt = accessTokens.get(match[1]);
    return expiresAt !== undefined && now().getTime() < expiresAt;
  }

  // --- HTTP ----------------------------------------------------------------

  const httpServer = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, graphError("generalException", String(error)));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", endpoint);
    const body = await readBody(request);
    const path = url.pathname;

    if (/^\/(consumers|common|organizations)\/oauth2\/v2\.0\//.test(path)) {
      handleAuth(path, new URLSearchParams(body.toString()), response);
      return;
    }
    if (path.startsWith("/upload/")) {
      handleUpload(request, path.slice("/upload/".length), body, response);
      return;
    }
    if (path.startsWith("/download/")) {
      handleDownload(request, path.slice("/download/".length), response);
      return;
    }
    if (path.startsWith("/v1.0/")) {
      handleGraph(request, url, body, response);
      return;
    }
    send(response, 404, graphError("itemNotFound", "No such endpoint."));
  }

  function handleAuth(path: string, form: URLSearchParams, response: ServerResponse): void {
    const tenant = path.split("/")[1] ?? "";
    if (form.get("client_id") !== clientId) {
      send(response, 400, {
        error: "unauthorized_client",
        error_description: "AADSTS700016: Unknown app.",
      });
      return;
    }
    if (path.endsWith("/devicecode")) {
      device.lastTenant = tenant;
      const deviceCode = `dc-${randomBytes(12).toString("hex")}`;
      deviceCodes.set(deviceCode, { tenant, polls: 0, slowedDown: false });
      send(response, 200, {
        device_code: deviceCode,
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 900,
        interval: 0,
        message: "To sign in, use a web browser…",
      });
      return;
    }
    const grant = form.get("grant_type");
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      const record = deviceCodes.get(form.get("device_code") ?? "");
      if (record === undefined) {
        send(response, 400, { error: "bad_verification_code", error_description: "AADSTS70019" });
        return;
      }
      if (device.decline) {
        send(response, 400, { error: "authorization_declined", error_description: "declined" });
        return;
      }
      if (device.expire) {
        send(response, 400, { error: "expired_token", error_description: "AADSTS70020" });
        return;
      }
      if (device.slowDownOnce && !record.slowedDown) {
        record.slowedDown = true;
        send(response, 400, { error: "slow_down", error_description: "slow down" });
        return;
      }
      if (record.polls < device.pendingPolls) {
        record.polls++;
        send(response, 400, { error: "authorization_pending", error_description: "pending" });
        return;
      }
      deviceCodes.delete(form.get("device_code") ?? "");
      send(response, 200, tokenAnswer(record.tenant === "common" ? "common" : "consumers"));
      return;
    }
    if (grant === "refresh_token") {
      const record = refreshTokens.get(form.get("refresh_token") ?? "");
      if (record === undefined) {
        send(response, 400, {
          error: "invalid_grant",
          error_description: "AADSTS70000: The provided grant is invalid or revoked.",
          error_codes: [70000],
        });
        return;
      }
      if (now().getTime() - record.issuedAt.getTime() >= REFRESH_LIFETIME_MS) {
        send(response, 400, {
          error: "invalid_grant",
          error_description:
            "AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.",
          error_codes: [70008],
        });
        return;
      }
      // A consumers token refreshed through /consumers or /common is fine; a work
      // account's token through /consumers is not.
      if (record.tenant === "common" && tenant === "consumers") {
        send(response, 400, { error: "invalid_grant", error_description: "AADSTS9002331" });
        return;
      }
      stats.refreshes++;
      send(response, 200, tokenAnswer(record.tenant === "common" ? "common" : "consumers"));
      return;
    }
    send(response, 400, { error: "unsupported_grant_type" });
  }

  function tokenAnswer(tenant: OneDriveTenant): Record<string, unknown> {
    return {
      token_type: "Bearer",
      scope: "Files.ReadWrite.AppFolder",
      expires_in: ACCESS_TOKEN_SECONDS,
      access_token: issueAccessToken(),
      refresh_token: issueRefreshToken({ tenant }),
    };
  }

  function handleGraph(
    request: IncomingMessage,
    url: URL,
    body: Buffer,
    response: ServerResponse,
  ): void {
    const method = request.method ?? "GET";
    const decodedPath = decodeURIComponent(url.pathname);
    stats.graphRequests.push(`${method} ${decodedPath}`);
    if (throttleLeft > 0) {
      throttleLeft--;
      stats.throttled++;
      response.setHeader("Retry-After", throttleRetryAfter);
      send(response, throttleStatus, graphError("activityLimitReached", "Throttled."));
      return;
    }
    if (!validBearer(request)) {
      send(
        response,
        401,
        graphError("InvalidAuthenticationToken", "Access token is empty or expired."),
      );
      return;
    }
    const path = url.pathname.slice("/v1.0".length);

    if (path === "/me/drive") {
      if (server.driveForbidden) {
        send(response, 403, graphError("accessDenied", "Access denied."));
        return;
      }
      const deleted = recycle.reduce((sum, item) => sum + item.size, 0);
      const used = usedBytes();
      send(response, 200, {
        id: "drive",
        driveType: "personal",
        quota: {
          total: server.quotaTotal,
          used,
          remaining: server.quotaTotal - used,
          deleted,
          state: "normal",
        },
      });
      return;
    }

    const byIdMatch = /^\/me\/drive\/items\/([^/]+)(\/children)?$/.exec(path);
    if (byIdMatch) {
      const nodePath = byId.get(decodeURIComponent(byIdMatch[1] ?? ""));
      const node = nodePath === undefined ? undefined : nodes.get(nodePath);
      if (node === undefined) {
        send(response, 404, graphError("itemNotFound", "The resource could not be found."));
        return;
      }
      if (byIdMatch[2] !== undefined) {
        sendChildren(node, url, response);
        return;
      }
      if (method === "DELETE") {
        deleteWithPreconditions(request, node, response);
        return;
      }
      send(response, 200, itemJson(node));
      return;
    }

    const prefix = "/me/drive/special/approot:";
    if (!path.startsWith(prefix)) {
      send(response, 400, graphError("invalidRequest", `Unsupported path ${decodedPath}`));
      return;
    }
    // "/folder/a/b:/content" → item "folder/a/b", action "content".
    const rest = path.slice(prefix.length);
    const actionIndex = rest.indexOf(":/");
    const rawItem = (actionIndex === -1 ? rest : rest.slice(0, actionIndex)).replace(/:$/, "");
    const action = actionIndex === -1 ? undefined : rest.slice(actionIndex + 2);
    const itemPath = rawItem
      .split("/")
      .filter((segment) => segment !== "")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const node = nodes.get(itemPath);

    if (action === "content" && method === "PUT") {
      stats.simplePuts++;
      const conflict = url.searchParams.get("@microsoft.graph.conflictBehavior") ?? "replace";
      const [status, json] = writeFile(itemPath, body, conflict);
      send(response, status, json);
      return;
    }
    if (action === "createUploadSession" && method === "POST") {
      const request = parseJson(body.toString());
      const item = (request as { item?: Record<string, unknown> } | undefined)?.item ?? {};
      const conflict = String(item["@microsoft.graph.conflictBehavior"] ?? "fail");
      const fileSize = typeof item.fileSize === "number" ? item.fileSize : undefined;
      if (fileSize !== undefined && usedBytes() + fileSize > server.quotaTotal) {
        send(response, 507, graphError("quotaLimitReached", "Insufficient Space Available"));
        return;
      }
      const id = randomUUID();
      sessions.set(id, {
        path: itemPath,
        conflict,
        fileSize,
        total: undefined,
        chunks: [],
        received: 0,
      });
      stats.sessionsCreated++;
      send(response, 200, {
        uploadUrl: `${endpoint}/upload/${id}?tempauth=${randomBytes(8).toString("hex")}`,
        expirationDateTime: new Date(Date.now() + DAY_MS).toISOString(),
        nextExpectedRanges: ["0-"],
      });
      return;
    }
    if (action === "children" && method === "GET") {
      if (node === undefined || node.kind !== "folder") {
        send(response, 404, graphError("itemNotFound", "The resource could not be found."));
        return;
      }
      sendChildren(node, url, response);
      return;
    }
    if (action === undefined && method === "GET") {
      if (node === undefined) {
        send(response, 404, graphError("itemNotFound", "The resource could not be found."));
        return;
      }
      send(response, 200, itemJson(node));
      return;
    }
    if (action === undefined && method === "DELETE") {
      if (node === undefined) {
        send(response, 404, graphError("itemNotFound", "The resource could not be found."));
        return;
      }
      deleteWithPreconditions(request, node, response);
      return;
    }
    send(response, 400, graphError("invalidRequest", `Unsupported ${method} ${decodedPath}`));
  }

  function deleteWithPreconditions(
    request: IncomingMessage,
    node: DriveNode,
    response: ServerResponse,
  ): void {
    const ifMatch = request.headers["if-match"];
    if (ifMatch !== undefined && ifMatch !== etagOf(node)) {
      send(response, 412, graphError("resourceModified", "The eTag does not match."));
      return;
    }
    deleteNode(node);
    send(response, 204, undefined);
  }

  function sendChildren(node: DriveNode, url: URL, response: ServerResponse): void {
    // Graph returns children in its own order; reverse-sorted here so the adapter
    // cannot get away with relying on any particular one.
    const all = childrenOf(node.path).sort((left, right) => (left.path < right.path ? 1 : -1));
    const skip = Number(url.searchParams.get("$skiptoken") ?? "0");
    const page = all.slice(skip, skip + server.pageSize);
    const nextSkip = skip + page.length;
    const next = new URL(url.toString());
    next.searchParams.set("$skiptoken", String(nextSkip));
    send(response, 200, {
      value: page.map((child) => itemJson(child)),
      ...(nextSkip < all.length ? { "@odata.nextLink": next.toString() } : {}),
    });
  }

  function handleUpload(
    request: IncomingMessage,
    rawId: string,
    body: Buffer,
    response: ServerResponse,
  ): void {
    if (request.headers.authorization !== undefined) {
      stats.bearerOnPreauthenticatedUrls++;
      send(response, 401, graphError("unauthenticated", "Do not send a token to the upload URL."));
      return;
    }
    const id = decodeURIComponent(rawId);
    const session = sessions.get(id);
    if (session === undefined) {
      send(response, 404, graphError("itemNotFound", "The upload session does not exist."));
      return;
    }
    const method = request.method ?? "GET";
    if (method === "DELETE") {
      sessions.delete(id);
      stats.sessionsCancelled++;
      send(response, 204, undefined);
      return;
    }
    if (method === "GET") {
      send(response, 200, { nextExpectedRanges: [`${session.received}-`] });
      return;
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(request.headers["content-range"] ?? "");
    if (!match) {
      send(response, 400, graphError("invalidRequest", "Content-Range is required."));
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    const length = end - start + 1;
    session.total ??= total;
    if (total !== session.total || (session.fileSize !== undefined && total !== session.fileSize)) {
      send(
        response,
        400,
        graphError("invalidRequest", "The total size changed between fragments."),
      );
      return;
    }
    if (length !== body.length) {
      send(response, 400, graphError("invalidRequest", "Content-Range does not match the body."));
      return;
    }
    if (start < session.received) {
      send(response, 416, graphError("invalidRange", "That range was already received."));
      return;
    }
    if (start !== session.received) {
      send(response, 400, graphError("invalidRequest", "Fragments must be uploaded in order."));
      return;
    }
    const last = end === total - 1;
    if (length > MAX_FRAGMENT || (!last && length % FRAGMENT_GRANULARITY !== 0)) {
      send(
        response,
        400,
        graphError("invalidRequest", "Fragments must be multiples of 320 KiB, at most 60 MiB."),
      );
      return;
    }
    stats.fragments.push(length);
    session.chunks.push(body);
    session.received += length;
    const loseAnswer = server.loseFragmentAnswers > 0;
    if (loseAnswer) server.loseFragmentAnswers--;
    if (!last) {
      if (loseAnswer) {
        send(response, 500, graphError("generalException", "The answer was lost."));
        return;
      }
      send(response, 202, {
        expirationDateTime: new Date(Date.now() + DAY_MS).toISOString(),
        nextExpectedRanges: [`${session.received}-`],
      });
      return;
    }
    // The last fragment commits the file: conflicts and quota are checked now.
    sessions.delete(id);
    const [status, json] = writeFile(session.path, Buffer.concat(session.chunks), session.conflict);
    send(response, status, json);
  }

  function handleDownload(request: IncomingMessage, rawId: string, response: ServerResponse): void {
    if (request.headers.authorization !== undefined) stats.bearerOnPreauthenticatedUrls++;
    const path = byId.get(decodeURIComponent(rawId));
    const node = path === undefined ? undefined : nodes.get(path);
    if (node === undefined || node.kind !== "file") {
      send(response, 404, graphError("itemNotFound", "Gone."));
      return;
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
      const start = Number(range[1]);
      const end =
        range[2] === "" ? node.data.length - 1 : Math.min(Number(range[2]), node.data.length - 1);
      if (start >= node.data.length) {
        response.writeHead(416, { "Content-Range": `bytes */${node.data.length}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${node.data.length}`,
        "Content-Length": String(end - start + 1),
      });
      response.end(node.data.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(node.data.length),
    });
    response.end(node.data);
  }

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}`;

  const server: FakeOneDriveServer = {
    endpoint,
    graphUrl: `${endpoint}/v1.0`,
    authorityUrl: endpoint,
    clientId,
    stats,
    device,
    pageSize: options.pageSize ?? 200,
    quotaTotal: options.quotaTotal ?? 5 * 1024 * 1024 * 1024,
    driveForbidden: false,
    loseFragmentAnswers: 0,
    issueRefreshToken,
    secret(secretOptions = {}) {
      const issuedAt = secretOptions.issuedAt ?? now();
      const tenant = secretOptions.tenant ?? "consumers";
      return encodeOneDriveSecret({
        refreshToken: issueRefreshToken({ issuedAt, tenant }),
        issuedAt,
        tenant,
        clientId,
      });
    },
    revokeAllRefreshTokens() {
      refreshTokens.clear();
    },
    throttle(count, status = 429, retryAfter = "0") {
      throttleLeft = count;
      throttleStatus = status;
      throttleRetryAfter = retryAfter;
    },
    files() {
      return [...nodes.values()]
        .filter((node) => node.kind === "file")
        .map((node) => node.path)
        .sort();
    },
    folders() {
      return [...nodes.values()]
        .filter((node) => node.kind === "folder" && node.path !== "")
        .map((node) => node.path)
        .sort();
    },
    read(path) {
      const node = nodes.get(path);
      return node?.kind === "file" ? node.data : undefined;
    },
    recycleBin: () => recycle,
    openSessions: () => sessions.size,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  return server;
}

function graphError(code: string, message: string): Record<string, unknown> {
  return { error: { code, message, innerError: { date: new Date().toISOString() } } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, json: unknown): void {
  if (json === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const text = JSON.stringify(json);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
