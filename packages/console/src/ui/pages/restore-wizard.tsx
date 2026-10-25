/**
 * The restore wizard: a flow of seven step tabs (components/step-flow.tsx), one step
 * shown at a time, so a restore feels like a sequence of small decisions instead of
 * one long scrolled form.
 *
 *   (1) What ── (2) Where ── (3) Keys ── (4) Review ── (5) Preview ── (6) Confirm ── (7) Progress
 *
 * 1. What: the backup's namespaces grouped by database, with a tri-state "whole
 *    database" checkbox and a search (restore-namespace-picker.tsx).
 * 2. Where: the target connection, under which names ("Restore as": original names, a
 *    copy next to the original, another database of the target, or custom rename rules
 *    like the CLI's --rename: restore-as.tsx) and the mode for existing data.
 * 3. Keys: for encrypted backups, an optional passphrase or age private keys (see
 *    below). An unencrypted backup needs nothing: the step says "Not needed" and is
 *    already marked done.
 * 4. Review: the server computes a dry-run plan (`POST /api/restore/plan`) when the
 *    "Review plan" button is pressed: every source → target namespace with document
 *    counts and what will happen. Conflicts (a target that already has documents) are
 *    highlighted, and a plan that would fail cannot go further.
 * 5. Preview (optional): compares the backup with the target's live data, read only
 *    (`POST /api/restore/preview`, a job; restore-preview.tsx shows it): per namespace
 *    which documents would be added, replaced or deleted, index and option differences,
 *    and a field-by-field view of single documents. It can be skipped (big restores
 *    take a while to compare), and it is not offered for selected documents, whose plan
 *    already counts them. Leaving the step cancels a preview that is still running.
 * 6. Confirm: a restore into a connection marked "production" needs the connection's
 *    name typed exactly, and the admin role.
 * 7. Progress: starting creates a job and the browser goes to its live progress page,
 *    so this tab only says what comes next (it is never opened inside the wizard).
 *
 * Locking: Review opens once a plan has been asked for (or the asking failed, so the
 * error can be shown there); Preview and Confirm open once the plan can run. Changing
 * any choice in steps 1–3 afterwards throws the plan (and any preview) away, which
 * locks the later steps again while the user stays on the step they are editing.
 *
 * Focus: after Back / Next, StepFlow moves focus to the new step's panel; this page
 * refines that to the step's heading ("Plan: …", "Preview: …", "Confirm restore …") and
 * does the same after its own buttons ("Review plan", "Skip preview", …). Choosing a
 * tab with a click or the arrow keys leaves focus on the tab, as WAI-ARIA tabs expect.
 *
 * Restoring selected documents (from the document browser) sends an `_id: {$in: …}`
 * Extended JSON filter (`RestoreRequest.filter`). As a safety net the review step still
 * refuses to go on when the server's plan covers more documents than were selected, so
 * a whole collection is never restored by accident.
 *
 * Encrypted backups are read with a key the console stores (a plan's passphrase) or
 * with keys typed here: a passphrase, or age private keys for backups encrypted to
 * public keys, which the console never stores. Typed keys are sent with the plan and
 * the restore request only and are cleared once the restore has started.
 */

