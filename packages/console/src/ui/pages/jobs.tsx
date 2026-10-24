/**
 * Jobs: every backup, restore, verify, drill, prune and restore preview the console has
 * run or is running, newest first. Running jobs refresh every few seconds; open one for live
 * progress and logs.
 */

import { useEffect, useState } from "react";
import type { JobKind, JobStatus } from "../../shared/api.ts";
import { SelectField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi, useLoad } from "../context.tsx";
import { formatDuration, humanize } from "../format.ts";
import { buildHref, navigate, segment } from "../router.ts";

/** How often the list refreshes while something is running. */
const REFRESH_MS = 5_000;

/** The jobs list. */
export function JobsPage() {
  const client = useApi();
  const [kind, setKind] = useState<JobKind | "all">("all");
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const jobs = useLoad("jobs", (signal) => client.call("GET /api/jobs", undefined, { signal }));
  const anyActive =
    jobs.data?.some((job) => job.status === "running" || job.status === "queued") === true;
  const { reload } = jobs;

  // Poll only while something is active; finished jobs don't change.
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyActive, reload]);

  const rows = (jobs.data ?? []).filter(
    (job) => (kind === "all" || job.kind === kind) && (status === "all" || job.status === status),
  );

  return (
    <>
      <PageHeader title="Jobs" description="Backups, restores, verifies, drills and prunes." />
      <div className="toolbar">
        <SelectField<JobKind | "all">
          label="Kind"
          value={kind}
          options={[
            { value: "all", label: "All kinds" },
            { value: "backup", label: "Backup" },
            { value: "restore", label: "Restore" },
            { value: "verify", label: "Verify" },
            { value: "drill", label: "Drill" },
            { value: "prune", label: "Prune" },
            { value: "preview", label: "Restore preview" },
            { value: "live-edit", label: "Live edit" },
          ]}
          onValue={setKind}
        />
        <SelectField<JobStatus | "all">
          label="Status"
          value={status}
          options={[
            { value: "all", label: "Any status" },
            { value: "running", label: "Running" },
            { value: "queued", label: "Queued" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
            { value: "cancelled", label: "Cancelled" },
          ]}
          onValue={setStatus}
        />
      </div>
      {jobs.error !== undefined ? <ErrorNotice error={jobs.error} onRetry={jobs.reload} /> : null}
      {jobs.data === undefined ? (
        jobs.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Jobs"
          rows={rows}
          rowKey={(job) => job.id}
          onRowActivate={(job) => navigate(`/jobs/${segment(job.id)}`)}
          empty={<EmptyState title="No jobs match" />}
          columns={[
            {
              key: "kind",
              header: "Job",
              render: (job) => (
                <a href={buildHref(`/jobs/${segment(job.id)}`)}>
                  {humanize(job.kind)} <span className="muted mono">{job.id}</span>
                </a>
              ),
            },
            {
              key: "status",
              header: "Status",
              sortValue: (job) => job.status,
              render: (job) => <StatusBadge status={job.status} />,
            },
            {
              key: "started",
              header: "Started",
              sortValue: (job) => job.startedAt,
              render: (job) => <Time value={job.startedAt} />,
            },
            {
              key: "duration",
              header: "Duration",
              align: "end",
              hideOnNarrow: true,
              render: (job) =>
                job.startedAt === undefined || job.finishedAt === undefined ? (
                  <span className="muted">–</span>
                ) : (
                  formatDuration(
                    new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime(),
                  )
                ),
            },
            { key: "by", header: "Started by", hideOnNarrow: true, render: (job) => job.startedBy },
            {
              key: "summary",
              header: "Result",
              render: (job) =>
                job.error?.message ?? job.summary ?? <span className="muted">–</span>,
            },
          ]}
        />
      )}
    </>
  );
}
