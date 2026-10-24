/**
 * One backup: what it contains and what you can do with it.
 *
 * Tabs: Summary (manifest summary + the raw manifest), Namespaces, Verification & drills,
 * Browse documents. Actions: Verify (fast or deep), Drill (a test restore into a
 * non-production connection), Hold / Release, and Restore (opens the wizard).
 * The current tab lives in the URL (`?tab=browse`) so it survives reloads and can be linked.
 */

import { type FormEvent, useState } from "react";
import type { BackupDetail, ConnectionView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button, LinkButton } from "../components/button.tsx";
import { CodeBlock } from "../components/code-block.tsx";
import { Dialog } from "../components/dialog.tsx";
import { SelectField, TextField } from "../components/field.tsx";
import {
  EmptyState,
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Panel,
  Tabs,
  Time,
} from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatBytes, formatDuration, formatNumber, humanize } from "../format.ts";
import { summarizeManifest } from "../manifest.ts";
import { buildHref, navigate, replaceQuery, segment } from "../router.ts";
import { ProtectionBadge, VerificationBadge } from "./backups.tsx";
import { DocumentBrowser } from "./document-browser.tsx";

const TABS = [
  { id: "summary", label: "Summary" },
  { id: "namespaces", label: "Namespaces" },
  { id: "history", label: "Verification & drills" },
  { id: "browse", label: "Browse documents" },
] as const;

/** Manifest topology values (FORMAT.md `source.topology`) in words. */
const TOPOLOGY_LABELS: Readonly<Record<string, string>> = {
  standalone: "Standalone",
  replicaSet: "Replica set",
  sharded: "Sharded cluster",
};

function topologyLabel(topology: string): string {
  return TOPOLOGY_LABELS[topology] ?? humanize(topology);
}

/** Props for `BackupDetailPage`. */
export interface BackupDetailPageProps {
  readonly storageId: string;
  readonly backupId: string;
  readonly tab?: string | undefined;
}

/** Which action dialog is open. */
type OpenDialog = "verify" | "drill" | "hold" | "release" | undefined;

