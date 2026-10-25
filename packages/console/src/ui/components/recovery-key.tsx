/**
 * The recovery key of a plan whose backups are encrypted with a key the console keeps
 * ("Key kept by the console"). The console restores those backups without anyone
 * typing a key; the recovery key (the age private key, `AGE-SECRET-KEY-1…`) is what
 * restores them when the console itself is gone (a lost volume, a new machine).
 *
 * - `RecoveryKeyDialog` explains it and downloads it as a text file; the key is fetched
 *   only when the button is pressed, and the server audits every download.
 * - `RecoveryKeyButton` opens the dialog; pages put it wherever people look for the key
 *   (the plan's Security step, Settings → Recovery keys, the backup bar). The key can be
 *   downloaded again at any time; the button says whether it was saved before.
 *
 * Only admins can fetch a recovery key (the server refuses everyone else).
 */

import { useState } from "react";
import type { PlanView, RecoveryKeyView } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { useApi } from "../context.tsx";
import { downloadTextFile } from "../onboarding.ts";
import { Button } from "./button.tsx";
import { Dialog } from "./dialog.tsx";
import { Icon } from "./icons.tsx";
import { Notice } from "./layout.tsx";
import "./recovery-key.css";

/** True for a plan whose backups use a key the console keeps (it has a recovery key). */
export function hasRecoveryKey(plan: PlanView): boolean {
  return plan.encryption.kind === "managed";
}

/** Whether the plan's recovery key was downloaded before (false for other plans). */
function recoveryKeySaved(plan: PlanView): boolean {
  return plan.encryption.kind === "managed" && plan.encryption.recoveryKeySaved;
}

/** Downloads a plan's recovery key as a text file, with an explanation first. */
export function RecoveryKeyDialog(props: {
  plan: PlanView;
  onClose: () => void;
  /** Called after a download, so the page can reload the plan ("saved"). */
  onSaved: () => void;
}) {
  const client = useApi();
  const [key, setKey] = useState<RecoveryKeyView | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Whether it was saved before this dialog opened: the plan reloads as "saved" right
  // after the download, and the dialog keeps its wording while it is open.
  const [saved] = useState(() => recoveryKeySaved(props.plan));
  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const view = await client.call("POST /api/plans/:id/recovery-key", undefined, {
        params: { id: props.plan.id },
      });
      setKey(view);
      downloadTextFile(view.filename, view.fileContent);
      props.onSaved();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={saved ? `Recovery key of "${props.plan.name}"` : "Save your recovery key"}
      onClose={props.onClose}
      description="Your backups are encrypted. The console keeps the key, so restoring needs no typing. Keep a copy elsewhere too."
      footer={
        key === undefined ? (
          <>
            <Button variant="ghost" onClick={props.onClose}>
              {saved ? "Cancel" : "Later"}
            </Button>
            <Button variant="primary" busy={busy} data-autofocus onClick={() => void download()}>
              {saved ? "Download again" : "Download recovery key"}
            </Button>
          </>
        ) : (
          <Button variant="primary" data-autofocus onClick={props.onClose}>
            Done
          </Button>
        )
      }
    >
      {key === undefined ? (
        <p>
          If this console or its volume is lost, the recovery key is the only way to restore these
          backups. Store it in a password manager or vault, not next to the backups.
          {saved ? " It was downloaded before; downloading it again gives the same key." : ""}
        </p>
      ) : (
        <div className="stack-vertical">
          <Notice tone="success" title="Downloaded">
            <p>
              Saved as <code>{key.filename}</code>. If the download did not start, copy the key:
            </p>
          </Notice>
          <code className="recovery-key">{key.identity}</code>
        </div>
      )}
      {error === undefined ? null : (
        <Notice tone="danger" title="The key could not be fetched">
          {error}
        </Notice>
      )}
    </Dialog>
  );
}

/**
 * "Download recovery key": opens {@link RecoveryKeyDialog} for one plan. Renders nothing
 * for plans without a console-kept key.
 */
export function RecoveryKeyButton(props: {
  plan: PlanView;
  onSaved: () => void;
  size?: "normal" | "small";
}) {
  const [open, setOpen] = useState(false);
  if (!hasRecoveryKey(props.plan)) return null;
  const saved = recoveryKeySaved(props.plan);
  return (
    <>
      <Button
        size={props.size ?? "normal"}
        variant={saved ? "secondary" : "primary"}
        onClick={() => setOpen(true)}
        // The visible words, plus which plan (several buttons can share a page).
        aria-label={`${saved ? "Download recovery key" : "Save recovery key"} for ${props.plan.name}`}
      >
        <Icon name="key" size={14} />
        {saved ? "Download recovery key" : "Save recovery key"}
      </Button>
      {open ? (
        <RecoveryKeyDialog
          plan={props.plan}
          onClose={() => setOpen(false)}
          onSaved={props.onSaved}
        />
      ) : null}
    </>
  );
}
