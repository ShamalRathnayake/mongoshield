/**
 * The add/edit dialog of a storage location, built from choices instead of free text,
 * as a two-step flow (StepFlow, ../components/step-flow.tsx) instead of one long scroll:
 *
 *   (1) Location ─── (2) Sign in                       [Cancel]    [Next: Sign in →]
 *
 * 1. Location: the name, then a "Type" select (Amazon S3, S3-compatible, Google Cloud
 *    Storage, Azure Blob Storage, SFTP, a local folder) and the fields of that type
 *    (bucket, folder, a region select with the common AWS regions, provider presets
 *    that build the endpoint for Cloudflare R2, Backblaze B2, Wasabi…). The URL the
 *    server stores is built from them and shown read-only; "Edit as URL (advanced)"
 *    swaps the fields for the raw URL. Editing an existing location parses its URL back
 *    into the fields, or opens in URL mode when the fields cannot show it exactly
 *    (../storage-url.ts).
 * 2. Sign in: "Sign in with" offers the provider's usual secret in named fields (access
 *    keys, a service account key file, an account key or connection string, an SSH
 *    private key), the console's own environment (an IAM role, workload identity, the
 *    SSH agent…), KEY=value lines for experts and, when editing, keeping the stored
 *    credentials. They become the same KEY=value pairs the server always stored
 *    (../storage-credentials.ts); secrets are never shown again. Types that take no
 *    credentials (a local folder) lock this step, so "Add and test" moves to step 1.
 *
 * Free-text fields offer one-click values under them (FillSuggestions): names from the
 * type ("S3 primary", "R2 offsite", the bucket), folders ("backups/", "prod/", one per
 * connection), SSH's port 22, MinIO's and Azurite's usual addresses. Secrets never get
 * suggestions.
 *
 * The flow's own row replaces the dialog footer: Cancel and Back on the left, Next or
 * "Add and test" / "Save and test" on the right, kept in view at the bottom.
 *
 * Saving validates every field first: problems are shown next to their fields, their
 * step's tab gets an exclamation mark, and the flow jumps to the first step with a
 * problem (focus on its first invalid field). The server's own checks still apply (a
 * save error is shown on the current step).
 */

import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { StorageInput, StorageView } from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import { Dialog } from "../components/dialog.tsx";
import { CheckboxField, SelectField, TextAreaField, TextField } from "../components/field.tsx";
import { FillSuggestions } from "../components/fill-suggestions.tsx";
import { ErrorNotice, Notice } from "../components/layout.tsx";
import { RadioCards } from "../components/radio-cards.tsx";
import { type FlowStep, StepFlow } from "../components/step-flow.tsx";
import { useApi, useLoad } from "../context.tsx";
import {
  buildCredentials,
  CREDENTIAL_NAMES,
  type CredentialMethod,
  type CredentialValues,
  credentialMethodsFor,
  EMPTY_CREDENTIALS,
} from "../storage-credentials.ts";
import {
  AWS_REGIONS,
  buildStorageUrl,
  emptyStorageFields,
  fingerprintsOf,
  parseStorageUrl,
  S3_PROVIDER_ORDER,
  S3_PROVIDERS,
  type S3Provider,
  STORAGE_KINDS,
  type StorageFieldErrors,
  type StorageFields,
  storageFieldErrors,
  storageSchemeOf,
} from "../storage-url.ts";
import "./storage-form.css";

/**
 * The value of the region select's "Other region…" option. Regions never contain `*`,
 * so it cannot collide with a real one.
 */
const OTHER_REGION = "*other*";

// ---- one-click suggestions (FillSuggestions under the fields) ------------------------
// Only names, folders and well-known defaults are ever suggested, never secrets.

/** Short provider names for name suggestions, e.g. "R2 offsite". */
const PROVIDER_SHORT_NAMES: Readonly<Record<S3Provider, string>> = {
  r2: "R2",
  b2: "B2",
  wasabi: "Wasabi",
  spaces: "Spaces",
  minio: "MinIO",
  other: "S3-compatible",
};

/** How many connections become folder suggestions, to keep the row short. */
const MAX_CONNECTION_FOLDERS = 3;

/**
 * Names for a location, from its type and fields: "S3 primary", "R2 offsite", the
 * bucket, container or host itself, "Local backups"… Undefined fields (URL mode with a
 * URL the fields cannot show) give two generic names.
 */