/** The backup detail page. */
export function BackupDetailPage(props: BackupDetailPageProps) {
  const client = useApi();
  const { hasRole } = useSession();
  const { storageId, backupId } = props;
  // Reading documents out of a backup needs the operator role (server rule).
  const tabs = hasRole("operator") ? TABS : TABS.filter((candidate) => candidate.id !== "browse");
  const tab = tabs.some((candidate) => candidate.id === props.tab)
    ? (props.tab ?? "summary")
    : "summary";
  const [dialog, setDialog] = useState<OpenDialog>(undefined);

  const backup = useLoad(`backup:${storageId}:${backupId}`, (signal) =>
    client.call("GET /api/storage/:id/backups/:backupId", undefined, {
      params: { id: storageId, backupId },
      signal,
    }),
  );
  const storage = useLoad("storage", (signal) =>
    client.call("GET /api/storage", undefined, { signal }),
  );
  const storageName =
    storage.data?.find((location) => location.id === storageId)?.name ?? storageId;
  const breadcrumbs = [
    { label: "Backups", href: "#/backups" },
    { label: storageName, href: buildHref(`/backups/${segment(storageId)}`) },
  ];

  if (backup.error !== undefined && backup.data === undefined) {
    return (
      <>
        <PageHeader title={backupId} breadcrumbs={breadcrumbs} />
        <ErrorNotice
          error={backup.error}
          onRetry={backup.reload}
          title="Could not read the backup"
        />
      </>
    );
  }
  if (backup.data === undefined) return <Loading />;
  const detail = backup.data;
  const complete = detail.status === "complete";
  const summary = summarizeManifest(detail.manifest);

  return (
    <>
      <PageHeader
        title={<span className="mono">{detail.id}</span>}
        breadcrumbs={breadcrumbs}
        description={
          <span className="stack">
            <StatusBadge status={detail.status} />
            <VerificationBadge backup={detail} />
            <ProtectionBadge backup={detail} />
          </span>
        }
        actions={
          <>
            {hasRole("operator") && complete ? (
              <>
                <Button onClick={() => setDialog("verify")}>Verify…</Button>
                <Button onClick={() => setDialog("drill")}>Drill…</Button>
              </>
            ) : null}
            {/* Operators may place a hold; only admins may release one (server rule). */}
            {detail.hold === undefined && hasRole("operator") ? (
              <Button onClick={() => setDialog("hold")}>Hold…</Button>
            ) : null}
            {detail.hold !== undefined && hasRole("admin") ? (
              <Button onClick={() => setDialog("release")}>Release hold…</Button>
            ) : null}
            {hasRole("operator") && complete ? (
              <LinkButton
                variant="primary"
                href={buildHref(`/backups/${segment(storageId)}/${segment(backupId)}/restore`)}
              >
                Restore…
              </LinkButton>
            ) : null}
          </>
        }
      />
      {complete ? null : (
        <Notice tone="warning" title="This backup is not complete">
          It has no manifest: it is still running, crashed or was cancelled. It cannot be restored,
          and retention will delete it once it is clearly abandoned.
        </Notice>
      )}
      {detail.hold === undefined ? null : (
        <Notice tone="warning" title="On hold">
          {detail.hold.reason} — held since <Time value={detail.hold.heldAt} />. Retention will not
          delete it until released.
        </Notice>
      )}

      <Tabs
        label="Backup details"
        tabs={tabs}
        selected={tab}
        onSelect={(id) => replaceQuery({ tab: id })}
      >
        {tab === "summary" ? <SummaryTab detail={detail} /> : null}
        {tab === "namespaces" ? (
          <Table
            caption="Namespaces in this backup"
            rows={summary.namespaces}
            rowKey={(entry) => entry.ns}
            empty={<EmptyState title="No namespaces recorded" />}
            columns={[
              {
                key: "ns",
                header: "Namespace",
                sortValue: (entry) => entry.ns,
                render: (entry) => <span className="mono">{entry.ns}</span>,
              },
              { key: "type", header: "Type", render: (entry) => entry.type },
              {
                key: "documents",
                header: "Documents",
                align: "end",
                sortValue: (entry) => entry.documents,
                render: (entry) => formatNumber(entry.documents),
              },
              {
                key: "raw",
                header: "Data size",
                align: "end",
                sortValue: (entry) => entry.bytesRaw,
                render: (entry) => formatBytes(entry.bytesRaw),
              },
              {
                key: "stored",
                header: "Stored",
                align: "end",
                hideOnNarrow: true,
                sortValue: (entry) => entry.bytesStored,
                render: (entry) => formatBytes(entry.bytesStored),
              },
              {
                key: "browse",
                header: <span className="visually-hidden">Browse</span>,
                align: "end",
                render: (entry) =>
                  entry.type === "view" || !hasRole("operator") ? null : (
                    <a
                      href={buildHref(`/backups/${segment(storageId)}/${segment(backupId)}`, {
                        tab: "browse",
                      })}
                    >
                      Browse
                    </a>
                  ),
              },
            ]}
          />
        ) : null}
        {tab === "history" ? <HistoryTab detail={detail} /> : null}
        {tab === "browse" ? (
          complete ? (
            <DocumentBrowser
              storageId={storageId}
              backupId={backupId}
              namespaces={summary.namespaces}
              encrypted={detail.encrypted === true}
            />
          ) : (
            <EmptyState title="Incomplete backups cannot be browsed" />
          )
        ) : null}
      </Tabs>

      <VerifyDialog
        open={dialog === "verify"}
        storageId={storageId}
        backupId={backupId}
        onClose={() => setDialog(undefined)}
      />
      <DrillDialog
        open={dialog === "drill"}
        storageId={storageId}
        backupId={backupId}
        onClose={() => setDialog(undefined)}
      />
      <HoldDialog
        open={dialog === "hold" || dialog === "release"}
        release={dialog === "release"}
        storageId={storageId}
        backupId={backupId}
        onClose={() => setDialog(undefined)}
        onDone={backup.reload}
      />
    </>
  );
}

