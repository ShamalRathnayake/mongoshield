/**
 * The audit log: who did what, when, to what, and whether it worked. Append-only on the
 * server; this page reads it newest first, 100 entries at a time (`before` paging), and
 * filters the loaded entries.
 *
 * The filters are built from the loaded entries themselves, so each one only offers
 * values that are on screen (with how many entries have them) and they work for every
 * role (the user list is admin only):
 *
 *   Actor    a select of the users in the log, plus "schedule" (scheduled runs) and
 *            "anonymous" (failed sign-ins), which are always offered
 *   Action   a select grouped by family: "All session actions" (session.*), then
 *            session.login, session.login_failed, …
 *   Target   free text (part of a name or id is enough), suggesting the known targets
 *   Outcome  success or failure
 */

import { useState } from "react";
import type { AuditEntry } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { ComboboxField } from "../components/combobox.tsx";
import { Field, SelectField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi, useLoad } from "../context.tsx";
import {
  ANY,
  compareText,
  countValues,
  filterOptions,
  matchesChoice,
  type ValueCount,
  withCount,
} from "../filter-options.ts";
import { humanize } from "../format.ts";

/** Entries per request. */
const PAGE_SIZE = 100;

/** Actors that are not users, always offered in the Actor filter, with what they mean. */
export const SPECIAL_ACTORS: Readonly<Record<string, string>> = {
  schedule: "schedule: scheduled runs",
  anonymous: "anonymous: failed sign-ins",
};

/** The audit page's filters. Empty strings mean "no filter". */
export interface AuditFilters {
  /** An exact actor, or "" for anyone. */
  readonly actor: string;
  /** An exact action ("restore.start"), a family ("restore.*"), or "" for any. */
  readonly action: string;
  /** Part of the target, case-insensitive, or "" for any. */
  readonly target: string;
  readonly outcome: "all" | AuditEntry["outcome"];
}

/** Filters that let every entry through. */
export const NO_AUDIT_FILTERS: AuditFilters = {
  actor: ANY,
  action: ANY,
  target: "",
  outcome: "all",
};

/** The family of an action: the part before the first dot ("session.login" → "session"). */
export function actionFamily(action: string): string {
  const dot = action.indexOf(".");
  return dot === -1 ? action : action.slice(0, dot);
}

/** True when `action` passes the Action filter: any, the exact action, or its family ("x.*"). */
export function actionMatches(choice: string, action: string): boolean {
  if (choice === ANY) return true;
  if (choice.endsWith(".*")) return action.startsWith(choice.slice(0, -1));
  return choice === action;
}

/** True when an entry passes the filters. */
export function auditMatches(entry: AuditEntry, filters: AuditFilters): boolean {
  const target = filters.target.trim().toLowerCase();
  return (
    matchesChoice(filters.actor, entry.actor) &&
    actionMatches(filters.action, entry.action) &&
    (target === "" || (entry.target ?? "").toLowerCase().includes(target)) &&
    (filters.outcome === "all" || entry.outcome === filters.outcome)
  );
}

/** One family of actions for the Action select: "session" with its actions and counts. */
export interface ActionGroup {
  readonly family: string;
  /** Entries with any action of the family. */
  readonly total: number;
  readonly actions: readonly ValueCount[];
}

/** The loaded actions grouped by family, families A → Z, actions A → Z within each. */
export function groupActions(actions: Iterable<string>): ActionGroup[] {
  const groups = new Map<string, ValueCount[]>();
  for (const counted of countValues(actions)) {
    const family = actionFamily(counted.value);
    groups.set(family, [...(groups.get(family) ?? []), counted]);
  }
  return [...groups]
    .sort(([a], [b]) => compareText(a, b))
    .map(([family, members]) => ({
      family,
      actions: members,
      total: members.reduce((sum, member) => sum + member.count, 0),
    }));
}

/**
 * The Action select: "Any action", then one group per family. A family with several
 * actions starts with "All <family> actions" (value "family.*") so a whole area, e.g.
 * every sign-in event, can be shown at once. A native select with optgroups, so it
 * stays fully keyboard and screen reader friendly.
 */
function ActionSelect(props: {
  value: string;
  groups: readonly ActionGroup[];
  onValue: (value: string) => void;
}) {
  return (
    <Field label="Action">
      {(control) => (
        <select
          id={control.id}
          className="input select"
          value={props.value}
          aria-describedby={control.describedBy}
          onChange={(event) => props.onValue(event.currentTarget.value)}
        >
          <option value={ANY}>Any action</option>
          {props.groups.map((group) => (
            <optgroup key={group.family} label={humanize(group.family)}>
              {/* "All …" only helps when the family has more than one action. */}
              {group.actions.length > 1 ? (
                <option value={`${group.family}.*`}>
                  {withCount(`All ${group.family} actions`, group.total)}
                </option>
              ) : null}
              {group.actions.map((action) => (
                <option key={action.value} value={action.value}>
                  {withCount(action.value, action.count)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </Field>
  );
}

/** The audit log page. */
export function AuditPage() {
  const client = useApi();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [older, setOlder] = useState<readonly AuditEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);
  const [exhausted, setExhausted] = useState(false);
  const first = useLoad("audit", (signal) =>
    client.call("GET /api/audit", undefined, { query: { limit: PAGE_SIZE }, signal }),
  );

  const entries = [...(first.data ?? []), ...older];
  const rows = entries.filter((entry) => auditMatches(entry, filters));
  /** Changes one filter, keeping the others. */
  const setFilter = (change: Partial<AuditFilters>) => setFilters({ ...filters, ...change });
  const filtered =
    filters.actor !== ANY ||
    filters.action !== ANY ||
    filters.target !== "" ||
    filters.outcome !== "all";

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
        <SelectField
          label="Actor"
          value={filters.actor}
          options={filterOptions(
            entries.map((entry) => entry.actor),
            {
              any: "Anyone",
              always: Object.keys(SPECIAL_ACTORS),
              selected: filters.actor,
              labelFor: (actor) => SPECIAL_ACTORS[actor] ?? actor,
            },
          )}
          onValue={(actor) => setFilter({ actor })}
        />
        <ActionSelect
          value={filters.action}
          groups={groupActions(entries.map((entry) => entry.action))}
          onValue={(action) => setFilter({ action })}
        />
        <ComboboxField
          label="Target"
          value={filters.target}
          options={countValues(entries.map((entry) => entry.target)).map((target) => ({
            value: target.value,
            // How many loaded entries name this target, e.g. "3 entries".
            description: target.count === 1 ? "1 entry" : `${target.count} entries`,
          }))}
          listLabel="Known targets"
          onValue={(target) => setFilter({ target })}
          placeholder="Part of a name or id"
          inputMode="search"
        />
        <SelectField<"all" | AuditEntry["outcome"]>
          label="Outcome"
          value={filters.outcome}
          options={[
            { value: "all", label: "Any outcome" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failure" },
          ]}
          onValue={(outcome) => setFilter({ outcome })}
        />
        {filtered ? (
          <Button variant="ghost" onClick={() => setFilters(NO_AUDIT_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
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
