/**
 * Settings: appearance, the signed-in account, exporting the console's setup as a
 * `mongoshield.config.ts` (secrets left as environment references) so the same backups
 * can run from the CLI or a CronJob without the console, and importing such a config
 * (as JSON) back into the console.
 *
 * Import is a two-step flow, like restore: "Preview changes" sends a dry run and shows
 * what would be created or changed; only then can "Apply import" send the same request
 * for real. Editing any input discards the preview, so what is applied is always what
 * was reviewed. Secrets go in their own field and never inside the config document.
 *
 * The plan name follows what was pasted: for a single config it is a box suggesting the
 * existing plans (choosing one updates that plan, typing a new name creates one); for
 * several configs keyed by plan name it is not asked at all, and the page lists the plans
 * found instead, each marked "new" or "updates the existing plan".
 */

import { useState } from "react";
import type {
  ConfigImportChange,
  ConfigImportRequest,
  ConfigImportResult,
  ConfigImportSecrets,
} from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { CodeBlock } from "../components/code-block.tsx";
import { ComboboxField } from "../components/combobox.tsx";
import { SelectField, TextAreaField } from "../components/field.tsx";
import { ErrorNotice, KeyValueList, Notice, PageHeader, Panel } from "../components/layout.tsx";
import { hasRecoveryKey, RecoveryKeyButton } from "../components/recovery-key.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { buildHref, segment } from "../router.ts";
import { applyTheme, storedTheme, type ThemeChoice } from "../theme.ts";

/**
 * Offers `content` as a file download. A Blob URL keeps it inside the browser (nothing
 * is sent anywhere) and works under the console's CSP.
 */
