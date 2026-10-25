/**
 * The plan editor (`#/plans/new` and `#/plans/:id`).
 *
 * The form is kept as plain strings (`PlanForm`) while editing and converted to the
 * API's `PlanInput` only on save, by `validatePlanForm`, which also produces the
 * per-field error messages. That keeps typing free (half-typed numbers, empty lines)
 * and puts every rule in one testable function.
 *
 * Wherever the value comes from a known set, the editor offers choices instead of a
 * text box:
 * - "What to back up": Everything, a checkbox tree of the connection's databases and
 *   collections (NamespacePicker), or include/exclude patterns for the rest;
 * - "When": a Repeat select (every hour … every month) with minute, time, weekday and
 *   day selects, turned into cron by schedule-presets.ts; "Custom" shows the cron field;
 *   the time zone is a select grouped by region;
 * - "Full backup every" and "Retention" are selects of common values, with "Custom"
 *   (retention) or the plan's own value (full backups) for anything else.
 * An existing plan opens on the choice that matches it, falling back to the free-form
 * fields (patterns, cron, custom retention) so nothing about it changes unseen.
 *
 * Live previews while editing:
 * - the namespace tree of the chosen connection, marking which collections the
 *   current choice selects;
 * - the schedule in words and its next five runs, computed in the browser (cron.ts),
 *   or "custom" when only the server can evaluate it.
 *
 * Secrets (passphrase, webhook URLs) are write-only: an existing plan shows that they
 * are configured, and leaving the field empty keeps them.
 *
 * The form is a step flow (components/step-flow.tsx), one step at a time, so filling it
 * in feels like a flow of work rather than a long scroll:
 *
 *   (1) Basics ─ (2) What to back up ─ (3) Security ─ (4) Schedule ─ (5) Retention ─ (6) Review
 *
 * - Every step is reachable at any time (new plan or not); Back / Next suggest the order,
 *   and on Review the Create / Save button ends the flow. An existing plan shows Save on
 *   every step (StepFlow's `finishOnEveryStep`), for quick one-field changes.
 * - Each tab's hint sums up the step's current choices ("Production cluster → S3
 *   primary", "6 collections", "Every day at 02:00").
 * - A tab shows ✓ once the step was visited and its fields are valid, and "!" when the
 *   step has problems after a save attempt (or, for an existing plan, as stored). Saving
 *   with problems opens the first such step, with focus on its first invalid field.
 * - The open step is kept in the URL (`?step=schedule`), so a reload stays on it.
 * - Beside the fields: the selection preview on "What to back up", a compact plan summary
 *   on the other steps; Review lists every choice with a "Change" button per step.
 *
 * Free-text fields offer one-click suggestions under them (FillSuggestions): names made
 * from the plan's own choices, the connection's databases and common exclusions as
 * patterns, ready-made cron expressions, and usual retention counts. Secrets (keys,
 * passphrases, webhook URLs) get none: only placeholders that show their shape.
 */

import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  ConnectionView,
  DatabaseNode,
  PlanInput,
  PlanView,
  StorageView,
} from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { AgeKeyGenerator } from "../components/age-key-generator.tsx";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import {
  CheckboxField,
  Field,
  FieldGroup,
  SelectField,
  type SelectOption,
  TextAreaField,
  TextField,
} from "../components/field.tsx";
import { FillSuggestions } from "../components/fill-suggestions.tsx";
import { Icon } from "../components/icons.tsx";
import {
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Panel,
} from "../components/layout.tsx";
import { NamespacePicker } from "../components/namespace-picker.tsx";
import { NamespaceTree } from "../components/namespace-tree.tsx";
import { RadioCards } from "../components/radio-cards.tsx";
import { hasRecoveryKey, RecoveryKeyButton } from "../components/recovery-key.tsx";
import { type FlowStep, StepFlow } from "../components/step-flow.tsx";
import { useToast } from "../components/toast.tsx";
import { type LoadState, useApi, useLoad, useSession } from "../context.tsx";
import { describeCron, nextRuns, parseCron } from "../cron.ts";
import { formatDateTimeInZone, formatNumber, plural } from "../format.ts";
import { type SelectionMode, selectionModeOf } from "../namespace-picks.ts";
import { isSelected, namespacesOf, patternProblem, splitNamespace } from "../namespaces.ts";
import {
  CUSTOM_RETENTION_LABEL,
  RETENTION_KEYS,
  RETENTION_PRESET_IDS,
  RETENTION_PRESETS,
  type RetentionKey,
  type RetentionPresetId,
  retentionPresetOf,
  retentionTextFor,
} from "../retention-presets.ts";
import { navigate, replaceQuery, segment, useLocation } from "../router.ts";
import {
  DEFAULT_PRESET,
  isHourlyKind,
  LAST_PRESET_DAY,
  minuteOptions,
  ordinal,
  parseTimeValue,
  presetFromCron,
  presetToCron,
  REPEAT_KINDS,
  REPEAT_LABELS,
  type RepeatKind,
  repeatKindOf,
  type SchedulePreset,
  switchPreset,
  timeOptions,
  timeValue,
  timeZoneGroups,
  twoDigits,
  WEEKDAY_ORDER,
  WEEKDAYS,
} from "../schedule-presets.ts";
import "./plan-editor.css";

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
  /**
   * How "What to back up" is chosen: everything, ticked databases and collections
   * (`picks`), or the `include` / `exclude` pattern boxes. Only the chosen mode's
   * values are saved; the others are kept so switching back loses nothing.
   */
  readonly selection: SelectionMode;
  /** The ticked databases ("db.*") and collections ("db.coll"), as include patterns. */
  readonly picks: readonly string[];
  /** One pattern per line (the "Patterns (advanced)" mode). */
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
  /**
   * The "Repeat" choice. For a preset, `cron` is rewritten from the preset controls
   * whenever they change; for "custom", `cron` is what the user types.
   */
  readonly repeat: RepeatKind;
  /** The schedule saved with the plan (always cron, whichever way it was chosen). */
  readonly cron: string;
  readonly timezone: string;
  /** The retention select; a preset fills `retention`, "custom" shows its boxes. */
  readonly retentionPreset: RetentionPresetId;
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

/** The browser's time zone, the default for new schedules (UTC if it cannot tell). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The "Full backup every" choices, in days. */
export const FULL_BACKUP_DAYS = [1, 2, 3, 7, 14, 30] as const;

/** "Every day", "Every week (7 days)" … for a number of days (as typed). */
export function fullBackupLabel(days: string): string {
  switch (days) {
    case "1":
      return "Every day";
    case "7":
      return "Every week (7 days)";
    case "14":
      return "Every 2 weeks (14 days)";
    default:
      return `Every ${days} days`;
  }
}

/** A blank form for a new plan. */
export function emptyPlanForm(): PlanForm {
  return {
    name: "",
    connectionId: "",
    storageId: "",
    selection: "everything",
    picks: [],
    include: "",
    exclude: "",
    compression: "zstd",
    encryptionKind: "recipients",
    recipients: "",
    passphrase: "",
    passphraseStored: false,
    consistency: "auto",
    scheduled: true,
    // Every day at 02:00 in the browser's time zone, a quiet hour for most databases.
    repeat: DEFAULT_PRESET.repeat,
    cron: presetToCron(DEFAULT_PRESET),
    timezone: browserTimeZone(),
    retentionPreset: "recommended",
    retention: retentionTextFor("recommended"),
    verify: "fast",
    notify: [],
    incremental: false,
    fullEveryDays: "7",
  };
}

