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
          onValue={(value) => replaceQuery({ connection: value === "" ? undefined : value })}
        />
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
          rows={entries.data}
          rowKey={(entry) => entry.id}
          empty={
            <EmptyState title="No live edits yet">
              Changes made in the live data browser show up here, with undo.
            </EmptyState>
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
