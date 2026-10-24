/**
 * Backup plans: connection + storage + what to back up + how + when + how long to keep.
 * The list shows each plan's schedule in words, its last and next run, and "Run now".
 */

import { useState } from "react";
import type { PlanView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button, LinkButton } from "../components/button.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { describeCron } from "../cron.ts";
import { buildHref, navigate, segment } from "../router.ts";

/** The plans list. */
export function PlansPage() {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const [running, setRunning] = useState<string | undefined>(undefined);
  const state = useLoad("plans", async (signal) => {
    const [plans, connections, storage] = await Promise.all([
      client.call("GET /api/plans", undefined, { signal }),
      client.call("GET /api/connections", undefined, { signal }),
      client.call("GET /api/storage", undefined, { signal }),
    ]);
    return { plans, connections, storage };
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

  return (
    <>
      <PageHeader
        title="Backup plans"
        description="What to back up, where to, how often, and how long to keep it."
        actions={
          hasRole("admin") ? (
            <LinkButton href="#/plans/new" variant="primary">
              New plan
            </LinkButton>
          ) : undefined
        }
      />
      {state.error !== undefined ? (
        <ErrorNotice error={state.error} onRetry={state.reload} />
      ) : null}
      {state.data === undefined ? (
        state.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Backup plans"
          rows={state.data.plans}
          rowKey={(plan) => plan.id}
          onRowActivate={(plan) => navigate(`/plans/${segment(plan.id)}`)}
          empty={
            <EmptyState
              title="No backup plans yet"
              action={
                hasRole("admin") ? (
                  <LinkButton href="#/plans/new" variant="primary">
                    Create a plan
                  </LinkButton>
                ) : undefined
              }
            >
              You need at least one connection and one storage location first.
            </EmptyState>
          }
          columns={[
            {
              key: "name",
              header: "Plan",
              sortValue: (plan) => plan.name,
              render: (plan) => <a href={buildHref(`/plans/${segment(plan.id)}`)}>{plan.name}</a>,
            },
            {
              key: "source",
              header: "From → to",
              hideOnNarrow: true,
              render: (plan) => (
                <span>
                  {state.data?.connections.find((connection) => connection.id === plan.connectionId)
                    ?.name ?? plan.connectionId}
                  <span aria-hidden="true"> → </span>
                  <span className="visually-hidden"> to </span>
                  {state.data?.storage.find((location) => location.id === plan.storageId)?.name ??
                    plan.storageId}
                </span>
              ),
            },
            {
              key: "schedule",
              header: "Schedule",
              render: (plan) =>
                plan.schedule === undefined ? (
                  <StatusBadge status="manual" />
                ) : (
                  <span title={`${plan.schedule.cron} (${plan.schedule.timezone})`}>
                    {describeCron(plan.schedule.cron)}{" "}
                    <span className="muted">{plan.schedule.timezone}</span>
                  </span>
                ),
            },
            {
              key: "last",
              header: "Last run",
              render: (plan) =>
                plan.lastRun === undefined ? (
                  <span className="muted">Never</span>
                ) : (
                  <a className="stack" href={buildHref(`/jobs/${segment(plan.lastRun.id)}`)}>
                    <StatusBadge status={plan.lastRun.status} />
                    <Time value={plan.lastRun.finishedAt ?? plan.lastRun.startedAt} relativeOnly />
                  </a>
                ),
            },
            {
              key: "next",
              header: "Next run",
              sortValue: (plan) => plan.nextRunAt,
              render: (plan) => <Time value={plan.nextRunAt} relativeOnly />,
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
      )}
    </>
  );
}