/** The form for an existing plan. Secrets stay on the server. */
export function planToForm(plan: PlanView): PlanForm {
  const retention = plan.retention ?? {};
  const retentionText = {
    last: retention.last === undefined ? "" : String(retention.last),
    daily: retention.daily === undefined ? "" : String(retention.daily),
    weekly: retention.weekly === undefined ? "" : String(retention.weekly),
    monthly: retention.monthly === undefined ? "" : String(retention.monthly),
    yearly: retention.yearly === undefined ? "" : String(retention.yearly),
  };
  const selection = selectionModeOf(plan.include, plan.exclude);
  const cron = plan.schedule?.cron ?? presetToCron(DEFAULT_PRESET);
  return {
    name: plan.name,
    connectionId: plan.connectionId,
    storageId: plan.storageId,
    selection,
    // The tree shows the plan's own patterns when they are plain picks.
    picks: selection === "pick" ? plan.include : [],
    // The pattern boxes always hold the plan's patterns, for "Patterns (advanced)".
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
    // A preset when the cron means one, else "Custom" with the expression as it is.
    repeat: repeatKindOf(cron),
    cron,
    timezone: plan.schedule?.timezone ?? browserTimeZone(),
    // A plan without retention keeps everything, which is the "forever" preset.
    retentionPreset: retentionPresetOf(retentionText),
    retention: retentionText,
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

/**
 * The include and exclude patterns the form's "What to back up" choice stands for:
 * none for everything, the ticked picks, or the pattern boxes.
 */
export function selectionPatterns(form: PlanForm): { include: string[]; exclude: string[] } {
  switch (form.selection) {
    case "everything":
      return { include: [], exclude: [] };
    case "pick":
      return { include: [...form.picks], exclude: [] };
    case "advanced":
      return { include: lines(form.include), exclude: lines(form.exclude) };
  }
}

/**
 * Switches "What to back up" to `selection`, carrying the user's work across where it
 * fits: patterns that are plain picks fill an empty tree, and picks fill empty pattern
 * boxes (so they can be refined with wildcards). Nothing is ever cleared.
 */
export function withSelection(form: PlanForm, selection: SelectionMode): PlanForm {
  const include = lines(form.include);
  const exclude = lines(form.exclude);
  if (
    selection === "pick" &&
    form.picks.length === 0 &&
    include.length > 0 &&
    selectionModeOf(include, exclude) === "pick"
  ) {
    return { ...form, selection, picks: include };
  }
  if (
    selection === "advanced" &&
    include.length === 0 &&
    exclude.length === 0 &&
    form.picks.length > 0
  ) {
    return { ...form, selection, include: form.picks.join("\n") };
  }
  return { ...form, selection };
}

/**
 * Picks a "Repeat" choice. "Custom" keeps the current expression (it becomes the text
 * in the cron field, a handy starting point); a preset keeps the chosen time, weekday
 * and day where it can and rewrites the cron from them.
 */
export function withRepeat(form: PlanForm, repeat: RepeatKind): PlanForm {
  if (repeat === "custom") return { ...form, repeat };
  return { ...form, repeat, cron: presetToCron(switchPreset(form.cron, repeat)) };
}

/** Applies a change to the preset controls (time, minute, weekday, day). */
export function withPreset(form: PlanForm, preset: SchedulePreset): PlanForm {
  return { ...form, repeat: preset.repeat, cron: presetToCron(preset) };
}

/** Picks a retention choice: a preset fills the counts; "Custom" keeps them to edit. */
export function withRetentionPreset(form: PlanForm, id: RetentionPresetId): PlanForm {
  if (id === "custom") return { ...form, retentionPreset: id };
  return { ...form, retentionPreset: id, retention: retentionTextFor(id) };
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

// ---- limits the server enforces (routes/plans.ts), checked here so a mistake shows
// next to its field instead of after a round trip.

/** Longest plan name the server stores. */
export const MAX_PLAN_NAME_LENGTH = 100;
/** Most age recipients per plan. */
export const MAX_RECIPIENTS = 20;
/** Shortest backup passphrase: it protects data at rest for years. */
export const MIN_PASSPHRASE_LENGTH = 12;
/** Largest count per retention bucket (about 3 years of dailies). */
export const MAX_RETENTION_COUNT = 1000;
/** Longest full-backup interval, in days (the library allows up to a year). */
export const MAX_FULL_EVERY_DAYS = 366;
/** Most notification targets per plan. */
export const MAX_NOTIFY = 10;

/** What `validatePlanForm` needs to know besides the form itself. */
export interface PlanFormContext {
  /**
   * The names of the console's other plans: two plans with the same name are refused by
   * the server, so the name field says so before saving.
   */
  readonly takenNames?: readonly string[];
  /**
   * True while a key pair made by "Generate a key pair" waits for its "I saved the
   * private key somewhere safe" box: without that key the backups could never be
   * restored, so the plan is not saved before it is ticked.
   */
  readonly unsavedPrivateKey?: boolean;
}

/** An age public key: "age1" and its bech32 data (lower case letters and digits). */
const AGE_RECIPIENT = /^age1[0-9a-z]{20,}$/;

/** A whole number written with digits only: no signs, decimals, exponents or hex. */
const WHOLE_NUMBER = /^\d+$/;

/** The message while a generated private key has not been marked as saved. */
export const UNSAVED_PRIVATE_KEY =
  "Tick “I saved the private key somewhere safe” first — the backups can only be restored with it.";

/**
 * The Recipients text after "Generate a key pair" made `recipient`: the line holding
 * `replaces` (the key generated before it, whose private key is gone from the screen)
 * becomes the new key; without one, the new key is added on a line of its own.
 */
export function withGeneratedRecipient(
  text: string,
  recipient: string,
  replaces: string | undefined,
): string {
  const rows = text.split("\n");
  const at = replaces === undefined ? -1 : rows.findIndex((row) => row.trim() === replaces);
  if (at < 0) return appendLine(text, recipient);
  rows[at] = recipient;
  return rows.join("\n");
}

/** Longest passphrase the server takes. */
const MAX_PASSPHRASE_LENGTH = 1024;

/** Longest notification URL the server takes. */
const MAX_NOTIFY_URL_LENGTH = 2048;

/**
 * What is wrong with the "Recipients" lines (already split by `lines`), or undefined.
 * Only age public keys: the console's server refuses anything else (KMS keys are a
 * library feature it does not offer).
 */
export function recipientsProblem(recipients: readonly string[]): string | undefined {
  if (recipients.length === 0) return "Add at least one age recipient (age1…).";
  const bad = recipients.find((recipient) => !AGE_RECIPIENT.test(recipient));
  if (bad !== undefined) return `"${bad}" is not an age public key (age1…).`;
  if (recipients.length > MAX_RECIPIENTS) return `Use at most ${MAX_RECIPIENTS} public keys.`;
  return undefined;
}

/**
 * What is wrong with the typed passphrase, or undefined. Empty is fine when the server
 * already stores one for the plan (it is kept).
 */
export function passphraseProblem(passphrase: string, stored: boolean): string | undefined {
  if (passphrase === "") return stored ? undefined : "Enter a passphrase.";
  // Twelve spaces pass the length check but protect nothing.
  if (passphrase.trim() === "") return "A passphrase cannot be only spaces.";
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters; a few random words work well.`;
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    return `Use at most ${MAX_PASSPHRASE_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * What is wrong with a notification row's URL, or undefined. An empty URL keeps the
 * stored one of an existing row; a new row needs one.
 */
export function notifyUrlProblem(row: NotifyRow): string | undefined {
  const url = row.url.trim();
  if (url === "") return row.storedPreview === undefined ? "Enter the webhook URL." : undefined;
  if (!/^https:\/\/\S+$/.test(url)) return "Use an https:// URL.";
  if (url.length > MAX_NOTIFY_URL_LENGTH) {
    return `Use at most ${MAX_NOTIFY_URL_LENGTH} characters.`;
  }
  return undefined;
}

/**
 * Checks the form and builds the `PlanInput` to send. Returns the input when valid,
 * otherwise the errors keyed by field name.
 */
export function validatePlanForm(
  form: PlanForm,
  context: PlanFormContext = {},
): { input: PlanInput; errors: undefined } | { input: undefined; errors: PlanFormErrors } {
  const errors: PlanFormErrors = {};
  const name = form.name.trim();
  if (name === "") errors.name = "Give the plan a name.";
  else if (name.length > MAX_PLAN_NAME_LENGTH) {
    errors.name = `Use at most ${MAX_PLAN_NAME_LENGTH} characters.`;
  } else if (context.takenNames?.includes(name) === true) {
    // The server compares the trimmed name exactly, so this does too.
    errors.name = `Another plan is already called "${name}". Choose another name.`;
  }
  if (form.connectionId === "") errors.connectionId = "Choose the connection to back up.";
  if (form.storageId === "") errors.storageId = "Choose where to store the backups.";

  // Only the chosen mode is checked: hidden boxes never block saving.
  if (form.selection === "advanced") {
    for (const field of ["include", "exclude"] as const) {
      for (const pattern of lines(form[field])) {
        const problem = patternProblem(pattern);
        if (problem !== undefined) {
          errors[field] = `"${pattern}": ${problem}.`;
          break;
        }
      }
    }
  }
  // No ticks would mean "everything" to the server, which is not what the user sees.
  if (form.selection === "pick" && form.picks.length === 0) {
    errors.picks = 'Tick at least one database or collection, or choose "Everything".';
  }

  const recipients = lines(form.recipients);
  if (form.encryptionKind === "recipients") {
    const problem = recipientsProblem(recipients);
    if (problem !== undefined) errors.recipients = problem;
  }
  if (form.encryptionKind === "recipients" && context.unsavedPrivateKey === true) {
    errors.generatedKey = UNSAVED_PRIVATE_KEY;
  }
  if (form.encryptionKind === "passphrase") {
    const problem = passphraseProblem(form.passphrase, form.passphraseStored);
    if (problem !== undefined) errors.passphrase = problem;
  }

  if (form.scheduled) {
    const parsed = parseCron(form.cron);
    if (parsed.kind === "invalid") errors.cron = parsed.message;
    const timezone = form.timezone.trim();
    if (timezone === "") errors.timezone = "Choose a time zone, e.g. UTC or Europe/Berlin.";
    else if (!isValidTimeZone(timezone))
      errors.timezone = `"${form.timezone}" is not a known time zone, e.g. UTC or Europe/Berlin.`;
  }

  const retention: Partial<Record<RetentionKey, number>> = {};
  for (const key of RETENTION_KEYS) {
    const text = form.retention[key].trim();
    // An empty bucket is not used.
    if (text === "") continue;
    const value = Number(text);
    // Digits only: Number() would also read "1e2", "0x10" or "1.0" as whole numbers. 0 is
    // refused too: the server drops it, so "0" would silently mean "not used".
    if (!WHOLE_NUMBER.test(text) || value < 1 || value > MAX_RETENTION_COUNT) {
      errors[`retention.${key}`] =
        `Use a whole number from 1 to ${MAX_RETENTION_COUNT}, or leave empty.`;
    } else {
      retention[key] = value;
    }
  }

  // Fractions are allowed (0.5 = every 12 hours), so this is a number check, not digits.
  const fullEveryText = form.fullEveryDays.trim();
  const fullEveryDays = Number(fullEveryText);
  if (
    form.incremental &&
    (fullEveryText === "" ||
      !Number.isFinite(fullEveryDays) ||
      fullEveryDays <= 0 ||
      fullEveryDays > MAX_FULL_EVERY_DAYS)
  ) {
    errors.fullEveryDays = `Use a number of days greater than 0 and at most ${MAX_FULL_EVERY_DAYS}, e.g. 7 for weekly.`;
  }

  form.notify.forEach((row, index) => {
    const problem = notifyUrlProblem(row);
    if (problem !== undefined) errors[`notify.${index}`] = problem;
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

  const { include, exclude } = selectionPatterns(form);
  const input: PlanInput = {
    name: form.name.trim(),
    connectionId: form.connectionId,
    storageId: form.storageId,
    include,
    exclude,
    compression: form.compression,
    encryption,
    consistency: form.consistency,
    verify: form.verify,
    // An empty URL keeps the stored one, so it is omitted rather than sent empty.
    // (Pasted URLs often come with a space or newline at the end: trimmed.)
    notify: form.notify.map((row) => ({
      type: row.type,
      ...(row.url.trim() === "" ? {} : { url: row.url.trim() }),
    })),
    ...(form.scheduled
      ? { schedule: { cron: form.cron.trim(), timezone: form.timezone.trim() } }
      : {}),
    ...(Object.keys(retention).length === 0 ? {} : { retention }),
    ...(form.incremental ? { incremental: { fullEveryDays } } : {}),
  };
  return { input, errors: undefined };
}

// ------------------------------------------------------------------------- the steps

/**
 * The editor's steps, in order. The ids are also the values of `?step=` in the URL, so a
 * reload (or a shared link) opens the same step.
 */
export const PLAN_STEPS = [
  "basics",
  "what",
  "security",
  "schedule",
  "retention",
  "review",
] as const;

/** One of the editor's steps. */
export type PlanStepId = (typeof PLAN_STEPS)[number];

/** Each step's tab title. */
export const PLAN_STEP_TITLES: Readonly<Record<PlanStepId, string>> = {
  basics: "Basics",
  what: "What to back up",
  security: "Security",
  schedule: "Schedule",
  retention: "Retention & alerts",
  review: "Review",
};

/** The step a `?step=` value names; anything else (or nothing) means the first step. */
export function parsePlanStep(value: string | null | undefined): PlanStepId {
  return PLAN_STEPS.find((id) => id === value) ?? PLAN_STEPS[0];
}

/**
 * The step that shows a field, by the field's key in `PlanFormErrors` ("name",
 * "retention.daily", "notify.0" …), so an error can be traced back to its step.
 */
export function stepOfField(field: string): PlanStepId {
  switch (field) {
    case "name":
    case "connectionId":
    case "storageId":
      return "basics";
    case "include":
    case "exclude":
    case "picks":
      return "what";
    case "recipients":
    case "generatedKey":
    case "passphrase":
      return "security";
    case "cron":
    case "timezone":
    case "fullEveryDays":
      return "schedule";
    default:
      // What is left: the retention buckets ("retention.*") and notifications ("notify.*").
      return "retention";
  }
}

/** The steps with at least one error, in step order (empty when there are none). */
export function stepsWithErrors(errors: PlanFormErrors | undefined): PlanStepId[] {
  const withErrors = new Set(
    Object.entries(errors ?? {})
      .filter(([, message]) => message !== undefined)
      .map(([field]) => stepOfField(field)),
  );
  return PLAN_STEPS.filter((id) => withErrors.has(id));
}

// --------------------------------------------------------------- choices and labels

/** The compression choices; the review and summary reuse the labels. */
const COMPRESSION_OPTIONS: readonly SelectOption<PlanInput["compression"]>[] = [
  { value: "zstd", label: "zstd (recommended)" },
  { value: "gzip", label: "gzip" },
  { value: "none", label: "None" },
];

/** The consistency choices. */
const CONSISTENCY_OPTIONS: readonly SelectOption<PlanInput["consistency"]>[] = [
  { value: "auto", label: "Auto (best available)" },
  { value: "snapshot", label: "Snapshot" },
  { value: "converge", label: "Converge (change stream)" },
  { value: "none", label: "None" },
];

/** The "Verify after backup" choices. */
const VERIFY_OPTIONS: readonly SelectOption<PlanInput["verify"]>[] = [
  { value: "fast", label: "Fast (checksums)" },
  { value: "deep", label: "Deep (decrypt and parse)" },
  { value: "none", label: "Don't verify" },
];

/** The encryption choices, worded to help choose (the select). */
const ENCRYPTION_OPTIONS: readonly SelectOption<PlanForm["encryptionKind"]>[] = [
  { value: "managed", label: "Key kept by the console — easiest" },
  { value: "recipients", label: "Public keys (age recipients) — recommended" },
  { value: "passphrase", label: "Passphrase" },
  { value: "none", label: "No encryption" },
];

/** The encryption choices as a plain name, for the review and the summary card. */
const ENCRYPTION_NAMES: Readonly<Record<PlanForm["encryptionKind"], string>> = {
  managed: "Key kept by the console",
  recipients: "Public keys (age recipients)",
  passphrase: "Passphrase",
  none: "Not encrypted",
};

/** The encryption choices in a word or two, for the "Security" tab's hint. */
const ENCRYPTION_SHORT: Readonly<Record<PlanForm["encryptionKind"], string>> = {
  managed: "Console key",
  recipients: "Public keys",
  passphrase: "Passphrase",
  none: "Not encrypted",
};

/** Notification types by name. */
const NOTIFY_NAMES: Readonly<Record<NotifyRow["type"], string>> = {
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
};

/** The label of `value` among `options` (the value itself when it is not one of them). */
function optionLabel<Value extends string>(
  options: readonly SelectOption<Value>[],
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

// ---------------------------------------------------------- the plan in a few words

/** What the summaries need besides the form: names for the ids, and the namespace tree. */
export interface PlanContext {
  readonly connections: readonly ConnectionView[];
  readonly storage: readonly StorageView[];
  /** The chosen connection's databases, once listed (undefined while loading). */
  readonly tree: readonly DatabaseNode[] | undefined;
}

/** The chosen connection's name, or undefined when none (or an unknown one) is chosen. */
function connectionName(form: PlanForm, context: PlanContext): string | undefined {
  return context.connections.find((connection) => connection.id === form.connectionId)?.name;
}

/** The chosen storage location's name, or undefined when none is chosen. */
function storageName(form: PlanForm, context: PlanContext): string | undefined {
  return context.storage.find((location) => location.id === form.storageId)?.name;
}

/** "Production cluster → S3 primary": where the backups come from and go to. */
export function describeTarget(form: PlanForm, context: PlanContext): string {
  const from = connectionName(form, context);
  const to = storageName(form, context);
  if (from === undefined && to === undefined) return "Choose a connection and storage";
  return `${from ?? "No connection"} → ${to ?? "no storage"}`;
}

/**
 * What the plan backs up, in a few words: "Everything", "6 collections" (counted in the
 * tree once it is listed), or before that "2 databases, 1 collection" / "3 patterns".
 */
export function describeSelection(form: PlanForm, tree: readonly DatabaseNode[] | undefined) {
  if (form.selection === "everything") return "Everything";
  if (form.selection === "pick" && form.picks.length === 0) return "Nothing chosen yet";
  const { include, exclude } = selectionPatterns(form);
  // Empty pattern boxes leave nothing out, which is everything again.
  if (include.length === 0 && exclude.length === 0) return "Everything";
  if (tree !== undefined) {
    const chosen = namespacesOf(tree).filter((ns) => isSelected(ns, include, exclude));
    return plural(chosen.length, "collection");
  }
  if (form.selection === "pick") {
    // A whole database is picked as "db.*" (see namespace-picks.ts).
    const databases = form.picks.filter((pick) => pick.endsWith(".*")).length;
    const collections = form.picks.length - databases;
    return [
      databases === 0 ? "" : plural(databases, "database"),
      collections === 0 ? "" : plural(collections, "collection"),
    ]
      .filter((part) => part !== "")
      .join(", ");
  }
  return plural(include.length + exclude.length, "pattern");
}

/** "Every day at 02:00", or "Manual runs only" without a schedule. */
export function describeSchedule(form: PlanForm): string {
  return form.scheduled ? describeCron(form.cron) : "Manual runs only";
}

/**
 * The retention rule from its counts: "Last 3, 7 daily, 4 weekly, 12 monthly", or
 * "Every backup kept" when no bucket is used. The counts are shown as typed.
 */
export function describeRetention(form: PlanForm): string {
  const parts = RETENTION_KEYS.flatMap((key) => {
    const count = form.retention[key].trim();
    if (count === "") return [];
    return [key === "last" ? `last ${count}` : `${count} ${key}`];
  });
  if (parts.length === 0) return "Every backup kept";
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "No alerts", "1 alert", "2 alerts". */
function describeAlerts(form: PlanForm): string {
  return form.notify.length === 0 ? "No alerts" : plural(form.notify.length, "alert");
}

/**
 * The few words under each step's tab, reflecting the current choices, e.g.
 * "Production cluster → S3 primary", "6 collections", "Every day at 02:00".
 */
export function planStepHints(
  form: PlanForm,
  context: PlanContext,
  isNew: boolean,
): Record<PlanStepId, string> {
  return {
    basics: describeTarget(form, context),
    what: describeSelection(form, context.tree),
    security: `${ENCRYPTION_SHORT[form.encryptionKind]} · ${
      form.compression === "none" ? "no compression" : form.compression
    }`,
    schedule: `${describeSchedule(form)}${form.incremental ? " · incremental" : ""}`,
    retention: `${describeRetention(form)} · ${describeAlerts(form)}`,
    review: isNew ? "Check, then create" : "Check, then save",
  };
}

// ------------------------------------------------------------------ fill suggestions

/** Collections people commonly leave out of a backup, offered under "Exclude". */
export const EXCLUDE_SUGGESTIONS = [
  { value: "*.sessions", hint: "Login sessions, which expire anyway" },
  { value: "*.cache", hint: "Caches the application can rebuild" },
  { value: "*.tmp_*", hint: "Temporary collections" },
  { value: "*.system.*", hint: "MongoDB's own per-database collections, e.g. system.profile" },
] as const;

/** Ready-made cron expressions for the "Custom" schedule, named by what they do. */
export const CRON_SUGGESTIONS = [
  { value: "0 2 * * *", label: "Daily at 02:00" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "*/30 * * * *", label: "Every 30 minutes" },
  { value: "0 3 * * 0", label: "Sundays at 03:00" },
  { value: "0 2 * * 1-5", label: "Weekdays at 02:00" },
] as const;

/** Usual counts for each custom retention bucket. */
export const RETENTION_SUGGESTIONS: Readonly<Record<RetentionKey, readonly string[]>> = {
  last: ["3", "7", "14", "30"],
  daily: ["7", "14", "30"],
  weekly: ["4", "8", "12"],
  monthly: ["6", "12", "24"],
  yearly: ["1", "3", "7"],
};

/**
 * What each notification type's URL looks like, as the field's placeholder. Webhook URLs
 * are secrets unique to each workspace, so there is nothing to suggest filling in.
 */
const NOTIFY_PLACEHOLDERS: Readonly<Record<NotifyRow["type"], string>> = {
  slack: "https://hooks.slack.com/services/…",
  discord: "https://discord.com/api/webhooks/…",
  webhook: "https://your-server.example/hooks/…",
};

/** Adds `line` to a one-per-line textarea on a line of its own, unless it is there already. */
export function appendLine(text: string, line: string): string {
  if (lines(text).includes(line)) return text;
  // Trailing blank lines would leave a gap before the new line.
  const kept = text.replace(/\s+$/, "");
  return kept === "" ? line : `${kept}\n${line}`;
}

/**
 * How often the plan runs, as a word for its name: "nightly" (a daily run at night),
 * "daily", "hourly", "weekly" …; undefined for a custom cron, which has no simple word.
 */
function frequencyWord(form: PlanForm): string | undefined {
  if (!form.scheduled) return "manual";
  switch (form.repeat) {
    case "hourly":
      return "hourly";
    case "every6h":
      return "6-hourly";
    case "every12h":
      return "twice daily";
    case "daily": {
      // 22:00 to 05:59 counts as night.
      const hour = presetFromCron(form.cron)?.hour ?? DEFAULT_PRESET.hour;
      return hour < 6 || hour >= 22 ? "nightly" : "daily";
    }
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    case "custom":
      return undefined;
  }
}

/**
 * Names to try for the plan, made from its current choices, e.g. "Production cluster
 * nightly", "Nightly shop" (for ticked databases), "Production cluster → S3 primary".
 */
export function planNameSuggestions(form: PlanForm, context: PlanContext): string[] {
  const from = connectionName(form, context);
  const to = storageName(form, context);
  const word = frequencyWord(form);
  const Word = word === undefined ? undefined : word.charAt(0).toUpperCase() + word.slice(1);
  // The databases the ticks belong to (at most two, to keep the row short).
  const databases = [
    ...new Set(
      form.selection === "pick" ? form.picks.map((pick) => splitNamespace(pick).database) : [],
    ),
  ].slice(0, 2);
  const names = [
    from === undefined || word === undefined ? undefined : `${from} ${word}`,
    ...databases.map((database) =>
      Word === undefined ? `${database} backup` : `${Word} ${database}`,
    ),
    from === undefined || to === undefined ? undefined : `${from} → ${to}`,
    from === undefined ? undefined : `${from} backups`,
  ];
  return names.filter((name): name is string => name !== undefined);
}

/** Where focus goes after the next render: a step's panel, or its first invalid field. */
interface FocusRequest {
  readonly target: "step" | "first-error";
  /** Counts up, so asking twice for the same target still moves focus again. */
  readonly serial: number;
}

/**
 * Moves focus into the step that is open in `form`: to its first invalid field when
 * asked (falling back to the panel, e.g. for the tree's "tick at least one" message),
 * else to the panel itself, so screen readers announce the step that just opened.
 */
function focusOpenStep(form: HTMLFormElement | null, target: FocusRequest["target"]): void {
  // StepFlow hides every panel but the open one.
  const panel = form?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
  // An invalid field, or a message that stands for a control the page cannot mark
  // (`data-step-error`, e.g. the generated key's "I saved it" box): the first in the page.
  const invalid =
    target === "first-error"
      ? panel?.querySelector<HTMLElement>('[aria-invalid="true"], [data-step-error]')
      : undefined;
  (invalid ?? panel)?.focus();
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
    return {
      plan: plans.find((candidate) => candidate.id === planId),
      // The other plans' names: a plan's name must be unique (see `validatePlanForm`).
      takenNames: plans.filter((candidate) => candidate.id !== planId).map((other) => other.name),
      connections,
      storage,
    };
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
      takenNames={state.data.takenNames}
      connections={state.data.connections}
      storage={state.data.storage}
      onReload={state.reload}
    />
  );
}

/** Props for `PlanEditorForm`. */
interface PlanEditorFormProps {
  /** The plan being edited; undefined for a new one. */
  readonly plan: PlanView | undefined;
  /** The names of the other plans, which this one may not take. */
  readonly takenNames: readonly string[];
  readonly connections: readonly ConnectionView[];
  readonly storage: readonly StorageView[];
  /** Loads the plan again (after its recovery key was downloaded, say). */
  readonly onReload: () => void;
}

/**
 * The editor once everything is loaded: the page header, then the step flow. The form
 * state, validation, the current step and saving live here; each step's fields are their
 * own component below.
 */
function PlanEditorForm(props: PlanEditorFormProps) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { plan } = props;
  const isNew = plan === undefined;
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
  // Field messages (and the "!" on step tabs) show after the first save attempt, or
  // straight away for an existing plan that does not pass the checks as stored (say, a
  // time zone this browser does not know), so its problems are visible before saving.
  /**
   * False while a key pair from "Generate a key pair" waits for its "I saved the private
   * key somewhere safe" box (true before any is generated: nothing to save then).
   */
  const [generatedKeySaved, setGeneratedKeySaved] = useState(true);
  const validationContext: PlanFormContext = {
    takenNames: props.takenNames,
    unsavedPrivateKey: !generatedKeySaved,
  };
  const [submitted, setSubmitted] = useState(
    () =>
      plan !== undefined &&
      validatePlanForm(planToForm(plan), { takenNames: props.takenNames }).input === undefined,
  );
  /**
   * Steps whose messages show before any save attempt: the ones the user tried to leave
   * while they were incomplete (Next, a later tab, or any other tab). A step nobody has
   * touched yet stays quiet, so a new plan does not open covered in red.
   */
  const [revealed, setRevealed] = useState<ReadonlySet<PlanStepId>>(() => new Set());
  /** Shows the messages of step `id` from now on. */
  const reveal = (id: PlanStepId) =>
    setRevealed((current) => (current.has(id) ? current : new Set([...current, id])));
  /** True when step `id` shows its messages (and its tab its "!"). */
  const showsErrors = (id: PlanStepId) => submitted || revealed.has(id);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The open step lives in the URL (`?step=schedule`), so a reload keeps it.
  const location = useLocation();
  const step = parsePlanStep(location.query.get("step"));
  /** Opens a step. The first one needs no `?step=`, which keeps the plain URL clean. */
  const goToStep = (id: PlanStepId) =>
    replaceQuery({ step: id === PLAN_STEPS[0] ? undefined : id });

  // The steps opened so far: a step is "done" once it was visited and its fields are
  // valid. An existing plan was filled in before, so all of its steps count as visited.
  const [visited, setVisited] = useState<ReadonlySet<PlanStepId>>(
    () => new Set(isNew ? [step] : PLAN_STEPS),
  );
  useEffect(() => {
    setVisited((current) => (current.has(step) ? current : new Set([...current, step])));
  }, [step]);

  // Focus to move once the next step is on screen (see `focusOpenStep`).
  const formRef = useRef<HTMLFormElement>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | undefined>(undefined);
  useEffect(() => {
    if (focusRequest !== undefined) focusOpenStep(formRef.current, focusRequest.target);
  }, [focusRequest]);
  /** Asks for focus to move to `target` after the next render. */
  const requestFocus = (target: FocusRequest["target"]) =>
    setFocusRequest((current) => ({ target, serial: (current?.serial ?? 0) + 1 }));

  /** Sets one field of the form. */
  const update = <Key extends keyof PlanForm>(key: Key, value: PlanForm[Key]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const validation = validatePlanForm(form, validationContext);
  // Only the messages of steps that show them (see `revealed`).
  const errors: PlanFormErrors = Object.fromEntries(
    Object.entries(validation.errors ?? {}).filter(([field]) => showsErrors(stepOfField(field))),
  );
  /** The steps that would not pass the checks as the form stands now. */
  const invalidSteps: ReadonlySet<PlanStepId> = new Set(stepsWithErrors(validation.errors));
  // The first of them: the steps after it stay closed until it is fixed (see StepFlow's
  // `isComplete`), so Review is only reachable for a plan that can be saved.
  const firstIncomplete = PLAN_STEPS.find((id) => invalidSteps.has(id));

  /**
   * Opens a step from the tabs or Back / Next. Leaving a step that is incomplete (to an
   * earlier one, say) shows its messages, so its tab is marked "!" instead of hiding the
   * problem until a save attempt.
   */
  const openStep = (id: PlanStepId) => {
    if (id !== step && invalidSteps.has(step)) reveal(step);
    goToStep(id);
  };

  /**
   * Called by StepFlow when Next is pressed on an incomplete step, or a tab behind it is
   * clicked (StepFlow has then opened that step): show its messages and put focus on its
   * first invalid field.
   */
  const onIncomplete = (id: PlanStepId) => {
    reveal(id);
    requestFocus("first-error");
  };

  // A step behind the first incomplete one can still be in the URL (a reload of a new
  // plan, a link, the browser's back button): open the incomplete step instead. An
  // existing plan that does not pass the checks as stored opens on its first problem.
  // Only admins are held back: everyone else just looks around (they cannot fix it).
  const openedOnce = useRef(false);
  useEffect(() => {
    const opening = !openedOnce.current;
    openedOnce.current = true;
    if (!canEdit || firstIncomplete === undefined) return;
    const behind = PLAN_STEPS.indexOf(step) > PLAN_STEPS.indexOf(firstIncomplete);
    const invalidPlanOpens = opening && !isNew && step !== firstIncomplete;
    if (behind || invalidPlanOpens) {
      replaceQuery({ step: firstIncomplete === PLAN_STEPS[0] ? undefined : firstIncomplete });
    }
  }, [canEdit, firstIncomplete, isNew, step]);

  const tree = useLoad<readonly DatabaseNode[]>(
    form.connectionId === "" ? "" : `namespaces:${form.connectionId}`,
    (signal) =>
      client.call("GET /api/connections/:id/namespaces", undefined, {
        params: { id: form.connectionId },
        signal,
      }),
  );
  const context: PlanContext = {
    connections: props.connections,
    storage: props.storage,
    tree: tree.data,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (validation.input === undefined) {
      // Open the first step with a problem and put focus on its first message's field.
      goToStep(stepsWithErrors(validation.errors)[0] ?? step);
      requestFocus("first-error");
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

  /** A tab's state: "!" for a step with problems once messages show, ✓ when visited and valid. */
  const stateOf = (id: PlanStepId): FlowStep<PlanStepId>["state"] => {
    // Review has no fields of its own.
    if (id === "review") return undefined;
    if (invalidSteps.has(id)) return showsErrors(id) ? "error" : undefined;
    return visited.has(id) ? "done" : undefined;
  };

  /**
   * A step's fields beside the side column: the selection preview on "What to back up",
   * the plan summary elsewhere. The fields sit in a fieldset that is disabled for
   * non-admins; the tabs and Back / Next stay outside it, so everyone can look around.
   */
  const withSideColumn = (id: PlanStepId, fields: ReactNode) => (
    <div className="plan-layout">
      <fieldset disabled={!canEdit} className="plain-fieldset plan-main">
        {fields}
      </fieldset>
      {/* Only the open step renders its side column, so the page has just one. */}
      {id !== step ? null : id === "what" ? (
        <SelectionPreviewCard form={form} tree={tree} />
      ) : (
        <PlanSummaryCard form={form} context={context} />
      )}
    </div>
  );

  const fieldProps: StepFieldsProps = { form, errors, update, change: setForm };
  const contents: Record<PlanStepId, ReactNode> = {
    basics: withSideColumn(
      "basics",
      <BasicsStep
        {...fieldProps}
        connections={props.connections}
        storage={props.storage}
        nameSuggestions={planNameSuggestions(form, context)}
      />,
    ),
    what: withSideColumn("what", <WhatStep {...fieldProps} tree={tree} />),
    security: withSideColumn(
      "security",
      <SecurityStep
        {...fieldProps}
        onGeneratedRecipient={(recipient, replaces) =>
          setForm((current) => ({
            ...current,
            recipients: withGeneratedRecipient(current.recipients, recipient, replaces),
          }))
        }
        onGeneratedKeySaved={setGeneratedKeySaved}
        storedPlan={props.plan}
        onRecoveryKeySaved={props.onReload}
      />,
    ),
    schedule: withSideColumn("schedule", <ScheduleStep {...fieldProps} />),
    retention: withSideColumn("retention", <RetentionStep {...fieldProps} />),
    review: (
      <ReviewStep
        form={form}
        context={context}
        isNew={isNew}
        needsAttention={new Set(PLAN_STEPS.filter((id) => invalidSteps.has(id) && showsErrors(id)))}
        onChange={(id) => {
          // The button that was clicked disappears with the review, so focus follows.
          goToStep(id);
          requestFocus("step");
        }}
      />
    ),
  };
  const hints = planStepHints(form, context, isNew);
  const steps: FlowStep<PlanStepId>[] = PLAN_STEPS.map((id) => ({
    id,
    title: PLAN_STEP_TITLES[id],
    hint: hints[id],
    state: stateOf(id),
    content: contents[id],
  }));

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

      <form
        ref={formRef}
        onSubmit={submit}
        noValidate
        className="plan-form"
        aria-label="Backup plan"
      >
        <StepFlow
          label="Backup plan steps"
          steps={steps}
          current={step}
          onStep={openStep}
          // Admins cannot go past a step that is incomplete (Next shows its messages, the
          // later tabs are closed). Everyone else may look at every step: they cannot
          // change anything, so holding them on a problem would only lock them out.
          {...(canEdit
            ? { isComplete: (id: PlanStepId) => !invalidSteps.has(id), onIncomplete }
            : {})}
          // Create / Save closes the flow on the Review step. An existing plan can be saved
          // from every step, so a small change does not mean walking through them all.
          finish={
            canEdit ? (
              <Button type="submit" variant="primary" busy={busy}>
                {isNew ? "Create plan" : "Save changes"}
              </Button>
            ) : null
          }
          finishOnEveryStep={!isNew}
          extra={
            canEdit ? (
              <a href="#/plans" className="button button-ghost">
                Cancel
              </a>
            ) : null
          }
        />
        {saveError === undefined ? null : (
          <ErrorNotice error={saveError} title="Could not save the plan" />
        )}
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

// -------------------------------------------------------------------- the step fields

/** What every step's fields get: the form, its messages, and two ways to change it. */
interface StepFieldsProps {
  readonly form: PlanForm;
  /** Field → message; empty until the first save attempt. */
  readonly errors: PlanFormErrors;
  /** Sets one field. */
  readonly update: <Key extends keyof PlanForm>(key: Key, value: PlanForm[Key]) => void;
  /** Applies a change that touches several fields, e.g. `withRepeat`. */
  readonly change: (next: (current: PlanForm) => PlanForm) => void;
}

/** Step 1: the plan's name, the connection it backs up and the storage it writes to. */
function BasicsStep(
  props: StepFieldsProps & {
    readonly connections: readonly ConnectionView[];
    readonly storage: readonly StorageView[];
    /** Names made from the plan's choices (`planNameSuggestions`). */
    readonly nameSuggestions: readonly string[];
  },
) {
  const { form, errors, update } = props;
  return (
    <FieldGroup
      legend="Basics"
      description="A name for the plan, the database it backs up, and where the backups go."
    >
      <TextField
        label="Name"
        value={form.name}
        onValue={(value) => update("name", value)}
        error={errors.name}
        suggestions={
          <FillSuggestions
            field="Name"
            items={props.nameSuggestions}
            current={form.name}
            onPick={(value) => update("name", value)}
          />
        }
      />
      <div className="grid-2">
        <SelectField
          label="Connection"
          value={form.connectionId}
          options={[
            { value: "", label: "Choose…", disabled: true },
            ...props.connections.map((connection) => ({
              value: connection.id,
              label: connection.production ? `${connection.name} (production)` : connection.name,
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
            ...props.storage.map((location) => ({ value: location.id, label: location.name })),
          ]}
          onValue={(value) => update("storageId", value)}
          error={errors.storageId}
        />
      </div>
    </FieldGroup>
  );
}

/** Step 2: everything, ticked databases and collections, or include / exclude patterns. */
function WhatStep(props: StepFieldsProps & { readonly tree: LoadState<readonly DatabaseNode[]> }) {
  const { form, errors, update, tree } = props;
  // Suggestions add a line to the box; ones already in it are not offered again.
  const notIn = (text: string) => (pattern: string) => !lines(text).includes(pattern);
  const databasePatterns = (tree.data ?? []).map((database) => `${database.name}.*`);
  return (
    <FieldGroup legend="What to back up">
      <RadioCards
        legend="Which databases and collections"
        hideLegend
        value={form.selection}
        onValue={(selection) => props.change((current) => withSelection(current, selection))}
        options={[
          {
            value: "everything",
            label: "Everything",
            description:
              "Every database and collection, including ones created later. MongoDB's own admin, local and config are always left out.",
          },
          {
            value: "pick",
            label: "Choose databases and collections",
            description:
              "Tick them in a list. A ticked database includes collections added to it later.",
          },
          {
            value: "advanced",
            label: "Patterns (advanced)",
            description: 'Include and exclude wildcard patterns, such as "*.sessions".',
          },
        ]}
      />
      {form.selection === "pick" ? (
        <NamespacePicker
          legend="Databases and collections to back up"
          tree={tree.data}
          loading={tree.loading}
          error={tree.error}
          onRetry={tree.reload}
          picks={form.picks}
          onPicks={(picks) => update("picks", picks)}
          message={errors.picks}
        />
      ) : null}
      {form.selection === "advanced" ? (
        <>
          <p className="field-hint">
            One pattern per line, like "shop.*", "*.sessions" or "shop.users". An empty Include
            backs up everything; Exclude then leaves collections out.
          </p>
          <div className="grid-2">
            <TextAreaField
              label="Include"
              value={form.include}
              onValue={(value) => update("include", value)}
              rows={4}
              spellCheck={false}
              placeholder="shop.*"
              error={errors.include}
              // Each database of the connection, whole.
              suggestions={
                <FillSuggestions
                  field="Include"
                  lead="Add"
                  mono
                  items={databasePatterns.filter(notIn(form.include))}
                  onPick={(pattern) => update("include", appendLine(form.include, pattern))}
                />
              }
            />
            <TextAreaField
              label="Exclude"
              value={form.exclude}
              onValue={(value) => update("exclude", value)}
              rows={4}
              spellCheck={false}
              placeholder="*.sessions"
              error={errors.exclude}
              suggestions={
                <FillSuggestions
                  field="Exclude"
                  lead="Add"
                  mono
                  items={EXCLUDE_SUGGESTIONS.filter((item) => notIn(form.exclude)(item.value))}
                  onPick={(pattern) => update("exclude", appendLine(form.exclude, pattern))}
                />
              }
            />
          </div>
        </>
      ) : null}
    </FieldGroup>
  );
}

/** Step 3: compression, consistency and verification, then who can read the backups. */
function SecurityStep(
  props: StepFieldsProps & {
    /** "Generate a key pair" made a public key (see `withGeneratedRecipient`). */
    readonly onGeneratedRecipient: (recipient: string, replaces: string | undefined) => void;
    /** Whether the generated private key was marked as saved. */
    readonly onGeneratedKeySaved: (saved: boolean) => void;
    /** The plan as saved (undefined for a new plan), for its recovery key. */
    readonly storedPlan: PlanView | undefined;
    /** Called after the recovery key was downloaded. */
    readonly onRecoveryKeySaved: () => void;
  },
) {
  const { form, errors, update } = props;
  const isAdmin = useSession().hasRole("admin");
  // The saved plan already has a console-kept key: its recovery key can be downloaded.
  const storedWithKey =
    props.storedPlan !== undefined && hasRecoveryKey(props.storedPlan)
      ? props.storedPlan
      : undefined;
  return (
    <>
      <FieldGroup legend="Format and checks">
        <div className="grid-3">
          <SelectField
            label="Compression"
            value={form.compression}
            options={COMPRESSION_OPTIONS}
            onValue={(value) => update("compression", value)}
          />
          <SelectField
            label="Consistency"
            value={form.consistency}
            options={CONSISTENCY_OPTIONS}
            onValue={(value) => update("consistency", value)}
            hint="Snapshot reads one point in time; converge replays changes made during the backup."
          />
          <SelectField
            label="Verify after backup"
            value={form.verify}
            options={VERIFY_OPTIONS}
            onValue={(value) => update("verify", value)}
          />
        </div>
      </FieldGroup>

      <FieldGroup legend="Who can read the backups">
        <SelectField
          label="Encryption"
          value={form.encryptionKind}
          options={ENCRYPTION_OPTIONS}
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
            // The generator panel below explains which key goes here.
            hint="One per line."
            error={errors.recipients}
          />
        ) : null}
        {/*
         * Outside the condition above, and only hidden for other kinds of encryption: the
         * generated private key lives in the panel's own state, so it must stay mounted
         * while someone looks at another choice and comes back.
         */}
        <div hidden={form.encryptionKind !== "recipients"}>
          <AgeKeyGenerator
            onRecipient={props.onGeneratedRecipient}
            onSavedChange={props.onGeneratedKeySaved}
          />
          {errors.generatedKey === undefined ? null : (
            // Focusable, so a blocked Next or save can move focus to the reason.
            <p className="field-error" role="alert" tabIndex={-1} data-step-error>
              <span aria-hidden="true">! </span>
              {errors.generatedKey}
            </p>
          )}
        </div>
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
          <Notice tone="info" title="The console keeps the key">
            <p>
              The console creates a key, encrypts every backup with it and uses it to restore, so
              nobody has to type a key. Its <strong>recovery key</strong> restores the backups even
              if the console is lost: download it and keep it somewhere safe.
            </p>
            {storedWithKey === undefined ? (
              <p className="muted">
                The key is created when the plan is saved. Download its recovery key here
                afterwards, or in Settings → Recovery keys.
              </p>
            ) : isAdmin ? (
              <div className="stack">
                <RecoveryKeyButton plan={storedWithKey} onSaved={props.onRecoveryKeySaved} />
                <span className="muted">
                  {storedWithKey.encryption.kind === "managed" &&
                  storedWithKey.encryption.recoveryKeySaved
                    ? "Downloaded before; you can download it again."
                    : "Not downloaded yet."}
                </span>
              </div>
            ) : (
              <p className="muted">An admin can download the recovery key.</p>
            )}
          </Notice>
        ) : null}
        {form.encryptionKind === "none" ? (
          <Notice tone="warning">
            Backups will be readable by anyone with access to the storage.
          </Notice>
        ) : null}
      </FieldGroup>
    </>
  );
}

/** Step 4: when the plan runs (with a live preview), and incremental backups. */
function ScheduleStep(props: StepFieldsProps) {
  const { form, errors, update, change } = props;
  return (
    <FieldGroup legend="When">
      <CheckboxField
        label="Run on a schedule"
        checked={form.scheduled}
        onChecked={(value) => update("scheduled", value)}
        hint="Without a schedule the plan only runs when started by hand."
      />
      {form.scheduled ? (
        <>
          <ScheduleFields
            repeat={form.repeat}
            cron={form.cron}
            cronError={errors.cron}
            onRepeat={(repeat) => change((current) => withRepeat(current, repeat))}
            onPreset={(preset) => change((current) => withPreset(current, preset))}
            onCron={(cron) => update("cron", cron)}
          />
          <TimeZoneField
            value={form.timezone}
            onValue={(value) => update("timezone", value)}
            error={errors.timezone}
          />
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
        <SelectField
          label="Full backup"
          value={form.fullEveryDays}
          options={fullBackupOptions(form.fullEveryDays)}
          onValue={(value) => update("fullEveryDays", value)}
          hint="Runs in between store only the changes, e.g. hourly runs with a weekly full backup."
          error={errors.fullEveryDays}
        />
      ) : null}
    </FieldGroup>
  );
}

/** Step 5: how long backups are kept, and where results and failures are reported. */
function RetentionStep(props: StepFieldsProps) {
  const { form, errors, update } = props;
  /** Replaces notification row `index` with `change(row)`. */
  const changeRow = (index: number, change: (row: NotifyRow) => NotifyRow) =>
    update(
      "notify",
      form.notify.map((row, at) => (at === index ? change(row) : row)),
    );
  return (
    <>
      <FieldGroup
        legend="Retention"
        description="Old backups are deleted after each run by this rule. The newest backup is never deleted."
      >
        <SelectField
          label="Keep"
          value={form.retentionPreset}
          options={RETENTION_PRESET_IDS.map((id) => ({
            value: id,
            label: id === "custom" ? CUSTOM_RETENTION_LABEL : RETENTION_PRESETS[id].label,
          }))}
          onValue={(id) => props.change((current) => withRetentionPreset(current, id))}
          hint={
            form.retentionPreset === "custom"
              ? "How many backups to keep in each bucket below. Empty = not used; a backup kept by any bucket stays."
              : RETENTION_PRESETS[form.retentionPreset].description
          }
        />
        {form.retentionPreset === "custom" ? (
          <div className="grid-5">
            {RETENTION_KEYS.map((key) => {
              const label = key === "last" ? "Last N" : key.charAt(0).toUpperCase() + key.slice(1);
              /** Sets this bucket's count. */
              const setCount = (value: string) =>
                update("retention", { ...form.retention, [key]: value });
              return (
                <TextField
                  key={key}
                  label={label}
                  inputMode="numeric"
                  value={form.retention[key]}
                  onValue={setCount}
                  error={errors[`retention.${key}`]}
                  suggestions={
                    <FillSuggestions
                      field={label}
                      items={RETENTION_SUGGESTIONS[key]}
                      current={form.retention[key]}
                      onPick={setCount}
                    />
                  }
                />
              );
            })}
          </div>
        ) : null}
      </FieldGroup>

      <FieldGroup legend="Notifications" description="Where to report failures and results.">
        {form.notify.map((row, index) => (
          // Rows have no id; their position is their identity while editing.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <div key={index} className="notify-row">
            <SelectField
              label="Type"
              value={row.type}
              options={[
                { value: "slack", label: NOTIFY_NAMES.slack },
                { value: "discord", label: NOTIFY_NAMES.discord },
                { value: "webhook", label: NOTIFY_NAMES.webhook },
              ]}
              onValue={(value) => changeRow(index, (current) => ({ ...current, type: value }))}
            />
            <TextField
              label="URL"
              type="password"
              autoComplete="off"
              value={row.url}
              onValue={(value) => changeRow(index, (current) => ({ ...current, url: value }))}
              // The shape of this type's URL; the URL itself is secret, so no suggestions.
              placeholder={
                row.storedPreview === undefined
                  ? NOTIFY_PLACEHOLDERS[row.type]
                  : "Leave empty to keep the stored URL"
              }
              hint={row.storedPreview === undefined ? undefined : `Stored: ${row.storedPreview}`}
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
          // The server takes at most MAX_NOTIFY targets per plan, so the button stops there.
          disabled={form.notify.length >= MAX_NOTIFY}
          title={
            form.notify.length >= MAX_NOTIFY
              ? `A plan can report to at most ${MAX_NOTIFY} places.`
              : undefined
          }
          onClick={() => update("notify", [...form.notify, { type: "slack", url: "" }])}
        >
          Add notification
        </Button>
      </FieldGroup>
    </>
  );
}

// ------------------------------------------------------------- review and side column

/** The steps the review lists (all but the review itself). */
type ReviewedStep = Exclude<PlanStepId, "review">;

/** One labelled row of the review: [label, value]. */
type ReviewRow = readonly [ReactNode, ReactNode];

/**
 * A muted placeholder for a value not chosen yet ("Not named yet"). It is an element in
 * a row array, so it carries a key (one per row, so the same key everywhere is fine).
 */
function missing(text: string): ReactNode {
  return (
    <span key="missing" className="muted">
      {text}
    </span>
  );
}

/** Every choice of the plan, grouped by the step it is made on, as label / value rows. */
function reviewRows(form: PlanForm, context: PlanContext): Record<ReviewedStep, ReviewRow[]> {
  const connection = context.connections.find((candidate) => candidate.id === form.connectionId);
  const storage = storageName(form, context);
  const recipients = lines(form.recipients);
  return {
    basics: [
      ["Name", form.name.trim() === "" ? missing("Not named yet") : form.name.trim()],
      [
        "Connection",
        connection === undefined
          ? missing("Not chosen")
          : connection.production
            ? `${connection.name} (production)`
            : connection.name,
      ],
      ["Storage", storage ?? missing("Not chosen")],
    ],
    what: [
      ["Backs up", describeSelection(form, context.tree)],
      // The ticks or patterns themselves, for the modes that have them.
      ...(form.selection === "pick" && form.picks.length > 0
        ? [["Chosen", form.picks.join(", ")] as const]
        : []),
      ...(form.selection === "advanced"
        ? [
            ["Include", lines(form.include).join(", ") || "Everything"] as const,
            ["Exclude", lines(form.exclude).join(", ") || "Nothing"] as const,
          ]
        : []),
    ],
    security: [
      ["Compression", optionLabel(COMPRESSION_OPTIONS, form.compression)],
      ["Consistency", optionLabel(CONSISTENCY_OPTIONS, form.consistency)],
      ["Verify after backup", optionLabel(VERIFY_OPTIONS, form.verify)],
      ["Encryption", ENCRYPTION_NAMES[form.encryptionKind]],
      ...(form.encryptionKind === "recipients"
        ? [
            [
              "Public keys",
              recipients.length === 0 ? missing("None yet") : plural(recipients.length, "key"),
            ] as const,
          ]
        : []),
      ...(form.encryptionKind === "passphrase"
        ? [
            [
              "Passphrase",
              form.passphrase !== ""
                ? "New passphrase entered"
                : form.passphraseStored
                  ? "The stored one is kept"
                  : missing("Not entered yet"),
            ] as const,
          ]
        : []),
    ],
    schedule: [
      ["Runs", describeSchedule(form)],
      ...(form.scheduled ? [["Time zone", form.timezone.trim()] as const] : []),
      [
        "Incremental",
        form.incremental
          ? `On, a full backup ${fullBackupLabel(form.fullEveryDays.trim()).toLowerCase()}`
          : "Off, every backup is full",
      ],
    ],
    retention: [
      ["Keeps", describeRetention(form)],
      [
        "Notifications",
        form.notify.length === 0
          ? "None"
          : form.notify.map((row) => NOTIFY_NAMES[row.type]).join(", "),
      ],
    ],
  };
}

/**
 * Step 6: every choice in readable sentences, one card per step with a "Change" button
 * that opens that step. The flow's Create / Save button follows it.
 */
function ReviewStep(props: {
  readonly form: PlanForm;
  readonly context: PlanContext;
  readonly isNew: boolean;
  /** Steps to flag as needing attention (empty before the first save attempt). */
  readonly needsAttention: ReadonlySet<PlanStepId>;
  readonly onChange: (id: ReviewedStep) => void;
}) {
  const rows = reviewRows(props.form, props.context);
  const sections = PLAN_STEPS.filter((id): id is ReviewedStep => id !== "review");
  return (
    <div className="plan-review">
      <p className="field-hint">
        {props.isNew
          ? "Check the plan, then create it. Change opens that step; nothing is lost on the way."
          : "Check the changes, then save them. Change opens that step; nothing is lost on the way."}
      </p>
      <div className="plan-review-grid">
        {sections.map((id) => (
          <ReviewSection
            key={id}
            title={PLAN_STEP_TITLES[id]}
            rows={rows[id]}
            needsAttention={props.needsAttention.has(id)}
            onChange={() => props.onChange(id)}
          />
        ))}
      </div>
    </div>
  );
}

/** One card of the review: the step's title, a "Change" button, and its choices. */
function ReviewSection(props: {
  readonly title: string;
  readonly rows: readonly ReviewRow[];
  readonly needsAttention: boolean;
  readonly onChange: () => void;
}) {
  const headingId = useId();
  return (
    <section
      className="plan-review-section"
      aria-labelledby={headingId}
      data-state={props.needsAttention ? "error" : undefined}
    >
      <header className="plan-review-header">
        <h3 id={headingId} className="plan-review-title">
          {props.title}
        </h3>
        {props.needsAttention ? (
          <span className="plan-review-alert">
            <span aria-hidden="true">! </span>Needs attention
          </span>
        ) : null}
        <Button
          size="small"
          variant="ghost"
          onClick={props.onChange}
          // "Change" alone is ambiguous in a list of buttons; the name says which step.
          aria-label={`Change ${props.title.toLowerCase()}`}
        >
          <Icon name="edit" size={13} />
          Change
        </Button>
      </header>
      <KeyValueList items={props.rows} />
    </section>
  );
}

/** The side column of "What to back up": which collections the choice selects. */
function SelectionPreviewCard(props: {
  readonly form: PlanForm;
  readonly tree: LoadState<readonly DatabaseNode[]>;
}) {
  const { form, tree } = props;
  return (
    <aside className="plan-preview" aria-label="Selection preview">
      <Panel title="Selection preview">
        <SelectionPreview
          tree={tree.data}
          loading={tree.loading}
          error={tree.error}
          {...selectionPatterns(form)}
          // "Choose" with nothing ticked selects nothing (an empty include pattern list
          // would otherwise read as "everything").
          nothingChosen={form.selection === "pick" && form.picks.length === 0}
        />
      </Panel>
    </aside>
  );
}

/** The side column of the other steps: the whole plan at a glance, as it stands. */
function PlanSummaryCard(props: { readonly form: PlanForm; readonly context: PlanContext }) {
  const { form, context } = props;
  const name = form.name.trim();
  return (
    <aside className="plan-preview" aria-label="Plan summary">
      <Panel title="Plan summary">
        <KeyValueList
          items={[
            ["Name", name === "" ? missing("Not named yet") : name],
            ["Where", describeTarget(form, context)],
            ["What", describeSelection(form, context.tree)],
            [
              "Schedule",
              form.scheduled
                ? `${describeSchedule(form)} (${form.timezone.trim()})`
                : describeSchedule(form),
            ],
            ["Encryption", ENCRYPTION_NAMES[form.encryptionKind]],
            ["Retention", describeRetention(form)],
          ]}
        />
      </Panel>
    </aside>
  );
}

/** The "Full backup" options: the common intervals, plus the plan's own when it differs. */
function fullBackupOptions(current: string) {
  const values: string[] = FULL_BACKUP_DAYS.map(String);
  const options = values.map((value) => ({ value, label: fullBackupLabel(value) }));
  // An existing plan with another interval (say 0.5 days) keeps it as a choice.
  if (!values.includes(current)) {
    options.push({ value: current, label: `${fullBackupLabel(current)} (this plan's setting)` });
  }
  return options;
}

/**
 * The schedule controls: the "Repeat" select, then what that choice needs: the minute
 * (hourly kinds), the weekday or day of the month, and the time of day; or, for
 * "Custom", the cron expression field.
 */
function ScheduleFields(props: {
  repeat: RepeatKind;
  cron: string;
  cronError: string | undefined;
  onRepeat: (repeat: RepeatKind) => void;
  onPreset: (preset: SchedulePreset) => void;
  onCron: (cron: string) => void;
}) {
  const { repeat } = props;
  // The preset controls show what the cron says; `repeat` wins over what it parses as,
  // so the select never jumps to another choice on its own.
  const preset: SchedulePreset | undefined =
    repeat === "custom" ? undefined : { ...(presetFromCron(props.cron) ?? DEFAULT_PRESET), repeat };

  return (
    <div className="plan-schedule-grid">
      <SelectField
        label="Repeat"
        value={repeat}
        options={REPEAT_KINDS.map((kind) => ({ value: kind, label: REPEAT_LABELS[kind] }))}
        onValue={props.onRepeat}
      />

      {preset !== undefined && isHourlyKind(preset.repeat) ? (
        <SelectField
          label="Minutes past the hour"
          value={String(preset.minute)}
          options={minuteOptions(preset.minute).map((minute) => ({
            value: String(minute),
            label: `:${twoDigits(minute)}`,
          }))}
          onValue={(minute) => props.onPreset({ ...preset, minute: Number(minute) })}
        />
      ) : null}

      {preset?.repeat === "weekly" ? (
        <SelectField
          label="Day of the week"
          value={String(preset.weekday)}
          options={WEEKDAY_ORDER.map((weekday) => ({
            value: String(weekday),
            label: WEEKDAYS[weekday],
          }))}
          onValue={(weekday) => props.onPreset({ ...preset, weekday: Number(weekday) })}
        />
      ) : null}

      {preset?.repeat === "monthly" ? (
        <SelectField
          label="Day of the month"
          value={String(preset.dayOfMonth)}
          options={Array.from({ length: LAST_PRESET_DAY }, (_unused, index) => ({
            value: String(index + 1),
            label: ordinal(index + 1),
          }))}
          onValue={(day) => props.onPreset({ ...preset, dayOfMonth: Number(day) })}
          hint="Up to the 28th, which every month has."
        />
      ) : null}

      {preset !== undefined && !isHourlyKind(preset.repeat) ? (
        <SelectField
          label="Time of day"
          value={timeValue(preset.hour, preset.minute)}
          options={timeOptions(preset.hour, preset.minute).map((time) => ({
            value: time,
            label: time,
          }))}
          onValue={(time) => props.onPreset({ ...preset, ...parseTimeValue(time) })}
        />
      ) : null}

      {repeat === "custom" ? (
        <TextField
          className="plan-schedule-cron"
          label="Cron expression"
          value={props.cron}
          onValue={props.onCron}
          spellCheck={false}
          hint="minute hour day-of-month month day-of-week, e.g. 0 2 * * 1-5 for 02:00 on weekdays"
          error={props.cronError}
          // Named by what they do; the tooltip shows the expression each one fills in.
          suggestions={
            <FillSuggestions
              field="Cron expression"
              items={CRON_SUGGESTIONS.map((item) => ({ ...item, hint: item.value }))}
              current={props.cron}
              onPick={props.onCron}
            />
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The time zone as a select, grouped by region (`<optgroup>`), with this browser's zone
 * and UTC first and each zone's current UTC offset. `SelectField` has no groups, so the
 * select is built here inside the shared `Field` wrapper (label, hint, error).
 */
function TimeZoneField(props: {
  value: string;
  onValue: (value: string) => void;
  error: string | undefined;
}) {
  const browserZone = useMemo(browserTimeZone, []);
  const groups = useMemo(
    () => timeZoneGroups(props.value, browserZone),
    [props.value, browserZone],
  );
  return (
    <Field
      label="Time zone"
      hint="The times above are in this zone, and follow its daylight saving changes."
      error={props.error}
      className="plan-time-zone"
    >
      {(control) => (
        <select
          id={control.id}
          className="input select"
          value={props.value}
          aria-describedby={control.describedBy}
          aria-invalid={control.invalid || undefined}
          onChange={(event) => props.onValue(event.target.value)}
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.zones.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </Field>
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
  /** True when nothing is chosen yet: every collection shows as left out. */
  nothingChosen?: boolean;
}) {
  const { tree, include, exclude } = props;
  /** Whether the plan as it stands would back up `ns`. */
  const selects = (ns: string): boolean =>
    props.nothingChosen !== true && isSelected(ns, include, exclude);
  if (props.error !== undefined)
    return <ErrorNotice error={props.error} title="Could not list namespaces" />;
  if (tree === undefined)
    return props.loading ? (
      <Loading label="Listing databases…" />
    ) : (
      <p className="muted">Choose a connection to preview.</p>
    );
  const all = namespacesOf(tree);
  const selected = all.filter(selects);
  let documents = 0;
  for (const database of tree) {
    for (const collection of database.collections) {
      if (selects(`${database.name}.${collection.name}`))
        documents += collection.estimatedDocuments;
    }
  }
  return (
    <>
      <p aria-live="polite">
        <strong className="numeric">{selected.length}</strong> of {all.length} collections selected,
        about <span className="numeric">{formatNumber(documents)}</span> documents.
      </p>
      <NamespaceTree tree={tree} isSelected={selects} />
    </>
  );
}
