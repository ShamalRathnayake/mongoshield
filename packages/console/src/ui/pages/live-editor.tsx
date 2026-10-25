/**
 * The dialogs that change live documents: edit (with a field-level review before
 * saving), insert, duplicate, delete, and "update many" / "delete many".
 *
 * The server does the real safety work (conditional writes, the journal, undo); these
 * dialogs make it visible:
 * - an edit is reviewed as a list of changed fields before "Save changes",
 * - a write refused because the document changed since it was loaded (409
 *   `CONSOLE_LIVE_CONFLICT`) shows the server's message and a "Reload document" button,
 * - a bulk edit needs a preview count and the exact confirmation text typed out.
 */

import { type ReactNode, useState } from "react";
import type { JobSummary, LiveBulkPreview, LiveDocument, UserView } from "../../shared/api.ts";
import { ApiRequestError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { EjsonTree } from "../components/code-block.tsx";
import { Dialog } from "../components/dialog.tsx";
import { TextAreaField, TextField } from "../components/field.tsx";
import { ErrorNotice, KeyValueList, Notice } from "../components/layout.tsx";
import { useApi } from "../context.tsx";
import {
  checkFilter,
  documentIdLabel,
  isJsonObject,
  type JsonValue,
  parseDocument,
} from "../ejson.ts";
import { formatNumber } from "../format.ts";
import { diffDocuments, type FieldChange } from "../live-diff.ts";
import { checkDocument, checkUpdate } from "../live-query.ts";

/** True when a user may change live data at all (the connection must allow it too). */
export function canEditLiveData(user: UserView | undefined): boolean {
  return user !== undefined && user.role !== "viewer" && user.permissions.includes("data:write");
}

/** True for the server's "the document changed since you loaded it" refusal. */
export function isConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === "CONSOLE_LIVE_CONFLICT";
}

/** A refused write: the server's message, plus "Reload document" for conflicts. */
function WriteError(props: { error: unknown; onReload: () => void }) {
  if (!isConflict(props.error)) return <ErrorNotice error={props.error} title="Not saved" />;
  return (
    <div className="notice notice-warning" role="alert">
      <p className="notice-title">
        <span aria-hidden="true">! </span>
        Someone changed this document
      </p>
      <p>{props.error instanceof Error ? props.error.message : String(props.error)}</p>
      <Button size="small" onClick={props.onReload}>
        Reload document
      </Button>
    </div>
  );
}