export function storageNameSuggestions(fields: StorageFields | undefined): string[] {
  if (fields === undefined) return ["Primary backups", "Offsite backups"];
  switch (fields.kind) {
    case "s3":
      return ["S3 primary", "S3 offsite", fields.bucket.trim()];
    case "s3-compatible": {
      const short = PROVIDER_SHORT_NAMES[fields.provider];
      return [`${short} offsite`, `${short} primary`, fields.bucket.trim()];
    }
    case "gcs":
      return ["GCS primary", "GCS offsite", fields.bucket.trim()];
    case "azure":
      return ["Azure primary", "Azure offsite", fields.container.trim()];
    case "sftp":
      return ["SFTP server", fields.host.trim() === "" ? "" : `SFTP ${fields.host.trim()}`];
    case "local":
      return ["Local backups", "Local archive"];
  }
}

/**
 * A connection name as a folder name: lower case, runs of other characters as one
 * dash, no dashes at the ends ("Production cluster" → "production-cluster").
 */
export function folderNameOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Folder names for the first few connections, the empty ones dropped. */
function connectionFolders(connectionNames: readonly string[]): string[] {
  return connectionNames
    .slice(0, MAX_CONNECTION_FOLDERS)
    .map(folderNameOf)
    .filter((folder) => folder !== "");
}

/** Prefixes inside a bucket or container: "backups/", "prod/", one per connection. */
export function prefixSuggestions(connectionNames: readonly string[]): string[] {
  return ["backups/", "prod/", ...connectionFolders(connectionNames).map((name) => `${name}/`)];
}

/** Local folders in the data volume: "backups", "backups/prod", one per connection. */
export function localFolderSuggestions(connectionNames: readonly string[]): string[] {
  return [
    "backups",
    "backups/prod",
    ...connectionFolders(connectionNames).map((name) => `backups/${name}`),
  ];
}

/** The steps of the dialog, in order (see the file header). */
export type StorageStepId = "location" | "signIn";

/** Longest storage name the server stores. */
const MAX_NAME_LENGTH = 100;
/** Longest location URL the server stores. */
const MAX_URL_LENGTH = 1024;

/** Props for `StorageDialog`. */
export interface StorageDialogProps {
  /** The location being edited, or undefined to add one. */
  readonly storage: StorageView | undefined;
  /**
   * The names of the other storage locations. Names must be unique (the server refuses a
   * second "S3 primary"), so the Name field says so before saving.
   */
  readonly takenNames?: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: (storage: StorageView) => void;
}