function SummaryTab(props: { detail: BackupDetail }) {
  const { detail } = props;
  const summary = summarizeManifest(detail.manifest);
  const duration =
    detail.completedAt === undefined
      ? undefined
      : new Date(detail.completedAt).getTime() - new Date(detail.startedAt).getTime();
  return (
    <>
      <div className="grid-2">
        <Panel title="Backup">
          <KeyValueList
            items={[
              ["Started", <Time key="s" value={detail.startedAt} />],
              ["Completed", <Time key="c" value={detail.completedAt} />],
              ["Duration", formatDuration(duration)],
              ["Namespaces", formatNumber(detail.namespaces)],
              ["Documents", formatNumber(detail.documents)],
              ["Data size", formatBytes(summary.bytesRaw)],
              ["Stored size", formatBytes(detail.bytesStored)],
            ]}
          />
        </Panel>
        <Panel title="Format">
          <KeyValueList
            items={[
              [
                "Source",
                summary.topology === undefined
                  ? "–"
                  : `${topologyLabel(summary.topology)}, MongoDB ${summary.serverVersion ?? "?"}`,
              ],
              ["Consistency", summary.consistencyMode ?? detail.consistency ?? "–"],
              ["Compression", summary.compression ?? "–"],
              [
                "Encryption",
                summary.encryption === undefined ? (
                  detail.encrypted ? (
                    "Yes"
                  ) : (
                    <span key="none" className="text-warning">
                      None
                    </span>
                  )
                ) : (
                  `${summary.encryption.scheme}, ${summary.encryption.recipients.length} recipient(s)`
                ),
              ],
              ["Written by", summary.tool ?? "–"],
              [
                "Labels",
                Object.keys(summary.labels).length === 0
                  ? "–"
                  : Object.entries(summary.labels)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(", "),
              ],
            ]}
          />
          {summary.consistencyWarning === undefined ? null : (
            <Notice tone="warning">{summary.consistencyWarning}</Notice>
          )}
        </Panel>
      </div>
      {detail.manifest === undefined ? null : (
        <details className="raw-manifest">
          <summary>Raw manifest</summary>
          <CodeBlock label="manifest.json" code={JSON.stringify(detail.manifest, null, 2)} />
        </details>
      )}
    </>
  );
}

function HistoryTab(props: { detail: BackupDetail }) {
  const { detail } = props;
  return (
    <div className="grid-2">
      <Panel title="Latest verification">
        {detail.verification === undefined ? (
          <EmptyState title="Not verified yet">
            A fast verify checks every file's size and SHA-256; a deep verify also decrypts and
            parses every document.
          </EmptyState>
        ) : (
          <KeyValueList
            items={[
              [
                "Result",
                <StatusBadge
                  key="r"
                  status={detail.verification.ok ? "verified" : "verify-failed"}
                />,
              ],
              ["Mode", detail.verification.mode],
              ["When", <Time key="w" value={detail.verification.verifiedAt} />],
            ]}
          />
        )}
      </Panel>
      <Panel title="Restore drills">
        <Table
          caption="Restore drills of this backup"
          rows={detail.drills}
          rowKey={(drill) => drill.drilledAt}
          empty={
            <EmptyState title="No drills yet">
              A drill restores the backup into a scratch connection and measures how long recovery
              takes.
            </EmptyState>
          }
          columns={[
            { key: "when", header: "When", render: (drill) => <Time value={drill.drilledAt} /> },
            {
              key: "result",
              header: "Result",
              render: (drill) => <StatusBadge status={drill.ok ? "succeeded" : "failed"} />,
            },
            {
              key: "rto",
              header: "Recovery time",
              align: "end",
              render: (drill) => formatDuration(drill.rtoMs),
            },
          ]}
        />
      </Panel>
    </div>
  );
}