/** Pretty-printed JSON of a document's text, for the editor. */
function pretty(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Edit, insert, duplicate
// ---------------------------------------------------------------------------

/** What the document editor is doing. */
export type EditorMode =
  | { readonly kind: "edit"; readonly document: LiveDocument }
  | { readonly kind: "duplicate"; readonly document: LiveDocument }
  | { readonly kind: "insert" };

/** Props for `DocumentEditorDialog`. */
export interface DocumentEditorProps {
  readonly connectionId: string;
  readonly ns: string;
  readonly mode: EditorMode;
  readonly onClose: () => void;
  /** After a successful write. */
  readonly onSaved: (message: string) => void;
  /** "Reload document" after a conflict: refetch the page (and close the editor). */
  readonly onReload: () => void;
}

/** The text the editor starts with. */
function initialText(mode: EditorMode): string {
  if (mode.kind === "insert") return "{\n  \n}";
  const parsed = parseDocument(mode.document.json);
  if (parsed === undefined || !isJsonObject(parsed)) return mode.document.json;
  if (mode.kind === "edit") return pretty(parsed);
  // A duplicate is the same document without `_id`: the server assigns a new ObjectId.
  const { _id: _ignored, ...withoutId } = parsed;
  return pretty(withoutId);
}

/** Edits, inserts or duplicates one document. */
export function DocumentEditorDialog(props: DocumentEditorProps) {
  const client = useApi();
  const { mode } = props;
  const original = mode.kind === "edit" ? parseDocument(mode.document.json) : undefined;
  const originalId = original !== undefined && isJsonObject(original) ? original._id : undefined;
  const [text, setText] = useState(() => initialText(mode));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** The reviewed changes; set once "Review changes" succeeded (edit mode only). */
  const [review, setReview] = useState<{ changes: FieldChange[]; text: string } | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const title =
    mode.kind === "edit"
      ? "Edit document"
      : mode.kind === "duplicate"
        ? "Duplicate document"
        : "Insert document";

  /** Validates the text and shows the field-level diff. */
  const startReview = () => {
    const checked = checkDocument(text, originalId);
    if (!checked.ok) {
      setProblem(checked.message);
      return;
    }
    if (original === undefined) return;
    const changes = diffDocuments(original, checked.document);
    if (changes.length === 0) {
      setProblem("Nothing changed yet. Edit a field, then review.");
      return;
    }
    setProblem(undefined);
    setReview({ changes, text: checked.text });
  };

  /** Sends the edit (PUT) or the new document (POST). */
  const save = async () => {
    setError(undefined);
    let body: string;
    if (mode.kind === "edit") {
      if (review === undefined) return;
      body = review.text;
    } else {
      const checked = checkDocument(text);
      if (!checked.ok) {
        setProblem(checked.message);
        return;
      }
      setProblem(undefined);
      body = checked.text;
    }
    setBusy(true);
    try {
      if (mode.kind === "edit") {
        const result = await client.call(
          "PUT /api/live/:id/documents",
          {
            ns: props.ns,
            id: mode.document.id ?? "",
            version: mode.document.version ?? "",
            document: body,
          },
          { params: { id: props.connectionId } },
        );
        const fields = result.changedFields?.length ?? review?.changes.length ?? 0;
        props.onSaved(
          `Saved ${fields === 1 ? "1 changed field" : `${fields} changed fields`}. Undo it from Edit history.`,
        );
      } else {
        const result = await client.call(
          "POST /api/live/:id/documents",
          { ns: props.ns, document: body },
          { params: { id: props.connectionId } },
        );
        props.onSaved(
          `Inserted ${result.entry.documentId ?? "the document"}. Undo it from Edit history.`,
        );
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const footer: ReactNode =
    mode.kind === "edit" && review !== undefined ? (
      <>
        <Button onClick={() => setReview(undefined)}>Back to editing</Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          Save changes
        </Button>
      </>
    ) : (
      <>
        <Button onClick={props.onClose}>Cancel</Button>
        {mode.kind === "edit" ? (
          <Button variant="primary" onClick={startReview}>
            Review changes
          </Button>
        ) : (
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Insert document
          </Button>
        )}
      </>
    );

  return (
    <Dialog
      open
      size="wide"
      title={title}
      onClose={props.onClose}
      description={
        mode.kind === "edit"
          ? "Edit the Extended JSON, then review the changed fields. Fields you leave as they are keep their exact types."
          : "Without _id the console assigns a new ObjectId. The insert is journaled and can be undone."
      }
      footer={footer}
    >
      {review === undefined ? (
        <TextAreaField
          label="Document (Extended JSON)"
          className="live-editor-text"
          value={text}
          onValue={(value) => {
            setText(value);
            setProblem(undefined);
          }}
          rows={18}
          spellCheck={false}
          data-autofocus
          hint='Types use Extended JSON, e.g. {"$oid": "…"}, {"$date": "…"}, {"$numberLong": "…"}.'
          error={problem}
        />
      ) : (
        <FieldChanges changes={review.changes} />
      )}
      {error === undefined ? null : <WriteError error={error} onReload={props.onReload} />}
    </Dialog>
  );
}

/** The reviewed field-level changes, as a table. */
export function FieldChanges(props: { changes: readonly FieldChange[] }) {
  return (
    <div className="live-diff">
      <p role="status">
        {props.changes.length === 1
          ? "1 field will change:"
          : `${formatNumber(props.changes.length)} fields will change:`}
      </p>
      <table className="table live-diff-table">
        <caption className="visually-hidden">Changed fields</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Change</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {props.changes.map((change) => (
            <tr key={`${change.path}:${change.change}`} className={`live-diff-${change.change}`}>
              <th scope="row" className="mono live-diff-cell">
                {change.path}
              </th>
              <td>
                {change.change === "added"
                  ? "Added"
                  : change.change === "removed"
                    ? "Removed"
                    : "Changed"}
              </td>
              <td className="mono live-diff-cell">
                {change.before ?? <span className="muted">–</span>}
              </td>
              <td className="mono live-diff-cell">
                {change.after ?? <span className="muted">–</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete one
// ---------------------------------------------------------------------------

/** Confirms and deletes one document (conditional on its version). */
export function DeleteDocumentDialog(props: {
  readonly connectionId: string;
  readonly ns: string;
  readonly document: LiveDocument;
  readonly onClose: () => void;
  readonly onSaved: (message: string) => void;
  readonly onReload: () => void;
}) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const parsed = parseDocument(props.document.json);
  const label = documentIdLabel(parsed);

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.call(
        "POST /api/live/:id/documents/delete",
        { ns: props.ns, id: props.document.id ?? "", version: props.document.version ?? "" },
        { params: { id: props.connectionId } },
      );
      props.onSaved(`Deleted ${label}. Undo it from Edit history.`);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`Delete document ${label}?`}
      description="The document is journaled first, so the delete can be undone from Edit history."
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void remove()}>
            Delete document
          </Button>
        </>
      }
    >
      {parsed === undefined ? (
        <pre className="mono">{props.document.json}</pre>
      ) : (
        <EjsonTree value={parsed} />
      )}
      {error === undefined ? null : <WriteError error={error} onReload={props.onReload} />}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Update many / delete many
// ---------------------------------------------------------------------------

/** Props for `BulkEditDialog`. */
export interface BulkEditProps {
  readonly connectionId: string;
  readonly ns: string;
  readonly op: "update" | "delete";
  /** The browser's current filter, as a starting point. */
  readonly initialFilter?: string;
  readonly onClose: () => void;
  /** The job that runs the edit. */
  readonly onStarted: (job: JobSummary) => void;
}

/** Previews, confirms (typed) and starts a bulk edit. */
export function BulkEditDialog(props: BulkEditProps) {
  const client = useApi();
  const [filterText, setFilterText] = useState(props.initialFilter ?? "");
  const [updateText, setUpdateText] = useState("");
  const [problems, setProblems] = useState<{ filter?: string; update?: string }>({});
  const [preview, setPreview] = useState<LiveBulkPreview | undefined>(undefined);
  const [sent, setSent] = useState<{ filter: string; update?: string } | undefined>(undefined);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"preview" | "run" | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const verb = props.op === "update" ? "Update" : "Delete";

  /** Any change to the query invalidates the preview: it must be run (and confirmed) again. */
  const changed = (apply: () => void) => {
    apply();
    setPreview(undefined);
    setConfirm("");
  };

  const runPreview = async () => {
    const filter = checkFilter(filterText);
    const update = props.op === "update" ? checkUpdate(updateText) : undefined;
    const next = {
      ...(filter.ok ? {} : { filter: filter.message }),
      ...(update === undefined || update.ok ? {} : { update: update.message }),
      ...(update?.ok === true && update.value === undefined
        ? { update: 'Give at least one update operator, e.g. {"$set": {"status": "archived"}}.' }
        : {}),
    };
    setProblems(next);
    if (!filter.ok || next.update !== undefined) return;
    const body = {
      filter: filter.filter ?? "{}",
      ...(update?.ok === true && update.value !== undefined ? { update: update.value } : {}),
    };
    setBusy("preview");
    setError(undefined);
    try {
      const result = await client.call(
        "POST /api/live/:id/bulk/preview",
        { ns: props.ns, op: props.op, ...body },
        { params: { id: props.connectionId } },
      );
      setPreview(result);
      setSent(body);
      setConfirm("");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  const run = async () => {
    if (preview === undefined || sent === undefined) return;
    setBusy("run");
    setError(undefined);
    try {
      const job = await client.call(
        "POST /api/live/:id/bulk",
        { ns: props.ns, op: props.op, ...sent, expectedCount: preview.matched, confirm },
        { params: { id: props.connectionId } },
      );
      props.onStarted(job);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(undefined);
    }
  };

  // "Run" needs a preview that allows the edit and the confirmation typed exactly.
  const confirmed = preview?.allowed === true && confirm === preview.confirmText;

  return (
    <Dialog
      open
      size="wide"
      title={`${verb} many documents in ${props.ns}`}
      description="Preview how many documents match first. Every document is journaled before it is changed, and the whole edit can be undone from Edit history."
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button busy={busy === "preview"} onClick={() => void runPreview()}>
            Preview
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed}
            busy={busy === "run"}
            onClick={() => void run()}
          >
            {verb} documents
          </Button>
        </>
      }
    >
      <TextAreaField
        label="Filter (Extended JSON)"
        value={filterText}
        onValue={(value) => changed(() => setFilterText(value))}
        rows={3}
        spellCheck={false}
        data-autofocus
        placeholder='{"status": "cancelled"}'
        hint="Leave empty to match every document of the collection."
        error={problems.filter}
      />
      {props.op === "update" ? (
        <TextAreaField
          label="Update (operators)"
          value={updateText}
          onValue={(value) => changed(() => setUpdateText(value))}
          rows={3}
          spellCheck={false}
          placeholder='{"$set": {"status": "archived"}}'
          hint="Update operators only: $set, $unset, $inc, $push, …"
          error={problems.update}
        />
      ) : null}
      {preview === undefined ? null : (
        <div className="live-bulk-preview" aria-live="polite">
          <KeyValueList
            items={[
              ["Matching documents", formatNumber(preview.matched)],
              ["Limit for this connection", formatNumber(preview.max)],
            ]}
          />
          {preview.matched === 0 ? (
            <Notice tone="info">
              No documents match the filter; there is nothing to {props.op}.
            </Notice>
          ) : !preview.allowed ? (
            <Notice tone="warning" title="Too many documents">
              This connection allows at most {formatNumber(preview.max)} documents per bulk edit.
              Narrow the filter, or ask an admin to raise the limit.
            </Notice>
          ) : (
            <TextField
              label={`Type "${preview.confirmText}" to confirm`}
              value={confirm}
              onValue={setConfirm}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </div>
      )}
      {error === undefined ? null : <ErrorNotice error={error} title={`Could not ${props.op}`} />}
    </Dialog>
  );
}