import { type KeyboardEvent, type Ref, useEffect, useRef, useState } from "react";
import type {
  ConnectionView,
  JobStatus,
  RestorePlanView,
  RestoreRequest,
} from "../../shared/api.ts";
import { isJobFinished } from "../api.ts";
import { Button } from "../components/button.tsx";
import { FieldGroup, SelectField, TextField } from "../components/field.tsx";
import { Icon } from "../components/icons.tsx";
import { KeyFileInput } from "../components/key-file-input.tsx";
import { ErrorNotice, Loading, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { type FlowStep, StepFlow } from "../components/step-flow.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatCompact, formatNumber, plural } from "../format.ts";
import { type ManifestNamespace, summarizeManifest } from "../manifest.ts";
import { databasesOf } from "../namespace-selection.ts";
import {
  DEFAULT_RESTORE_AS,
  NEW_DATABASE,
  type RestoreAsSettings,
  renameOf,
} from "../restore-rename.ts";
import { navigate, segment } from "../router.ts";
import { RestoreAsFields } from "./restore-as.tsx";
import { RestoreNamespacePicker } from "./restore-namespace-picker.tsx";
import { RestorePreviewStep } from "./restore-preview.tsx";
import "./restore-wizard.css";

// ---------------------------------------------------------------------------
// Pure helpers (exported for the tests)
// ---------------------------------------------------------------------------

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

/** True when a plan entry is a conflict worth highlighting (existing data is affected or blocks). */
export function isConflict(entry: RestorePlanView["entries"][number]): boolean {
  return BLOCKING_ACTIONS.has(entry.action) || (entry.existingDocuments ?? 0) > 0;
}

/** "copy (_restored)", "into shop_archive", "custom rules": the "Restore as" choice in a few words. */
export function describeRestoreAs(settings: RestoreAsSettings): string {
  switch (settings.kind) {
    case "original":
      return "original names";
    case "copy":
      // An empty suffix is an error the Where step shows; the hint just says so briefly.
      return `copy (${settings.suffix.trim() || "no suffix"})`;
    case "database": {
      // The select holds a database name, NEW_DATABASE ("New database…"), or "" (none yet).
      const name = settings.database === NEW_DATABASE ? settings.newDatabase : settings.database;
      return name.trim() === "" ? "into another database" : `into ${name.trim()}`;
    }
    case "custom":
      return "custom rules";
  }
}

/** The Where tab's hint: "Staging · copy (_restored)". */
export function whereHint(
  target: Pick<ConnectionView, "name"> | undefined,
  settings: RestoreAsSettings,
): string {
  if (target === undefined) return "Choose a target";
  return `${target.name} · ${describeRestoreAs(settings)}`;
}

/** The Keys tab's hint: what was typed, "Optional", or "Not needed" for unencrypted backups. */
export function keysHint(encrypted: boolean, passphrase: string, identityCount: number): string {
  if (!encrypted) return "Not needed";
  if (identityCount > 0) return plural(identityCount, "private key");
  if (passphrase !== "") return "Passphrase entered";
  // The console may already store a matching key (a plan's passphrase); it cannot tell
  // beforehand, so typing one stays optional and the review says if it was missing.
  return "Optional";
}

/** The Review tab's hint: "Plan: 3 namespaces, 1.2M documents". */
export function planHint(plan: Pick<RestorePlanView, "entries">): string {
  const documents = plan.entries.reduce((sum, entry) => sum + entry.documents, 0);
  // Compact ("1.2M") because the tab is narrow; the step itself shows the exact count.
  return `Plan: ${plural(plan.entries.length, "namespace")}, ${formatCompact(documents)} documents`;
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

/**
 * A keydown handler for a step's form: Enter in a single-line text field runs `action`
 * (going on, like the navigation row's main button). Forms with several fields and no
 * submit button are never submitted by Enter, so this does it by hand; Enter on buttons,
 * radios, selects and textareas keeps its usual meaning.
 */
function onEnterInTextField(action: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    const field = event.target;
    if (event.key !== "Enter" || !(field instanceof HTMLInputElement)) return;
    if (!["text", "password", "search"].includes(field.type)) return;
    event.preventDefault();
    action();
  };
}

/** The wizard's steps. */
type StepId = "what" | "where" | "keys" | "review" | "preview" | "confirm" | "progress";

/** The order of the steps, used to tell which ones the user has already been past. */
const STEP_ORDER: readonly StepId[] = [
  "what",
  "where",
  "keys",
  "review",
  "preview",
  "confirm",
  "progress",
];

/** Problems with the choices of steps 1–3, by field; empty when a plan can be asked for. */
interface ChoiceProblems {
  namespaces?: string;
  rename?: string;
  target?: string;
  identities?: string;
}

/** The step that shows each choice problem, so "Review plan" can go to the first one. */
const PROBLEM_STEP: Readonly<Record<keyof ChoiceProblems, StepId>> = {
  namespaces: "what",
  rename: "where",
  target: "where",
  identities: "keys",
};

/** The earliest step that shows one of `problems`, or undefined when there are none. */
function firstProblemStep(problems: ChoiceProblems): StepId | undefined {
  const fields = Object.keys(problems) as (keyof ChoiceProblems)[];
  return fields
    .map((field) => PROBLEM_STEP[field])
    .sort((a, b) => STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b))[0];
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/** Props for `RestoreWizardPage`. */
export interface RestoreWizardPageProps {
  readonly storageId: string;
  readonly backupId: string;
  /** Preselects one namespace (from the document browser). */
  readonly namespace?: string | undefined;
  /** JSON array of selected `_id`s (from the document browser). */
  readonly documentIds?: string | undefined;
}

/** The restore wizard page: loads the backup and the connections, then shows the flow. */
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
  const entries = summarizeManifest(state.data.backup.manifest).namespaces;
  return (
    <>
      <PageHeader
        title="Restore"
        description={<span className="mono">{backupId}</span>}
        breadcrumbs={breadcrumbs}
      />
      <RestoreWizard
        {...props}
        entries={entries}
        connections={state.data.connections}
        encrypted={state.data.backup.encrypted === true}
        backupDate={state.data.backup.startedAt}
        selectedIds={parseSelectedIds(props.documentIds)}
      />
    </>
  );
}

