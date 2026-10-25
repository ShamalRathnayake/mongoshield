/**
 * Jobs: history, details, live progress and cancellation.
 *
 *   GET  /api/jobs                viewer   (query: limit ≤ 500)
 *   GET  /api/jobs/:id            viewer
 *   GET  /api/jobs/:id/events     viewer   Server-Sent Events
 *   POST /api/jobs/:id/cancel     operator
 *
 * The event stream sends each `JobEvent` as one unnamed SSE message
 * (`data: <json>`), so `EventSource.onmessage` receives them all and switches on
 * `type`. It starts with a replay (the job's current status, its latest progress,
 * and the log lines so far, at most 500), then streams live events, sends a
 * comment line every 15 s so proxies keep the connection open,
 * and ends after the final status.
 */

import type { Hono } from "hono";
import type { JobEvent, JobStatus } from "../../shared/api.ts";
import { recordAudit } from "../audit.ts";
import { requireRole } from "../auth.ts";
import type { AppEnv, ConsoleServices } from "../context.ts";
import { notFound } from "../errors.ts";
import { queryInt } from "../validate.ts";

/** Heartbeat interval of the event stream. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Statuses after which nothing more happens. */
function isFinal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Registers the job routes. */
export function jobRoutes(
  app: Hono<AppEnv>,
  services: ConsoleServices,
  options: { readonly heartbeatMs?: number } = {},
): void {
  const { runner } = services;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_MS;

  app.get("/api/jobs", (c) => {
    requireRole(c, "viewer");
    const limit = queryInt(c.req.query("limit"), "limit", { min: 1, max: 500, fallback: 500 });
    return c.json(runner.list().slice(0, limit));
  });

  app.get("/api/jobs/:id", (c) => {
    requireRole(c, "viewer");
    const job = runner.get(c.req.param("id"));
    if (job === undefined) throw notFound("The job");
    return c.json(job);
  });

  app.post("/api/jobs/:id/cancel", async (c) => {
    const principal = requireRole(c, "operator");
    const job = await runner.cancel(c.req.param("id"));
    if (job === undefined) throw notFound("The job");
    await recordAudit(services, {
      actor: principal,
      action: "job.cancel",
      target: job.id,
      outcome: "success",
      details: { kind: job.kind },
    });
    return c.json(job);
  });

  app.get("/api/jobs/:id/events", (c) => {
    requireRole(c, "viewer");
    const id = c.req.param("id");
    if (runner.get(id) === undefined) throw notFound("The job");

    const encoder = new TextEncoder();
    let stop: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        let unsubscribe: () => void = () => {};
        const write = (text: string): void => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // The client already went away (the stream was cancelled).
          }
        };
        const heartbeat = setInterval(() => write(": heartbeat\n\n"), heartbeatMs);
        unsubscribe = runner.subscribe(id, (event: JobEvent) => {
          write(`data: ${JSON.stringify(event)}\n\n`);
          // Close after the final status, once the current call stack is done.
          if (event.type === "status" && isFinal(event.job.status)) queueMicrotask(close);
        });
        c.req.raw.signal.addEventListener("abort", close, { once: true });
        stop = close;
      },
      cancel() {
        stop();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        // nginx buffers responses by default, which would hold events back.
        "X-Accel-Buffering": "no",
      },
    });
  });
}
