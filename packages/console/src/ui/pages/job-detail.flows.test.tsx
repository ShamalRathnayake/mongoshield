/**
 * More job page tests: cancelling (confirm, keep running, refused), the stream's
 * connection states, finished jobs without progress, failure details, links to the
 * plan and backup, the log line cap of the reducer, and load errors.
 */

import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JobSummary } from "../../shared/api.ts";
import type { EventSourceFactory, EventStreamHandlers } from "../api.ts";
import { renderFailingApp } from "../failing-backend.testkit.tsx";
import { renderApp, requestsTo } from "../testing.tsx";
import { initialJobState, reduceJobEvent } from "./job-detail.tsx";

const RUNNING_RESTORE: JobSummary = {
  id: "job-restore",
  kind: "restore",
  status: "running",
  storageId: "st-s3",
  backupId: "2026-10-21T02-00-04Z_abc123",
  startedAt: new Date(Date.now() - 5_000).toISOString(),
  startedBy: "maya",
};

/** An EventSource stand-in the test drives by hand. */
function manualStreams() {
  const streams: { handlers: EventStreamHandlers; closed: boolean }[] = [];
  const openEventSource: EventSourceFactory = (_url, handlers) => {
    const stream = { handlers, closed: false };
    streams.push(stream);
    return { close: () => (stream.closed = true) };
  };
  return { streams, openEventSource };
}

describe("cancelling a job", () => {
  it("asks first, can keep the job running, and then cancels it", async () => {
    const sse = manualStreams();
    const { user, backend } = renderApp({
      signedInAs: "maya",
      hash: "#/jobs/job-restore",
      openEventSource: sse.openEventSource,
      prepare: (mock) => mock.data.jobs.unshift(RUNNING_RESTORE),
    });
    await user.click(await screen.findByRole("button", { name: "Cancel job" }));
    expect(screen.getByText(/Collections already restored stay as they are/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel job" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this job?" });
    await user.click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel job",
      ) ?? dialog,
    );
    expect(await screen.findByText("Cancelling the job…")).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/jobs/job-restore/cancel")).toHaveLength(1);
  });

  it("reports a cancel the server refused", async () => {
    const sse = manualStreams();
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: "#/jobs/job-restore",
      openEventSource: sse.openEventSource,
      prepare: (mock) => mock.data.jobs.unshift({ ...RUNNING_RESTORE, kind: "backup" }),
      failures: [{ method: "POST", path: /\/cancel$/, status: 409, message: "Already finished." }],
    });
    await user.click(await screen.findByRole("button", { name: "Cancel job" }));
    expect(screen.getByText(/The job stops as soon as possible/)).toBeTruthy();
    const dialog = screen.getByRole("dialog", { name: "Cancel this job?" });
    await user.click(
      [...dialog.querySelectorAll("button")].find(
        (button) => button.textContent === "Cancel job",
      ) ?? dialog,
    );
    expect(await screen.findByText("Already finished.")).toBeTruthy();
  });

  it("is not offered to viewers", async () => {
    const sse = manualStreams();
    renderApp({
      signedInAs: "sam",
      hash: "#/jobs/job-restore",
      openEventSource: sse.openEventSource,
      prepare: (mock) => mock.data.jobs.unshift(RUNNING_RESTORE),
    });
    await screen.findByRole("heading", { name: "Restore job" });
    expect(screen.queryByRole("button", { name: "Cancel job" })).toBeNull();
  });
});

describe("live view", () => {
  it("shows connecting, live and reconnecting states while waiting for progress", async () => {
    const sse = manualStreams();
    renderApp({
      signedInAs: "sam",
      hash: "#/jobs/job-restore",
      openEventSource: sse.openEventSource,
      prepare: (mock) => mock.data.jobs.unshift({ ...RUNNING_RESTORE, status: "queued" }),
    });
    expect(await screen.findByText("Connecting to live updates…")).toBeTruthy();
    expect(screen.getByText("Waiting for progress…")).toBeTruthy();
    expect(screen.getByText("No log lines yet.")).toBeTruthy();
    await waitFor(() => expect(sse.streams).toHaveLength(1));
    act(() => sse.streams[0]?.handlers.onOpen());
    expect(screen.getByText("Live")).toBeTruthy();
    act(() => sse.streams[0]?.handlers.onError(false));
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    act(() =>
      sse.streams[0]?.handlers.onMessage(
        JSON.stringify({ type: "progress", documents: 5, estimatedDocuments: 10, bytes: 50 }),
      ),
    );
    expect(screen.getByText("5 of ~10 · 50%")).toBeTruthy();
    expect(screen.getByText("–", { selector: ".mono" })).toBeTruthy();
  });

  it("shows a finished job's summary, failure hint and links without streaming", async () => {
    const sse = manualStreams();
    renderApp({
      signedInAs: "sam",
      hash: "#/jobs/job-done",
      openEventSource: sse.openEventSource,
      prepare: (mock) =>
        mock.data.jobs.unshift({
          ...RUNNING_RESTORE,
          id: "job-done",
          kind: "backup",
          planId: "plan-nightly",
          status: "failed",
          finishedAt: new Date().toISOString(),
          summary: "nothing written",
          error: { code: "MS_STORAGE_IO", message: "Bucket gone.", hint: "Check the bucket." },
        }),
    });
    expect(await screen.findByText("Failed: MS_STORAGE_IO")).toBeTruthy();
    expect(screen.getByText("Check the bucket.")).toBeTruthy();
    expect(screen.getAllByText("nothing written").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "plan-nightly" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "2026-10-21T02-00-04Z_abc123" })).toBeTruthy();
    expect(screen.getByText("No log lines were streamed for this job.")).toBeTruthy();
    expect(sse.streams).toHaveLength(0);
  });

  it("says when a finished job reported no progress or result", async () => {
    renderApp({
      signedInAs: "sam",
      hash: "#/jobs/job-bare",
      prepare: (mock) =>
        mock.data.jobs.unshift({
          id: "job-bare",
          kind: "verify",
          status: "cancelled",
          startedBy: "sam",
        }),
    });
    expect(await screen.findByText("No progress was reported.")).toBeTruthy();
  });

  it("shows a load error and retries", async () => {
    const { user } = renderFailingApp({
      signedInAs: "sam",
      hash: "#/jobs/job-1042",
      failures: [
        { method: "GET", path: "/api/jobs/job-1042", status: 500, message: "Nope.", times: 1 },
      ],
    });
    expect(await screen.findByRole("heading", { name: "Job job-1042" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Backup job" })).toBeTruthy();
  });
});

describe("reduceJobEvent log cap", () => {
  it("keeps only the newest 1,000 log lines", () => {
    let state = initialJobState(RUNNING_RESTORE);
    for (let index = 0; index < 1_005; index += 1) {
      state = reduceJobEvent(state, { type: "log", level: "info", message: `line ${index}` });
    }
    expect(state.logs).toHaveLength(1_000);
    expect(state.logs[0]?.message).toBe("line 5");
  });

  it("starts over on a reset and ignores progress without a namespace for namespace counts", () => {
    let state = reduceJobEvent(initialJobState(RUNNING_RESTORE), {
      type: "progress",
      documents: 3,
      estimatedDocuments: 9,
      bytes: 1,
    });
    expect(state.namespaces).toEqual([]);
    state = reduceJobEvent(state, { type: "reset", job: RUNNING_RESTORE });
    expect(state.progress).toBeUndefined();
  });
});
