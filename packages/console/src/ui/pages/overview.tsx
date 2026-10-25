/**
 * Overview: is everything backed up, and what needs attention?
 *
 * Shows warnings first (failed runs, backups that are not verified or failed
 * verification, plans without a recent backup, incomplete backups), then every plan
 * with its last and next run and recovery point, then recent jobs. Everything is
 * computed from the plain list endpoints, so this page needs no special API.
 */

import { type ReactNode, useState } from "react";
import type { BackupSummary, JobSummary, PlanView, StorageView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button, LinkButton } from "../components/button.tsx";
import { Icon, type IconName } from "../components/icons.tsx";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Panel,
  Time,
} from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatBytes, formatNumber, humanize } from "../format.ts";
import { buildHref, navigate, segment } from "../router.ts";

/** A plan without a complete backup for this long gets a warning. 26 h tolerates a late nightly run. */
const RECENT_BACKUP_MS = 26 * 3_600_000;

/** Failed jobs from this window are listed as warnings. */
const RECENT_FAILURE_MS = 24 * 3_600_000;

/** Everything the overview needs, loaded together. */
interface OverviewData {
  readonly plans: readonly PlanView[];
  readonly jobs: readonly JobSummary[];
  readonly storage: readonly StorageView[];
  /** Backups per storage id; a storage that failed to list maps to an error message. */
  readonly backups: ReadonlyMap<string, readonly BackupSummary[] | string>;
}

/** One tile of the summary row: a label, a big value, a line of detail and a small chart. */
interface Tile {
  readonly label: string;
  readonly icon: IconName;
  readonly value: ReactNode;
  readonly detail: ReactNode;
  /** The tile's own color (styles.css `.stat-<color>`). */
  readonly color: "emerald" | "cyan" | "violet" | "amber";
  /** Replaces the color when the detail reports a problem. */
  readonly tone?: "danger" | "warning" | undefined;
  /** A small chart below the detail (decoration: the value and detail say it in words). */
  readonly chart?: ReactNode;
}

/** How many days the "Backups stored" bars cover. */
const SPARK_DAYS = 14;

