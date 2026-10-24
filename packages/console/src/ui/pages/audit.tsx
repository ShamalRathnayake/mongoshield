/**
 * The audit log: who did what, when, to what, and whether it worked. Append-only on the
 * server; this page reads it newest first, 100 entries at a time (`before` paging), and
 * filters the loaded entries by actor, action and outcome.
 */

import { useState } from "react";
import type { AuditEntry } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { SelectField, TextField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi, useLoad } from "../context.tsx";

/** Entries per request. */
const PAGE_SIZE = 100;

/** True when an entry passes the filters. Text filters are case-insensitive substrings. */
export function auditMatches(
  entry: AuditEntry,
  filters: { actor: string; action: string; outcome: "all" | AuditEntry["outcome"] },
): boolean {
  const contains = (value: string | undefined, query: string) =>
    query === "" || (value ?? "").toLowerCase().includes(query.toLowerCase());
  return (
    contains(entry.actor, filters.actor) &&
    (contains(entry.action, filters.action) || contains(entry.target, filters.action)) &&
    (filters.outcome === "all" || entry.outcome === filters.outcome)
  );
}

/** The audit log page. */
export function AuditPage() {
  const client = useApi();
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<"all" | AuditEntry["outcome"]>("all");
  const [older, setOlder] = useState<readonly AuditEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);
  const [exhausted, setExhausted] = useState(false);
  const first = useLoad("audit", (signal) =>
    client.call("GET /api/audit", undefined, { query: { limit: PAGE_SIZE }, signal }),
  );

  const entries = [...(first.data ?? []), ...older];
  const rows = entries.filter((entry) => auditMatches(entry, { actor, action, outcome }));

  const loadOlder = async () => {
    const oldest = entries[entries.length - 1];
    if (oldest === undefined) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const page = await client.call("GET /api/audit", undefined, {
        query: { limit: PAGE_SIZE, before: oldest.at },
      });
      setOlder([...older, ...page]);
      if (page.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      setMoreError(describeError(error));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in and change, newest first. Entries cannot be edited or deleted."
      />
      <div className="toolbar">
        <TextField label="Actor" value={actor} onValue={setActor} placeholder="admin, schedule…" />
        <TextField
          label="Action or target"
          value={action}
          onValue={setAction}
          placeholder="restore, connection…"
        />
        <SelectField<"all" | AuditEntry["outcome"]>
          label="Outcome"
          value={outcome}
          options={[
            { value: "all", label: "Any outcome" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failure" },
          ]}
          onValue={setOutcome}
        />
      </div>
      {first.error !== undefined ? (
        <ErrorNotice error={first.error} onRetry={first.reload} />
      ) : null}
      {first.data === undefined ? (
        first.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <>
          <p className="muted" aria-live="polite">
            Showing {rows.length} of {entries.length} loaded entries.
          </p>
          <Table
            caption="Audit log entries"
            rows={rows}
            rowKey={(entry) => `${entry.at}|${entry.actor}|${entry.action}|${entry.target ?? ""}`}
            empty={<EmptyState title="No entries match the filters" />}
            columns={[
              { key: "at", header: "When", render: (entry) => <Time value={entry.at} /> },
              { key: "actor", header: "Actor", render: (entry) => entry.actor },
              { key: "action", header: "Action", render: (entry) => <code>{entry.action}</code> },
              {
                key: "target",
                header: "Target",
                render: (entry) => entry.target ?? <span className="muted">–</span>,
              },
              {
                key: "outcome",
                header: "Outcome",
                render: (entry) => <StatusBadge status={entry.outcome} />,
              },
              {
                key: "details",
                header: "Details",
                hideOnNarrow: true,
                render: (entry) =>
                  entry.details === undefined ? (
                    <span className="muted">–</span>
                  ) : (
                    <span className="mono details">
                      {Object.entries(entry.details)
                        .map(([key, value]) => `${key}=${String(value)}`)
                        .join(" ")}
                    </span>
                  ),
              },
            ]}
          />
          <div className="form-actions">
            {moreError === undefined ? null : <span className="field-error">{moreError}</span>}
            <Button
              onClick={() => void loadOlder()}
              busy={loadingMore}
              disabled={exhausted || (first.data.length < PAGE_SIZE && older.length === 0)}
            >
              {exhausted || first.data.length < PAGE_SIZE
                ? "No older entries"
                : "Load older entries"}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
