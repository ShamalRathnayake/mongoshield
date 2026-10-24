/**
 * Page tests for live job progress: SSE events from a hand-driven EventSource are
 * rendered as progress, per-namespace state and log lines; a finished status ends the
 * stream. Also unit-tests the event reducer.
 */

import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JobEvent, JobSummary } from "../../shared/api.ts";
import type { EventSourceFactory, EventStreamHandlers } from "../api.ts";
import { renderApp } from "../testing.tsx";
import { initialJobState, reduceJobEvent } from "./job-detail.tsx";

const RUNNING_JOB: JobSummary = {
  id: "job-live",
  kind: "backup",
  status: "running",
  planId: "plan-nightly",
  storageId: "st-s3",
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  startedBy: "maya",
};

/** An EventSource stand-in whose messages the test sends by hand. */
function controllableStream() {
  const streams: { url: string; handlers: EventStreamHandlers; closed: boolean }[] = [];
  const openEventSource: EventSourceFactory = (url, handlers) => {
    const stream = { url, handlers, closed: false };
    streams.push(stream);
    return { close: () => (stream.closed = true) };
  };
  const send = (event: JobEvent) => {
    act(() => streams.at(-1)?.handlers.onMessage(JSON.stringify(event)));
  };
  return { streams, openEventSource, send };
}

function progress(documents: number, namespace: string): JobEvent {
  return {
    type: "progress",
    documents,
    estimatedDocuments: 4_000,
    bytes: documents * 1_000,
    etaMs: 90_000,
    namespace,
  };
}

describe("job progress page", () => {
  it("renders progress, namespaces and logs from SSE events, and stops when the job finishes", async () => {
    const sse = controllableStream();
    renderApp({
      signedInAs: "maya",
      hash: "#/jobs/job-live",
      openEventSource: sse.openEventSource,
      prepare: (backend) => backend.data.jobs.unshift(RUNNING_JOB),
    });
    await screen.findByRole("heading", { name: "Backup job" });
    // The stream opens in an effect after the first render.
    await waitFor(() => expect(sse.streams[0]?.url).toBe("/api/jobs/job-live/events"));
    act(() => sse.streams[0]?.handlers.onOpen());
    expect(screen.getByText("Live")).toBeTruthy();

    sse.send({ type: "log", level: "info", message: "backup started by maya" });
    sse.send(progress(500, "shop.users"));
    sse.send(progress(1_000, "shop.orders"));
    sse.send({ type: "log", level: "warn", message: "slow storage response" });

    const bar = screen.getByLabelText("Documents") as HTMLProgressElement;
    expect(bar.tagName).toBe("PROGRESS");
    expect(bar.value).toBe(1_000);
    expect(bar.max).toBe(4_000);
    expect(screen.getByText("1,000 of ~4,000 · 25%")).toBeTruthy();
    expect(screen.getByText("1 min 30 s")).toBeTruthy();
    expect(screen.getByText("977 KiB")).toBeTruthy();

    const usersLine = screen
      .getByText("shop.users", { selector: ".namespace-progress .mono" })
      .closest("li");
    const ordersLine = screen
      .getByText("shop.orders", { selector: ".namespace-progress .mono" })
      .closest("li");
    expect(usersLine?.textContent).toContain("Done");
    expect(usersLine?.textContent).toContain("500 documents");
    expect(ordersLine?.textContent).toContain("In progress");

    const log = screen.getByRole("list", { name: "Job log" });
    expect(log.textContent).toContain("backup started by maya");
    expect(log.textContent).toContain("WARN slow storage response");
    expect(screen.getByRole("button", { name: "Cancel job" })).toBeTruthy();

    sse.send({
      type: "status",
      job: {
        ...RUNNING_JOB,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
        summary: "2026-10-21T02-00-04Z_abc123",
        backupId: "2026-10-21T02-00-04Z_abc123",
      },
    });
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(sse.streams[0]?.closed).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
    expect(screen.getByRole("link", { name: "2026-10-21T02-00-04Z_abc123" })).toBeTruthy();
  });

  it("does not open a stream for a job that had already finished", async () => {
    const sse = controllableStream();
    renderApp({ signedInAs: "sam", hash: "#/jobs/job-1041", openEventSource: sse.openEventSource });
    expect(await screen.findByText("Failed: MS_SOURCE_UNREACHABLE")).toBeTruthy();
    expect(sse.streams).toHaveLength(0);
  });
});

describe("reduceJobEvent", () => {
  it("counts documents per namespace from the running total", () => {
    let state = initialJobState(RUNNING_JOB);
    state = reduceJobEvent(state, progress(100, "a.x"));
    state = reduceJobEvent(state, progress(300, "a.x"));
    state = reduceJobEvent(state, progress(450, "a.y"));
    state = reduceJobEvent(state, progress(700, "a.y"));
    expect(state.namespaces).toEqual([
      { ns: "a.x", documents: 300, state: "done" },
      { ns: "a.y", documents: 400, state: "active" },
    ]);
  });

  it("marks every namespace done when the job finishes", () => {
    let state = reduceJobEvent(initialJobState(RUNNING_JOB), progress(10, "a.x"));
    state = reduceJobEvent(state, { type: "status", job: { ...RUNNING_JOB, status: "failed" } });
    expect(state.namespaces.every((entry) => entry.state === "done")).toBe(true);
  });
});
