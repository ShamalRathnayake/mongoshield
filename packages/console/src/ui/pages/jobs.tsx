/**
 * Jobs: every backup, restore, verify, drill, prune and restore preview the console has
 * run or is running, newest first. Running jobs refresh every few seconds; open one for live
 * progress and logs.
 *
 * Filters: kind and status, plus plan, storage location and who started the job. The
 * last three are selects built from the loaded jobs (with how many jobs each has), named
 * through the plan and storage lists every role may read; a filter only appears once
 * some job has such a value.
 */

import { useEffect, useState } from "react";
import type { JobKind, JobStatus, JobSummary } from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import { SelectField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi, useLoad } from "../context.tsx";
import { ANY, filterOptions, matchesChoice } from "../filter-options.ts";
import { formatDuration, humanize } from "../format.ts";
import { buildHref, navigate, segment } from "../router.ts";

/** How often the list refreshes while something is running. */
const REFRESH_MS = 5_000;

/** The jobs page's filters. "all" and "" (ANY) mean "no filter". */
export interface JobFilters {
  readonly kind: JobKind | "all";
  readonly status: JobStatus | "all";
  /** A plan id, or "" for any. */
  readonly planId: string;
  /** A storage location id, or "" for any. */
  readonly storageId: string;
  /** A username or "schedule", or "" for anyone. */
  readonly startedBy: string;
}

/** Filters that let every job through. */
export const NO_JOB_FILTERS: JobFilters = {
  kind: "all",
  status: "all",
  planId: ANY,
  storageId: ANY,
  startedBy: ANY,
};

/** True when a job passes every filter. */
export function jobMatches(job: JobSummary, filters: JobFilters): boolean {
  return (
    (filters.kind === "all" || job.kind === filters.kind) &&
    (filters.status === "all" || job.status === filters.status) &&
    matchesChoice(filters.planId, job.planId) &&
    matchesChoice(filters.storageId, job.storageId) &&
    matchesChoice(filters.startedBy, job.startedBy)
  );
}

/** "Nightly production" for a known id; the id itself when the list has no such entry. */
function nameFrom(list: readonly { id: string; name: string }[] | undefined) {
  return (id: string) => list?.find((entry) => entry.id === id)?.name ?? id;
}

/** The jobs list. */
export function JobsPage() {
  const client = useApi();
  const [filters, setFilters] = useState<JobFilters>(NO_JOB_FILTERS);
  const jobs = useLoad("jobs", (signal) => client.call("GET /api/jobs", undefined, { signal }));
  // Only for naming the plan and storage options; the filters work without them (ids).
  const plans = useLoad("plans", (signal) => client.call("GET /api/plans", undefined, { signal }));
  const storage = useLoad("storage", (signal) =>
    client.call("GET /api/storage", undefined, { signal }),
  );
  const anyActive =
    jobs.data?.some((job) => job.status === "running" || job.status === "queued") === true;
  const { reload } = jobs;

  // Poll only while something is active; finished jobs don't change.
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [anyActive, reload]);

  const loaded = jobs.data ?? [];
  const rows = loaded.filter((job) => jobMatches(job, filters));
  /** Changes one filter, keeping the others. */
  const setFilter = (change: Partial<JobFilters>) => setFilters({ ...filters, ...change });
  const filtered = Object.entries(filters).some(
    ([key, value]) => value !== NO_JOB_FILTERS[key as keyof JobFilters],
  );
  // The derived filters, each shown only when some loaded job has such a value.
  const planOptions = filterOptions(
    loaded.map((job) => job.planId),
    { any: "Any plan", selected: filters.planId, labelFor: nameFrom(plans.data) },
  );
  const storageOptions = filterOptions(
    loaded.map((job) => job.storageId),
    { any: "Any storage", selected: filters.storageId, labelFor: nameFrom(storage.data) },
  );
  const starterOptions = filterOptions(
    loaded.map((job) => job.startedBy),
    {
      any: "Anyone",
      selected: filters.startedBy,
      labelFor: (by) => (by === "schedule" ? "schedule: scheduled runs" : by),
    },
  );

  return (
    <>
      <PageHeader title="Jobs" description="Backups, restores, verifies, drills and prunes." />
      <div className="toolbar">
        <SelectField<JobKind | "all">
          label="Kind"
          value={filters.kind}
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
          onValue={(kind) => setFilter({ kind })}
        />
        <SelectField<JobStatus | "all">
          label="Status"
          value={filters.status}
          options={[
            { value: "all", label: "Any status" },
            { value: "running", label: "Running" },
            { value: "queued", label: "Queued" },
            { value: "succeeded", label: "Succeeded" },
            { value: "failed", label: "Failed" },
            { value: "cancelled", label: "Cancelled" },
          ]}
          onValue={(status) => setFilter({ status })}
        />
        {/* More than "Any …" alone: some job has such a value, so the filter can help. */}
        {planOptions.length > 1 ? (
          <SelectField
            label="Plan"
            value={filters.planId}
            options={planOptions}
            onValue={(planId) => setFilter({ planId })}
          />
        ) : null}
        {storageOptions.length > 1 ? (
          <SelectField
            label="Storage"
            value={filters.storageId}
            options={storageOptions}
            onValue={(storageId) => setFilter({ storageId })}
          />
        ) : null}
        {starterOptions.length > 1 ? (
          <SelectField
            label="Started by"
            value={filters.startedBy}
            options={starterOptions}
            onValue={(startedBy) => setFilter({ startedBy })}
          />
        ) : null}
        {filtered ? (
          <Button variant="ghost" onClick={() => setFilters(NO_JOB_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
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