/** Complete backups per calendar day (UTC) for the last `days` days, oldest first. */
export function backupsPerDay(
  startedAt: readonly string[],
  now: number,
  days = SPARK_DAYS,
): number[] {
  const DAY = 86_400_000;
  const today = Math.floor(now / DAY);
  const counts = new Array<number>(days).fill(0);
  for (const value of startedAt) {
    const index = days - 1 - (today - Math.floor(Date.parse(value) / DAY));
    if (index >= 0 && index < days) counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

/**
 * The row of four tiles at the top: when the last backup finished, how many backups
 * are stored (and their size), how many are verified, and the last day's jobs.
 * Everything is derived from the data the overview already loaded.
 */
function SummaryTiles(props: { data: OverviewData; storageName: (id: string) => string }) {
  const now = Date.now();
  // Every complete backup of every storage location that listed fine, with its storage.
  const complete: { backup: BackupSummary; storageId: string }[] = [];
  for (const [storageId, backups] of props.data.backups) {
    if (typeof backups === "string") continue;
    for (const backup of backups) {
      if (backup.status === "complete") complete.push({ backup, storageId });
    }
  }
  const newest = complete.reduce<(typeof complete)[number] | undefined>(
    (best, entry) =>
      best === undefined || entry.backup.startedAt > best.backup.startedAt ? entry : best,
    undefined,
  );
  const bytes = complete.reduce((sum, entry) => sum + (entry.backup.bytesStored ?? 0), 0);
  const verified = complete.filter((entry) => entry.backup.verification?.ok === true).length;
  const unverified = complete.length - verified;
  const verifiedPercent =
    complete.length === 0 ? 0 : Math.round((verified / complete.length) * 100);
  const lastDay = props.data.jobs.filter(
    (job) => job.startedAt !== undefined && now - Date.parse(job.startedAt) < RECENT_FAILURE_MS,
  );
  const succeeded = lastDay.filter((job) => job.status === "succeeded").length;
  const failed = lastDay.filter((job) => job.status === "failed").length;
  const otherJobs = lastDay.length - succeeded - failed;
  // Freshness: full right after a backup, empty once the 26 h window has passed.
  const newestAt = newest === undefined ? undefined : Date.parse(newest.backup.startedAt);
  const freshness =
    newestAt === undefined ? 0 : Math.max(0, 1 - (now - newestAt) / RECENT_BACKUP_MS);
  const perDay = backupsPerDay(
    complete.map((entry) => entry.backup.startedAt),
    now,
  );
  const busiestDay = Math.max(1, ...perDay);

  const tiles: readonly Tile[] = [
    {
      label: "Last backup",
      icon: "clock",
      color: "emerald",
      value:
        newest === undefined ? (
          "Never"
        ) : (
          <Time value={newest.backup.completedAt ?? newest.backup.startedAt} relativeOnly />
        ),
      detail:
        newest === undefined
          ? "No complete backup yet"
          : `in ${props.storageName(newest.storageId)}`,
      tone: newest === undefined ? "warning" : undefined,
      chart: (
        <div className="fresh-bar">
          <span style={{ width: `${Math.max(3, Math.round(freshness * 100))}%` }} />
        </div>
      ),
    },
    {
      label: "Backups stored",
      icon: "archive",
      color: "cyan",
      value: formatNumber(complete.length),
      detail: `${formatBytes(bytes)} across ${formatNumber(props.data.storage.length)} ${
        props.data.storage.length === 1 ? "location" : "locations"
      }`,
      chart: (
        <div className="spark">
          {perDay.map((count, day) => (
            <span
              // One bar per day of a fixed window: the position is the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above.
              key={day}
              className={count === 0 ? "spark-empty" : undefined}
              style={count === 0 ? undefined : { height: `${(count / busiestDay) * 100}%` }}
            />
          ))}
        </div>
      ),
    },
    {
      label: "Verified",
      icon: "shield",
      color: "violet",
      value: complete.length === 0 ? "–" : `${verifiedPercent}%`,
      detail:
        unverified === 0 ? "Every backup checked" : `${formatNumber(unverified)} not verified yet`,
      chart: (
        <span
          className="ring"
          style={{
            background: `conic-gradient(var(--stat-color) ${verifiedPercent}%, var(--color-border-strong) 0)`,
          }}
        />
      ),
    },
    {
      label: "Jobs, last 24 h",
      icon: "activity",
      color: "amber",
      value: formatNumber(lastDay.length),
      detail:
        failed === 0
          ? `${formatNumber(succeeded)} succeeded, none failed`
          : `${formatNumber(succeeded)} succeeded, ${formatNumber(failed)} failed`,
      tone: failed === 0 ? undefined : "danger",
      chart:
        lastDay.length === 0 ? (
          <div className="split-bar">
            <span className="split-other" style={{ flexGrow: 1 }} />
          </div>
        ) : (
          <div className="split-bar">
            {succeeded === 0 ? null : <span className="split-ok" style={{ flexGrow: succeeded }} />}
            {failed === 0 ? null : <span className="split-failed" style={{ flexGrow: failed }} />}
            {otherJobs === 0 ? null : (
              <span className="split-other" style={{ flexGrow: otherJobs }} />
            )}
          </div>
        ),
    },
  ];

  return (
    <dl className="stat-grid" aria-label="Summary">
      {tiles.map((tile) => (
        <div key={tile.label} className={`stat stat-${tile.tone ?? tile.color}`}>
          <dt className="stat-label">
            <span className="stat-icon">
              <Icon name={tile.icon} />
            </span>
            {tile.label}
          </dt>
          <dd className="stat-value">{tile.value}</dd>
          <dd className="stat-detail">{tile.detail}</dd>
          {tile.chart === undefined ? null : (
            <dd className="stat-chart" aria-hidden="true">
              {tile.chart}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/** One warning line. */
export interface OverviewWarning {
  readonly key: string;
  readonly tone: "failed" | "unverified" | "incomplete" | "verify-failed";
  readonly text: string;
  readonly href: string;
}

/** The newest complete backup in a list, if any. */
function latestComplete(backups: readonly BackupSummary[]): BackupSummary | undefined {
  let latest: BackupSummary | undefined;
  for (const backup of backups) {
    if (backup.status !== "complete") continue;
    if (latest === undefined || backup.startedAt > latest.startedAt) latest = backup;
  }
  return latest;
}

/** Works out what needs attention. Exported for tests. */
export function computeWarnings(data: OverviewData, now: number): OverviewWarning[] {
  const warnings: OverviewWarning[] = [];

  for (const job of data.jobs) {
    const finished = job.finishedAt === undefined ? 0 : new Date(job.finishedAt).getTime();
    if (job.status === "failed" && now - finished < RECENT_FAILURE_MS) {
      const plan = data.plans.find((candidate) => candidate.id === job.planId);
      warnings.push({
        key: `job-${job.id}`,
        tone: "failed",
        text: `${humanize(job.kind)} ${plan === undefined ? "" : `for "${plan.name}" `}failed: ${job.error?.message ?? "see the job log"}`,
        href: buildHref(`/jobs/${segment(job.id)}`),
      });
    }
  }

  for (const storage of data.storage) {
    const backups = data.backups.get(storage.id);
    if (typeof backups === "string") {
      warnings.push({
        key: `list-${storage.id}`,
        tone: "failed",
        text: `Could not list backups in "${storage.name}": ${backups}`,
        href: buildHref(`/backups/${segment(storage.id)}`),
      });
      continue;
    }
    if (backups === undefined) continue;
    const latest = latestComplete(backups);
    if (latest !== undefined && latest.verification === undefined) {
      warnings.push({
        key: `unverified-${storage.id}`,
        tone: "unverified",
        text: `The newest backup in "${storage.name}" has not been verified yet.`,
        href: buildHref(`/backups/${segment(storage.id)}/${segment(latest.id)}`),
      });
    }
    for (const backup of backups) {
      if (backup.verification?.ok === false) {
        warnings.push({
          key: `verify-${backup.id}`,
          tone: "verify-failed",
          text: `Backup ${backup.id} in "${storage.name}" failed verification.`,
          href: buildHref(`/backups/${segment(storage.id)}/${segment(backup.id)}`),
        });
      }
      if (backup.status === "incomplete") {
        warnings.push({
          key: `incomplete-${backup.id}`,
          tone: "incomplete",
          text: `Backup ${backup.id} in "${storage.name}" is incomplete (it crashed or is still running).`,
          href: buildHref(`/backups/${segment(storage.id)}/${segment(backup.id)}`),
        });
      }
    }
  }

  for (const plan of data.plans) {
    if (plan.schedule === undefined) continue;
    const backups = data.backups.get(plan.storageId);
    if (typeof backups !== "object") continue;
    const latest = latestComplete(backups);
    if (latest === undefined || now - new Date(latest.startedAt).getTime() > RECENT_BACKUP_MS) {
      warnings.push({
        key: `stale-${plan.id}`,
        tone: "failed",
        text: `"${plan.name}" has no complete backup from the last 26 hours.`,
        href: buildHref(`/plans/${segment(plan.id)}`),
      });
    }
  }
  return warnings;
}

/** The landing page after sign-in. */
export function OverviewPage() {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const [running, setRunning] = useState<string | undefined>(undefined);

  const state = useLoad<OverviewData>("overview", async (signal) => {
    const [plans, jobs, storage] = await Promise.all([
      client.call("GET /api/plans", undefined, { signal }),
      client.call("GET /api/jobs", undefined, { signal }),
      client.call("GET /api/storage", undefined, { signal }),
    ]);
    const entries = await Promise.all(
      storage.map(async (location): Promise<[string, readonly BackupSummary[] | string]> => {
        try {
          const list = await client.call("GET /api/storage/:id/backups", undefined, {
            params: { id: location.id },
            signal,
          });
          return [location.id, list];
        } catch (error) {
          // One unreachable bucket must not hide the rest of the overview.
          return [location.id, describeError(error)];
        }
      }),
    );
    return { plans, jobs, storage, backups: new Map(entries) };
  });

  const runNow = async (plan: PlanView) => {
    setRunning(plan.id);
    try {
      const job = await client.call("POST /api/plans/:id/run", undefined, {
        params: { id: plan.id },
      });
      toast.show("success", `Started a backup of "${plan.name}".`);
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setRunning(undefined);
    }
  };

  const header = (
    <PageHeader
      title="Overview"
      description="Backup health across every plan and storage location."
      actions={
        hasRole("admin") ? (
          <LinkButton href="#/plans/new" variant="primary">
            New backup plan
          </LinkButton>
        ) : undefined
      }
    />
  );

  if (state.error !== undefined && state.data === undefined) {
    return (
      <>
        {header}
        <ErrorNotice error={state.error} onRetry={state.reload} />
      </>
    );
  }
  if (state.data === undefined) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }

  const data = state.data;
  const warnings = computeWarnings(data, Date.now());
  const storageName = (id: string) =>
    data.storage.find((location) => location.id === id)?.name ?? id;
  const recoveryPoint = (plan: PlanView) => {
    const backups = data.backups.get(plan.storageId);
    return typeof backups === "object" ? latestComplete(backups) : undefined;
  };
  const upcoming = data.plans
    .filter((plan) => plan.nextRunAt !== undefined)
    .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));

  return (
    <>
      {header}
      <SummaryTiles data={data} storageName={storageName} />
      <Panel
        title={warnings.length === 0 ? "No warnings" : `Needs attention (${warnings.length})`}
        className={warnings.length === 0 ? "panel-ok" : "panel-alert"}
      >
        {warnings.length === 0 ? (
          <p className="all-good">
            <StatusBadge status="ok" label="All good" /> Every plan has a recent, verified backup.
          </p>
        ) : (
          <ul className="warning-list">
            {warnings.map((warning) => (
              <li key={warning.key}>
                <StatusBadge
                  status={
                    warning.tone === "unverified"
                      ? "unverified"
                      : warning.tone === "incomplete"
                        ? "incomplete"
                        : "failed"
                  }
                />
                <a href={warning.href}>{warning.text}</a>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Backup plans">
        <Table
          caption="Backup plans with their last run, next run and recovery point"
          rows={data.plans}
          rowKey={(plan) => plan.id}
          onRowActivate={(plan) => navigate(`/plans/${segment(plan.id)}`)}
          empty={
            <EmptyState title="No backup plans yet">
              A plan says what to back up, where to, how often and how long to keep it.
            </EmptyState>
          }
          columns={[
            {
              key: "name",
              header: "Plan",
              render: (plan) => <a href={buildHref(`/plans/${segment(plan.id)}`)}>{plan.name}</a>,
              sortValue: (plan) => plan.name,
            },
            {
              key: "last",
              header: "Last run",
              render: (plan) =>
                plan.lastRun === undefined ? (
                  <span className="muted">Never</span>
                ) : (
                  <span className="stack">
                    <StatusBadge status={plan.lastRun.status} />
                    <Time value={plan.lastRun.finishedAt ?? plan.lastRun.startedAt} relativeOnly />
                  </span>
                ),
            },
            {
              key: "next",
              header: "Next run",
              render: (plan) =>
                plan.nextRunAt === undefined ? (
                  <StatusBadge status="manual" />
                ) : (
                  <Time value={plan.nextRunAt} />
                ),
              sortValue: (plan) => plan.nextRunAt,
            },
            {
              key: "point",
              header: "Recovery point",
              hideOnNarrow: true,
              render: (plan) => <Time value={recoveryPoint(plan)?.completedAt} relativeOnly />,
            },
            {
              key: "storage",
              header: "Storage",
              hideOnNarrow: true,
              render: (plan) => (
                <a href={buildHref(`/backups/${segment(plan.storageId)}`)}>
                  {storageName(plan.storageId)}
                </a>
              ),
            },
            {
              key: "actions",
              header: <span className="visually-hidden">Actions</span>,
              align: "end",
              render: (plan) =>
                hasRole("operator") ? (
                  <Button
                    size="small"
                    busy={running === plan.id}
                    onClick={() => void runNow(plan)}
                    aria-label={`Run now ${plan.name}`}
                  >
                    Run now
                  </Button>
                ) : null,
            },
          ]}
        />
      </Panel>

      <div className="grid-2">
        <Panel title="Next runs">
          {upcoming.length === 0 ? (
            <EmptyState title="Nothing scheduled">
              Plans without a schedule only run when started by hand.
            </EmptyState>
          ) : (
            <ol className="plain-list">
              {upcoming.slice(0, 6).map((plan) => (
                <li key={plan.id} className="list-row">
                  <a href={buildHref(`/plans/${segment(plan.id)}`)}>{plan.name}</a>
                  <Time value={plan.nextRunAt} />
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title="Recent jobs" actions={<a href="#/jobs">All jobs</a>}>
          {data.jobs.length === 0 ? (
            <EmptyState title="No jobs yet" />
          ) : (
            <ul className="plain-list">
              {data.jobs.slice(0, 6).map((job) => (
                <li key={job.id} className="list-row">
                  <span className="stack">
                    <StatusBadge status={job.status} />
                    <a href={buildHref(`/jobs/${segment(job.id)}`)}>{humanize(job.kind)}</a>
                    <span className="muted">by {job.startedBy}</span>
                  </span>
                  <Time value={job.startedAt} relativeOnly />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
