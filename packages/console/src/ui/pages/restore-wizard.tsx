/**
 * The restore wizard: choose → review the dry-run plan → preview the changes → confirm
 * → live job.
 *
 * 1. Choose what to restore (namespaces), where to (target connection), rename rules
 *    (`shop.*=shop_restored.*`, like the CLI's --rename) and the mode for existing data.
 * 2. The server computes a dry-run plan (`POST /api/restore/plan`): every source → target
 *    namespace with document counts and what will happen. Conflicts (a target that
 *    already has documents) are highlighted, and a plan that would fail cannot be started.
 * 3. "Preview changes" compares the backup with the target's live data, read only
 *    (`POST /api/restore/preview`, a job; restore-preview.tsx shows it): per namespace
 *    which documents would be added, replaced or deleted, index and option differences,
 *    and a field-by-field view of single documents. It can be skipped (big restores
 *    take a while to compare), and it is not offered for selected documents, whose plan
 *    already counts them. Leaving the step cancels a preview that is still running.
 * 4. Confirm: a restore into a connection marked "production" needs the connection's
 *    name typed exactly, and the admin role.
 * 5. Starting creates a job; the browser goes to its live progress page.
 *
 * Restoring selected documents (from the document browser) sends an `_id: {$in: …}`
 * Extended JSON filter (`RestoreRequest.filter`). As a safety net the review step still
 * refuses to start when the server's plan covers more documents than were selected, so
 * a whole collection is never restored by accident.
 *
 * Encrypted backups are read with a key the console stores (a plan's passphrase) or
 * with keys typed here: a passphrase, or age private keys for backups encrypted to
 * public keys, which the console never stores. Typed keys are sent with the plan and
 * the restore request only and are cleared once the restore has started.
 */

import { type FormEvent, useEffect, useRef, useState } from "react";
import type {
  ConnectionView,
  JobStatus,
  RestorePlanView,
  RestoreRequest,
} from "../../shared/api.ts";
import { isJobFinished } from "../api.ts";
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
import { RestorePreviewStep } from "./restore-preview.tsx";

/** Why a typed private key is not an age identity, or undefined when every key is one. */
export function identitiesProblem(identities: readonly string[]): string | undefined {
  const invalid = identities.find((line) => !/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(line));
  return invalid === undefined ? undefined : "That is not an age private key (AGE-SECRET-KEY-1…).";
}

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