/** Add/edit form for a storage location. Credentials are write-only. */
export function StorageDialog(props: StorageDialogProps) {
  const client = useApi();
  const existing = props.storage;
  // The connections' names become folder suggestions ("shop/"). Only a convenience: a
  // failed load just means fewer suggestions.
  const connections = useLoad("connections", (signal) =>
    client.call("GET /api/connections", undefined, { signal }),
  );
  const connectionNames = (connections.data ?? []).map((connection) => connection.name);
  // An existing URL the fields can show opens in the fields; anything else as a URL.
  const parsedExisting = existing === undefined ? undefined : parseStorageUrl(existing.url);
  const [name, setName] = useState(existing?.name ?? "");
  const [fields, setFields] = useState<StorageFields>(parsedExisting ?? emptyStorageFields());
  const [advanced, setAdvanced] = useState(existing !== undefined && parsedExisting === undefined);
  const [rawUrl, setRawUrl] = useState(existing?.url ?? "");
  /** Why the URL could not be turned back into fields (when leaving URL mode). */
  const [advancedProblem, setAdvancedProblem] = useState<string | undefined>(undefined);
  /** False until the location is changed: an untouched location is saved as it was. */
  const [touched, setTouched] = useState(false);
  const [regionOther, setRegionOther] = useState(
    fields.region !== "" && !AWS_REGIONS.some((region) => region.value === fields.region),
  );
  const [chosenMethod, setChosenMethod] = useState<CredentialMethod | undefined>(undefined);
  const [secrets, setSecrets] = useState<CredentialValues>(EMPTY_CREDENTIALS);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  /** The step the user is on. */
  const [step, setStep] = useState<StorageStepId>("location");
  /** Steps the user has moved on from: their tab shows a check mark when complete. */
  const [left, setLeft] = useState<ReadonlySet<StorageStepId>>(() => new Set());
  /**
   * Steps whose messages show before a save attempt: the ones the user tried to leave
   * while incomplete (Next, or the Sign in tab). An untouched step stays quiet.
   */
  const [revealed, setRevealed] = useState<ReadonlySet<StorageStepId>>(() => new Set());
  /**
   * Counts the saves stopped by a problem, so the focus effect below runs even when the
   * flow is already on the step it jumps to.
   */
  const [jumps, setJumps] = useState(0);
  /** Set by such a save; the effect clears it, so plain step changes keep focus. */
  const focusProblem = useRef(false);
  const urlId = useId();
  // The content of each step, to find its first invalid field after a jump.
  const locationRef = useRef<HTMLDivElement>(null);
  const signInRef = useRef<HTMLDivElement>(null);

  /** Changes some location fields (and marks the location as changed). */
  const update = (change: Partial<StorageFields>) => {
    setFields((current) => ({ ...current, ...change }));
    setTouched(true);
  };
  /** Changes one typed secret. */
  const updateSecret = (change: Partial<CredentialValues>) =>
    setSecrets((current) => ({ ...current, ...change }));

  // ---- what would be saved ----------------------------------------------------------
  const url = advanced
    ? rawUrl.trim()
    : !touched && existing !== undefined
      ? existing.url
      : buildStorageUrl(fields);
  const scheme = storageSchemeOf(url);
  // Stored credentials can only be kept for the same kind of storage: the server
  // refuses AWS keys for an az:// URL.
  const stored =
    existing?.credentials.configured === true && storageSchemeOf(existing.url) === scheme
      ? (existing.credentials.preview ?? "configured")
      : undefined;
  const methods = credentialMethodsFor(scheme, stored);
  // A choice that does not exist for this type (e.g. "keep" after changing the type)
  // falls back to the first one.
  const method = methods.some((option) => option.value === chosenMethod)
    ? chosenMethod
    : methods[0]?.value;
  // Azure account keys become a connection string for the location's account.
  const locationFields = advanced ? parseStorageUrl(rawUrl.trim()) : fields;
  const credentials = buildCredentials(method, secrets, {
    scheme,
    account: locationFields?.kind === "azure" ? locationFields.account.trim() : "",
    endpoint: locationFields?.kind === "azure" ? locationFields.endpoint.trim() : "",
  });

  // ---- validation -------------------------------------------------------------------
  const fieldErrors: StorageFieldErrors = advanced ? {} : storageFieldErrors(fields);
  // What the Location step needs before "Sign in" opens: its own fields, without the
  // SFTP fingerprint rule below, which depends on the sign-in method chosen on step 2
  // (it is still checked on save, and then shown on Location).
  const locationFieldsIncomplete = Object.keys(fieldErrors).length > 0;
  // Whether the location fields alone make a usable URL yet (before the sign-in checks
  // below add their own messages), for the "Resulting URL" line.
  const locationIncomplete = Object.keys(fieldErrors).length > 0;
  // With a key the console stores, it verifies the SFTP server against a fingerprint
  // only (it has no known_hosts file of its own); the environment can use known_hosts.
  if (
    !advanced &&
    fields.kind === "sftp" &&
    method !== "environment" &&
    !fields.allowUnknownHostKey &&
    fingerprintsOf(fields.fingerprint).length === 0 &&
    fieldErrors.fingerprint === undefined
  ) {
    fieldErrors.fingerprint = `Needed when the console stores the key, to check it talks to the right server. Get it with: ssh-keyscan${fields.port.trim() === "" ? "" : ` -p ${fields.port.trim()}`} ${fields.host.trim() || "<host>"} | ssh-keygen -lf -`;
  }
  const nameError = storageNameProblem(name, props.takenNames ?? []);
  const urlError = advanced ? advancedUrlProblem(url) : undefined;
  const secretErrors = credentials.ok ? {} : credentials.errors;
  const valid =
    nameError === undefined &&
    urlError === undefined &&
    Object.keys(fieldErrors).length === 0 &&
    credentials.ok;
  /** True when step `id` shows its messages (after a save attempt, or once left incomplete). */
  const showsErrors = (id: StorageStepId) => submitted || revealed.has(id);
  /** The message for a Location field, once that step shows its messages. */
  const shown = (message: string | undefined) => (showsErrors("location") ? message : undefined);

  // ---- steps ------------------------------------------------------------------------
  // Which step each problem belongs to. The SFTP fingerprint depends on the sign-in
  // method but is a location field, so it counts for "Location".
  const locationProblem =
    nameError !== undefined || urlError !== undefined || Object.keys(fieldErrors).length > 0;
  const signInProblem = !credentials.ok;
  /** Whether a step's required values are filled in and valid (StepFlow's `isComplete`). */
  const isComplete = (id: StorageStepId): boolean =>
    id === "location"
      ? nameError === undefined && urlError === undefined && !locationFieldsIncomplete
      : !signInProblem;
  // No sign-in method (a local folder, memory://): nothing to ask, the step is locked.
  const needsSignIn = method !== undefined;
  const current: StorageStepId = needsSignIn ? step : "location";

  /** Goes to a step, remembering the one left (for its check mark). */
  const goToStep = (target: StorageStepId) => {
    setLeft((before) => new Set(before).add(current));
    setStep(target);
  };

  /**
   * A step's tab state: "error" once a save was tried and it has a problem; "done"
   * when it is complete and the user has been through it (or it was saved before).
   */
  const stepState = (id: StorageStepId, problem: boolean): "done" | "error" | undefined => {
    if (problem) return showsErrors(id) ? "error" : undefined;
    return existing !== undefined || submitted || left.has(id) ? "done" : undefined;
  };

  // After a save stopped by a problem: focus the first invalid field of the step the
  // flow jumped to (or the step itself), so keyboard and screen reader users land on it.
  useEffect(() => {
    // `jumps` is read so a save stopped on the current step runs this effect too.
    if (jumps === 0 || !focusProblem.current) return;
    focusProblem.current = false;
    const content = (current === "location" ? locationRef : signInRef).current;
    const invalid = content?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (invalid ?? content?.closest<HTMLElement>('[role="tabpanel"]'))?.focus();
  }, [jumps, current]);

  /**
   * Called by StepFlow when Next is pressed on an incomplete step (or the Sign in tab
   * while Location is incomplete): show the step's messages and focus the first one.
   */
  const onIncomplete = (id: StorageStepId) => {
    setRevealed((before) => (before.has(id) ? before : new Set(before).add(id)));
    focusProblem.current = true;
    setJumps((count) => count + 1);
  };

  // ---- URL mode ---------------------------------------------------------------------
  const toggleAdvanced = (on: boolean) => {
    setAdvancedProblem(undefined);
    if (on) {
      // Start from the URL the fields stand for.
      setRawUrl(url);
      setAdvanced(true);
      return;
    }
    if (rawUrl.trim() === "") {
      setAdvanced(false);
      return;
    }
    const parsed = parseStorageUrl(rawUrl.trim());
    if (parsed === undefined) {
      setAdvancedProblem(
        "This URL cannot be shown as fields (an unknown type, file:// or memory://, or parameters in another order). Keep editing it as a URL, or clear it to start over.",
      );
      return;
    }
    setFields(parsed);
    setRegionOther(
      parsed.region !== "" && !AWS_REGIONS.some((region) => region.value === parsed.region),
    );
    setAdvanced(false);
  };

  // ---- saving -----------------------------------------------------------------------
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (!valid || !credentials.ok) {
      // Jump to the first step that needs attention.
      setStep(locationProblem ? "location" : "signIn");
      focusProblem.current = true;
      setJumps((count) => count + 1);
      return;
    }
    setBusy(true);
    setError(undefined);
    const input: StorageInput = {
      name: name.trim(),
      url,
      // undefined = keep the stored credentials (the server's "omit to keep").
      ...(credentials.credentials === undefined ? {} : { credentials: credentials.credentials }),
    };
    try {
      const saved =
        existing === undefined
          ? await client.call("POST /api/storage", input)
          : await client.call("PUT /api/storage/:id", input, { params: { id: existing.id } });
      // The secrets are not needed any more; do not keep them in memory.
      setSecrets(EMPTY_CREDENTIALS);
      props.onSaved(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  // A failed save is shown at the end of the step the user is on, above the button
  // they just pressed.
  const saveFailure =
    error === undefined ? null : <ErrorNotice error={error} title="Could not save" />;

  // ---- step 1: Location -------------------------------------------------------------
  const locationStep = (
    <div className="storage-form-step" ref={locationRef}>
      <TextField
        label="Name"
        value={name}
        onValue={setName}
        data-autofocus
        error={shown(nameError)}
        suggestions={
          <FillSuggestions
            field="Name"
            items={storageNameSuggestions(locationFields)}
            current={name}
            onPick={setName}
          />
        }
      />
      {advanced ? (
        <TextField
          label="Location URL"
          value={rawUrl}
          onValue={(value) => {
            setRawUrl(value);
            setAdvancedProblem(undefined);
          }}
          spellCheck={false}
          autoComplete="off"
          className="storage-form-mono"
          placeholder="s3://acme-backups/prod/"
          hint="s3://, gs://, az://, sftp:// or a folder inside the console's data volume."
          error={shown(urlError)}
        />
      ) : (
        <LocationFields
          fields={fields}
          update={update}
          regionOther={regionOther}
          setRegionOther={setRegionOther}
          errors={showsErrors("location") ? fieldErrors : {}}
          connectionNames={connectionNames}
        />
      )}
      {advanced ? null : (
        <p className="storage-form-url">
          <label htmlFor={urlId} className="field-label">
            Resulting URL
          </label>{" "}
          {/* An <output> is read-only and can have a label; aria-live="off" stops
              it from announcing the URL again on every keystroke. */}
          {/* Until the fields make a valid location (no bucket yet, say), a hint
              instead of a half-built URL such as "s3:///". */}
          {url === "" || locationIncomplete ? (
            <output id={urlId} className="muted" aria-live="off">
              Fill in the fields above
            </output>
          ) : (
            <output id={urlId} className="mono" aria-live="off">
              {url}
            </output>
          )}
        </p>
      )}
      <CheckboxField
        label="Edit as URL (advanced)"
        checked={advanced}
        onChecked={toggleAdvanced}
        hint="For URL parameters the fields do not cover, e.g. retention=governance."
      />
      {advancedProblem === undefined ? null : (
        <p className="field-error" role="alert">
          <span aria-hidden="true">! </span>
          {advancedProblem}
        </p>
      )}
      {/* With nothing to sign in with, "Sign in" is locked: say why here instead. */}
      {needsSignIn ? null : (
        <p className="field-hint">
          {scheme === "file"
            ? "Local folders need no credentials: the console writes with its own file permissions."
            : "This kind of storage takes no credentials."}
        </p>
      )}
      {current === "location" ? saveFailure : null}
    </div>
  );

  // ---- step 2: Sign in (empty while locked) -----------------------------------------
  const signInStep = (
    <div className="storage-form-step" ref={signInRef}>
      {method === undefined ? null : (
        <>
          <RadioCards
            legend="Sign in with"
            value={method}
            options={methods}
            onValue={setChosenMethod}
          />
          <CredentialFields
            method={method}
            scheme={scheme}
            values={secrets}
            update={updateSecret}
            errors={showsErrors("signIn") ? secretErrors : {}}
          />
        </>
      )}
      {current === "signIn" ? saveFailure : null}
    </div>
  );

  const steps: readonly FlowStep<StorageStepId>[] = [
    {
      id: "location",
      title: "Location",
      hint: "Where backups are written",
      state: stepState("location", locationProblem),
      content: locationStep,
    },
    {
      id: "signIn",
      title: "Sign in",
      hint: needsSignIn ? "How the console signs in" : "Not needed",
      locked: !needsSignIn,
      state: needsSignIn ? stepState("signIn", signInProblem) : undefined,
      content: signInStep,
    },
  ];

  return (
    <Dialog
      open
      size="wide"
      title={existing === undefined ? "Add storage" : `Edit "${existing.name}"`}
      onClose={props.onClose}
      // No footer: the flow's own row (Cancel, Back, Next or the save button) is it.
    >
      <form id="storage-form" onSubmit={submit} noValidate className="form storage-form">
        <StepFlow
          label="Storage steps"
          steps={steps}
          current={current}
          onStep={goToStep}
          // Location must be complete before Sign in opens; Next shows what is missing.
          isComplete={isComplete}
          onIncomplete={onIncomplete}
          extra={<Button onClick={props.onClose}>Cancel</Button>}
          // Editing: save from any step, without walking through the others first.
          finishOnEveryStep={existing !== undefined}
          finish={
            <Button variant="primary" type="submit" busy={busy}>
              {existing === undefined ? "Add and test" : "Save and test"}
            </Button>
          }
        />
      </form>
    </Dialog>
  );
}

/** What is wrong with a storage name, or undefined. */
export function storageNameProblem(
  name: string,
  takenNames: readonly string[],
): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the storage a name, e.g. “S3 primary”.";
  if (trimmed.length > MAX_NAME_LENGTH) return `Use at most ${MAX_NAME_LENGTH} characters.`;
  // The server compares the trimmed name exactly.
  if (takenNames.includes(trimmed)) {
    return `Another storage location is already called “${trimmed}”. Choose another name.`;
  }
  return undefined;
}

/** What is wrong with a URL typed in "Edit as URL (advanced)" (already trimmed), or undefined. */
export function advancedUrlProblem(url: string): string | undefined {
  if (url === "") return "Enter a URL such as s3://bucket/prefix/ or a path like /data/backups.";
  if (url.length > MAX_URL_LENGTH) return `Use at most ${MAX_URL_LENGTH} characters.`;
  // "ftp://…", "https://…": a scheme the console cannot write to.
  if (storageSchemeOf(url) === "unknown") {
    return "Use s3://, gs://, az://, sftp:// or a folder in the console's data volume.";
  }
  return undefined;
}

/** The fields of the chosen storage type (the "Type" select first). */
function LocationFields(props: {
  fields: StorageFields;
  update: (change: Partial<StorageFields>) => void;
  regionOther: boolean;
  setRegionOther: (other: boolean) => void;
  errors: StorageFieldErrors;
  /** The console's connection names, for folder suggestions. */
  connectionNames: readonly string[];
}) {
  const { fields, update, errors } = props;
  /** Chips that fill the bucket's (or container's) folder; `field` names the field. */
  const prefixChips = (field: string) => (
    <FillSuggestions
      field={field}
      items={prefixSuggestions(props.connectionNames)}
      current={fields.prefix}
      onPick={(prefix) => update({ prefix })}
      mono
    />
  );
  const preset = S3_PROVIDERS[fields.provider];
  /** Bucket and folder, shared by S3, S3-compatible and GCS. */
  const bucketFields = (
    <div className="storage-form-row">
      <TextField
        label="Bucket"
        value={fields.bucket}
        onValue={(bucket) => update({ bucket })}
        spellCheck={false}
        autoComplete="off"
        placeholder="acme-backups"
        error={errors.bucket}
      />
      <TextField
        label="Folder in the bucket (optional)"
        value={fields.prefix}
        onValue={(prefix) => update({ prefix })}
        spellCheck={false}
        autoComplete="off"
        placeholder="prod/"
        hint="Backups go under this prefix; leave empty for the whole bucket."
        suggestions={prefixChips("Folder in the bucket")}
      />
    </div>
  );

  return (
    <>
      <SelectField
        label="Type"
        value={fields.kind}
        options={STORAGE_KINDS}
        onValue={(kind) => update({ kind })}
      />

      {fields.kind === "local" ? (
        <TextField
          label="Folder"
          value={fields.folder}
          onValue={(folder) => update({ folder })}
          spellCheck={false}
          autoComplete="off"
          placeholder="backups"
          hint="Inside the console's data volume: relative (backups/prod) or an absolute path under it (/data/backups). Other folders are refused for safety."
          error={errors.folder}
          suggestions={
            <FillSuggestions
              field="Folder"
              items={localFolderSuggestions(props.connectionNames)}
              current={fields.folder}
              onPick={(folder) => update({ folder })}
              mono
            />
          }
        />
      ) : null}

      {fields.kind === "s3" ? (
        <>
          {bucketFields}
          <SelectField
            label="Region"
            value={props.regionOther ? OTHER_REGION : fields.region}
            options={[
              { value: "", label: "The console's default (AWS_REGION)" },
              ...AWS_REGIONS,
              { value: OTHER_REGION, label: "Other region…" },
            ]}
            onValue={(value) => {
              props.setRegionOther(value === OTHER_REGION);
              update({ region: value === OTHER_REGION ? "" : value });
            }}
            hint="The region the bucket was created in."
            error={props.regionOther ? undefined : errors.region}
          />
          {props.regionOther ? (
            <TextField
              label="Region code"
              value={fields.region}
              onValue={(region) => update({ region })}
              spellCheck={false}
              autoComplete="off"
              placeholder="ap-southeast-3"
              error={errors.region}
            />
          ) : null}
        </>
      ) : null}

      {fields.kind === "s3-compatible" ? (
        <>
          <SelectField
            label="Provider"
            value={fields.provider}
            options={S3_PROVIDER_ORDER.map((provider) => ({
              value: provider,
              label: S3_PROVIDERS[provider].label,
            }))}
            onValue={(provider) => update({ provider })}
          />
          {preset.parameter === undefined ? (
            <TextField
              label="Endpoint URL"
              value={fields.endpoint}
              onValue={(endpoint) => update({ endpoint })}
              type="url"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://minio.example.com:9000"
              error={errors.endpoint}
              // MinIO's usual addresses: a container named "minio", or this machine.
              suggestions={
                <FillSuggestions
                  field="Endpoint URL"
                  items={["http://minio:9000", "http://localhost:9000"]}
                  current={fields.endpoint}
                  onPick={(endpoint) => update({ endpoint })}
                  mono
                />
              }
            />
          ) : (
            <TextField
              label={preset.parameter.label}
              value={fields.providerValue}
              onValue={(providerValue) => update({ providerValue })}
              spellCheck={false}
              autoComplete="off"
              placeholder={preset.parameter.placeholder}
              hint={`The endpoint is ${preset.parameter.endpoint(fields.providerValue.trim() || preset.parameter.placeholder)}.`}
              error={errors.providerValue}
            />
          )}
          {fields.provider === "other" ? (
            <div className="storage-form-row">
              <TextField
                label="Region (optional)"
                value={fields.region}
                onValue={(region) => update({ region })}
                spellCheck={false}
                autoComplete="off"
                placeholder="us-east-1"
                error={errors.region}
                // The regions most S3-compatible services accept.
                suggestions={
                  <FillSuggestions
                    field="Region"
                    items={["us-east-1", "auto"]}
                    current={fields.region}
                    onPick={(region) => update({ region })}
                    mono
                  />
                }
              />
              <CheckboxField
                label="Path-style requests"
                checked={fields.forcePathStyle}
                onChecked={(forcePathStyle) => update({ forcePathStyle })}
                hint="endpoint/bucket/key instead of bucket.endpoint/key; most self-hosted services need it."
              />
            </div>
          ) : null}
          {bucketFields}
        </>
      ) : null}

      {fields.kind === "gcs" ? (
        <>
          {bucketFields}
          <TextField
            label="Project ID (optional)"
            value={fields.projectId}
            onValue={(projectId) => update({ projectId })}
            spellCheck={false}
            autoComplete="off"
            placeholder="acme-prod"
            hint="Usually taken from the credentials."
          />
        </>
      ) : null}

      {fields.kind === "azure" ? (
        <>
          <div className="storage-form-row">
            <TextField
              label="Storage account"
              value={fields.account}
              onValue={(account) => update({ account })}
              spellCheck={false}
              autoComplete="off"
              placeholder="acmebackups"
              error={errors.account}
            />
            <TextField
              label="Container"
              value={fields.container}
              onValue={(container) => update({ container })}
              spellCheck={false}
              autoComplete="off"
              placeholder="mongodb"
              error={errors.container}
              suggestions={
                <FillSuggestions
                  field="Container"
                  items={["backups", "mongodb"]}
                  current={fields.container}
                  onPick={(container) => update({ container })}
                  mono
                />
              }
            />
          </div>
          <TextField
            label="Folder in the container (optional)"
            value={fields.prefix}
            onValue={(prefix) => update({ prefix })}
            spellCheck={false}
            autoComplete="off"
            placeholder="prod/"
            suggestions={prefixChips("Folder in the container")}
          />
          <TextField
            label="Custom endpoint (optional)"
            value={fields.endpoint}
            onValue={(endpoint) => update({ endpoint })}
            type="url"
            spellCheck={false}
            autoComplete="off"
            placeholder="http://127.0.0.1:10000/devstoreaccount1"
            hint="Only for Azurite or a sovereign cloud; leave empty for https://<account>.blob.core.windows.net."
            error={errors.endpoint}
            // Azurite's well-known local address (its default account).
            suggestions={
              <FillSuggestions
                field="Custom endpoint"
                items={[
                  {
                    value: "http://127.0.0.1:10000/devstoreaccount1",
                    label: "Azurite (local)",
                    hint: "The Azurite emulator on this machine, default account",
                  },
                ]}
                current={fields.endpoint}
                onPick={(endpoint) => update({ endpoint })}
              />
            }
          />
        </>
      ) : null}

      {fields.kind === "sftp" ? (
        <>
          <div className="storage-form-row storage-form-row-host">
            <TextField
              label="User"
              value={fields.user}
              onValue={(user) => update({ user })}
              spellCheck={false}
              autoComplete="off"
              placeholder="backup"
              error={errors.user}
              suggestions={
                <FillSuggestions
                  field="User"
                  items={["backup"]}
                  current={fields.user}
                  onPick={(user) => update({ user })}
                  mono
                />
              }
            />
            <TextField
              label="Host"
              value={fields.host}
              onValue={(host) => update({ host })}
              spellCheck={false}
              autoComplete="off"
              placeholder="backup.example.com"
              error={errors.host}
            />
            <TextField
              label="Port"
              value={fields.port}
              onValue={(port) => update({ port })}
              inputMode="numeric"
              autoComplete="off"
              placeholder="22"
              error={errors.port}
              // SSH's standard port.
              suggestions={
                <FillSuggestions
                  field="Port"
                  items={["22"]}
                  current={fields.port}
                  onPick={(port) => update({ port })}
                  mono
                />
              }
            />
          </div>
          <TextField
            label="Folder on the server"
            value={fields.path}
            onValue={(path) => update({ path })}
            spellCheck={false}
            autoComplete="off"
            placeholder="/srv/backups"
            hint="Absolute (/srv/backups) or in the login directory (~/backups)."
            error={errors.path}
            suggestions={
              <FillSuggestions
                field="Folder on the server"
                items={["/backups", "~/backups", "/srv/backups"]}
                current={fields.path}
                onPick={(path) => update({ path })}
                mono
              />
            }
          />
          <TextField
            label="Host key fingerprint"
            value={fields.fingerprint}
            onValue={(fingerprint) => update({ fingerprint })}
            spellCheck={false}
            autoComplete="off"
            className="storage-form-mono"
            placeholder="SHA256:k3S1xS1v8bM0gYp4m7bJ1rQ6yQ0b0v8vXr5Y2rVwA6c"
            hint="The server's SHA256 fingerprint; several separated by commas. Verify it out of band."
            error={errors.fingerprint}
          />
          <CheckboxField
            label="Accept any host key (unsafe)"
            checked={fields.allowUnknownHostKey}
            onChecked={(allowUnknownHostKey) => update({ allowUnknownHostKey })}
            hint="Skips the server check: anyone who can intercept the connection could read or replace backups. Only for testing."
          />
          {fields.allowUnknownHostKey ? (
            <Notice tone="warning" title="The server's identity is not checked">
              Add the fingerprint instead before using this location for real backups.
            </Notice>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** The named fields of the chosen sign-in method. */
function CredentialFields(props: {
  method: CredentialMethod;
  scheme: ReturnType<typeof storageSchemeOf>;
  values: CredentialValues;
  update: (change: Partial<CredentialValues>) => void;
  errors: Partial<Record<keyof CredentialValues, string>>;
}) {
  const { values, update, errors } = props;
  /** Props shared by every secret input: never autofilled, never spell-checked. */
  const secret = { type: "password", autoComplete: "new-password", spellCheck: false } as const;
  switch (props.method) {
    case "keep":
    case "environment":
      return null;
    case "keys":
      return (
        <>
          <div className="storage-form-row">
            <TextField
              label="Access key ID"
              value={values.accessKeyId}
              onValue={(accessKeyId) => update({ accessKeyId })}
              autoComplete="off"
              spellCheck={false}
              className="storage-form-mono"
              placeholder="AKIA…"
              error={errors.accessKeyId}
            />
            <TextField
              label="Secret access key"
              value={values.secretAccessKey}
              onValue={(secretAccessKey) => update({ secretAccessKey })}
              {...secret}
              error={errors.secretAccessKey}
            />
          </div>
          <TextField
            label="Session token (optional)"
            value={values.sessionToken}
            onValue={(sessionToken) => update({ sessionToken })}
            {...secret}
            hint="Only for temporary credentials; they expire, so prefer a dedicated user or a role."
          />
        </>
      );
    case "serviceAccount":
      return (
        <SecretFileField
          label="Service account key (JSON)"
          value={values.serviceAccountJson}
          onValue={(serviceAccountJson) => update({ serviceAccountJson })}
          accept=".json,application/json"
          placeholder={'{\n  "type": "service_account",\n  …\n}'}
          hint="The key file downloaded from IAM → Service accounts → Keys. It needs the Storage Object Admin role on the bucket."
          error={errors.serviceAccountJson}
        />
      );
    case "accountKey":
      return (
        <TextField
          label="Storage account key"
          value={values.accountKey}
          onValue={(accountKey) => update({ accountKey })}
          {...secret}
          hint="Storage account → Security + networking → Access keys. Sent as a connection string for this account."
          error={errors.accountKey}
        />
      );
    case "connectionString":
      return (
        <TextField
          label="Azure connection string"
          value={values.connectionString}
          onValue={(connectionString) => update({ connectionString })}
          {...secret}
          hint="DefaultEndpointsProtocol=https;AccountName=…;AccountKey=… or a SAS connection string."
          error={errors.connectionString}
        />
      );
    case "sshKey":
      return (
        <>
          <SecretFileField
            label="SSH private key"
            value={values.privateKey}
            onValue={(privateKey) => update({ privateKey })}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
            hint="The key whose public half is in the server's authorized_keys."
            error={errors.privateKey}
          />
          <TextField
            label="Key passphrase (optional)"
            value={values.keyPassphrase}
            onValue={(keyPassphrase) => update({ keyPassphrase })}
            {...secret}
          />
        </>
      );
    case "lines": {
      const names = CREDENTIAL_NAMES[props.scheme];
      return (
        <TextAreaField
          label="Credentials"
          value={values.lines}
          onValue={(lines) => update({ lines })}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          className="storage-form-mono"
          placeholder={names.length > 0 ? names.map((key) => `${key}=…`).join("\n") : "KEY=value"}
          hint="One KEY=value per line, stored encrypted. Replaces all stored credentials."
          error={errors.lines}
        />
      );
    }
  }
}

/**
 * A textarea for a secret that usually comes as a file (a JSON key, a private key),
 * with a "Choose file…" button that reads the file into it. The file never leaves the
 * browser except as part of the saved credentials.
 */
function SecretFileField(props: {
  label: string;
  value: string;
  onValue: (value: string) => void;
  hint: string;
  placeholder: string;
  accept?: string;
  error: string | undefined;
}) {
  const fileId = useId();
  return (
    <div className="storage-form-file">
      <TextAreaField
        label={props.label}
        value={props.value}
        onValue={props.onValue}
        rows={5}
        spellCheck={false}
        autoComplete="off"
        className="storage-form-secret"
        placeholder={props.placeholder}
        hint={props.hint}
        error={props.error}
      />
      {/* A real file input inside a button-styled label: keyboard and screen readers
          reach the input itself, the label only looks like a button. */}
      <label
        htmlFor={fileId}
        className="button button-secondary button-small storage-form-file-button"
      >
        Choose file…
        <input
          id={fileId}
          type="file"
          className="visually-hidden"
          accept={props.accept}
          aria-label={`Choose a file for ${props.label}`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void readFileText(file).then(props.onValue);
            // Choosing the same file again should read it again.
            event.target.value = "";
          }}
        />
      </label>
    </div>
  );
}

/**
 * Reads a chosen file as text. FileReader rather than `Blob.text()`, which older
 * browsers (and jsdom, used by the tests) do not have.
 */
function readFileText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