/** The wizard's steps, once the backup and the connections are loaded. */
function RestoreWizard(
  props: RestoreWizardPageProps & {
    /** The backup's namespaces with document counts and types. */
    entries: readonly ManifestNamespace[];
    connections: readonly ConnectionView[];
    encrypted: boolean;
    selectedIds: unknown[] | undefined;
    /** When the backup was taken (ISO), for the name suggestions of "Restore as". */
    backupDate: string | undefined;
  },
) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { selectedIds, encrypted } = props;
  const namespaces = props.entries.map((entry) => entry.ns);
  const preselected =
    props.namespace !== undefined && namespaces.includes(props.namespace)
      ? [props.namespace]
      : namespaces;

  // ----- Where the user is in the flow
  const [step, setStep] = useState<StepId>("what");
  /** The furthest step reached so far (its index): valid steps before it count as done. */
  const [furthest, setFurthest] = useState(0);

  // ----- Steps 1–3: the choices
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(preselected));
  const [targetId, setTargetId] = useState(
    props.connections.find((connection) => !connection.production)?.id ??
      props.connections[0]?.id ??
      "",
  );
  /** "Restore as": original names, a copy, another database or custom rules. */
  const [restoreAs, setRestoreAs] = useState<RestoreAsSettings>(DEFAULT_RESTORE_AS);
  const [mode, setMode] = useState<RestoreRequest["mode"]>(
    selectedIds === undefined ? "fail-if-exists" : "upsert",
  );
  const [passphrase, setPassphrase] = useState("");
  const [identitiesText, setIdentitiesText] = useState("");
  /** Field errors appear once "Review plan" was pressed, then follow what is typed. */
  const [showProblems, setShowProblems] = useState(false);
  /**
   * Steps 1–3 whose errors show before "Review plan": the ones the user tried to leave
   * while incomplete (Next, a later tab). Untouched steps stay quiet.
   */
  const [revealed, setRevealed] = useState<ReadonlySet<StepId>>(() => new Set());

  // ----- Steps 4–6: what the server said
  const [plan, setPlan] = useState<RestorePlanView | undefined>(undefined);
  const [planError, setPlanError] = useState<unknown>(undefined);
  /** The running or finished preview, with the request it compared. */
  const [preview, setPreview] = useState<
    { readonly jobId: string; readonly request: RestoreRequest } | undefined
  >(undefined);
  const [previewStatus, setPreviewStatus] = useState<JobStatus>("queued");
  const [previewError, setPreviewError] = useState<unknown>(undefined);
  const [confirmName, setConfirmName] = useState("");
  const [startError, setStartError] = useState<unknown>(undefined);
  /** Which request is on its way, for the spinner on its button. */
  const [busy, setBusy] = useState<"plan" | "preview" | "start" | undefined>(undefined);

  /**
   * Bumped by every change to a choice. A plan or preview asked for before the latest
   * change describes choices that no longer exist, so its answer is dropped.
   */
  const choicesVersion = useRef(0);

  // ----- Focus targets (see the file header)
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  /** The content of steps 1–3, whose tab panels take focus (they have no heading). */
  const whatContent = useRef<HTMLDivElement>(null);
  const whereContent = useRef<HTMLFormElement>(null);
  const keysContent = useRef<HTMLFormElement>(null);
  /** Bumped to focus the current step's heading again when the step itself stays the same. */
  const [focusRequest, setFocusRequest] = useState(0);
  /** What the focus effect last acted on: it acts on changes only (StrictMode runs effects twice). */
  const focusedFor = useRef({ step, focusRequest });

  // A step change from a button replaces or hides the focused button; without this,
  // focus would fall to <body> and keyboard users would start again from the top.
  useEffect(() => {
    // The first render (the shell has already focused the page heading), or a re-run.
    if (focusedFor.current.step === step && focusedFor.current.focusRequest === focusRequest) {
      return;
    }
    focusedFor.current = { step, focusRequest };
    // A tab chosen by click or arrow key keeps focus on the tab list (WAI-ARIA tabs).
    if (document.activeElement?.getAttribute("role") === "tab") return;
    const heading = { review: reviewHeading, preview: previewHeading, confirm: confirmHeading };
    const content = { what: whatContent, where: whereContent, keys: keysContent };
    if (step === "review" || step === "preview" || step === "confirm") {
      heading[step].current?.focus();
    } else if (step !== "progress") {
      // Steps 1–3: their whole panel takes focus, so reading starts at their top.
      content[step].current?.closest<HTMLElement>("[role=tabpanel]")?.focus();
    }
  }, [step, focusRequest]);

  // ----- Derived values
  const target = props.connections.find((connection) => connection.id === targetId);
  const targetLabel = target?.name ?? "the target";
  // The chosen namespaces in the backup's order (a Set has the order of clicking).
  const chosenInOrder = namespaces.filter((ns) => chosen.has(ns));
  const rename = renameOf(restoreAs, databasesOf(chosenInOrder));
  // Masked input, so several keys are separated by spaces rather than lines.
  const identities = identitiesText.split(/\s+/).filter((key) => key !== "");

  /** Everything wrong with the choices right now (shown only once `showProblems` is on). */
  const problems: ChoiceProblems = {};
  if (chosen.size === 0) problems.namespaces = "Choose at least one namespace.";
  if (typeof rename === "string") problems.rename = rename;
  if (target === undefined) problems.target = "Choose a target connection.";
  const identitiesError = identitiesProblem(identities);
  if (identitiesError !== undefined) problems.identities = identitiesError;
  /** True when step `id` shows its errors (after "Review plan", or once left incomplete). */
  const showsErrors = (id: StepId) => showProblems || revealed.has(id);
  const errors: ChoiceProblems = Object.fromEntries(
    Object.entries(problems).filter(([field]) =>
      showsErrors(PROBLEM_STEP[field as keyof ChoiceProblems]),
    ),
  );
  /** Whether a step's own choices are filled in and valid (StepFlow's `isComplete`). */
  const isComplete = (id: StepId): boolean => {
    if (id === "what") return problems.namespaces === undefined;
    if (id === "where") return problems.target === undefined && problems.rename === undefined;
    // The keys are optional, but a typed one must be a private key.
    if (id === "keys") return problems.identities === undefined;
    // The later steps have their own locks (a plan, a plan that can run).
    return true;
  };

  /** The request shared by the dry run, the preview and the restore; undefined while a choice is invalid. */
  const request: RestoreRequest | undefined =
    Object.keys(problems).length > 0 || typeof rename === "string" || target === undefined
      ? undefined
      : {
          storageId: props.storageId,
          backupId: props.backupId,
          targetConnectionId: target.id,
          mode,
          // Exact namespaces are valid patterns; sending none means "everything".
          ...(chosen.size === namespaces.length ? {} : { include: chosenInOrder }),
          ...(Object.keys(rename).length === 0 ? {} : { rename }),
          ...(passphrase === "" ? {} : { passphrase }),
          ...(identities.length === 0 ? {} : { identities }),
          ...(selectedIds === undefined
            ? {}
            : { filter: JSON.stringify({ _id: { $in: selectedIds } }) }),
        };

  const plannedDocuments = plan?.entries.reduce((sum, entry) => sum + entry.documents, 0) ?? 0;
  const blocking = plan?.entries.filter((entry) => BLOCKING_ACTIONS.has(entry.action)) ?? [];
  // The server must have honoured the selection; otherwise refuse (see file header).
  const selectionIgnored = selectedIds !== undefined && plannedDocuments > selectedIds.length;
  const needsAdmin = target?.production === true && !hasRole("admin");
  const confirmed = target?.production !== true || confirmName === target.name;
  // A plan that would fail (or ignored the selection) goes no further than the review.
  const canProceed =
    plan !== undefined && blocking.length === 0 && !selectionIgnored && !needsAdmin;
  const canStart = canProceed && confirmed && busy === undefined;
  // Selected documents have no preview: their plan already counts what is replaced.
  const previewAvailable = selectedIds === undefined;
  const previewFinished = isJobFinished({ status: previewStatus });
  const previewRunning = preview !== undefined && !previewFinished;

  // ----- Moving between steps

  /** Cancels a preview that is still comparing (it would only load the target for nothing). */
  const cancelRunningPreview = () => {
    if (preview === undefined || !previewRunning) return;
    client
      .call("POST /api/jobs/:id/cancel", undefined, { params: { id: preview.jobId } })
      .catch(() => undefined);
  };

  /** Opens a step (from the tabs, Back / Next, or this page's own buttons). */
  const goTo = (next: StepId) => {
    // Leaving the preview step stops a comparison that is still running.
    if (step === "preview" && next !== "preview") cancelRunningPreview();
    setStep(next);
    setFurthest((reached) => Math.max(reached, STEP_ORDER.indexOf(next)));
  };

  /** Focuses the current step's heading again (its content was replaced). */
  const refocus = () => setFocusRequest((count) => count + 1);

  // After a step was left incomplete (or "Review plan" found a problem): focus its first
  // invalid field, or its panel when the message has no field (the namespace list).
  const [invalidFocus, setInvalidFocus] = useState(0);
  useEffect(() => {
    if (invalidFocus === 0) return;
    const content = { what: whatContent, where: whereContent, keys: keysContent };
    if (step !== "what" && step !== "where" && step !== "keys") return;
    const container = content[step].current;
    const field = container?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (field ?? container?.closest<HTMLElement>("[role=tabpanel]"))?.focus();
  }, [invalidFocus, step]);

  /**
   * Called by StepFlow (and Enter in a text field) for a step left incomplete: show its
   * errors and focus the first one.
   */
  const onIncomplete = (id: StepId) => {
    setRevealed((current) => (current.has(id) ? current : new Set([...current, id])));
    setInvalidFocus((count) => count + 1);
  };

  /**
   * Throws away the plan and the preview after a choice changed: they describe the old
   * choices. Review, Preview and Confirm lock again; the user stays where they are.
   */
  const invalidate = () => {
    choicesVersion.current += 1;
    cancelRunningPreview();
    setPlan(undefined);
    setPlanError(undefined);
    setPreview(undefined);
    setPreviewError(undefined);
    setConfirmName("");
    setStartError(undefined);
  };

  /** Wraps a choice's setter so that changing the choice also invalidates the review. */
  function changes<Value>(set: (value: Value) => void): (value: Value) => void {
    return (value) => {
      set(value);
      invalidate();
    };
  }

  // ----- The requests

  /** "Review plan": checks the choices, asks the server for the dry run and opens Review. */
  const review = async () => {
    setShowProblems(true);
    if (request === undefined) {
      // Go to the first step with a problem; its fields say what is wrong, and focus
      // goes to the first of them.
      const first = firstProblemStep(problems);
      if (first !== undefined) goTo(first);
      refocus();
      setInvalidFocus((count) => count + 1);
      return;
    }
    const version = choicesVersion.current;
    setBusy("plan");
    setPlanError(undefined);
    try {
      const answer = await client.call("POST /api/restore/plan", request);
      if (version !== choicesVersion.current) return; // The choices changed meanwhile.
      setPlan(answer);
      setConfirmName("");
      // A new plan needs a new preview.
      setPreview(undefined);
      setPreviewError(undefined);
    } catch (error) {
      if (version !== choicesVersion.current) return;
      // Review opens to show what went wrong (see its `locked` below).
      setPlan(undefined);
      setPlanError(error);
    } finally {
      setBusy(undefined);
    }
    goTo("review");
    refocus();
  };

  /** Starts the preview job of the reviewed plan's request (inside the Preview step). */
  const startPreview = async () => {
    if (request === undefined) return;
    const version = choicesVersion.current;
    setBusy("preview");
    setPreviewError(undefined);
    try {
      const job = await client.call("POST /api/restore/preview", request);
      if (version !== choicesVersion.current) return;
      setPreview({ jobId: job.id, request });
      setPreviewStatus(job.status);
      // The preview's own panel replaces the introduction: focus its heading.
      refocus();
    } catch (error) {
      setPreviewError(error);
    } finally {
      setBusy(undefined);
    }
  };

  /** "Start restore": creates the job and opens its live progress page. */
  const start = async () => {
    if (request === undefined || target === undefined) return;
    setBusy("start");
    setStartError(undefined);
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
      setStartError(error);
    } finally {
      setBusy(undefined);
    }
  };

  // ----- The steps: each tab's hint and state, and the content of its panel

  /** "done" for a valid step the user has been past (or that a plan already covers). */
  const doneIfPast = (id: StepId, valid: boolean): "done" | undefined =>
    valid && (plan !== undefined || furthest > STEP_ORDER.indexOf(id)) ? "done" : undefined;

  /** The Preview tab's hint: why it is not offered, or how far the comparison got. */
  const previewHint = (): string => {
    if (!previewAvailable) return "Not for selected documents";
    if (preview === undefined) return "Optional";
    if (previewRunning) return "Comparing…";
    if (previewStatus === "succeeded") return "Compared";
    return previewStatus === "cancelled" ? "Cancelled" : "Failed";
  };

  const steps: FlowStep<StepId>[] = [
    {
      id: "what",
      title: "What",
      hint:
        selectedIds === undefined
          ? plural(chosen.size, "collection")
          : plural(selectedIds.length, "selected document"),
      state: errors.namespaces !== undefined ? "error" : doneIfPast("what", chosen.size > 0),
      content: (
        <div className="form restore-step" ref={whatContent}>
          <FieldGroup legend="What to restore">
            <RestoreNamespacePicker
              entries={props.entries}
              chosen={chosen}
              onChosen={changes(setChosen)}
              disabled={selectedIds !== undefined}
              error={errors.namespaces}
            />
          </FieldGroup>
        </div>
      ),
    },
    {
      id: "where",
      title: "Where",
      hint: whereHint(target, restoreAs),
      state:
        errors.rename !== undefined || errors.target !== undefined || needsAdmin
          ? "error"
          : doneIfPast("where", problems.rename === undefined && problems.target === undefined),
      content: (
        <form
          className="form restore-step"
          ref={whereContent}
          aria-label="Where to restore"
          noValidate
          // Enter in a text field goes on to the next step, like the Next button: only
          // when the step is complete (otherwise it shows what is missing, as Next does).
          onKeyDown={onEnterInTextField(() =>
            isComplete("where") ? goTo("keys") : onIncomplete("where"),
          )}
          onSubmit={(event) => event.preventDefault()}
        >
          <FieldGroup legend="Where to">
            <SelectField
              label="Target connection"
              value={targetId}
              options={props.connections.map((connection) => ({
                value: connection.id,
                label: connection.production ? `${connection.name} — PRODUCTION` : connection.name,
              }))}
              onValue={changes(setTargetId)}
              error={errors.target}
            />
            {target?.production ? (
              <Notice tone="danger" title="This is a production connection">
                You will need to type its name to confirm
                {hasRole("admin") ? "" : ", and only admins can restore into production"}.
              </Notice>
            ) : null}
            <RestoreAsFields
              settings={restoreAs}
              onSettings={changes(setRestoreAs)}
              chosen={chosenInOrder}
              target={target}
              rules={rename}
              error={errors.rename}
              backupDate={props.backupDate}
            />
            <SelectField
              label="If a target collection already has data"
              value={mode}
              options={MODES}
              onValue={changes(setMode)}
            />
          </FieldGroup>
        </form>
      ),
    },
    {
      id: "keys",
      title: "Keys",
      hint: keysHint(encrypted, passphrase, identities.length),
      state:
        errors.identities !== undefined
          ? "error"
          : // Nothing to do for an unencrypted backup: done from the start.
            !encrypted
            ? "done"
            : doneIfPast("keys", problems.identities === undefined),
      content: (
        <form
          className="form restore-step"
          ref={keysContent}
          aria-label="Decryption keys"
          noValidate
          // Enter in a key field does what the navigation row's main button does.
          onKeyDown={onEnterInTextField(() => {
            if (plan !== undefined || planError !== undefined) goTo("review");
            else if (!needsAdmin) void review();
          })}
          onSubmit={(event) => event.preventDefault()}
        >
          {encrypted ? (
            <FieldGroup
              legend="Decryption"
              description="This backup is encrypted. Leave both fields empty when the console already stores a matching key (a backup plan's passphrase)."
            >
              <TextField
                label="Passphrase (optional)"
                type="password"
                autoComplete="off"
                value={passphrase}
                onValue={changes(setPassphrase)}
                hint="Only needed when the console does not already store a matching key."
              />
              <TextField
                label="Private key (optional)"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={identitiesText}
                onValue={changes(setIdentitiesText)}
                placeholder="AGE-SECRET-KEY-1…"
                hint="For backups encrypted to public keys: the matching age private key (several separated by spaces). Used for this restore only, never stored."
                error={errors.identities}
              />
              {/* Keys from a key file are added to the typed ones (each key once), and
                  change the choices like typing does (the plan is asked for again). */}
              <KeyFileInput
                onKeys={(keys) =>
                  changes(setIdentitiesText)([...new Set([...identities, ...keys])].join(" "))
                }
              />
            </FieldGroup>
          ) : (
            <Notice tone="success" title="No key needed">
              This backup is not encrypted, so there is nothing to enter here. Review the plan next.
            </Notice>
          )}
        </form>
      ),
    },
    {
      id: "review",
      title: "Review",
      hint:
        plan !== undefined
          ? planHint(plan)
          : planError !== undefined
            ? "Could not plan"
            : "The server's dry run",
      state:
        planError !== undefined || (plan !== undefined && !canProceed)
          ? "error"
          : plan !== undefined
            ? "done"
            : undefined,
      // Opens once a plan was asked for: to show it, or why there is none.
      locked: plan === undefined && planError === undefined,
      content:
        plan !== undefined ? (
          <PlanPanel
            plan={plan}
            targetName={target?.name ?? "?"}
            selectedCount={selectedIds?.length}
            titleRef={reviewHeading}
          />
        ) : planError !== undefined ? (
          <Panel titleRef={reviewHeading} title="No plan yet">
            <ErrorNotice error={planError} title="Could not plan the restore" />
            <p className="muted">
              Check the choices in the earlier steps (a missing or wrong key is a common cause),
              then choose “Review plan” again.
            </p>
          </Panel>
        ) : null,
    },
    {
      id: "preview",
      title: "Preview",
      hint: previewHint(),
      state:
        previewError !== undefined || (preview !== undefined && previewStatus === "failed")
          ? "error"
          : preview !== undefined && previewStatus === "succeeded"
            ? "done"
            : undefined,
      // Not offered for selected documents (the hint says so), and only for a plan that can run.
      locked: !previewAvailable || !canProceed,
      content:
        preview !== undefined ? (
          <>
            <RestorePreviewStep
              // A new job (e.g. "Preview again") starts the step afresh.
              key={preview.jobId}
              jobId={preview.jobId}
              request={preview.request}
              targetName={targetLabel}
              titleRef={previewHeading}
              onStatus={setPreviewStatus}
            />
            {/* A cancelled or failed comparison can be run again. */}
            {previewFinished && previewStatus !== "succeeded" ? (
              <div className="form-actions">
                <Button busy={busy === "preview"} onClick={() => void startPreview()}>
                  Preview again
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <Panel
            titleRef={previewHeading}
            title={`Preview: what the restore would change in ${targetLabel}`}
          >
            <p>
              Compares the backup with the target's current data, read only, and shows which
              documents would be added, replaced or deleted, down to single fields. It is optional:
              big restores take a while to compare, and “Next: Confirm” skips it.
            </p>
            {previewError === undefined ? null : (
              <ErrorNotice error={previewError} title="Could not start the preview" />
            )}
            <div className="form-actions">
              <Button
                variant="primary"
                busy={busy === "preview"}
                onClick={() => void startPreview()}
              >
                Preview changes
              </Button>
            </div>
          </Panel>
        ),
    },
    {
      id: "confirm",
      title: "Confirm",
      hint: target?.production ? "Type the name to confirm" : "Start the restore",
      state: startError !== undefined ? "error" : undefined,
      locked: !canProceed,
      content:
        plan === undefined ? null : (
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
            {startError === undefined ? null : (
              <ErrorNotice error={startError} title="Could not start the restore" />
            )}
          </>
        ),
    },
    {
      id: "progress",
      title: "Progress",
      hint: "Opens when started",
      // Starting the restore leaves the wizard for the job's live page, so this tab is
      // never opened here: it shows where the flow ends.
      locked: true,
      content: (
        <p className="muted">
          Starting the restore opens its live job page: progress per namespace, the log and the
          result.
        </p>
      ),
    },
  ];

  // ----- The navigation row's own buttons. StepFlow shows `finish` instead of Next when
  // the next step is locked (and on the last step), so it only matters on Keys before
  // the plan, on Review when Preview is locked, and on Confirm.
  const finish =
    step === "confirm" ? (
      <Button
        variant={target?.production ? "danger" : "primary"}
        disabled={!canStart}
        busy={busy === "start"}
        onClick={() => void start()}
      >
        Start restore
      </Button>
    ) : step === "review" && plan !== undefined ? (
      // Preview is locked: for selected documents straight on to Confirm, and for a plan
      // that cannot run, a disabled button (the plan's notices say why).
      <Button variant="primary" disabled={!canProceed} onClick={() => goTo("confirm")}>
        Next: Confirm
        <Icon name="chevronRight" size={14} />
      </Button>
    ) : (
      // Keys before Review is open, and Review after a failed plan (to try again).
      <Button
        variant="primary"
        busy={busy === "plan"}
        // The server refuses even to plan a restore into production for non-admins (the
        // Where step's notice says why), so do not offer a request that must fail.
        disabled={needsAdmin}
        onClick={() => void review()}
      >
        Review plan
      </Button>
    );
  // On Review, next to Back: skipping the optional preview.
  const extra =
    step === "review" && previewAvailable && canProceed ? (
      <Button disabled={busy !== undefined} onClick={() => goTo("confirm")}>
        Skip preview
      </Button>
    ) : undefined;

  return (
    <>
      {selectedIds === undefined ? null : (
        <Notice tone="info" title={`Restoring ${plural(selectedIds.length, "selected document")}`}>
          Only these documents from <code>{props.namespace}</code> are restored. Upsert replaces
          existing documents with the same <code>_id</code>.
        </Notice>
      )}
      <StepFlow
        label="Restore steps"
        steps={steps}
        current={step}
        onStep={goTo}
        // What and Where must be complete (and typed keys valid) before moving on.
        isComplete={isComplete}
        onIncomplete={onIncomplete}
        finish={finish}
        extra={extra}
      />
    </>
  );
}

/** The Review step: the dry-run plan with its conflicts highlighted. */
function PlanPanel(props: {
  plan: RestorePlanView;
  targetName: string;
  /** How many documents were selected in the document browser, if any. */
  selectedCount: number | undefined;
  titleRef: Ref<HTMLHeadingElement>;
}) {
  const { plan } = props;
  const plannedDocuments = plan.entries.reduce((sum, entry) => sum + entry.documents, 0);
  const blocking = plan.entries.filter((entry) => BLOCKING_ACTIONS.has(entry.action));
  const conflicts = plan.entries.filter(isConflict);
  // See the file header: a plan that covers more than the selection is refused.
  const selectionIgnored =
    props.selectedCount !== undefined && plannedDocuments > props.selectedCount;
  return (
    <Panel
      titleRef={props.titleRef}
      title={`Plan: ${plural(plan.entries.length, "namespace")}, ${formatNumber(plannedDocuments)} documents into ${props.targetName}`}
    >
      {conflicts.length === 0 ? (
        <p>
          <StatusBadge status="ok" label="No conflicts" /> No target collection has existing data.
        </p>
      ) : (
        <Notice
          tone={blocking.length > 0 ? "danger" : "warning"}
          title={`${plural(conflicts.length, "conflict")} with existing data`}
        >
          {blocking.length > 0
            ? "The restore would stop at the highlighted collections. Go back to “Where” and choose another mode or rename the targets."
            : "Existing data in the highlighted collections will be changed as described."}
        </Notice>
      )}
      {selectionIgnored ? (
        <Notice
          tone="danger"
          title="The server did not limit the restore to the selected documents"
        >
          The plan covers {formatNumber(plannedDocuments)} documents but{" "}
          {formatNumber(props.selectedCount)} were selected. Restoring selected documents is not
          supported by this server yet.
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
                {entry.reason === undefined ? null : <span className="muted">{entry.reason}</span>}
              </span>
            ),
          },
        ]}
      />
    </Panel>
  );
}
