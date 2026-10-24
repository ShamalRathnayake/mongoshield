/**
 * The restore wizard: choose → review the dry-run plan → confirm → live job.
 *
 * 1. Choose what to restore (namespaces), where to (target connection), rename rules
 *    (`shop.*=shop_restored.*`, like the CLI's --rename) and the mode for existing data.
 * 2. The server computes a dry-run plan (`POST /api/restore/plan`): every source → target
 *    namespace with document counts and what will happen. Conflicts (a target that
 *    already has documents) are highlighted, and a plan that would fail cannot be started.
 * 3. A restore into a connection marked "production" needs the connection's name typed
 *    exactly, and the admin role.
 * 4. Starting creates a job; the browser goes to its live progress page.
 *
 * Restoring selected documents (from the document browser) sends an `_id: {$in: …}`
 * Extended JSON filter. NOTE: `filter` is a proposed addition to `RestoreRequest`; until
 * the server supports it, the plan check below refuses to start when the server's plan
 * covers more documents than were selected, so a whole collection is never restored by
 * accident.
 */

import { type FormEvent, useState } from "react";
import type { ConnectionView, RestorePlanView, RestoreRequest } from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import {
  CheckboxField,
  FieldGroup,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/field.tsx";
import { ErrorNotice, Loading, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatNumber, plural } from "../format.ts";
import { summarizeManifest } from "../manifest.ts";
import { patternProblem } from "../namespaces.ts";
import { navigate, segment } from "../router.ts";
import { lines } from "./plan-editor.tsx";

/**
 * `RestoreRequest` plus the proposed `filter` (Extended JSON) used to restore only
 * selected documents. See the file header.
 */
export type RestoreRequestWithFilter = RestoreRequest & { readonly filter?: string };

/** Restore modes with the explanation shown next to them. */
const MODES: readonly { value: RestoreRequest["mode"]; label: string }[] = [
  { value: "fail-if-exists", label: "Stop if a target collection has data (safest)" },
  { value: "drop", label: "Drop existing target collections first" },
  { value: "insert", label: "Insert next to existing data (duplicate _id fails)" },
  { value: "upsert", label: "Upsert: replace documents with the same _id" },
];

/** Actions in a plan entry that mean "this will not work as asked". */
const BLOCKING_ACTIONS = new Set(["fail", "error", "conflict"]);

/**
 * Parses rename rules, one `from=to` per line. Returns the map or an error message.
 * Both sides must be valid namespace patterns.
 */
export function parseRenameRules(text: string): Record<string, string> | string {
  const rules: Record<string, string> = {};
  for (const line of lines(text)) {
    const equals = line.indexOf("=");
    if (equals <= 0) return `"${line}" is not from=to, e.g. shop.*=shop_restored.*`;
    const from = line.slice(0, equals).trim();
    const to = line.slice(equals + 1).trim();
    const problem = patternProblem(from) ?? patternProblem(to);
    if (problem !== undefined) return `"${line}": ${problem}.`;
    rules[from] = to;
  }
  return rules;
}

/** True when a plan entry is a conflict worth highlighting (existing data is affected or blocks). */
export function isConflict(entry: RestorePlanView["entries"][number]): boolean {
  return BLOCKING_ACTIONS.has(entry.action) || (entry.existingDocuments ?? 0) > 0;
}

/** Turns the `ids` query value (a JSON array of `_id`s) into a list, or undefined. */
function parseSelectedIds(text: string | undefined): unknown[] | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Props for `RestoreWizardPage`. */
export interface RestoreWizardPageProps {
  readonly storageId: string;
  readonly backupId: string;
  /** Preselects one namespace (from the document browser). */
  readonly namespace?: string | undefined;
  /** JSON array of selected `_id`s (from the document browser). */
  readonly documentIds?: string | undefined;
}

type Step = "choose" | "review";

/** The restore wizard page. */
export function RestoreWizardPage(props: RestoreWizardPageProps) {
  const client = useApi();
  const { storageId, backupId } = props;
  const state = useLoad(`restore:${storageId}:${backupId}`, async (signal) => {
    const [backup, connections] = await Promise.all([
      client.call("GET /api/storage/:id/backups/:backupId", undefined, {
        params: { id: storageId, backupId },
        signal,
      }),
      client.call("GET /api/connections", undefined, { signal }),
    ]);
    return { backup, connections };
  });
  const backupHref = `#/backups/${segment(storageId)}/${segment(backupId)}`;
  const breadcrumbs = [
    { label: "Backups", href: `#/backups/${segment(storageId)}` },
    { label: backupId, href: backupHref },
  ];
  if (state.error !== undefined) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Loading />;
  const namespaces = summarizeManifest(state.data.backup.manifest).namespaces.map(
    (entry) => entry.ns,
  );
  return (
    <>
      <PageHeader
        title="Restore"
        description={<span className="mono">{backupId}</span>}
        breadcrumbs={breadcrumbs}
      />
      <RestoreWizard
        {...props}
        namespaces={namespaces}
        connections={state.data.connections}
        encrypted={state.data.backup.encrypted === true}
        selectedIds={parseSelectedIds(props.documentIds)}
      />
    </>
  );
}

function RestoreWizard(
  props: RestoreWizardPageProps & {
    namespaces: readonly string[];
    connections: readonly ConnectionView[];
    encrypted: boolean;
    selectedIds: unknown[] | undefined;
  },
) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { selectedIds } = props;
  const preselected =
    props.namespace !== undefined && props.namespaces.includes(props.namespace)
      ? [props.namespace]
      : props.namespaces;

  const [step, setStep] = useState<Step>("choose");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(preselected));
  const [targetId, setTargetId] = useState(
    props.connections.find((connection) => !connection.production)?.id ??
      props.connections[0]?.id ??
      "",
  );
  const [renameText, setRenameText] = useState("");
  const [mode, setMode] = useState<RestoreRequest["mode"]>(
    selectedIds === undefined ? "fail-if-exists" : "upsert",
  );
  const [passphrase, setPassphrase] = useState("");
  const [plan, setPlan] = useState<RestorePlanView | undefined>(undefined);
  const [confirmName, setConfirmName] = useState("");
  const [errors, setErrors] = useState<{ namespaces?: string; rename?: string; target?: string }>(
    {},
  );
  const [requestError, setRequestError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const target = props.connections.find((connection) => connection.id === targetId);
  const rename = parseRenameRules(renameText);

  /** The request shared by the dry run and the real restore. */
  const buildRequest = (): RestoreRequestWithFilter | undefined => {
    const nextErrors: typeof errors = {};
    if (chosen.size === 0) nextErrors.namespaces = "Choose at least one namespace.";
    if (typeof rename === "string") nextErrors.rename = rename;
    if (target === undefined) nextErrors.target = "Choose a target connection.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || typeof rename === "string" || target === undefined)
      return undefined;
    const allChosen = chosen.size === props.namespaces.length;
    return {
      storageId: props.storageId,
      backupId: props.backupId,
      targetConnectionId: target.id,
      mode,
      // Exact namespaces are valid patterns; sending none means "everything".
      ...(allChosen ? {} : { include: [...chosen] }),
      ...(Object.keys(rename).length === 0 ? {} : { rename }),
      ...(passphrase === "" ? {} : { passphrase }),
      ...(selectedIds === undefined
        ? {}
        : { filter: JSON.stringify({ _id: { $in: selectedIds } }) }),
    };
  };

  const review = async (event: FormEvent) => {
    event.preventDefault();
    const request = buildRequest();
    if (request === undefined) return;
    setBusy(true);
    setRequestError(undefined);
    try {
      setPlan(await client.call("POST /api/restore/plan", request));
      setConfirmName("");
      setStep("review");
    } catch (error) {
      setRequestError(error);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const request = buildRequest();
    if (request === undefined || target === undefined) return;
    setBusy(true);
    setRequestError(undefined);
    try {
      const job = await client.call("POST /api/restore", {
        ...request,
        ...(target.production ? { confirmName } : {}),
      });
      toast.show("success", `Restore into "${target.name}" started.`);
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      setRequestError(error);
    } finally {
      setBusy(false);
    }
  };

  const plannedDocuments = plan?.entries.reduce((sum, entry) => sum + entry.documents, 0) ?? 0;
  const blocking = plan?.entries.filter((entry) => BLOCKING_ACTIONS.has(entry.action)) ?? [];
  const conflicts = plan?.entries.filter(isConflict) ?? [];
  // The server must have honoured the selection; otherwise refuse (see file header).
  const selectionIgnored = selectedIds !== undefined && plannedDocuments > selectedIds.length;
  const needsAdmin = target?.production === true && !hasRole("admin");
  const confirmed = target?.production !== true || confirmName === target.name;
  const canStart =
    plan !== undefined &&
    blocking.length === 0 &&
    !selectionIgnored &&
    !needsAdmin &&
    confirmed &&
    !busy;

  return (
    <>
      <ol className="stepper" aria-label="Restore steps">
        <li aria-current={step === "choose" ? "step" : undefined}>1. Choose</li>
        <li aria-current={step === "review" ? "step" : undefined}>2. Review plan and confirm</li>
        <li>3. Watch progress</li>
      </ol>

      {selectedIds === undefined ? null : (
        <Notice tone="info" title={`Restoring ${plural(selectedIds.length, "selected document")}`}>
          Only these documents from <code>{props.namespace}</code> are restored. Upsert replaces
          existing documents with the same <code>_id</code>.
        </Notice>
      )}

      {step === "choose" ? (
        <form onSubmit={review} noValidate className="form" aria-label="Restore options">
          <FieldGroup legend="What to restore">
            {errors.namespaces === undefined ? null : (
              <p className="field-error" role="alert">
                <span aria-hidden="true">! </span>
                {errors.namespaces}
              </p>
            )}
            <div className="checkbox-grid">
              {props.namespaces.map((ns) => (
                <CheckboxField
                  key={ns}
                  label={<span className="mono">{ns}</span>}
                  checked={chosen.has(ns)}
                  disabled={selectedIds !== undefined}
                  onChecked={(checked) => {
                    const next = new Set(chosen);
                    if (checked) next.add(ns);
                    else next.delete(ns);
                    setChosen(next);
                  }}
                />
              ))}
            </div>
          </FieldGroup>
          <FieldGroup legend="Where to">
            <SelectField
              label="Target connection"
              value={targetId}
              options={props.connections.map((connection) => ({
                value: connection.id,
                label: connection.production ? `${connection.name} — PRODUCTION` : connection.name,
              }))}
              onValue={setTargetId}
              error={errors.target}
            />
            {target?.production ? (
              <Notice tone="danger" title="This is a production connection">
                You will need to type its name to confirm
                {hasRole("admin") ? "" : ", and only admins can restore into production"}.
              </Notice>
            ) : null}
            <TextAreaField
              label="Rename rules (optional)"
              value={renameText}
              onValue={setRenameText}
              rows={2}
              spellCheck={false}
              placeholder="shop.*=shop_restored.*"
              hint="One from=to per line. Restoring next to the original data is the safest way to recover a few documents."
              error={errors.rename}
            />
            <SelectField
              label="If a target collection already has data"
              value={mode}
              options={MODES}
              onValue={setMode}
            />
          </FieldGroup>
          {props.encrypted ? (
            <FieldGroup legend="Decryption">
              <TextField
                label="Passphrase (optional)"
                type="password"
                autoComplete="off"
                value={passphrase}
                onValue={setPassphrase}
                hint="Only needed when the console does not already store a matching key."
              />
            </FieldGroup>
          ) : null}
          {requestError === undefined ? null : (
            <ErrorNotice error={requestError} title="Could not plan the restore" />
          )}
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={busy}>
              Review plan
            </Button>
          </div>
        </form>
      ) : null}

      {step === "review" && plan !== undefined ? (
        <>
          <Panel
            title={`Plan: ${plural(plan.entries.length, "namespace")}, ${formatNumber(plannedDocuments)} documents into ${target?.name ?? "?"}`}
          >
            {conflicts.length === 0 ? (
              <p>
                <StatusBadge status="ok" label="No conflicts" /> No target collection has existing
                data.
              </p>
            ) : (
              <Notice
                tone={blocking.length > 0 ? "danger" : "warning"}
                title={`${plural(conflicts.length, "conflict")} with existing data`}
              >
                {blocking.length > 0
                  ? "The restore would stop at the highlighted collections. Go back and choose another mode or rename the targets."
                  : "Existing data in the highlighted collections will be changed as described."}
              </Notice>
            )}
            {selectionIgnored ? (
              <Notice
                tone="danger"
                title="The server did not limit the restore to the selected documents"
              >
                The plan covers {formatNumber(plannedDocuments)} documents but{" "}
                {formatNumber(selectedIds?.length ?? 0)} were selected. Restoring selected documents
                is not supported by this server yet.
              </Notice>
            ) : null}
            <Table
              caption="Dry-run plan"
              rows={plan.entries}
              rowKey={(entry) => `${entry.from}->${entry.to}`}
              rowClassName={(entry) =>
                isConflict(entry)
                  ? BLOCKING_ACTIONS.has(entry.action)
                    ? "row-blocking"
                    : "row-conflict"
                  : undefined
              }
              columns={[
                {
                  key: "from",
                  header: "From",
                  render: (entry) => <span className="mono">{entry.from}</span>,
                },
                {
                  key: "to",
                  header: "To",
                  render: (entry) => <span className="mono">{entry.to}</span>,
                },
                {
                  key: "documents",
                  header: "Documents",
                  align: "end",
                  render: (entry) => formatNumber(entry.documents),
                },
                {
                  key: "existing",
                  header: "Already in target",
                  align: "end",
                  render: (entry) => formatNumber(entry.existingDocuments),
                },
                {
                  key: "action",
                  header: "Action",
                  render: (entry) => (
                    <span className="stack">
                      {BLOCKING_ACTIONS.has(entry.action) ? (
                        <StatusBadge status="failed" label={`Conflict: ${entry.action}`} />
                      ) : isConflict(entry) ? (
                        <StatusBadge status="incomplete" label={entry.action} />
                      ) : (
                        <StatusBadge status="ok" label={entry.action} />
                      )}
                      {entry.reason === undefined ? null : (
                        <span className="muted">{entry.reason}</span>
                      )}
                    </span>
                  ),
                },
              ]}
            />
          </Panel>

          {target?.production ? (
            <Panel title="Confirm restore into production">
              {needsAdmin ? (
                <Notice tone="danger" title="Admin role required">
                  Only admins can restore into a production connection.
                </Notice>
              ) : (
                <TextField
                  label={
                    <>
                      Type <strong>{target.name}</strong> to confirm
                    </>
                  }
                  value={confirmName}
                  onValue={setConfirmName}
                  autoComplete="off"
                  spellCheck={false}
                  error={
                    confirmName !== "" && confirmName !== target.name
                      ? "The name does not match."
                      : undefined
                  }
                />
              )}
            </Panel>
          ) : null}

          {requestError === undefined ? null : (
            <ErrorNotice error={requestError} title="Could not start the restore" />
          )}
          <div className="form-actions">
            <Button onClick={() => setStep("choose")}>Back</Button>
            <Button
              variant={target?.production ? "danger" : "primary"}
              disabled={!canStart}
              busy={busy}
              onClick={() => void start()}
            >
              Start restore
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}
