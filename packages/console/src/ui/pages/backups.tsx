/**
 * Backups in one storage location (the catalog), newest first.
 *
 * Columns: id, date, status, size, documents, encrypted, verification and protection
 * (a hold, or write-once object lock until a date). Selecting a row opens the backup's
 * detail page with its namespaces, verification history, document browser and restore.
 *
 * Admins can also apply a plan's retention policy here ("Apply retention…"). Like a
 * restore, it is dry run first: the dialog shows which backups would be deleted and
 * why, and only the confirm button starts the `prune` job, passing exactly the ids
 * that were shown (the server refuses to delete anything else).
 */

import { useState } from "react";
import type { BackupSummary, PlanView, PrunePlanView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
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

/** "last 7, daily 14" for a retention policy. */
export function describeRetention(retention: NonNullable<PlanView["retention"]>): string {
  return Object.entries(retention)
    .map(([bucket, count]) => `${bucket} ${count}`)
    .join(", ");
}

/**
 * The dry run and confirmation of applying a plan's retention to this storage.
 * Only plans that write here and have a retention policy can be chosen.
 */
function PruneDialog(props: { storageId: string; storageName: string; onClose: () => void }) {
  const client = useApi();
  const toast = useToast();
  const plans = useLoad("plans", (signal) => client.call("GET /api/plans", undefined, { signal }));
  const eligible = (plans.data ?? []).filter(
    (plan) => plan.storageId === props.storageId && plan.retention !== undefined,
  );
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const planId = chosenId ?? eligible[0]?.id;
  const dryRun = useLoad(planId === undefined ? "" : `prune:${planId}`, () =>
    client.call("POST /api/plans/:id/prune/plan", undefined, { params: { id: planId ?? "" } }),
  );
  // A previous plan's dry run stays in `data` until the new one arrives; never show it.
  const preview = dryRun.data?.planId === planId ? dryRun.data : undefined;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const confirm = async () => {
    if (preview === undefined || planId === undefined) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const job = await client.call(
        "POST /api/plans/:id/prune",
        { remove: preview.remove.map((entry) => entry.id) },
        { params: { id: planId } },
      );
      toast.show("success", `Pruning started: deleting ${preview.remove.length} backup(s).`);
      props.onClose();
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      setFailure(error);
      toast.show("error", describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const removeCount = preview?.remove.length ?? 0;
  return (
    <Dialog
      open
      size="wide"
      title="Apply retention"
      description={`Deletes the backups in ${props.storageName} that a plan's retention policy no longer keeps.`}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={preview === undefined || removeCount === 0}
            busy={busy}
            onClick={() => void confirm()}
          >
            {`Delete ${removeCount} backup${removeCount === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      {plans.error !== undefined ? (
        <ErrorNotice error={plans.error} onRetry={plans.reload} />
      ) : null}
      {plans.data === undefined ? (
        plans.error === undefined ? (
          <Loading />
        ) : null
      ) : eligible.length === 0 ? (
        <Notice tone="info" title="No plan with a retention policy">
          No backup plan that writes to this storage has a retention policy. Add one in the plan
          editor to prune here.
        </Notice>
      ) : (
        <>
          <SelectField
            label="Retention of plan"
            value={planId ?? ""}
            options={eligible.map((plan) => ({
              value: plan.id,
              label: `${plan.name} (${describeRetention(plan.retention ?? {})})`,
            }))}
            onValue={setChosenId}
          />
          {dryRun.error !== undefined ? (
            <ErrorNotice error={dryRun.error} onRetry={dryRun.reload} title="Could not plan" />
          ) : null}
          {preview === undefined ? (
            dryRun.error === undefined ? (
              <Loading label="Planning…" />
            ) : null
          ) : (
            <PrunePreview preview={preview} />
          )}
          {failure === undefined ? null : <ErrorNotice error={failure} title="Could not prune" />}
        </>
      )}
    </Dialog>
  );
}

/** The dry run's warnings, its list of backups to delete, and what it leaves alone. */
function PrunePreview(props: { preview: PrunePlanView }) {
  const { preview } = props;
  return (
    <>
      {preview.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      <p>
        Keeps {preview.keep.length} backup{preview.keep.length === 1 ? "" : "s"}.{" "}
        {preview.remove.length === 0
          ? "Nothing to prune: the policy keeps every backup."
          : `Deletes ${preview.remove.length}:`}
      </p>
      {preview.remove.length === 0 ? null : (
        <ul className="plain-list" aria-label="Backups to delete">
          {preview.remove.map((entry) => (
            <li key={entry.id}>
              <code>{entry.id}</code> <span className="muted">({entry.reason})</span>
            </li>
          ))}
        </ul>
      )}
      {preview.outOfScope === 0 ? null : (
        <p className="muted">
          {preview.outOfScope} other backup{preview.outOfScope === 1 ? "" : "s"} in this storage
          (other plans or sources) {preview.outOfScope === 1 ? "is" : "are"} left alone: a
          plan&apos;s retention only applies to its own backups.
        </p>
      )}
    </>
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
  const { hasRole } = useSession();
  const [filter, setFilter] = useState<BackupFilter>("all");
  const [pruning, setPruning] = useState(false);
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
        {hasRole("admin") ? (
          <Button onClick={() => setPruning(true)}>Apply retention…</Button>
        ) : null}
      </div>
      {pruning ? (
        <PruneDialog
          storageId={storageId}
          storageName={current?.name ?? storageId}
          onClose={() => {
            setPruning(false);
            backups.reload();
          }}
        />
      ) : null}
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
