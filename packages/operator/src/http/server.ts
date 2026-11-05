/**
 * The operator's HTTP endpoint: health probes and Prometheus metrics.
 *
 *   GET /healthz   liveness: 200 while the process can serve requests at all.
 *   GET /readyz    readiness: 200 once the operator is either leading with synced
 *                  caches or standing by; 503 while it starts up or shuts down.
 *   GET /metrics   Prometheus text format (operator-metrics.ts). When a metrics token
 *                  is configured, only with `Authorization: Bearer <token>`: the
 *                  per-plan metrics name every watched namespace and plan.
 *
 * Standby replicas report ready on purpose: readiness only decides whether a pod
 * receives Service traffic (here: metrics scrapes), and an unready standby would make
 * every rollout of a 2-replica Deployment look stuck.
 *
 * Listen address: by default `::`, which on a dual-stack host accepts IPv4 and IPv6
 * (so the kubelet's probes work in IPv4, IPv6 and dual-stack clusters alike), falling
 * back to `0.0.0.0` where the kernel has no IPv6 at all.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface HttpServerOptions {
  readonly port: number;
  /** Bind address. Default: all interfaces, IPv6 and IPv4 (the kubelet probes the pod IP). */
  readonly host?: string;
  readonly isReady: () => boolean;
  readonly metrics: () => string;
  /** When set, /metrics requires `Authorization: Bearer <metricsToken>`. Probes never do. */
  readonly metricsToken?: string;
}

/** Errors that mean "this machine has no IPv6", after which IPv4 alone is tried. */
const NO_IPV6_ERRORS = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL"]);

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
      if (options.metricsToken !== undefined && !hasBearerToken(request, options.metricsToken)) {
        response
          .writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" })
          .end("unauthorized\n");
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
        .end(options.metrics());
    } else {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    }
  });

  if (options.host !== undefined) {
    await listen(server, options.port, options.host);
    return server;
  }
  try {
    await listen(server, options.port, "::");
  } catch (error) {
    if (!NO_IPV6_ERRORS.has(errorCode(error))) throw error;
    await listen(server, options.port, "0.0.0.0");
  }
  return server;
}

/** Closes the server (and idle keep-alive connections). */
export async function stopHttpServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Listens on one address; rejects with the bind error (port in use, no such family, …). */
function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/**
 * True when the request carries `Authorization: Bearer <token>`. Both sides are hashed
 * first, so the comparison takes the same time whatever the length or content of the
 * guess (timingSafeEqual needs equal lengths).
 */
function hasBearerToken(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) return false;
  return timingSafeEqual(sha256(match[1].trim()), sha256(token));
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** The `code` of a Node.js system error, or "" for anything else. */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return "";
}
