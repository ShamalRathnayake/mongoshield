/**
 * Backups in one storage location (the catalog), newest first.
 *
 * Columns: id, date, status, size, documents, encrypted, verification and protection
 * (a hold, or write-once object lock until a date). Selecting a row opens the backup's
 * detail page with its namespaces, verification history, document browser and restore.
 */

import { useState } from "react";
import type { BackupSummary } from "../../shared/api.ts";
import { SelectField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, PageHeader, Time } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi, useLoad } from "../context.tsx";
import { formatBytes, formatCompact, formatDateTime } from "../format.ts";
import { buildHref, navigate, segment } from "../router.ts";

/** Quick filters above the table. */
type BackupFilter = "all" | "complete" | "problems" | "unverified" | "protected";

/** True when a backup passes the quick filter. */
export function backupMatchesFilter(backup: BackupSummary, filter: BackupFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "complete":
      return backup.status === "complete";
    case "problems":
      return backup.status !== "complete" || backup.verification?.ok === false;
    case "unverified":
      return backup.status === "complete" && backup.verification === undefined;
    case "protected":
      return backup.hold !== undefined || isImmutable(backup);
  }
}

function isImmutable(backup: BackupSummary): boolean {
  return (
    backup.immutableUntil !== undefined && new Date(backup.immutableUntil).getTime() > Date.now()
  );
}

/** The verification cell: verified (mode), failed, or not verified. */
export function VerificationBadge(props: { backup: BackupSummary }) {
  const { verification } = props.backup;
  if (props.backup.status !== "complete") return <span className="muted">–</span>;
  if (verification === undefined) return <StatusBadge status="unverified" />;
  return verification.ok ? (
    <StatusBadge
      status="verified"
      label={`Verified (${verification.mode})`}
      title={`Verified ${formatDateTime(verification.verifiedAt)}`}
    />
  ) : (
    <StatusBadge
      status="verify-failed"
      title={`Failed ${formatDateTime(verification.verifiedAt)}`}
    />
  );
}

/** The protection cell: on hold and/or immutable until a date. */
export function ProtectionBadge(props: { backup: BackupSummary }) {
  const { backup } = props;
  const parts = [];
  if (backup.hold !== undefined)
    parts.push(<StatusBadge key="hold" status="held" title={backup.hold.reason} />);
  if (isImmutable(backup)) {
    parts.push(
      <span
        key="lock"
        className="lock-label"
        title={`Object lock until ${formatDateTime(backup.immutableUntil)}`}
      >
        <span aria-hidden="true">🔒 </span>Locked until {formatDateTime(backup.immutableUntil)}
      </span>,
    );
  }
  return parts.length === 0 ? (
    <span className="muted">–</span>
  ) : (
    <span className="stack">{parts}</span>
  );
}

/** Props for `BackupsPage`. */
export interface BackupsPageProps {
  /** Storage to list; defaults to the first one. */
  readonly storageId?: string | undefined;
}

/** The backup catalog of one storage location. */
export function BackupsPage(props: BackupsPageProps) {
  const client = useApi();
  const [filter, setFilter] = useState<BackupFilter>("all");
  const storage = useLoad("storage", (signal) =>
    client.call("GET /api/storage", undefined, { signal }),
  );
  const storageId = props.storageId ?? storage.data?.[0]?.id;
  const backups = useLoad(storageId === undefined ? "" : `backups:${storageId}`, (signal) =>
    client.call("GET /api/storage/:id/backups", undefined, {
      params: { id: storageId ?? "" },
      signal,
    }),
  );

  if (storage.error !== undefined)
    return <ErrorNotice error={storage.error} onRetry={storage.reload} />;
  if (storage.data === undefined) return <Loading />;
  if (storage.data.length === 0 || storageId === undefined) {
    return (
      <>
        <PageHeader title="Backups" />
        <EmptyState title="No storage locations" action={<a href="#/storage">Add storage</a>}>
          Backups are listed per storage location.
        </EmptyState>
      </>
    );
  }
  const current = storage.data.find((location) => location.id === storageId);
  const rows = (backups.data ?? []).filter((backup) => backupMatchesFilter(backup, filter));

  return (
    <>
      <PageHeader
        title="Backups"
        description={current === undefined ? undefined : <code>{current.url}</code>}
      />
      <div className="toolbar">
        <SelectField
          label="Storage"
          value={storageId}
          options={storage.data.map((location) => ({ value: location.id, label: location.name }))}
          onValue={(value) => navigate(`/backups/${segment(value)}`)}
        />
        <SelectField<BackupFilter>
          label="Show"
          value={filter}
          options={[
            { value: "all", label: "All backups" },
            { value: "complete", label: "Complete only" },
            { value: "problems", label: "Problems (incomplete, invalid, failed verification)" },
            { value: "unverified", label: "Not verified yet" },
            { value: "protected", label: "On hold or locked" },
          ]}
          onValue={setFilter}
        />
      </div>
      {backups.error !== undefined ? (
        <ErrorNotice
          error={backups.error}
          onRetry={backups.reload}
          title="Could not list backups"
        />
      ) : null}
      {backups.data === undefined ? (
        backups.error === undefined ? (
          <Loading label="Reading the catalog…" />
        ) : null
      ) : (
        <Table
          caption={`Backups in ${current?.name ?? storageId}`}
          rows={rows}
          rowKey={(backup) => backup.id}
          initialSort={{ key: "date", direction: "descending" }}
          onRowActivate={(backup) =>
            navigate(`/backups/${segment(storageId)}/${segment(backup.id)}`)
          }
          empty={
            <EmptyState
              title={filter === "all" ? "No backups here yet" : "No backups match this filter"}
            >
              {filter === "all"
                ? "Run a plan that writes to this storage to create the first one."
                : null}
            </EmptyState>
          }
          columns={[
            {
              key: "id",
              header: "Backup",
              render: (backup) => (
                <a
                  className="mono"
                  href={buildHref(`/backups/${segment(storageId)}/${segment(backup.id)}`)}
                >
                  {backup.id}
                </a>
              ),
            },
            {
              key: "date",
              header: "Started",
              sortValue: (backup) => backup.startedAt,
              render: (backup) => <Time value={backup.startedAt} />,
            },
            {
              key: "status",
              header: "Status",
              sortValue: (backup) => backup.status,
              render: (backup) => <StatusBadge status={backup.status} />,
            },
            {
              key: "size",
              header: "Size",
              align: "end",
              sortValue: (backup) => backup.bytesStored,
              render: (backup) => formatBytes(backup.bytesStored),
            },
            {
              key: "documents",
              header: "Documents",
              align: "end",
              hideOnNarrow: true,
              sortValue: (backup) => backup.documents,
              render: (backup) => formatCompact(backup.documents),
            },
            {
              key: "encrypted",
              header: "Encrypted",
              hideOnNarrow: true,
              render: (backup) =>
                backup.encrypted === undefined ? (
                  <span className="muted">–</span>
                ) : backup.encrypted ? (
                  "Yes"
                ) : (
                  <span className="text-warning">No</span>
                ),
            },
            {
              key: "verification",
              header: "Verification",
              render: (backup) => <VerificationBadge backup={backup} />,
            },
            {
              key: "protected",
              header: "Protected",
              hideOnNarrow: true,
              render: (backup) => <ProtectionBadge backup={backup} />,
            },
          ]}
        />
      )}
    </>
  );
}
