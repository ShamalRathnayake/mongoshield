/**
 * One job with live progress: documents, bytes, ETA, per-namespace progress and the
 * log, streamed over Server-Sent Events (`GET /api/jobs/:id/events`), plus Cancel.
 *
 * `useJobEvents` folds the event stream into display state. It starts from the job as
 * loaded over REST, so a finished job renders immediately, and the server replays the
 * latest status/progress and the log when the stream (re)connects.
 */

import { useEffect, useReducer, useState } from "react";
import type { JobEvent, JobSummary } from "../../shared/api.ts";
import { describeError, isJobFinished, type StreamState } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import {
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Panel,
  Time,
} from "../components/layout.tsx";
import { ProgressBar } from "../components/progress-bar.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatBytes, formatDuration, formatNumber, humanize } from "../format.ts";
import { buildHref, segment } from "../router.ts";

/** Most log lines kept in the page; older ones are dropped to bound memory. */
const MAX_LOG_LINES = 1_000;

/** Progress of one namespace, derived from the stream. */
export interface NamespaceProgress {
  readonly ns: string;
  readonly documents: number;
  readonly state: "done" | "active";
}

/** Everything the job page shows, built from events. */
export interface JobLiveState {
  readonly job: JobSummary | undefined;
  readonly progress: Extract<JobEvent, { type: "progress" }> | undefined;
  readonly namespaces: readonly NamespaceProgress[];
  /** Total documents when the current namespace started, to count per namespace. */
  readonly namespaceStart: number;
  readonly logs: readonly {
    readonly level: string;
    readonly message: string;
    readonly at: string;
  }[];
}

/** The initial state for a job loaded over REST. */
export function initialJobState(job: JobSummary | undefined): JobLiveState {
  return { job, progress: undefined, namespaces: [], namespaceStart: 0, logs: [] };
}

/**
 * Folds one event into the state. Pure, so it is tested directly.
 * Per-namespace counts come from `progress.namespace`: when it changes, the previous
 * namespace is marked done and counting restarts for the new one.
 */
export function reduceJobEvent(
  state: JobLiveState,
  event: JobEvent | { type: "reset"; job: JobSummary },
): JobLiveState {
  switch (event.type) {
    case "reset":
      return initialJobState(event.job);
    case "status":
      return {
        ...state,
        job: event.job,
        // A finished job has no active namespace any more.
        namespaces: isJobFinished(event.job)
          ? state.namespaces.map((entry) => ({ ...entry, state: "done" }))
          : state.namespaces,
      };
    case "log": {
      const logs = [
        ...state.logs,
        { level: event.level, message: event.message, at: new Date().toISOString() },
      ];
      return { ...state, logs: logs.length > MAX_LOG_LINES ? logs.slice(-MAX_LOG_LINES) : logs };
    }
    case "progress": {
      let { namespaces, namespaceStart } = state;
      const current = namespaces[namespaces.length - 1];
      if (event.namespace !== undefined && event.namespace !== current?.ns) {
        // A new namespace started: close the previous one at the count reached so far.
        namespaces = [
          ...namespaces.map((entry) => ({ ...entry, state: "done" as const })),
          { ns: event.namespace, documents: 0, state: "active" },
        ];
        namespaceStart = state.progress?.documents ?? 0;
      }
      const last = namespaces[namespaces.length - 1];
      if (last !== undefined) {
        namespaces = [
          ...namespaces.slice(0, -1),
          { ...last, documents: Math.max(0, event.documents - namespaceStart) },
        ];
      }
      return { ...state, progress: event, namespaces, namespaceStart };
    }
  }
}

/** Subscribes to a job's events and returns the live state plus the stream's connection state. */
export function useJobEvents(
  jobId: string,
  loadedJob: JobSummary | undefined,
): { state: JobLiveState; stream: StreamState } {
  const client = useApi();
  const [state, dispatch] = useReducer(reduceJobEvent, loadedJob, initialJobState);
  const [stream, setStream] = useState<StreamState>("connecting");

  // When the REST copy arrives (or reloads), start from it.
  useEffect(() => {
    if (loadedJob !== undefined) dispatch({ type: "reset", job: loadedJob });
  }, [loadedJob]);

  const finished = loadedJob !== undefined && isJobFinished(loadedJob);
  useEffect(() => {
    // A job that had already finished when loaded needs no stream.
    if (finished) {
      setStream("closed");
      return;
    }
    return client.subscribeToJob(jobId, { onEvent: dispatch, onStateChange: setStream });
  }, [client, jobId, finished]);

  return { state, stream };
}

/** Props for `JobDetailPage`. */
export interface JobDetailPageProps {
  readonly jobId: string;
}

/** The job page. */
export function JobDetailPage(props: JobDetailPageProps) {
  const client = useApi();
  const loaded = useLoad(`job:${props.jobId}`, (signal) =>
    client.call("GET /api/jobs/:id", undefined, { params: { id: props.jobId }, signal }),
  );
  const breadcrumbs = [{ label: "Jobs", href: "#/jobs" }];
  if (loaded.error !== undefined && loaded.data === undefined) {
    return (
      <>
        <PageHeader title={`Job ${props.jobId}`} breadcrumbs={breadcrumbs} />
        <ErrorNotice error={loaded.error} onRetry={loaded.reload} />
      </>
    );
  }
  if (loaded.data === undefined) return <Loading />;
  return <JobLiveView jobId={props.jobId} loadedJob={loaded.data} />;
}

