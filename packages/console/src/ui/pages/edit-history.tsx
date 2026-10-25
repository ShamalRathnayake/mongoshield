/**
 * Edit history (`#/edit-history?connection=<id>`): every change made from the live data
 * browser, newest first, with undo.
 *
 * Each entry is backed by the live edit journal: before the console changed a document,
 * it stored the document's previous state (sealed with the console's key). Undo puts
 * that state back, but only if the document is still exactly as the edit left it; if
 * someone changed it since, undo refuses instead of overwriting their change. An undo is
 * itself an entry (undoing it redoes the edit). Single documents are undone at once;
 * bulk edits are undone by a job.
 *
 * Reading the history needs the operator role; undoing needs the `data:write`
 * permission (and live edits still allowed on the connection, checked by the server).
 *
 * Filters: the connection (asks the server for that connection's entries only), then
 * database, collection, who and what kind of change, all selects built from the loaded
 * entries (with how many entries each has). The collection select lists the chosen
 * database's collections, or every namespace while no database is chosen.
 */

import { useState } from "react";
import type { LiveEditEntryView, LiveEditOp, LiveEditStatus } from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import { EjsonTree } from "../components/code-block.tsx";
import { Dialog } from "../components/dialog.tsx";
import { SelectField } from "../components/field.tsx";
import {
  EmptyState,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Time,
} from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { isJsonObject, parseDocument } from "../ejson.ts";
import { ANY, filterOptions, matchesChoice } from "../filter-options.ts";
import { formatNumber } from "../format.ts";
import { buildHref, replaceQuery, segment } from "../router.ts";
import { canEditLiveData } from "./live-editor.tsx";

/** Words for each operation. */
export const OP_LABELS: Readonly<Record<LiveEditOp, string>> = {
  insert: "Insert",
  update: "Edit",
  delete: "Delete",
  "bulk-update": "Update many",
  "bulk-delete": "Delete many",
  undo: "Undo",
};

/** Each entry status as a badge: a StatusBadge tone plus our own word. */
const STATUS_BADGES: Readonly<Record<LiveEditStatus, { status: string; label: string }>> = {
  applied: { status: "success", label: "Applied" },
  pending: { status: "queued", label: "Pending" },
  partial: { status: "incomplete", label: "Partly applied" },
  conflict: { status: "incomplete", label: "Conflict" },
  failed: { status: "failed", label: "Failed" },
};

/** Props for `EditHistoryPage`. */
export interface EditHistoryPageProps {
  /** Only this connection's entries (the `connection` query parameter). */
  readonly connectionId?: string | undefined;
}

/** The page's filters on the loaded entries. "" (ANY) means "no filter". */
export interface EditHistoryFilters {
  /** A database name. */
  readonly database: string;
  /** A whole namespace, `db.collection`. */
  readonly ns: string;
  /** Who made the change. */
  readonly by: string;
  /** The kind of change. */
  readonly op: LiveEditOp | typeof ANY;
}

/** Filters that let every entry through. */
export const NO_EDIT_FILTERS: EditHistoryFilters = { database: ANY, ns: ANY, by: ANY, op: ANY };

/** The database part of a namespace: everything before the first dot. */
export function databaseOf(ns: string): string {
  const dot = ns.indexOf(".");
  return dot === -1 ? ns : ns.slice(0, dot);
}

/** The collection part of a namespace (collection names may contain dots themselves). */
export function collectionOf(ns: string): string {
  const dot = ns.indexOf(".");
  return dot === -1 ? "" : ns.slice(dot + 1);
}

/** True when an entry passes the filters. */
export function editMatches(entry: LiveEditEntryView, filters: EditHistoryFilters): boolean {
  return (
    matchesChoice(filters.database, databaseOf(entry.ns)) &&
    matchesChoice(filters.ns, entry.ns) &&
    matchesChoice(filters.by, entry.by) &&
    matchesChoice(filters.op, entry.op)
  );
}

