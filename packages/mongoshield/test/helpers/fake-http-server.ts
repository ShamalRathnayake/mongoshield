/**
 * A tiny programmable HTTP server on 127.0.0.1, for testing the fetch-based adapters
 * and the OAuth helpers against real sockets instead of a mocked `fetch`.
 *
 *   const server = await startFakeHttpServer(async (request) => {
 *     if (request.path === "/token") return { status: 200, json: { access_token: "a" } };
 *     return { status: 404 };
 *   });
 *   await fetch(`${server.url}/token`, { method: "POST" });
 *   expect(server.requests[0]?.body.toString()).toContain("grant_type=");
 *   await server.close();
 *
 * Every request is recorded (method, path, query, headers, body) before the handler
 * runs. A handler can answer with a status, headers and a JSON or raw body, delay its
 * answer (`delayMs`, for timeout tests) or drop the connection (`destroy: true`, for
 * network-error tests). The drive adapters' fakes (Drive, Graph, Dropbox) build on it.
 */

import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the server received. */
export interface RecordedRequest {
  readonly method: string;
  /** The path without the query, e.g. `/drive/v3/files`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** How the handler answers. */
export interface FakeResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialized as JSON with `content-type: application/json`. */
  readonly json?: unknown;
  /** A raw body (wins over `json`). */
  readonly body?: string | Buffer;
  /** Wait this long before answering. */
  readonly delayMs?: number;
  /** Drop the connection without answering. */
  readonly destroy?: boolean;
}

/** A running fake server. */
export interface FakeHttpServer {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Starts the server; `handler` decides every answer. */
export async function startFakeHttpServer(
  handler: (request: RecordedRequest) => FakeResponse | Promise<FakeResponse>,
): Promise<FakeHttpServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const request: RecordedRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(request);
      Promise.resolve(handler(request))
        .then((answer) => respond(response, answer))
        .catch((error: unknown) => {
          response.writeHead(500).end(String(error));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function respond(response: ServerResponse, answer: FakeResponse): Promise<void> {
  const { delayMs } = answer;
  if (delayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (answer.destroy === true) {
    response.socket?.destroy();
    return;
  }
  const headers: Record<string, string> = { ...answer.headers };
  let body: string | Buffer = "";
  if (answer.body !== undefined) {
    body = answer.body;
  } else if (answer.json !== undefined) {
    body = JSON.stringify(answer.json);
    headers["content-type"] ??= "application/json";
  }
  if (!response.destroyed) response.writeHead(answer.status ?? 200, headers).end(body);
}
