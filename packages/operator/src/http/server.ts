/**
 * The operator's HTTP endpoint: health probes and Prometheus metrics.
 *
 *   GET /healthz   liveness: 200 while the process can serve requests at all.
 *   GET /readyz    readiness: 200 once the operator is either leading with synced
 *                  caches or standing by; 503 while it starts up or shuts down.
 *   GET /metrics   Prometheus text format (operator-metrics.ts).
 *
 * Standby replicas report ready on purpose: readiness only decides whether a pod
 * receives Service traffic (here: metrics scrapes), and an unready standby would make
 * every rollout of a 2-replica Deployment look stuck.
 */

import { createServer, type Server } from "node:http";

export interface HttpServerOptions {
  readonly port: number;
  /** Bind address. Default: all interfaces (the kubelet probes the pod IP). */
  readonly host?: string;
  readonly isReady: () => boolean;
  readonly metrics: () => string;
}

/** Starts the server; resolves once it listens. */
export async function startHttpServer(options: HttpServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    if (path === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else if (path === "/readyz") {
      const ready = options.isReady();
      response
        .writeHead(ready ? 200 : 503, { "content-type": "text/plain" })
        .end(ready ? "ok\n" : "not ready\n");
    } else if (path === "/metrics") {
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
        .end(options.metrics());
    } else {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** Closes the server (and idle keep-alive connections). */
export async function stopHttpServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
