/**
 * A minimal in-process fake of the Google Cloud Storage JSON API, just enough
 * for the real `@google-cloud/storage` SDK to upload (single-request and
 * resumable, with preconditions and checksums), download (with ranges and
 * `x-goog-hash`), stat, list (with pages and delimiters) and delete objects.
 * It lets the GCS adapter run the full storage conformance suite through the
 * real SDK without Docker:
 *
 *   const server = await startFakeGcsServer(["my-bucket"]);
 *   const storage = gcsStorage({ bucket: "my-bucket", storage: server.client() });
 *   …
 *   await server.close();
 *
 * Bucket metadata (`GET /storage/v1/b/<bucket>`) is answered with a bucket that
 * has no object retention, so retained puts are refused as on an unprepared bucket.
 *
 * It is not a general emulator: no ACLs, versions, compose or auth. The
 * Docker-based integration test runs the same suite against fake-gcs-server.
 */

import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CRC32C, Storage } from "@google-cloud/storage";

interface StoredObject {
  readonly data: Buffer;
  readonly contentType: string;
  readonly generation: number;
  readonly updated: Date;
}

interface UploadSession {
  readonly bucket: string;
  readonly name: string;
  readonly contentType: string;
  readonly ifGenerationMatch: string | null;
  readonly chunks: Buffer[];
}

/** A running fake and a way to get SDK clients pointed at it. */
export interface FakeGcsServer {
  readonly endpoint: string;
  /** A `Storage` client for this server (no credentials needed). */
  client(): Storage;
  close(): Promise<void>;
}