function VerifyDialog(props: {
  open: boolean;
  storageId: string;
  backupId: string;
  onClose: () => void;
}) {
  const client = useApi();
  const toast = useToast();
  const [mode, setMode] = useState<"fast" | "deep">("fast");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const job = await client.call(
        "POST /api/storage/:id/backups/:backupId/verify",
        { mode },
        { params: { id: props.storageId, backupId: props.backupId } },
      );
      toast.show("success", `Started a ${mode} verify.`);
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      title="Verify backup"
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            Start verify
          </Button>
        </>
      }
    >
      <SelectField<"fast" | "deep">
        label="Mode"
        value={mode}
        options={[
          { value: "fast", label: "Fast: check sizes and checksums (no key needed)" },
          { value: "deep", label: "Deep: also decrypt and parse every document" },
        ]}
        onValue={setMode}
      />
    </Dialog>
  );
}

function DrillDialog(props: {
  open: boolean;
  storageId: string;
  backupId: string;
  onClose: () => void;
}) {
  const client = useApi();
  const toast = useToast();
  const connections = useLoad<readonly ConnectionView[]>(
    props.open ? "connections" : "",
    (signal) => client.call("GET /api/connections", undefined, { signal }),
  );
  // Drills overwrite their target, so production connections are never offered.
  const targets = (connections.data ?? []).filter((connection) => !connection.production);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = targetId === "" ? (targets[0]?.id ?? "") : targetId;

  const start = async () => {
    if (chosen === "") return;
    setBusy(true);
    try {
      const job = await client.call(
        "POST /api/storage/:id/backups/:backupId/drill",
        { targetConnectionId: chosen },
        { params: { id: props.storageId, backupId: props.backupId } },
      );
      toast.show("success", "Started a restore drill.");
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      title="Restore drill"
      description="Restores this backup into a scratch connection, checks it and measures the recovery time. The target's matching collections are replaced."
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={chosen === ""}
            onClick={() => void start()}
          >
            Start drill
          </Button>
        </>
      }
    >
      {connections.data === undefined ? (
        <Loading />
      ) : targets.length === 0 ? (
        <Notice tone="warning" title="No non-production connection">
          Add a staging or scratch connection first. Drills never run against production.
        </Notice>
      ) : (
        <SelectField
          label="Target connection"
          value={chosen}
          options={targets.map((connection) => ({ value: connection.id, label: connection.name }))}
          onValue={setTargetId}
          hint="Production connections are not listed."
        />
      )}
    </Dialog>
  );
}

function HoldDialog(props: {
  open: boolean;
  release: boolean;
  storageId: string;
  backupId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useApi();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const params = { id: props.storageId, backupId: props.backupId };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.release && reason.trim() === "") {
      setError("Say why the backup is held, e.g. a ticket number.");
      return;
    }
    setBusy(true);
    try {
      if (props.release)
        await client.call("DELETE /api/storage/:id/backups/:backupId/hold", undefined, { params });
      else
        await client.call(
          "POST /api/storage/:id/backups/:backupId/hold",
          { reason: reason.trim() },
          { params },
        );
      toast.show("success", props.release ? "Hold released." : "Backup is on hold.");
      setReason("");
      props.onClose();
      props.onDone();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      title={props.release ? "Release hold" : "Put backup on hold"}
      description={
        props.release
          ? "Retention may delete this backup once it is released."
          : "Retention never deletes a held backup until the hold is released."
      }
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant={props.release ? "danger" : "primary"}
            type="submit"
            form="hold-form"
            busy={busy}
          >
            {props.release ? "Release hold" : "Hold backup"}
          </Button>
        </>
      }
    >
      <form id="hold-form" onSubmit={submit} noValidate>
        {props.release ? (
          <p>{error ?? "Release the hold on this backup?"}</p>
        ) : (
          <TextField
            label="Reason"
            value={reason}
            onValue={setReason}
            data-autofocus
            placeholder="Legal hold: ticket SEC-1234"
            error={error}
          />
        )}
      </form>
    </Dialog>
  );
}