/** The live view of one job; also usable on its own (e.g. in tests). */
export function JobLiveView(props: { jobId: string; loadedJob: JobSummary }) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { state, stream } = useJobEvents(props.jobId, props.loadedJob);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const job = state.job ?? props.loadedJob;
  const { progress } = state;
  const active = job.status === "running" || job.status === "queued";

  const cancel = async () => {
    setCancelling(true);
    try {
      await client.call("POST /api/jobs/:id/cancel", undefined, { params: { id: job.id } });
      toast.show("info", "Cancelling the job…");
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  };

  const duration =
    job.startedAt === undefined
      ? undefined
      : (job.finishedAt === undefined ? Date.now() : new Date(job.finishedAt).getTime()) -
        new Date(job.startedAt).getTime();

  return (
    <>
      <PageHeader
        title={`${humanize(job.kind)} job`}
        breadcrumbs={[{ label: "Jobs", href: "#/jobs" }]}
        description={
          <span className="stack">
            <StatusBadge status={job.status} />
            <span className="mono muted">{job.id}</span>
            {active ? <span className="muted stream-state">{streamLabel(stream)}</span> : null}
          </span>
        }
        actions={
          active && hasRole("operator") ? (
            <Button variant="danger" onClick={() => setConfirmCancel(true)}>
              Cancel job
            </Button>
          ) : undefined
        }
      />

      {job.error === undefined ? null : (
        <Notice tone="danger" title={`Failed: ${job.error.code}`}>
          <p>{job.error.message}</p>
          {job.error.hint === undefined ? null : <p className="muted">{job.error.hint}</p>}
        </Notice>
      )}

      <div className="grid-2">
        <Panel title="Progress">
          {progress === undefined ? (
            active ? (
              <Loading label="Waiting for progress…" />
            ) : (
              <p className="muted">{job.summary ?? "No progress was reported."}</p>
            )
          ) : (
            <>
              <ProgressBar
                label="Documents"
                value={progress.documents}
                max={progress.estimatedDocuments}
                detail={`${formatNumber(progress.documents)} of ~${formatNumber(progress.estimatedDocuments)}`}
              />
              <KeyValueList
                items={[
                  ["Data processed", formatBytes(progress.bytes)],
                  ["Time remaining", active ? formatDuration(progress.etaMs) : "–"],
                  [
                    "Current namespace",
                    active ? (
                      <span key="ns" className="mono">
                        {progress.namespace ?? "–"}
                      </span>
                    ) : (
                      "–"
                    ),
                  ],
                ]}
              />
            </>
          )}
        </Panel>
        <Panel title="Details">
          <KeyValueList
            items={[
              ["Started", <Time key="s" value={job.startedAt} />],
              ["Finished", <Time key="f" value={job.finishedAt} />],
              ["Duration", formatDuration(duration)],
              ["Started by", job.startedBy],
              [
                "Plan",
                job.planId === undefined ? (
                  "–"
                ) : (
                  <a key="p" href={buildHref(`/plans/${segment(job.planId)}`)}>
                    {job.planId}
                  </a>
                ),
              ],
              [
                "Backup",
                job.storageId === undefined || job.backupId === undefined ? (
                  "–"
                ) : (
                  <a
                    key="b"
                    className="mono"
                    href={buildHref(`/backups/${segment(job.storageId)}/${segment(job.backupId)}`)}
                  >
                    {job.backupId}
                  </a>
                ),
              ],
              ["Result", job.summary ?? "–"],
            ]}
          />
        </Panel>
      </div>

      {state.namespaces.length === 0 ? null : (
        <Panel title="Namespaces">
          <ul className="namespace-progress">
            {state.namespaces.map((entry) => (
              <li key={entry.ns}>
                <StatusBadge
                  status={entry.state === "done" ? "succeeded" : "running"}
                  label={entry.state === "done" ? "Done" : "In progress"}
                />
                <span className="mono">{entry.ns}</span>
                <span className="numeric muted">{formatNumber(entry.documents)} documents</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Log">
        {state.logs.length === 0 ? (
          <p className="muted">
            {active ? "No log lines yet." : "No log lines were streamed for this job."}
          </p>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable log must be reachable by keyboard.
          <ol className="job-log" aria-live="polite" tabIndex={0} aria-label="Job log">
            {state.logs.map((line, index) => (
              // Log lines have no id and never reorder; the index is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              <li key={index} className={`log-line log-${line.level}`}>
                <span className="log-level">{line.level.toUpperCase()}</span> {line.message}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Dialog
        open={confirmCancel}
        title="Cancel this job?"
        description={
          job.kind === "restore"
            ? "Collections already restored stay as they are; the one in progress may be partly restored."
            : "The job stops as soon as possible. Partial output is cleaned up."
        }
        onClose={() => setConfirmCancel(false)}
        footer={
          <>
            <Button onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button variant="danger" busy={cancelling} onClick={() => void cancel()}>
              Cancel job
            </Button>
          </>
        }
      >
        <p>This cannot be undone.</p>
      </Dialog>
    </>
  );
}

function streamLabel(state: StreamState): string {
  switch (state) {
    case "connecting":
      return "Connecting to live updates…";
    case "live":
      return "Live";
    case "reconnecting":
      return "Reconnecting…";
    case "closed":
      return "";
  }
}