/**
 * The selects that narrow the loaded entries. Every option comes from the entries, so
 * nothing offered matches nothing; the chosen collection belongs to the chosen database.
 */
function EditFilters(props: {
  entries: readonly LiveEditEntryView[];
  filters: EditHistoryFilters;
  onFilters: (filters: EditHistoryFilters) => void;
}) {
  const { entries, filters, onFilters } = props;
  // Collections are offered for the chosen database only (or all, while none is chosen).
  const inDatabase = entries.filter((entry) =>
    matchesChoice(filters.database, databaseOf(entry.ns)),
  );
  return (
    <>
      <SelectField
        label="Database"
        value={filters.database}
        options={filterOptions(
          entries.map((entry) => databaseOf(entry.ns)),
          { any: "All databases", selected: filters.database },
        )}
        onValue={(database) => {
          // A collection of another database would leave the table empty: forget it.
          const keepNs = database === ANY || databaseOf(filters.ns) === database;
          onFilters({ ...filters, database, ns: keepNs ? filters.ns : ANY });
        }}
      />
      <SelectField
        label="Collection"
        value={filters.ns}
        options={filterOptions(
          inDatabase.map((entry) => entry.ns),
          {
            any: "All collections",
            selected: filters.ns,
            // Within one database the collection name says enough; otherwise db.collection.
            labelFor: (ns) => (filters.database === ANY ? ns : collectionOf(ns)),
          },
        )}
        onValue={(ns) =>
          // Choosing a collection also chooses its database, so the two always agree.
          onFilters({ ...filters, ns, database: ns === ANY ? filters.database : databaseOf(ns) })
        }
      />
      <SelectField
        label="Who"
        value={filters.by}
        options={filterOptions(
          entries.map((entry) => entry.by),
          { any: "Anyone", selected: filters.by },
        )}
        onValue={(by) => onFilters({ ...filters, by })}
      />
      <SelectField<LiveEditOp | typeof ANY>
        label="Change"
        value={filters.op}
        options={[
          { value: ANY, label: "Any change" },
          // Every kind of change, in the order of OP_LABELS, with its count.
          ...(Object.keys(OP_LABELS) as LiveEditOp[])
            .map((op) => ({ op, count: entries.filter((entry) => entry.op === op).length }))
            .filter(({ op, count }) => count > 0 || op === filters.op)
            .map(({ op, count }) => ({ value: op, label: `${OP_LABELS[op]} (${count})` })),
        ]}
        onValue={(op) => onFilters({ ...filters, op })}
      />
      {Object.values(filters).some((value) => value !== ANY) ? (
        <Button variant="ghost" onClick={() => onFilters(NO_EDIT_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </>
  );
}

/** What a row shows in the Document column. */
function documentsLabel(entry: LiveEditEntryView): string {
  if (entry.documentId !== undefined) return entry.documentId;
  return entry.documents === 1 ? "1 document" : `${formatNumber(entry.documents)} documents`;
}

/** The Edit history page. */
export function EditHistoryPage(props: EditHistoryPageProps) {
  const client = useApi();
  const toast = useToast();
  const { user } = useSession();
  const mayUndo = canEditLiveData(user);
  const connectionId = props.connectionId ?? "";
  const connections = useLoad("connections", (signal) =>
    client.call("GET /api/connections", undefined, { signal }),
  );
  const entries = useLoad(`live-edits:${connectionId}`, (signal) =>
    client.call("GET /api/live-edits", undefined, {
      query: { connectionId: connectionId === "" ? undefined : connectionId },
      signal,
    }),
  );
  const [undoing, setUndoing] = useState<LiveEditEntryView | undefined>(undefined);
  const [details, setDetails] = useState<LiveEditEntryView | undefined>(undefined);
  const [jobLink, setJobLink] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<EditHistoryFilters>(NO_EDIT_FILTERS);
  const rows = (entries.data ?? []).filter((entry) => editMatches(entry, filters));

  return (
    <>
      <PageHeader
        title="Edit history"
        description="Every change made from the live data browser. The previous state of each document was saved before it changed, so an edit can be undone while the document is still as the edit left it."
      />
      <div className="toolbar">
        <SelectField
          label="Connection"
          value={connectionId}
          options={[
            { value: "", label: "All connections" },
            ...(connections.data ?? []).map((connection) => ({
              value: connection.id,
              label: connection.name,
            })),
          ]}
          onValue={(value) => {
            // Another connection has other databases: start those filters afresh.
            setFilters({ ...filters, database: ANY, ns: ANY });
            replaceQuery({ connection: value === "" ? undefined : value });
          }}
        />
        {entries.data === undefined || entries.data.length === 0 ? null : (
          <EditFilters entries={entries.data} filters={filters} onFilters={setFilters} />
        )}
      </div>
      {jobLink === undefined ? null : (
        <Notice tone="info" title="Undo is running as a job">
          <a href={jobLink}>Follow the undo job</a>
        </Notice>
      )}
      {entries.error !== undefined ? (
        <ErrorNotice error={entries.error} onRetry={entries.reload} />
      ) : null}
      {entries.data === undefined ? (
        entries.error === undefined ? (
          <Loading />
        ) : null
      ) : (
        <Table
          caption="Live edits"
          rows={rows}
          rowKey={(entry) => entry.id}
          empty={
            entries.data.length === 0 ? (
              <EmptyState title="No live edits yet">
                Changes made in the live data browser show up here, with undo.
              </EmptyState>
            ) : (
              <EmptyState title="No edits match the filters" />
            )
          }
          columns={[
            {
              key: "at",
              header: "When",
              sortValue: (entry) => entry.at,
              render: (entry) => <Time value={entry.at} relativeOnly />,
            },
            {
              key: "by",
              header: "Who",
              sortValue: (entry) => entry.by,
              render: (entry) => entry.by,
            },
            {
              key: "connection",
              header: "Connection",
              hideOnNarrow: true,
              render: (entry) =>
                entry.connectionName === undefined ? (
                  <span className="muted">(deleted)</span>
                ) : (
                  <a
                    href={buildHref(`/connections/${segment(entry.connectionId)}/data`, {
                      ns: entry.ns,
                    })}
                  >
                    {entry.connectionName}
                  </a>
                ),
            },
            {
              key: "ns",
              header: "Namespace",
              render: (entry) => <span className="mono">{entry.ns}</span>,
            },
            {
              key: "op",
              header: "Change",
              render: (entry) => (
                <>
                  {OP_LABELS[entry.op]}
                  {entry.undoneBy === undefined ? null : <span className="muted"> (undone)</span>}
                </>
              ),
            },
            {
              key: "document",
              header: "Document",
              render: (entry) => <span className="mono">{documentsLabel(entry)}</span>,
            },
            {
              key: "status",
              header: "Status",
              render: (entry) => {
                const badge = STATUS_BADGES[entry.status];
                const skipped =
                  entry.conflicts > 0 ? `, ${formatNumber(entry.conflicts)} skipped` : "";
                return (
                  <StatusBadge
                    status={badge.status}
                    label={`${badge.label}${skipped}`}
                    {...(entry.error === undefined ? {} : { title: entry.error.message })}
                  />
                );
              },
            },
            {
              key: "actions",
              header: <span className="visually-hidden">Actions</span>,
              align: "end",
              render: (entry) => (
                <span className="row-actions">
                  <Button
                    size="small"
                    aria-label={`Details of ${OP_LABELS[entry.op].toLowerCase()} of ${documentsLabel(entry)} in ${entry.ns}`}
                    onClick={() => setDetails(entry)}
                  >
                    Details
                  </Button>
                  {mayUndo && entry.undoable ? (
                    <Button
                      size="small"
                      aria-label={`Undo ${OP_LABELS[entry.op].toLowerCase()} of ${documentsLabel(entry)} in ${entry.ns}`}
                      onClick={() => setUndoing(entry)}
                    >
                      Undo
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      )}
      {undoing === undefined ? null : (
        <UndoDialog
          entry={undoing}
          onClose={() => setUndoing(undefined)}
          onDone={(result) => {
            setUndoing(undefined);
            if (result.kind === "applied") {
              toast.show("success", "Undone. The document is back to its previous state.");
            } else {
              setJobLink(buildHref(`/jobs/${segment(result.jobId)}`));
              toast.show("info", "Undo started as a job.");
            }
            entries.reload();
          }}
        />
      )}
      {details === undefined ? null : (
        <DetailsDialog entry={details} onClose={() => setDetails(undefined)} />
      )}
    </>
  );
}

/** Confirms and runs an undo; shows a conflict (or any refusal) inside the dialog. */
function UndoDialog(props: {
  entry: LiveEditEntryView;
  onClose: () => void;
  onDone: (result: { kind: "applied" } | { kind: "job"; jobId: string }) => void;
}) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const { entry } = props;

  const undo = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await client.call("POST /api/live-edits/:id/undo", undefined, {
        params: { id: entry.id },
      });
      props.onDone(
        result.kind === "applied" ? { kind: "applied" } : { kind: "job", jobId: result.job.id },
      );
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Undo this edit?"
      description={`${OP_LABELS[entry.op]} of ${documentsLabel(entry)} in ${entry.ns} by ${entry.by}. Each document is restored only if it is still as this edit left it.`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void undo()}>
            Undo edit
          </Button>
        </>
      }
    >
      <p>The undo is journaled too, so you can undo it again to redo the edit.</p>
      {error === undefined ? null : <ErrorNotice error={error} title="Not undone" />}
    </Dialog>
  );
}

/** One entry with its journaled documents, before and after. */
function DetailsDialog(props: { entry: LiveEditEntryView; onClose: () => void }) {
  const client = useApi();
  const detail = useLoad(`live-edit:${props.entry.id}`, (signal) =>
    client.call("GET /api/live-edits/:id", undefined, { params: { id: props.entry.id }, signal }),
  );
  const show = (text: string | undefined, absent: string) => {
    if (text === undefined) return <p className="muted">{absent}</p>;
    const parsed = parseDocument(text);
    return parsed === undefined || !isJsonObject(parsed) ? (
      <pre className="mono">{text}</pre>
    ) : (
      <EjsonTree value={parsed} />
    );
  };
  return (
    <Dialog
      open
      size="wide"
      title={`${OP_LABELS[props.entry.op]} in ${props.entry.ns}`}
      onClose={props.onClose}
    >
      {detail.error !== undefined ? (
        <ErrorNotice error={detail.error} onRetry={detail.reload} />
      ) : null}
      {detail.data === undefined ? (
        detail.error === undefined ? (
          <Loading label="Reading the journal…" />
        ) : null
      ) : (
        <>
          {detail.data.beforeHash === undefined && detail.data.afterHash === undefined ? null : (
            <p className="muted mono live-hashes">
              {detail.data.beforeHash === undefined
                ? ""
                : `before ${detail.data.beforeHash.slice(0, 16)}… `}
              {detail.data.afterHash === undefined
                ? ""
                : `after ${detail.data.afterHash.slice(0, 16)}…`}
            </p>
          )}
          {detail.data.records.length === 0 ? (
            <EmptyState title="Nothing journaled">This entry changed no documents.</EmptyState>
          ) : (
            <ol className="live-records" aria-label="Journaled documents">
              {detail.data.records.map((record) => (
                <li key={record.id} className="live-record">
                  <p className="mono">{record.id}</p>
                  <div className="grid-2">
                    <section>
                      <h3>Before</h3>
                      {show(record.before, "Did not exist (inserted).")}
                    </section>
                    <section>
                      <h3>After</h3>
                      {show(record.after, "Deleted.")}
                    </section>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {detail.data.truncated ? (
            <Notice tone="info">Only the first documents are shown.</Notice>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