/** Starts the fake on a random port on 127.0.0.1 with the given (empty) buckets. */
export async function startFakeGcsServer(bucketNames: readonly string[]): Promise<FakeGcsServer> {
  const buckets = new Map(bucketNames.map((name) => [name, new Map<string, StoredObject>()]));
  const sessions = new Map<string, UploadSession>();
  let generation = 0;
  let endpoint = "";

  function objectResource(bucket: string, name: string, stored: StoredObject) {
    const crc = new CRC32C();
    crc.update(stored.data);
    return {
      kind: "storage#object",
      bucket,
      name,
      size: String(stored.data.length),
      contentType: stored.contentType,
      generation: String(stored.generation),
      metageneration: "1",
      updated: stored.updated.toISOString(),
      timeCreated: stored.updated.toISOString(),
      etag: `etag-${stored.generation}`,
      md5Hash: createHash("md5").update(stored.data).digest("base64"),
      crc32c: crc.toString(),
    };
  }

  /** Stores an object, honouring `ifGenerationMatch=0` ("create only"). */
  function finalize(
    response: ServerResponse,
    bucket: string,
    name: string,
    data: Buffer,
    contentType: string,
    ifGenerationMatch: string | null,
  ): void {
    const objects = buckets.get(bucket);
    if (!objects) {
      sendError(response, 404, "The specified bucket does not exist.");
      return;
    }
    if (ifGenerationMatch === "0" && objects.has(name)) {
      sendError(response, 412, "At least one of the pre-conditions you specified did not hold.");
      return;
    }
    const stored = { data, contentType, generation: ++generation, updated: new Date() };
    objects.set(name, stored);
    sendJson(response, 200, objectResource(bucket, name, stored));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake");
    const body = await readBody(request);
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? "GET";

    // /upload/storage/v1/b/<bucket>/o
    if (segments[0] === "upload" && segments[3] === "b" && segments[5] === "o") {
      const bucket = segments[4] ?? "";
      const uploadId = url.searchParams.get("upload_id");
      if (uploadId !== null) return continueResumable(request, response, uploadId, body);
      const name = url.searchParams.get("name") ?? "";
      const ifGenerationMatch = url.searchParams.get("ifGenerationMatch");
      if (url.searchParams.get("uploadType") === "resumable") {
        const metadata =
          body.length > 0 ? (JSON.parse(body.toString()) as { contentType?: string }) : {};
        const id = randomUUID();
        sessions.set(id, {
          bucket,
          name,
          contentType:
            header(request, "x-upload-content-type") ??
            metadata.contentType ??
            "application/octet-stream",
          ifGenerationMatch,
          chunks: [],
        });
        response.setHeader(
          "Location",
          `${endpoint}/upload/storage/v1/b/${bucket}/o?uploadType=resumable&upload_id=${id}`,
        );
        return sendJson(response, 200, {});
      }
      const { metadata, media } = parseMultipart(request, body);
      return finalize(
        response,
        bucket,
        metadata.name ?? name,
        media,
        metadata.contentType ?? "application/octet-stream",
        ifGenerationMatch,
      );
    }

    // /storage/v1/b/<bucket>: bucket metadata, without object retention.
    if (
      segments[0] === "storage" &&
      segments[1] === "v1" &&
      segments[2] === "b" &&
      segments.length === 4 &&
      method === "GET"
    ) {
      const bucket = segments[3] ?? "";
      if (!buckets.has(bucket))
        return sendError(response, 404, "The specified bucket does not exist.");
      return sendJson(response, 200, { kind: "storage#bucket", name: bucket, id: bucket });
    }

    // /storage/v1/b/<bucket>/o[/<name>]
    if (
      segments[0] === "storage" &&
      segments[1] === "v1" &&
      segments[2] === "b" &&
      segments[4] === "o"
    ) {
      const bucket = segments[3] ?? "";
      const objects = buckets.get(bucket);
      if (!objects) return sendError(response, 404, "The specified bucket does not exist.");
      const name = segments.slice(5).join("/");
      if (name === "" && method === "GET")
        return listObjects(response, bucket, objects, url.searchParams);
      const stored = objects.get(name);
      if (method === "DELETE") {
        if (!stored) return sendError(response, 404, `No such object: ${bucket}/${name}`);
        objects.delete(name);
        response.writeHead(204).end();
        return;
      }
      if (!stored) return sendError(response, 404, `No such object: ${bucket}/${name}`);
      if (url.searchParams.get("alt") === "media") return download(request, response, stored);
      return sendJson(response, 200, objectResource(bucket, name, stored));
    }

    sendError(response, 400, `Unsupported request ${method} ${url.pathname}`);
  }

  /** A PUT to a resumable session: append the bytes, then finalize or ask for more (308). */
  function continueResumable(
    request: IncomingMessage,
    response: ServerResponse,
    uploadId: string,
    body: Buffer,
  ): void {
    const session = sessions.get(uploadId);
    if (!session) {
      sendError(response, 404, "No such upload session.");
      return;
    }
    if (request.method === "DELETE") {
      sessions.delete(uploadId);
      response.writeHead(499).end();
      return;
    }
    session.chunks.push(body);
    const received = session.chunks.reduce((total, chunk) => total + chunk.length, 0);
    // "bytes 0-*/*" (one streaming request), "bytes 0-262143/*" (more to come)
    // or "bytes 262144-300000/300001" (last chunk, total known).
    const range = /^bytes (?:\*|\d+-(-?\d+|\*))\/(\d+|\*)$/.exec(
      header(request, "content-range") ?? "",
    );
    const total = range?.[2];
    const isLast =
      total === undefined || (total === "*" ? range?.[1] === "*" : Number(total) === received);
    if (!isLast) {
      if (received > 0) response.setHeader("Range", `bytes=0-${received - 1}`);
      response.writeHead(308).end();
      return;
    }
    sessions.delete(uploadId);
    finalize(
      response,
      session.bucket,
      session.name,
      Buffer.concat(session.chunks),
      session.contentType,
      session.ifGenerationMatch,
    );
  }

  function download(
    request: IncomingMessage,
    response: ServerResponse,
    stored: StoredObject,
  ): void {
    const range = /^bytes=(\d+)-(\d*)$/.exec(header(request, "range") ?? "");
    const headers: Record<string, string> = {
      "content-type": stored.contentType,
      "x-goog-stored-content-encoding": "identity",
      "x-goog-generation": String(stored.generation),
    };
    if (!range) {
      const crc = new CRC32C();
      crc.update(stored.data);
      const md5 = createHash("md5").update(stored.data).digest("base64");
      headers["x-goog-hash"] = `crc32c=${crc.toString()},md5=${md5}`;
      response.writeHead(200, { ...headers, "content-length": String(stored.data.length) });
      response.end(stored.data);
      return;
    }
    const start = Number(range[1]);
    const end =
      range[2] === "" ? stored.data.length - 1 : Math.min(Number(range[2]), stored.data.length - 1);
    if (start >= stored.data.length) {
      sendError(response, 416, "Requested range not satisfiable");
      return;
    }
    const slice = stored.data.subarray(start, end + 1);
    response.writeHead(206, {
      ...headers,
      "content-length": String(slice.length),
      "content-range": `bytes ${start}-${end}/${stored.data.length}`,
    });
    response.end(slice);
  }

  function listObjects(
    response: ServerResponse,
    bucket: string,
    objects: Map<string, StoredObject>,
    query: URLSearchParams,
  ): void {
    const prefix = query.get("prefix") ?? "";
    const delimiter = query.get("delimiter");
    const maxResults = Number(query.get("maxResults") ?? "1000");
    const names = [...objects.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const entries: { name: string; isPrefix: boolean }[] = [];
    const seenPrefixes = new Set<string>();
    for (const name of names) {
      const rest = name.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut < 0) {
        entries.push({ name, isPrefix: false });
        continue;
      }
      const rolledUp = prefix + rest.slice(0, cut + (delimiter?.length ?? 0));
      if (!seenPrefixes.has(rolledUp)) {
        seenPrefixes.add(rolledUp);
        entries.push({ name: rolledUp, isPrefix: true });
      }
    }
    const start = Number(query.get("pageToken") ?? "0");
    const page = entries.slice(start, start + maxResults);
    const next = start + maxResults < entries.length ? String(start + maxResults) : undefined;
    sendJson(response, 200, {
      kind: "storage#objects",
      items: page.flatMap((entry) => {
        const stored = objects.get(entry.name);
        return entry.isPrefix || !stored ? [] : [objectResource(bucket, entry.name, stored)];
      }),
      prefixes: page.filter((entry) => entry.isPrefix).map((entry) => entry.name),
      ...(next === undefined ? {} : { nextPageToken: next }),
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendError(response, 500, String(error));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoint,
    client: () =>
      new Storage({
        apiEndpoint: endpoint,
        projectId: "test-project",
        // Fail fast in tests instead of retrying with backoff.
        retryOptions: { autoRetry: false, maxRetries: 0 },
      }),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Splits a `multipart/related` single-request upload into its JSON metadata and media parts. */
function parseMultipart(
  request: IncomingMessage,
  body: Buffer,
): { metadata: { name?: string; contentType?: string }; media: Buffer } {
  const boundary = /boundary="?([^";]+)"?/.exec(header(request, "content-type") ?? "")?.[1];
  if (!boundary) return { metadata: {}, media: body };
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let position = body.indexOf(delimiter);
  while (position >= 0) {
    const start = position + delimiter.length;
    const next = body.indexOf(delimiter, start);
    if (next < 0) break;
    parts.push(body.subarray(start, next));
    position = next;
  }
  const [metadataPart, mediaPart] = parts.map((part) => {
    const headerEnd = part.indexOf("\r\n\r\n");
    // Each part is "\r\n<headers>\r\n\r\n<content>\r\n".
    return part.subarray(headerEnd + 4, part.length - 2);
  });
  return {
    metadata: metadataPart
      ? (JSON.parse(metadataPart.toString()) as { name?: string; contentType?: string })
      : {},
    media: mediaPart ?? Buffer.alloc(0),
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, {
    error: { code: status, message, errors: [{ message, reason: "fake" }] },
  });
}
