/**
 * The plan editor (`#/plans/new` and `#/plans/:id`).
 *
 * The form is kept as plain strings (`PlanForm`) while editing and converted to the
 * API's `PlanInput` only on save, by `validatePlanForm`, which also produces the
 * per-field error messages. That keeps typing free (half-typed numbers, empty lines)
 * and puts every rule in one testable function.
 *
 * Live previews while typing:
 * - the namespace tree of the chosen connection, marking which collections the
 *   include/exclude patterns select;
 * - the schedule in words and its next five runs, computed in the browser (cron.ts),
 *   or "custom" when only the server can evaluate it.
 *
 * Secrets (passphrase, webhook URLs) are write-only: an existing plan shows that they
 * are configured, and leaving the field empty keeps them.
 */

import { type FormEvent, useMemo, useState } from "react";
import type {
  ConnectionView,
  DatabaseNode,
  PlanInput,
  PlanView,
  StorageView,
} from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import {
  CheckboxField,
  FieldGroup,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/field.tsx";
import { ErrorNotice, Loading, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { NamespaceTree } from "../components/namespace-tree.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { describeCron, nextRuns, parseCron } from "../cron.ts";
import { formatDateTimeInZone, formatNumber } from "../format.ts";
import { isSelected, namespacesOf, patternProblem } from "../namespaces.ts";
import { navigate, segment } from "../router.ts";

/** Retention buckets, in the order the library documents them. */
const RETENTION_KEYS = ["last", "daily", "weekly", "monthly", "yearly"] as const;
type RetentionKey = (typeof RETENTION_KEYS)[number];

/** One notification target in the form. `url` is empty when keeping a stored URL. */
export interface NotifyRow {
  readonly type: "webhook" | "slack" | "discord";
  readonly url: string;
  /** Redacted preview of the stored URL (existing rows only). */
  readonly storedPreview?: string | undefined;
}

/** The editor's state: strings while typing, converted on save. */
export interface PlanForm {
  readonly name: string;
  readonly connectionId: string;
  readonly storageId: string;
  /** One pattern per line. */
  readonly include: string;
  readonly exclude: string;
  readonly compression: PlanInput["compression"];
  readonly encryptionKind: PlanInput["encryption"]["kind"];
  /** One age recipient per line. */
  readonly recipients: string;
  readonly passphrase: string;
  /** True when the server already stores a passphrase for this plan. */
  readonly passphraseStored: boolean;
  readonly consistency: PlanInput["consistency"];
  readonly scheduled: boolean;
  readonly cron: string;
  readonly timezone: string;
  readonly retention: Readonly<Record<RetentionKey, string>>;
  readonly verify: PlanInput["verify"];
  readonly notify: readonly NotifyRow[];
  /** Incremental backups between full ones (`PlanInput.incremental`). */
  readonly incremental: boolean;
  /** A full backup every this many days, as typed. */
  readonly fullEveryDays: string;
}

/** Field → error message. */
export type PlanFormErrors = Partial<Record<string, string>>;

/** The browser's time zone, the default for new schedules. */
function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A blank form for a new plan. */
export function emptyPlanForm(): PlanForm {
  return {
    name: "",
    connectionId: "",
    storageId: "",
    include: "",
    exclude: "*.sessions",
    compression: "zstd",
    encryptionKind: "recipients",
    recipients: "",
    passphrase: "",
    passphraseStored: false,
    consistency: "auto",
    scheduled: true,
    cron: "0 2 * * *",
    timezone: browserTimeZone(),
    retention: { last: "3", daily: "7", weekly: "4", monthly: "12", yearly: "" },
    verify: "fast",
    notify: [],
    incremental: false,
    fullEveryDays: "7",
  };
}

/** The form for an existing plan. Secrets stay on the server. */
export function planToForm(plan: PlanView): PlanForm {
  const retention = plan.retention ?? {};
  return {
    name: plan.name,
    connectionId: plan.connectionId,
    storageId: plan.storageId,
    include: plan.include.join("\n"),
    exclude: plan.exclude.join("\n"),
    compression: plan.compression,
    encryptionKind: plan.encryption.kind,
    recipients: plan.encryption.kind === "recipients" ? plan.encryption.recipients.join("\n") : "",
    passphrase: "",
    passphraseStored:
      plan.encryption.kind === "passphrase" && plan.encryption.passphrase.configured,
    consistency: plan.consistency,
    scheduled: plan.schedule !== undefined,
    cron: plan.schedule?.cron ?? "0 2 * * *",
    timezone: plan.schedule?.timezone ?? browserTimeZone(),
    retention: {
      last: retention.last === undefined ? "" : String(retention.last),
      daily: retention.daily === undefined ? "" : String(retention.daily),
      weekly: retention.weekly === undefined ? "" : String(retention.weekly),
      monthly: retention.monthly === undefined ? "" : String(retention.monthly),
      yearly: retention.yearly === undefined ? "" : String(retention.yearly),
    },
    verify: plan.verify,
    notify: plan.notify.map((target) => ({
      type: target.type,
      url: "",
      storedPreview: target.url.preview ?? (target.url.configured ? "configured" : undefined),
    })),
    incremental: plan.incremental !== undefined,
    fullEveryDays: String(plan.incremental?.fullEveryDays ?? 7),
  };
}

/** Splits a one-per-line textarea into trimmed, non-empty entries. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** True when the time zone is known to this browser. */
function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the form and builds the `PlanInput` to send. Returns the input when valid,
 * otherwise the errors keyed by field name.
 */
export function validatePlanForm(
  form: PlanForm,
): { input: PlanInput; errors: undefined } | { input: undefined; errors: PlanFormErrors } {
  const errors: PlanFormErrors = {};
  if (form.name.trim() === "") errors.name = "Give the plan a name.";
  if (form.connectionId === "") errors.connectionId = "Choose the connection to back up.";
  if (form.storageId === "") errors.storageId = "Choose where to store the backups.";

  for (const field of ["include", "exclude"] as const) {
    for (const pattern of lines(form[field])) {
      const problem = patternProblem(pattern);
      if (problem !== undefined) {
        errors[field] = `"${pattern}": ${problem}.`;
        break;
      }
    }
  }

  const recipients = lines(form.recipients);
  if (form.encryptionKind === "recipients") {
    if (recipients.length === 0) errors.recipients = "Add at least one age recipient (age1…).";
    const bad = recipients.find(
      (recipient) => !/^age1[0-9a-z]{20,}$/.test(recipient) && !recipient.startsWith("kms:"),
    );
    if (bad !== undefined)
      errors.recipients = `"${bad}" is not an age recipient (age1…) or a KMS key (kms:…).`;
  }
  if (form.encryptionKind === "passphrase" && form.passphrase === "" && !form.passphraseStored) {
    errors.passphrase = "Enter a passphrase.";
  }
  if (
    form.encryptionKind === "passphrase" &&
    form.passphrase !== "" &&
    form.passphrase.length < 12
  ) {
    errors.passphrase = "Use at least 12 characters; a few random words work well.";
  }

  if (form.scheduled) {
    const parsed = parseCron(form.cron);
    if (parsed.kind === "invalid") errors.cron = parsed.message;
    if (!isValidTimeZone(form.timezone.trim()))
      errors.timezone = `"${form.timezone}" is not a known time zone, e.g. UTC or Europe/Berlin.`;
  }

  const retention: Partial<Record<RetentionKey, number>> = {};
  for (const key of RETENTION_KEYS) {
    const text = form.retention[key].trim();
    if (text === "") continue;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) {
      errors[`retention.${key}`] = "Use a whole number, or leave empty.";
    } else {
      retention[key] = value;
    }
  }

  const fullEveryDays = Number(form.fullEveryDays.trim());
  if (
    form.incremental &&
    (form.fullEveryDays.trim() === "" ||
      !Number.isFinite(fullEveryDays) ||
      fullEveryDays <= 0 ||
      fullEveryDays > 366)
  ) {
    errors.fullEveryDays = "Use a number of days between 0 and 366, e.g. 7 for weekly.";
  }

  form.notify.forEach((row, index) => {
    if (row.url === "" && row.storedPreview === undefined) {
      errors[`notify.${index}`] = "Enter the webhook URL.";
    } else if (row.url !== "" && !/^https:\/\/\S+$/.test(row.url)) {
      errors[`notify.${index}`] = "Use an https:// URL.";
    }
  });

  if (Object.keys(errors).length > 0) return { input: undefined, errors };

  const encryption: PlanInput["encryption"] =
    form.encryptionKind === "none"
      ? { kind: "none" }
      : form.encryptionKind === "managed"
        ? // The server keeps the plan's key, or generates one for a plan that had none.
          { kind: "managed" }
        : form.encryptionKind === "recipients"
          ? { kind: "recipients", recipients }
          : {
              kind: "passphrase",
              ...(form.passphrase === "" ? {} : { passphrase: form.passphrase }),
            };

  const input: PlanInput = {
    name: form.name.trim(),
    connectionId: form.connectionId,
    storageId: form.storageId,
    include: lines(form.include),
    exclude: lines(form.exclude),
    compression: form.compression,
    encryption,
    consistency: form.consistency,
    verify: form.verify,
    // An empty URL keeps the stored one, so it is omitted rather than sent empty.
    notify: form.notify.map((row) => ({
      type: row.type,
      ...(row.url === "" ? {} : { url: row.url }),
    })),
    ...(form.scheduled
      ? { schedule: { cron: form.cron.trim(), timezone: form.timezone.trim() } }
      : {}),
    ...(Object.keys(retention).length === 0 ? {} : { retention }),
    ...(form.incremental ? { incremental: { fullEveryDays } } : {}),
  };
  return { input, errors: undefined };
}

/** Props for `PlanEditorPage`. */
export interface PlanEditorPageProps {
  /** Absent for a new plan. */
  readonly planId?: string | undefined;
}

/** Create or edit a plan. */
export function PlanEditorPage(props: PlanEditorPageProps) {
  const client = useApi();
  const { planId } = props;
  const state = useLoad(`plan-editor:${planId ?? "new"}`, async (signal) => {
    const [plans, connections, storage] = await Promise.all([
      client.call("GET /api/plans", undefined, { signal }),
      client.call("GET /api/connections", undefined, { signal }),
      client.call("GET /api/storage", undefined, { signal }),
    ]);
    return { plan: plans.find((candidate) => candidate.id === planId), connections, storage };
  });

  if (state.error !== undefined) return <ErrorNotice error={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return <Loading />;
  if (planId !== undefined && state.data.plan === undefined) {
    return (
      <>
        <PageHeader
          title="Plan not found"
          breadcrumbs={[{ label: "Backup plans", href: "#/plans" }]}
        />
        <p>
          It may have been deleted. <a href="#/plans">Back to plans</a>
        </p>
      </>
    );
  }
  return (
    <PlanEditorForm
      plan={state.data.plan}
      connections={state.data.connections}
      storage={state.data.storage}
    />
  );
}

function PlanEditorForm(props: {
  plan: PlanView | undefined;
  connections: readonly ConnectionView[];
  storage: readonly StorageView[];
}) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { plan } = props;
  const canEdit = hasRole("admin");
  const [form, setForm] = useState<PlanForm>(() =>
    plan === undefined
      ? {
          ...emptyPlanForm(),
          connectionId: props.connections[0]?.id ?? "",
          storageId: props.storage[0]?.id ?? "",
        }
      : planToForm(plan),
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const update = <Key extends keyof PlanForm>(key: Key, value: PlanForm[Key]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const validation = validatePlanForm(form);
  const errors: PlanFormErrors = submitted ? (validation.errors ?? {}) : {};

  const tree = useLoad<readonly DatabaseNode[]>(
    form.connectionId === "" ? "" : `namespaces:${form.connectionId}`,
    (signal) =>
      client.call("GET /api/connections/:id/namespaces", undefined, {
        params: { id: form.connectionId },
        signal,
      }),
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (validation.input === undefined) {
      toast.show("error", "Some fields need attention; see the messages next to them.");
      return;
    }
    setBusy(true);
    setSaveError(undefined);
    try {
      const saved =
        plan === undefined
          ? await client.call("POST /api/plans", validation.input)
          : await client.call("PUT /api/plans/:id", validation.input, { params: { id: plan.id } });
      toast.show("success", `Saved "${saved.name}".`);
      navigate("/plans");
    } catch (error) {
      setSaveError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (plan === undefined) return;
    try {
      await client.call("DELETE /api/plans/:id", undefined, { params: { id: plan.id } });
      toast.show("success", `Deleted "${plan.name}". Its backups were kept.`);
      navigate("/plans");
    } catch (error) {
      toast.show("error", describeError(error));
    }
  };

  const runNow = async () => {
    if (plan === undefined) return;
    try {
      const job = await client.call("POST /api/plans/:id/run", undefined, {
        params: { id: plan.id },
      });
      navigate(`/jobs/${segment(job.id)}`);
    } catch (error) {
      toast.show("error", describeError(error));
    }
  };

  const noPrerequisites = props.connections.length === 0 || props.storage.length === 0;

  return (
    <>
      <PageHeader
        title={plan === undefined ? "New backup plan" : plan.name}
        breadcrumbs={[{ label: "Backup plans", href: "#/plans" }]}
        actions={
          plan === undefined ? undefined : (
            <>
              {hasRole("operator") ? <Button onClick={() => void runNow()}>Run now</Button> : null}
              {canEdit ? (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete plan
                </Button>
              ) : null}
            </>
          )
        }
      />
      {canEdit ? null : (
        <Notice tone="info" title="Read only">
          Only admins can change backup plans.
        </Notice>
      )}
      {noPrerequisites ? (
        <Notice tone="warning" title="Add a connection and storage first">
          A plan needs a <a href="#/connections">connection</a> to back up and a{" "}
          <a href="#/storage">storage location</a> to write to.
        </Notice>
      ) : null}

      <form onSubmit={submit} noValidate className="plan-form" aria-label="Backup plan">
        <fieldset disabled={!canEdit} className="plain-fieldset">
          <div className="plan-layout">
            <div className="plan-main">
              <FieldGroup legend="Basics">
                <TextField
                  label="Name"
                  value={form.name}
                  onValue={(value) => update("name", value)}
                  error={errors.name}
                />
                <div className="grid-2">
                  <SelectField
                    label="Connection"
                    value={form.connectionId}
                    options={[
                      { value: "", label: "Choose…", disabled: true },
                      ...props.connections.map((connection) => ({
                        value: connection.id,
                        label: connection.production
                          ? `${connection.name} (production)`
                          : connection.name,
                      })),
                    ]}
                    onValue={(value) => update("connectionId", value)}
                    error={errors.connectionId}
                  />
                  <SelectField
                    label="Storage"
                    value={form.storageId}
                    options={[
                      { value: "", label: "Choose…", disabled: true },
                      ...props.storage.map((location) => ({
                        value: location.id,
                        label: location.name,
                      })),
                    ]}
                    onValue={(value) => update("storageId", value)}
                    error={errors.storageId}
                  />
                </div>
              </FieldGroup>

              <FieldGroup
                legend="What to back up"
                description='One pattern per line, like "shop.*", "*.sessions" or "shop.users". Leave Include empty to back up everything.'
              >
                <div className="grid-2">
                  <TextAreaField
                    label="Include"
                    value={form.include}
                    onValue={(value) => update("include", value)}
                    rows={4}
                    spellCheck={false}
                    placeholder="shop.*"
                    error={errors.include}
                  />
                  <TextAreaField
                    label="Exclude"
                    value={form.exclude}
                    onValue={(value) => update("exclude", value)}
                    rows={4}
                    spellCheck={false}
                    placeholder="*.sessions"
                    error={errors.exclude}
                  />
                </div>
              </FieldGroup>

              <FieldGroup legend="How">
                <div className="grid-3">
                  <SelectField
                    label="Compression"
                    value={form.compression}
                    options={[
                      { value: "zstd", label: "zstd (recommended)" },
                      { value: "gzip", label: "gzip" },
                      { value: "none", label: "None" },
                    ]}
                    onValue={(value) => update("compression", value)}
                  />
                  <SelectField
                    label="Consistency"
                    value={form.consistency}
                    options={[
                      { value: "auto", label: "Auto (best available)" },
                      { value: "snapshot", label: "Snapshot" },
                      { value: "converge", label: "Converge (change stream)" },
                      { value: "none", label: "None" },
                    ]}
                    onValue={(value) => update("consistency", value)}
                    hint="Snapshot reads one point in time; converge replays changes made during the backup."
                  />
                  <SelectField
                    label="Verify after backup"
                    value={form.verify}
                    options={[
                      { value: "fast", label: "Fast (checksums)" },
                      { value: "deep", label: "Deep (decrypt and parse)" },
                      { value: "none", label: "Don't verify" },
                    ]}
                    onValue={(value) => update("verify", value)}
                  />
                </div>
                <SelectField
                  label="Encryption"
                  value={form.encryptionKind}
                  options={[
                    { value: "managed", label: "Key kept by the console — easiest" },
                    { value: "recipients", label: "Public keys (age recipients) — recommended" },
                    { value: "passphrase", label: "Passphrase" },
                    { value: "none", label: "No encryption" },
                  ]}
                  onValue={(value) => update("encryptionKind", value)}
                  hint="With public keys, the console can write backups but cannot read them back without the matching private key."
                />
                {form.encryptionKind === "recipients" ? (
                  <TextAreaField
                    label="Recipients"
                    value={form.recipients}
                    onValue={(value) => update("recipients", value)}
                    rows={3}
                    spellCheck={false}
                    placeholder="age1…"
                    hint="One per line. Generate a key pair with `mongoshield keygen`."
                    error={errors.recipients}
                  />
                ) : null}
                {form.encryptionKind === "passphrase" ? (
                  <TextField
                    label="Passphrase"
                    type="password"
                    autoComplete="new-password"
                    value={form.passphrase}
                    onValue={(value) => update("passphrase", value)}
                    hint={
                      form.passphraseStored
                        ? "A passphrase is stored. Leave empty to keep it."
                        : "Stored encrypted. Keep a copy somewhere safe: backups cannot be restored without it."
                    }
                    error={errors.passphrase}
                  />
                ) : null}
                {form.encryptionKind === "managed" ? (
                  <Notice tone="info">
                    The console creates a key, encrypts every backup with it and uses it to restore,
                    so nobody has to type a key. Download the recovery key (from the connection's
                    data page after the first backup) and keep it somewhere safe: it restores the
                    backups even if the console is lost.
                  </Notice>
                ) : null}
                {form.encryptionKind === "none" ? (
                  <Notice tone="warning">
                    Backups will be readable by anyone with access to the storage.
                  </Notice>
                ) : null}
              </FieldGroup>

              <FieldGroup legend="When">
                <CheckboxField
                  label="Run on a schedule"
                  checked={form.scheduled}
                  onChecked={(value) => update("scheduled", value)}
                  hint="Without a schedule the plan only runs when started by hand."
                />
                {form.scheduled ? (
                  <>
                    <div className="grid-2">
                      <TextField
                        label="Cron expression"
                        value={form.cron}
                        onValue={(value) => update("cron", value)}
                        spellCheck={false}
                        hint="minute hour day-of-month month day-of-week"
                        error={errors.cron}
                      />
                      <TextField
                        label="Time zone"
                        value={form.timezone}
                        onValue={(value) => update("timezone", value)}
                        list="time-zones"
                        spellCheck={false}
                        error={errors.timezone}
                      />
                    </div>
                    <TimeZoneList />
                    <SchedulePreview cron={form.cron} timezone={form.timezone} />
                  </>
                ) : null}
                <CheckboxField
                  label="Incremental backups between full ones"
                  checked={form.incremental}
                  onChecked={(value) => update("incremental", value)}
                  hint="Each run stores only what changed since the previous backup; a full backup starts a new chain. Needs a replica set or sharded cluster."
                />
                {form.incremental ? (
                  <TextField
                    label="Full backup every (days)"
                    inputMode="decimal"
                    value={form.fullEveryDays}
                    onValue={(value) => update("fullEveryDays", value)}
                    hint="E.g. an hourly schedule with 7 here: full weekly, incremental hourly."
                    error={errors.fullEveryDays}
                  />
                ) : null}
              </FieldGroup>

              <FieldGroup
                legend="Retention"
                description="How many backups to keep per bucket. Empty = not used. The newest backup is never deleted."
              >
                <div className="grid-5">
                  {RETENTION_KEYS.map((key) => (
                    <TextField
                      key={key}
                      label={key === "last" ? "Last N" : key.charAt(0).toUpperCase() + key.slice(1)}
                      inputMode="numeric"
                      value={form.retention[key]}
                      onValue={(value) => update("retention", { ...form.retention, [key]: value })}
                      error={errors[`retention.${key}`]}
                    />
                  ))}
                </div>
              </FieldGroup>

              <FieldGroup
                legend="Notifications"
                description="Where to report failures and results."
              >
                {form.notify.map((row, index) => (
                  // Rows have no id; their position is their identity while editing.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                  <div key={index} className="notify-row">
                    <SelectField
                      label="Type"
                      value={row.type}
                      options={[
                        { value: "slack", label: "Slack" },
                        { value: "discord", label: "Discord" },
                        { value: "webhook", label: "Webhook" },
                      ]}
                      onValue={(value) =>
                        update(
                          "notify",
                          form.notify.map((candidate, at) =>
                            at === index ? { ...candidate, type: value } : candidate,
                          ),
                        )
                      }
                    />
                    <TextField
                      label="URL"
                      type="password"
                      autoComplete="off"
                      value={row.url}
                      onValue={(value) =>
                        update(
                          "notify",
                          form.notify.map((candidate, at) =>
                            at === index ? { ...candidate, url: value } : candidate,
                          ),
                        )
                      }
                      placeholder={
                        row.storedPreview === undefined
                          ? "https://hooks.slack.com/services/…"
                          : "Leave empty to keep the stored URL"
                      }
                      hint={
                        row.storedPreview === undefined ? undefined : `Stored: ${row.storedPreview}`
                      }
                      error={errors[`notify.${index}`]}
                    />
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() =>
                        update(
                          "notify",
                          form.notify.filter((_row, at) => at !== index),
                        )
                      }
                      aria-label={`Remove notification ${index + 1}`}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  size="small"
                  onClick={() => update("notify", [...form.notify, { type: "slack", url: "" }])}
                >
                  Add notification
                </Button>
              </FieldGroup>

              {saveError === undefined ? null : (
                <ErrorNotice error={saveError} title="Could not save the plan" />
              )}
              {canEdit ? (
                <div className="form-actions">
                  <Button type="submit" variant="primary" busy={busy}>
                    {plan === undefined ? "Create plan" : "Save changes"}
                  </Button>
                  <a href="#/plans" className="button button-ghost">
                    Cancel
                  </a>
                </div>
              ) : null}
            </div>

            <aside className="plan-preview" aria-label="Selection preview">
              <Panel title="Selection preview">
                <SelectionPreview
                  tree={tree.data}
                  loading={tree.loading}
                  error={tree.error}
                  include={lines(form.include)}
                  exclude={lines(form.exclude)}
                />
              </Panel>
            </aside>
          </div>
        </fieldset>
      </form>

      <Dialog
        open={confirmDelete}
        title={`Delete "${plan?.name ?? ""}"?`}
        description="The schedule stops. Backups already made are kept in storage and can still be restored."
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void remove()}>
              Delete plan
            </Button>
          </>
        }
      >
        <p>This cannot be undone.</p>
      </Dialog>
    </>
  );
}

/** Suggestions for the time zone field (native `<datalist>`, no script needed). */
function TimeZoneList() {
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return ["UTC"];
    }
  }, []);
  return (
    <datalist id="time-zones">
      <option value="UTC" />
      {zones.map((zone) => (
        <option key={zone} value={zone} />
      ))}
    </datalist>
  );
}

/** The schedule in words and its next five runs. */
export function SchedulePreview(props: { cron: string; timezone: string }) {
  const description = describeCron(props.cron);
  const runs = nextRuns(props.cron, props.timezone.trim(), 5);
  return (
    <div className="schedule-preview" aria-live="polite">
      <p>
        <strong>{description}</strong>
        {description === "Custom schedule" ? (
          <span className="muted"> — the server computes when it runs.</span>
        ) : null}
      </p>
      {runs === undefined || runs.length === 0 ? null : (
        <>
          <p className="muted">Next runs:</p>
          <ol className="compact-list numeric">
            {runs.map((run) => (
              <li key={run.toISOString()}>{formatDateTimeInZone(run, props.timezone.trim())}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

/** Which collections the current patterns select, with totals. */
function SelectionPreview(props: {
  tree: readonly DatabaseNode[] | undefined;
  loading: boolean;
  error: unknown;
  include: readonly string[];
  exclude: readonly string[];
}) {
  const { tree, include, exclude } = props;
  if (props.error !== undefined)
    return <ErrorNotice error={props.error} title="Could not list namespaces" />;
  if (tree === undefined)
    return props.loading ? (
      <Loading label="Listing databases…" />
    ) : (
      <p className="muted">Choose a connection to preview.</p>
    );
  const all = namespacesOf(tree);
  const selected = all.filter((ns) => isSelected(ns, include, exclude));
  let documents = 0;
  for (const database of tree) {
    for (const collection of database.collections) {
      if (isSelected(`${database.name}.${collection.name}`, include, exclude))
        documents += collection.estimatedDocuments;
    }
  }
  return (
    <>
      <p aria-live="polite">
        <strong className="numeric">{selected.length}</strong> of {all.length} collections selected,
        about <span className="numeric">{formatNumber(documents)}</span> documents.
      </p>
      <NamespaceTree tree={tree} isSelected={(ns) => isSelected(ns, include, exclude)} />
    </>
  );
}