type Step = "choose" | "review" | "preview" | "confirm";

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
  const [identitiesText, setIdentitiesText] = useState("");
  const [plan, setPlan] = useState<RestorePlanView | undefined>(undefined);
  /** The running or finished preview, with the request it compared. */
  const [preview, setPreview] = useState<
    { readonly jobId: string; readonly request: RestoreRequest } | undefined
  >(undefined);
  const [previewStatus, setPreviewStatus] = useState<JobStatus>("queued");
  const [confirmName, setConfirmName] = useState("");
  const [errors, setErrors] = useState<{
    namespaces?: string;
    rename?: string;
    target?: string;
    identities?: string;
  }>({});
  const [requestError, setRequestError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const stepChanged = useRef(false);

  // Changing step unmounts the focused button; without this, focus would fall to
  // <body> and keyboard users would start again from the top of the page. On the
  // first render the shell has already focused the page heading.
  useEffect(() => {
    if (!stepChanged.current) {
      stepChanged.current = true;
      return;
    }
    if (step === "review") reviewHeading.current?.focus();
    else if (step === "preview") previewHeading.current?.focus();
    else if (step === "confirm") confirmHeading.current?.focus();
    else reviewButton.current?.focus();
  }, [step]);

  const target = props.connections.find((connection) => connection.id === targetId);
  const rename = parseRenameRules(renameText);
  // Masked input, so several keys are separated by spaces rather than lines.
  const identities = identitiesText.split(/\s+/).filter((key) => key !== "");

  /** The request shared by the dry run and the real restore. */
  const buildRequest = (): RestoreRequest | undefined => {
    const nextErrors: typeof errors = {};
    if (chosen.size === 0) nextErrors.namespaces = "Choose at least one namespace.";
    if (typeof rename === "string") nextErrors.rename = rename;
    if (target === undefined) nextErrors.target = "Choose a target connection.";
    const identitiesError = identitiesProblem(identities);
    if (identitiesError !== undefined) nextErrors.identities = identitiesError;
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
      ...(identities.length === 0 ? {} : { identities }),
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
      // A new plan needs a new preview.
      setPreview(undefined);
      setStep("review");
    } catch (error) {
      setRequestError(error);
    } finally {
      setBusy(false);
    }
  };

  /** Starts the preview job of the reviewed plan's request and opens its step. */
  const startPreview = async () => {
    const request = buildRequest();
    if (request === undefined) return;
    setBusy(true);
    setRequestError(undefined);
    try {
      const job = await client.call("POST /api/restore/preview", request);
      setPreview({ jobId: job.id, request });
      setPreviewStatus(job.status);
      setStep("preview");
    } catch (error) {
      setRequestError(error);
    } finally {
      setBusy(false);
    }
  };

  /** Leaves the preview step; a preview still running is cancelled (it would only load the target). */
  const leavePreview = (next: Step) => {
    if (preview !== undefined && !isJobFinished({ status: previewStatus })) {
      client
        .call("POST /api/jobs/:id/cancel", undefined, { params: { id: preview.jobId } })
        .catch(() => undefined);
    }
    setRequestError(undefined);
    setStep(next);
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
      // The keys are not needed any more; do not keep them in memory.
      setPassphrase("");
      setIdentitiesText("");
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
  // A plan that would fail (or ignored the selection) goes no further than the review.
  const canProceed =
    plan !== undefined && blocking.length === 0 && !selectionIgnored && !needsAdmin;
  const canStart = canProceed && confirmed && !busy;
  // Selected documents have no preview: their plan already counts what is replaced.
  const previewAvailable = selectedIds === undefined;

  return (
    <>
      <ol className="stepper" aria-label="Restore steps">
        <li aria-current={step === "choose" ? "step" : undefined}>1. Choose</li>
        <li aria-current={step === "review" ? "step" : undefined}>2. Review plan</li>
        <li aria-current={step === "preview" ? "step" : undefined}>
          3. Preview changes{previewAvailable ? "" : " (not for selected documents)"}
        </li>
        <li aria-current={step === "confirm" ? "step" : undefined}>4. Confirm</li>
        <li>5. Watch progress</li>
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
              <TextField
                label="Private key (optional)"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={identitiesText}
                onValue={setIdentitiesText}
                placeholder="AGE-SECRET-KEY-1…"
                hint="For backups encrypted to public keys: the matching age private key (several separated by spaces). Used for this restore only, never stored."
                error={errors.identities}
              />
            </FieldGroup>
          ) : null}
          {requestError === undefined ? null : (
            <ErrorNotice error={requestError} title="Could not plan the restore" />
          )}
          <div className="form-actions">
            {/* The server refuses even to plan a restore into production for non-admins
                (the notice above says why), so do not offer a request that must fail. */}
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={needsAdmin}
              ref={reviewButton}
            >
              Review plan
            </Button>
          </div>
        </form>
      ) : null}

      {step === "review" && plan !== undefined ? (
        <>
          <Panel
            titleRef={reviewHeading}
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

          {requestError === undefined ? null : (
            <ErrorNotice error={requestError} title="Could not start the preview" />
          )}
          <div className="form-actions">
            <Button onClick={() => setStep("choose")}>Back</Button>
            {previewAvailable ? (
              <>
                <Button disabled={!canProceed || busy} onClick={() => setStep("confirm")}>
                  Skip preview
                </Button>
                <Button
                  variant="primary"
                  disabled={!canProceed}
                  busy={busy}
                  onClick={() => void startPreview()}
                >
                  Preview changes
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={!canProceed} onClick={() => setStep("confirm")}>
                Continue
              </Button>
            )}
          </div>
        </>
      ) : null}

      {step === "preview" && preview !== undefined ? (
        <>
          <RestorePreviewStep
            jobId={preview.jobId}
            request={preview.request}
            targetName={target?.name ?? "the target"}
            titleRef={previewHeading}
            onStatus={setPreviewStatus}
          />
          <div className="form-actions">
            <Button onClick={() => leavePreview("review")}>Back</Button>
            <Button variant="primary" onClick={() => leavePreview("confirm")}>
              {isJobFinished({ status: previewStatus }) ? "Continue" : "Skip the rest"}
            </Button>
          </div>
        </>
      ) : null}

      {step === "confirm" && plan !== undefined ? (
        <>
          <Panel
            titleRef={confirmHeading}
            title={target?.production ? "Confirm restore into production" : "Confirm restore"}
          >
            <p>
              Restore {plural(plan.entries.length, "namespace")} ({formatNumber(plannedDocuments)}{" "}
              documents) from <span className="mono">{plan.backupId}</span> into{" "}
              <strong>{target?.name ?? "?"}</strong>, mode <code>{plan.mode}</code>.
            </p>
            {/* Only admins get this far for production targets (see canProceed). */}
            {target?.production ? (
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
            ) : null}
          </Panel>

          {requestError === undefined ? null : (
            <ErrorNotice error={requestError} title="Could not start the restore" />
          )}
          <div className="form-actions">
            <Button
              onClick={() => {
                setRequestError(undefined);
                setStep(preview === undefined ? "review" : "preview");
              }}
            >
              Back
            </Button>
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