export function downloadTextFile(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoke on the next tick: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** What the import form's text fields parse to, or why they do not. */
export type ParsedImportInput =
  | {
      readonly ok: true;
      readonly document: unknown;
      readonly secrets: Readonly<Record<string, ConfigImportSecrets>> | undefined;
    }
  | { readonly ok: false; readonly documentError?: string; readonly secretsError?: string };

/** Parses JSON text, returning the value or the parser's message. */
function parseJsonText(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Parses the import form: the config document (required JSON) and the secrets (optional
 * JSON object of plan name → secrets). Only the shape is checked here; the server
 * validates the content.
 */
export function parseImportInput(documentText: string, secretsText: string): ParsedImportInput {
  let documentError: string | undefined;
  let secretsError: string | undefined;
  let document: unknown;
  let secrets: Readonly<Record<string, ConfigImportSecrets>> | undefined;

  if (documentText.trim() === "") {
    documentError = "Paste the configuration as JSON.";
  } else {
    const parsed = parseJsonText(documentText);
    if ("error" in parsed) documentError = `This is not valid JSON: ${parsed.error}`;
    else document = parsed.value;
  }

  if (secretsText.trim() !== "") {
    const parsed = parseJsonText(secretsText);
    if ("error" in parsed) {
      secretsError = `This is not valid JSON: ${parsed.error}`;
    } else if (
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      Array.isArray(parsed.value)
    ) {
      secretsError = 'Use an object of plan names, e.g. { "Nightly": { "uri": "mongodb://…" } }.';
    } else {
      // The server checks every field; the client only needs the outer shape right.
      secrets = parsed.value as Readonly<Record<string, ConfigImportSecrets>>;
    }
  }

  if (documentError !== undefined || secretsError !== undefined) {
    return {
      ok: false,
      ...(documentError === undefined ? {} : { documentError }),
      ...(secretsError === undefined ? {} : { secretsError }),
    };
  }
  return { ok: true, document, secrets };
}

/** The plan name the server uses for a single config when none is given. */
export const DEFAULT_IMPORT_PLAN_NAME = "Imported plan";

/**
 * What the pasted configuration holds, as far as the plan name is concerned:
 *
 *   single   one config (it has "storage"): the plan name box applies
 *   several  configs keyed by plan name: the names are the keys, no box needed
 *   unknown  empty, not JSON, or neither shape yet: keep the box, the server will say
 *
 * Mirrors the server's rule (config-import.ts): a document with "storage" is one config,
 * otherwise every key is a plan name.
 */
export type ImportShape =
  | { readonly kind: "single" }
  | { readonly kind: "several"; readonly planNames: readonly string[] }
  | { readonly kind: "unknown" };

/** True for a plain JSON object (not an array or null). */
function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Works out the shape of the pasted configuration (see `ImportShape`). */
export function importShape(documentText: string): ImportShape {
  const parsed = documentText.trim() === "" ? undefined : parseJsonText(documentText);
  if (parsed === undefined || "error" in parsed || !isObject(parsed.value)) {
    return { kind: "unknown" };
  }
  const document = parsed.value;
  if (Object.hasOwn(document, "storage")) return { kind: "single" };
  const entries = Object.entries(document);
  // Only call it "several plans" when every value looks like a config object.
  if (entries.length === 0 || !entries.every(([, value]) => isObject(value))) {
    return { kind: "unknown" };
  }
  return { kind: "several", planNames: entries.map(([name]) => name.trim()) };
}

/** The plans a multi-plan configuration holds, each marked new or updating an existing plan. */
function ImportedPlanList(props: { planNames: readonly string[]; existing: readonly string[] }) {
  return (
    <Notice tone="info" title={`This configuration holds ${props.planNames.length} plan(s)`}>
      <p>The plans are named by their keys, so no plan name is needed:</p>
      <ul className="plain-list" aria-label="Plans in the configuration">
        {props.planNames.map((name) => (
          <li key={name}>
            <strong>{name}</strong>{" "}
            <span className="muted">
              {props.existing.includes(name) ? "(updates the existing plan)" : "(new plan)"}
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** One change row: a "field: from → to" list for updates. */
function ChangeFields(props: { change: ConfigImportChange }) {
  if (props.change.fields.length === 0) return <span className="muted">–</span>;
  return (
    <ul className="plain-list">
      {props.change.fields.map((field) => (
        <li key={field.field}>
          <code>{field.field}</code>: {field.from ?? "(none)"} → {field.to ?? "(none)"}
        </li>
      ))}
    </ul>
  );
}

/** The changes of a dry run or an applied import, plus warnings. */
function ImportResultView(props: { result: ConfigImportResult }) {
  const { result } = props;
  return (
    <>
      {result.warnings.length === 0 ? null : (
        <Notice tone="warning" title="Ignored settings">
          <ul className="plain-list">
            {result.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Notice>
      )}
      <Table
        caption={result.dryRun ? "Changes the import would make" : "Changes the import made"}
        showCaption
        rows={result.changes}
        rowKey={(change) => `${change.kind}:${change.name}`}
        empty={<p className="muted">Nothing to change.</p>}
        columns={[
          { key: "kind", header: "Kind", render: (change) => change.kind },
          { key: "name", header: "Name", render: (change) => change.name },
          {
            key: "action",
            header: "Action",
            render: (change) => (
              // Unknown statuses render neutral; "scheduled" borrows the pending tone for changes.
              <StatusBadge
                status={change.action === "unchanged" ? "unchanged" : "scheduled"}
                label={change.action}
              />
            ),
          },
          {
            key: "fields",
            header: "Changes",
            render: (change) => <ChangeFields change={change} />,
          },
        ]}
      />
    </>
  );
}

/** The admin-only import form: dry run first, then apply. */
function ImportConfigPanel() {
  const client = useApi();
  const toast = useToast();
  const [documentText, setDocumentText] = useState("");
  const [planName, setPlanName] = useState("");
  const [secretsText, setSecretsText] = useState("");
  const [inputErrors, setInputErrors] = useState<{ document?: string; secrets?: string }>({});
  const [preview, setPreview] = useState<ConfigImportResult | undefined>(undefined);
  const [applied, setApplied] = useState<ConfigImportResult | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState<"preview" | "apply" | undefined>(undefined);
  // The existing plans, suggested as plan names (an import matches plans by name).
  const plans = useLoad("plans", (signal) => client.call("GET /api/plans", undefined, { signal }));
  const existingNames = (plans.data ?? []).map((plan) => plan.name);
  const shape = importShape(documentText);
  // The plan name only matters for a single config; for several the keys name the plans.
  const usesPlanName = shape.kind !== "several";
  const chosenName = planName.trim();

  /** Any edit invalidates the reviewed preview. */
  const edited = (update: (value: string) => void) => (value: string) => {
    update(value);
    setPreview(undefined);
    setApplied(undefined);
    setFailure(undefined);
  };

  const send = async (dryRun: boolean) => {
    const parsed = parseImportInput(documentText, secretsText);
    if (!parsed.ok) {
      setInputErrors({
        ...(parsed.documentError === undefined ? {} : { document: parsed.documentError }),
        ...(parsed.secretsError === undefined ? {} : { secrets: parsed.secretsError }),
      });
      return;
    }
    setInputErrors({});
    setFailure(undefined);
    setBusy(dryRun ? "preview" : "apply");
    const request: ConfigImportRequest = {
      document: parsed.document,
      dryRun,
      ...(!usesPlanName || chosenName === "" ? {} : { planName: chosenName }),
      ...(parsed.secrets === undefined ? {} : { secrets: parsed.secrets }),
    };
    try {
      const result = await client.call("POST /api/config/import", request);
      if (dryRun) {
        setPreview(result);
      } else {
        setPreview(undefined);
        setApplied(result);
        const count = result.changes.filter((change) => change.action !== "unchanged").length;
        toast.show("success", `Imported the configuration: ${count} change(s).`);
      }
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Panel title="Import configuration">
      <p>
        Paste a <code>mongoshield.config.ts</code> as JSON: the object passed to{" "}
        <code>defineConfig</code>, or several of them keyed by plan name. Connections and storage
        locations are matched by address and created when new; plans are matched by name.
      </p>
      <TextAreaField
        label="Configuration (JSON)"
        value={documentText}
        onValue={edited(setDocumentText)}
        rows={10}
        spellCheck={false}
        error={inputErrors.document}
        hint='For example { "storage": "s3://backups/prod", "retention": { "last": 7 } }.'
      />
      {usesPlanName ? (
        <ComboboxField
          label="Plan name"
          value={planName}
          onValue={edited(setPlanName)}
          options={existingNames.map((name) => ({ value: name, description: "updates it" }))}
          listLabel="Existing plans"
          placeholder={DEFAULT_IMPORT_PLAN_NAME}
          hint={
            chosenName === ""
              ? `Pick an existing plan to update it, or type a new name. Defaults to "${DEFAULT_IMPORT_PLAN_NAME}".`
              : existingNames.includes(chosenName)
                ? `Updates the existing plan "${chosenName}".`
                : `Creates a new plan "${chosenName}".`
          }
        />
      ) : (
        <ImportedPlanList
          planNames={shape.kind === "several" ? shape.planNames : []}
          existing={existingNames}
        />
      )}
      <TextAreaField
        label="Secrets (JSON, optional)"
        value={secretsText}
        onValue={edited(setSecretsText)}
        rows={4}
        spellCheck={false}
        error={inputErrors.secrets}
        hint="Secrets never go into the configuration itself. Give them here per plan name: uri, passphrase, notifyUrls, storageCredentials. They are stored encrypted and never shown again."
      />
      <div className="form-actions">
        <Button onClick={() => void send(true)} busy={busy === "preview"}>
          Preview changes
        </Button>
        {preview === undefined ? null : (
          <Button variant="primary" onClick={() => void send(false)} busy={busy === "apply"}>
            Apply import
          </Button>
        )}
      </div>
      {failure === undefined ? null : <ErrorNotice error={failure} title="Could not import" />}
      {preview === undefined ? null : <ImportResultView result={preview} />}
      {applied === undefined ? null : <ImportResultView result={applied} />}
    </Panel>
  );
}

/**
 * "Recovery keys": every plan whose backups use a key the console keeps, with a button
 * to download its recovery key (the private key that restores those backups when the
 * console itself is gone) and whether it was saved before. One place to find them all.
 */
function RecoveryKeysPanel(props: { canDownload: boolean }) {
  const client = useApi();
  const plans = useLoad("plans", (signal) => client.call("GET /api/plans", undefined, { signal }));
  const withKeys = (plans.data ?? []).filter(hasRecoveryKey);
  return (
    <Panel title="Recovery keys">
      <p>
        Plans that use <strong>Key kept by the console</strong> encrypt their backups with a key the
        console holds, so restoring needs no typing. Each plan's recovery key restores its backups
        even if this console is lost: download it and keep it in a password manager or vault, not
        next to the backups.
      </p>
      {plans.error !== undefined ? (
        <ErrorNotice error={plans.error} onRetry={plans.reload} />
      ) : plans.data === undefined ? null : withKeys.length === 0 ? (
        <p className="muted">No plan uses a key kept by the console.</p>
      ) : (
        <ul className="plain-list">
          {withKeys.map((plan) => (
            <li key={plan.id} className="list-row">
              <span className="stack">
                <a href={buildHref(`/plans/${segment(plan.id)}`)}>{plan.name}</a>
                {plan.encryption.kind === "managed" && plan.encryption.recoveryKeySaved ? (
                  <StatusBadge status="ok" label="Saved before" />
                ) : (
                  <StatusBadge status="unverified" label="Not saved yet" />
                )}
              </span>
              {props.canDownload ? (
                <RecoveryKeyButton plan={plan} onSaved={plans.reload} size="small" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {props.canDownload ? null : (
        <Notice tone="info">Only admins can download recovery keys.</Notice>
      )}
    </Panel>
  );
}

/** The settings page. */
export function SettingsPage() {
  const client = useApi();
  const toast = useToast();
  const { user, session, hasRole } = useSession();
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme);
  const [exported, setExported] = useState<{ filename: string; content: string } | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);

  const exportConfig = async () => {
    setBusy(true);
    try {
      const result = await client.call("GET /api/config/export");
      setExported(result);
      downloadTextFile(result.filename, result.content);
      toast.show("success", `Downloaded ${result.filename}.`);
    } catch (error) {
      toast.show("error", describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid-2">
        <Panel title="Appearance">
          <SelectField<ThemeChoice>
            label="Theme"
            value={theme}
            options={[
              { value: "dark", label: "Dark (default)" },
              { value: "light", label: "Light" },
              { value: "system", label: "Same as the operating system" },
            ]}
            onValue={(value) => {
              applyTheme(value);
              setTheme(value);
            }}
            hint="Remembered in this browser only."
          />
        </Panel>
        <Panel title="Your account">
          <KeyValueList
            items={[
              ["Username", user?.username ?? "–"],
              ["Role", user?.role ?? "–"],
              ["Sign-in methods", session.authMethods.join(", ")],
            ]}
          />
        </Panel>
      </div>
      <RecoveryKeysPanel canDownload={hasRole("admin")} />
      <Panel title="Export configuration">
        <p>
          Download the console's connections, storage and plans as a{" "}
          <code>mongoshield.config.ts</code> for the CLI. Secrets are not included: they appear as{" "}
          <code>process.env.…</code> references you fill in yourself.
        </p>
        {hasRole("admin") ? (
          <Button onClick={() => void exportConfig()} busy={busy}>
            Download mongoshield.config.ts
          </Button>
        ) : (
          <Notice tone="info">Only admins can export the configuration.</Notice>
        )}
        {exported === undefined ? null : (
          <CodeBlock label={exported.filename} code={exported.content} />
        )}
      </Panel>
      {hasRole("admin") ? (
        <ImportConfigPanel />
      ) : (
        <Panel title="Import configuration">
          <Notice tone="info">Only admins can import a configuration.</Notice>
        </Panel>
      )}
    </>
  );
}
