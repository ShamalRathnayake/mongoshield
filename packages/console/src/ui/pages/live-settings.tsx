/**
 * The "Live data" panel of a connection page: a link to the live data browser, the
 * connection's live edit settings for everyone to see, and (admins only) the form that
 * turns "Allow live edits" on or off.
 *
 * Live edits are off by default. Turning them on for a connection marked production
 * needs a second, explicit confirmation: the connection's name typed again and a reason,
 * both recorded by the server (the reason also in the audit log). Even with edits
 * allowed, only users with the `data:write` permission can change documents.
 */

import { type FormEvent, useState } from "react";
import {
  type ConnectionView,
  LIVE_BULK_HARD_LIMIT,
  type LiveEditSettingsInput,
} from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import { CheckboxField, SelectField, TextField } from "../components/field.tsx";
import { ErrorNotice, KeyValueList, Notice, Panel, Time } from "../components/layout.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { formatNumber } from "../format.ts";
import { buildHref, segment } from "../router.ts";

/** Value of the journal select meaning "the console's data directory". */
const CONSOLE_JOURNAL = "";

/** Props for `LiveDataPanel`. */
export interface LiveDataPanelProps {
  readonly connection: ConnectionView;
  /** Called with the updated connection after the settings were saved. */
  readonly onSaved: (connection: ConnectionView) => void;
}

/** The connection page's Live data panel. */
export function LiveDataPanel(props: LiveDataPanelProps) {
  const { hasRole } = useSession();
  const { connection } = props;
  const settings = connection.liveEdits;
  const client = useApi();
  const storage = useLoad("storage", (signal) =>
    client.call("GET /api/storage", undefined, { signal }),
  );
  const journalName =
    settings.journalStorageId === undefined
      ? "Console data directory"
      : (storage.data?.find((location) => location.id === settings.journalStorageId)?.name ??
        settings.journalStorageId);

  return (
    <Panel
      title="Live data"
      actions={
        hasRole("operator") ? (
          <a
            className="button button-secondary button-small"
            href={buildHref(`/connections/${segment(connection.id)}/data`)}
          >
            Browse live data
          </a>
        ) : undefined
      }
    >
      <p className="muted">
        Browse the documents of this connection's databases. Changing them is off unless an admin
        allows live edits here; every change is journaled first and can be undone.
      </p>
      <KeyValueList
        items={[
          [
            "Live edits",
            settings.enabled
              ? connection.production
                ? "Allowed (confirmed for production)"
                : "Allowed"
              : "Off (read-only)",
          ],
          ["Edit journal", journalName],
          ["Most documents per bulk edit", formatNumber(settings.maxBulkDocuments)],
          ...(settings.changedBy === undefined
            ? []
            : [
                [
                  "Last changed",
                  <span key="changed">
                    by {settings.changedBy} <Time value={settings.changedAt} relativeOnly />
                  </span>,
                ] as const,
              ]),
          ...(settings.reason === undefined ? [] : [["Reason", settings.reason] as const]),
        ]}
      />
      {hasRole("admin") ? (
        <LiveSettingsForm
          connection={connection}
          storage={storage.data ?? []}
          onSaved={props.onSaved}
        />
      ) : null}
    </Panel>
  );
}

/** The admin form for the live edit settings. */
function LiveSettingsForm(props: {
  connection: ConnectionView;
  storage: readonly { readonly id: string; readonly name: string }[];
  onSaved: (connection: ConnectionView) => void;
}) {
  const client = useApi();
  const toast = useToast();
  const { connection } = props;
  const settings = connection.liveEdits;
  const [enabled, setEnabled] = useState(settings.enabled);
  const [journal, setJournal] = useState(settings.journalStorageId ?? CONSOLE_JOURNAL);
  const [max, setMax] = useState(String(settings.maxBulkDocuments));
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const needsConfirmation = enabled && connection.production;

  const maxValue = Number(max);
  const errors = {
    max:
      !Number.isInteger(maxValue) || maxValue < 1 || maxValue > LIVE_BULK_HARD_LIMIT
        ? `Enter a whole number from 1 to ${formatNumber(LIVE_BULK_HARD_LIMIT)}.`
        : undefined,
    reason:
      needsConfirmation && reason.trim() === ""
        ? "Give a reason: it is recorded with the setting and in the audit log."
        : undefined,
    confirmName:
      needsConfirmation && confirmName !== connection.name
        ? `Type "${connection.name}" exactly.`
        : undefined,
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (errors.max !== undefined || errors.reason !== undefined || errors.confirmName !== undefined)
      return;
    const input: LiveEditSettingsInput = {
      enabled,
      maxBulkDocuments: maxValue,
      ...(journal === CONSOLE_JOURNAL ? {} : { journalStorageId: journal }),
      ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
      ...(needsConfirmation ? { confirmName } : {}),
    };
    setBusy(true);
    setError(undefined);
    try {
      const saved = await client.call("PUT /api/connections/:id/live-edits", input, {
        params: { id: connection.id },
      });
      toast.show(
        "success",
        saved.liveEdits.enabled ? "Live edits are allowed." : "Live edits are off.",
      );
      setSubmitted(false);
      setReason("");
      setConfirmName("");
      props.onSaved(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form live-settings" onSubmit={submit} noValidate>
      <CheckboxField
        label="Allow live edits"
        checked={enabled}
        onChecked={setEnabled}
        hint="Users with the data:write permission may insert, edit and delete documents here. Every write is conditional, journaled and audited."
      />
      <SelectField
        label="Edit journal"
        value={journal}
        options={[
          { value: CONSOLE_JOURNAL, label: "Console data directory" },
          ...props.storage.map((location) => ({ value: location.id, label: location.name })),
        ]}
        onValue={setJournal}
        hint="Where the previous state of every edited document is kept for undo, encrypted with the console's key."
      />
      <TextField
        label="Most documents per bulk edit"
        inputMode="numeric"
        value={max}
        onValue={setMax}
        error={submitted ? errors.max : undefined}
      />
      <TextField
        label="Reason"
        value={reason}
        onValue={setReason}
        maxLength={500}
        hint={
          needsConfirmation
            ? "Required for production connections."
            : "Optional; recorded in the audit log."
        }
        error={submitted ? errors.reason : undefined}
      />
      {needsConfirmation ? (
        <>
          <Notice tone="warning" title="This is a production connection">
            Live edits change production documents directly. Each write is checked against the
            version that was loaded, journaled and audited, but it still changes customer data.
          </Notice>
          <TextField
            label="Type the connection's name to confirm"
            value={confirmName}
            onValue={setConfirmName}
            autoComplete="off"
            spellCheck={false}
            hint={`Type "${connection.name}".`}
            error={submitted ? errors.confirmName : undefined}
          />
        </>
      ) : null}
      {error === undefined ? null : <ErrorNotice error={error} title="Could not save" />}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          Save live edit settings
        </Button>
      </div>
    </form>
  );
}
