/**
 * One connection: its details, a connection test, and the namespace tree (databases and
 * collections with estimated document and index counts), marked with the backup plans
 * that include each collection, plus the Live data panel (browse link and the
 * "Allow live edits" settings, see live-settings.tsx).
 */

import { useState } from "react";
import type { ConnectionTestResult, DatabaseNode, PlanView } from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import {
  ErrorNotice,
  KeyValueList,
  Loading,
  PageHeader,
  Panel,
  Time,
} from "../components/layout.tsx";
import { NamespaceTree } from "../components/namespace-tree.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { isSelected } from "../namespaces.ts";
import { buildHref, segment } from "../router.ts";
import { ConnectionTestReport } from "./connections.tsx";
import { LiveDataPanel } from "./live-settings.tsx";

/** Props for `ConnectionDetailPage`. */
export interface ConnectionDetailPageProps {
  readonly connectionId: string;
}

/** The connection page with its namespace tree. */
export function ConnectionDetailPage(props: ConnectionDetailPageProps) {
  const client = useApi();
  const { hasRole } = useSession();
  const { connectionId } = props;
  const [test, setTest] = useState<{ result?: ConnectionTestResult; error?: unknown } | undefined>(
    undefined,
  );

  const details = useLoad(`connection:${connectionId}`, async (signal) => {
    const [connections, plans] = await Promise.all([
      client.call("GET /api/connections", undefined, { signal }),
      client.call("GET /api/plans", undefined, { signal }),
    ]);
    return { connection: connections.find((candidate) => candidate.id === connectionId), plans };
  });
  const tree = useLoad<readonly DatabaseNode[]>(`namespaces:${connectionId}`, (signal) =>
    client.call("GET /api/connections/:id/namespaces", undefined, {
      params: { id: connectionId },
      signal,
    }),
  );

  const runTest = async () => {
    setTest({});
    try {
      setTest({
        result: await client.call("POST /api/connections/:id/test", undefined, {
          params: { id: connectionId },
        }),
      });
    } catch (error) {
      setTest({ error });
    }
  };

  const breadcrumbs = [{ label: "Connections", href: "#/connections" }];
  if (details.error !== undefined)
    return <ErrorNotice error={details.error} onRetry={details.reload} />;
  if (details.data === undefined) return <Loading />;
  const { connection } = details.data;
  if (connection === undefined) {
    return (
      <>
        <PageHeader title="Connection not found" breadcrumbs={breadcrumbs} />
        <p>
          It may have been deleted. <a href="#/connections">Back to connections</a>
        </p>
      </>
    );
  }
  const plans = details.data.plans.filter((plan) => plan.connectionId === connectionId);
  const plansFor = (ns: string): PlanView[] =>
    plans.filter((plan) => isSelected(ns, plan.include, plan.exclude));

  return (
    <>
      <PageHeader
        title={connection.name}
        breadcrumbs={breadcrumbs}
        actions={
          hasRole("operator") ? (
            <Button
              onClick={() => void runTest()}
              busy={test !== undefined && test.result === undefined && test.error === undefined}
            >
              Test connection
            </Button>
          ) : undefined
        }
      />
      <div className="grid-2">
        <Panel title="Details">
          <KeyValueList
            items={[
              [
                "Connection string",
                <code key="uri" className="secret-preview">
                  {connection.uri.preview ?? "configured"}
                </code>,
              ],
              [
                "Production",
                connection.production ? <StatusBadge key="p" status="production" /> : "No",
              ],
              ["Added", <Time key="t" value={connection.createdAt} />],
              [
                "Backup plans",
                plans.length === 0 ? (
                  "None"
                ) : (
                  <span key="plans" className="comma-list">
                    {plans.map((plan) => (
                      <a key={plan.id} href={buildHref(`/plans/${segment(plan.id)}`)}>
                        {plan.name}
                      </a>
                    ))}
                  </span>
                ),
              ],
            ]}
          />
        </Panel>
        <Panel title="Connection test">
          {test === undefined ? (
            <p className="muted">
              Connects, reads the topology and checks the privileges needed for backups and
              restores.
            </p>
          ) : (
            <ConnectionTestReport result={test.result} error={test.error} />
          )}
        </Panel>
      </div>
      <LiveDataPanel connection={connection} onSaved={() => details.reload()} />
      <Panel
        title="Databases and collections"
        actions={
          <Button size="small" onClick={tree.reload}>
            Refresh
          </Button>
        }
      >
        {tree.error !== undefined ? <ErrorNotice error={tree.error} onRetry={tree.reload} /> : null}
        {tree.data === undefined ? (
          tree.error === undefined ? (
            <Loading label="Listing databases…" />
          ) : null
        ) : (
          <NamespaceTree
            tree={tree.data}
            annotateHeader="Backed up by"
            annotate={(ns) => {
              const using = plansFor(ns);
              return using.length === 0 ? (
                <span className="muted">No plan</span>
              ) : (
                <span className="comma-list">
                  {using.map((plan) => (
                    <a key={plan.id} href={buildHref(`/plans/${segment(plan.id)}`)}>
                      {plan.name}
                    </a>
                  ))}
                </span>
              );
            }}
          />
        )}
      </Panel>
    </>
  );
}
