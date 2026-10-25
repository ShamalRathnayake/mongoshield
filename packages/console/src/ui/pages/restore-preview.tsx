/**
 * The restore wizard's "Preview changes" step: what the restore would change in the
 * target, compared with the live data before anything is written.
 *
 *   the wizard starts the preview job (`POST /api/restore/preview`) and hands its id here
 *   → this step follows the job's events (Cancel stops it) → `GET /api/restore/preview/:id`
 *   → a summary table per namespace: documents only in the backup / only in the target /
 *     changed / identical, what the chosen mode does with them, index and option differences
 *   → "Documents" opens one namespace: the listed `_id`s per category, page by page
 *   → choosing an `_id` shows that document in both versions: the differing fields in a
 *     table, and both documents side by side as Extended JSON trees
 *
 * Counts of large namespaces are estimates from a sample; they are marked "Estimate"
 * (a word, not only a color) and prefixed with "≈". Document lists and contents need
 * the document browser's role; the server says whether the user has it
 * (`documentsVisible`) and refuses the requests otherwise.
 */

import { type Ref, useEffect, useRef, useState } from "react";
import type {
  JobStatus,
  PreviewCategory,
  PreviewDocumentDiff,
  PreviewDocumentPage,
  PreviewNamespaceView,
  RestorePreviewView,
  RestoreRequest,
} from "../../shared/api.ts";
import { isJobFinished } from "../api.ts";
import { Button } from "../components/button.tsx";
import { EjsonTree } from "../components/code-block.tsx";
import { SelectField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, Notice, Panel } from "../components/layout.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { Table } from "../components/table.tsx";
import { useApi } from "../context.tsx";
import { describeWrapper, parseDocument } from "../ejson.ts";
import { formatNumber, plural } from "../format.ts";

/** Ids per page of the drill-down list. */
const PAGE_SIZE = 10;

/** Category names as shown, from the target's point of view. */
const CATEGORY_LABELS: Readonly<Record<PreviewCategory, string>> = {
  changed: "Changed",
  "backup-only": "Only in the backup",
  "live-only": "Only in the target",
};

/** Props for `RestorePreviewStep`. */
export interface RestorePreviewStepProps {
  /** The preview job started by the wizard. */
  readonly jobId: string;
  /** The request it was started with: its keys are needed again to open documents. */
  readonly request: RestoreRequest;
  readonly targetName: string;
  /** The step's heading, which the wizard focuses when the step opens. */
  readonly titleRef: Ref<HTMLHeadingElement>;
  /** Called with the job's status whenever it changes (the wizard words its buttons by it). */
  readonly onStatus?: (status: JobStatus) => void;
}

/** The "Preview changes" step. */
export function RestorePreviewStep(props: RestorePreviewStepProps) {
  const client = useApi();
  const { jobId, onStatus } = props;
  const [status, setStatus] = useState<JobStatus>("queued");
  const [view, setView] = useState<RestorePreviewView | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // Follow the job; once it has finished, load the result (also for failures, whose
  // view carries the error).
  useEffect(() => {
    let loaded = false;
    const unsubscribe = client.subscribeToJob(jobId, {
      onEvent: (event) => {
        if (event.type !== "status") return;
        setStatus(event.job.status);
        onStatusRef.current?.(event.job.status);
        if (!isJobFinished(event.job) || loaded) return;
        loaded = true;
        client
          .call("GET /api/restore/preview/:id", undefined, { params: { id: jobId } })
          .then(setView, setError);
      },
    });
    return unsubscribe;
  }, [client, jobId]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await client.call("POST /api/jobs/:id/cancel", undefined, { params: { id: jobId } });
    } catch (failure) {
      setError(failure);
    } finally {
      setCancelling(false);
    }
  };

  const namespaces = view?.namespaces ?? [];
  const chosen = namespaces.find((namespace) => namespace.from === selected);
  const changing = namespaces.filter((namespace) => !namespace.identical);
  const sampled = namespaces.filter((namespace) => namespace.accuracy === "sampled");

  return (
    <>
      <Panel
        titleRef={props.titleRef}
        title={`Preview: what the restore would change in ${props.targetName}`}
      >
        <p className="muted">
          The backup is compared with the target's current data, read only. Nothing is written until
          you start the restore.
        </p>
        {error === undefined ? null : (
          <ErrorNotice error={error} title="Could not load the preview" />
        )}
        {view === undefined && error === undefined ? (
          <div className="stack">
            <StatusBadge status={status} />
            <span>Comparing the backup with the target…</span>
            {isJobFinished({ status }) ? null : (
              <Button size="small" busy={cancelling} onClick={() => void cancel()}>
                Cancel preview
              </Button>
            )}
          </div>
        ) : null}
        {view !== undefined && view.namespaces === undefined ? (
          <Notice
            tone={view.status === "cancelled" ? "info" : "danger"}
            title={view.status === "cancelled" ? "Preview cancelled" : "The preview failed"}
          >
            {view.error?.message ?? "No result."} {view.error?.hint ?? ""} You can still continue to
            the confirmation without a preview.
          </Notice>
        ) : null}
        {view?.namespaces === undefined ? null : (
          <>
            {changing.length === 0 ? (
              <p>
                <StatusBadge status="ok" label="No changes" /> The target already matches the
                backup.
              </p>
            ) : (
              <Notice tone="warning" title={`${plural(changing.length, "namespace")} would change`}>
                Check the highlighted rows. "Documents" shows which documents differ, field by
                field.
              </Notice>
            )}
            {sampled.length === 0 ? null : (
              <Notice tone="info" title="Some counts are estimates">
                {plural(sampled.length, "namespace")} had more than{" "}
                {formatNumber(view.limits.sampleAbove)} documents, so{" "}
                {formatNumber(view.limits.sampleSize)} backed-up documents of each were looked up in
                the target and the counts were extrapolated (marked ≈). Documents only in the target
                cannot be listed for them.
              </Notice>
            )}
            <PreviewSummary
              namespaces={namespaces}
              selected={selected}
              onSelect={(ns) => setSelected(ns === selected ? undefined : ns)}
            />
          </>
        )}
      </Panel>
      {view === undefined || chosen === undefined ? null : (
        <NamespaceDetails
          key={chosen.from}
          view={view}
          namespace={chosen}
          request={props.request}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** A count, prefixed with ≈ when it is an estimate. */
function count(namespace: PreviewNamespaceView, value: number): string {
  return namespace.accuracy === "sampled" ? `≈ ${formatNumber(value)}` : formatNumber(value);
}

/** "3 new, 4 replaced, 2 deleted, 25 unchanged", or why nothing happens. */
export function describeEffect(namespace: PreviewNamespaceView): string {
  const { effect } = namespace;
  if (effect === undefined) {
    return namespace.action === "skip" ? "Skipped" : `Blocked (${namespace.action})`;
  }
  const parts = [
    `${count(namespace, effect.inserted)} new`,
    `${count(namespace, effect.replaced)} replaced`,
    `${count(namespace, effect.deleted)} deleted`,
    `${count(namespace, effect.kept)} unchanged`,
  ];
  return parts.join(", ");
}

/** "1 index, 2 options differ", "1 index differs", or "Same". */
export function describeMetadata(namespace: PreviewNamespaceView): string {
  const { indexes, options } = namespace;
  const indexCount = indexes.backupOnly.length + indexes.liveOnly.length + indexes.different.length;
  const parts: string[] = [];
  if (indexCount > 0) parts.push(indexCount === 1 ? "1 index" : `${indexCount} indexes`);
  if (options.length > 0) parts.push(plural(options.length, "option"));
  if (parts.length === 0) return "Same";
  // "1 index differs", "2 options differ", "1 index, 1 option differ".
  const single = parts.length === 1 && indexCount + options.length === 1;
  return `${parts.join(", ")} ${single ? "differs" : "differ"}`;
}

function PreviewSummary(props: {
  namespaces: readonly PreviewNamespaceView[];
  selected: string | undefined;
  onSelect: (ns: string) => void;
}) {
  return (
    <Table
      caption="Changes per namespace"
      rows={props.namespaces}
      rowKey={(namespace) => namespace.from}
      rowClassName={(namespace) =>
        namespace.effect === undefined && namespace.action !== "skip"
          ? "row-blocking"
          : namespace.identical
            ? undefined
            : "row-conflict"
      }
      columns={[
        {
          key: "namespace",
          header: "Namespace",
          render: (namespace) => (
            <span className="stack-vertical preview-namespace">
              <span className="mono">{namespace.from}</span>
              {namespace.to === namespace.from ? null : (
                <span className="muted">
                  → <span className="mono">{namespace.to}</span>
                  {namespace.targetExists ? "" : " (new)"}
                </span>
              )}
            </span>
          ),
        },
        {
          key: "accuracy",
          header: "Counts",
          render: (namespace) =>
            namespace.accuracy === "sampled" ? (
              <span className="stack-vertical">
                <StatusBadge status="incomplete" label="Estimate" />
                <span className="muted">
                  sample of {formatNumber(namespace.sample?.documents)} of{" "}
                  {formatNumber(namespace.sample?.of)}
                </span>
              </span>
            ) : (
              <StatusBadge status="ok" label="Exact" />
            ),
        },
        {
          key: "backupOnly",
          header: "Only in backup",
          align: "end",
          render: (namespace) => count(namespace, namespace.documents.backupOnly),
        },
        {
          key: "liveOnly",
          header: "Only in target",
          align: "end",
          render: (namespace) => count(namespace, namespace.documents.liveOnly),
        },
        {
          key: "changed",
          header: "Changed",
          align: "end",
          render: (namespace) => count(namespace, namespace.documents.changed),
        },
        {
          key: "identical",
          header: "Identical",
          align: "end",
          hideOnNarrow: true,
          render: (namespace) => count(namespace, namespace.documents.identical),
        },
        {
          key: "effect",
          header: "The restore would",
          render: (namespace) => (
            <span className="stack-vertical">
              <span>{describeEffect(namespace)}</span>
              {namespace.reason === undefined ? null : (
                <span className="muted">{namespace.reason}</span>
              )}
            </span>
          ),
        },
        {
          key: "metadata",
          header: "Indexes and options",
          hideOnNarrow: true,
          render: (namespace) => describeMetadata(namespace),
        },
        {
          key: "details",
          header: <span className="visually-hidden">Details</span>,
          render: (namespace) => (
            <Button
              size="small"
              aria-pressed={props.selected === namespace.from}
              aria-label={`Documents of ${namespace.from}`}
              onClick={() => props.onSelect(namespace.from)}
            >
              Documents
            </Button>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// One namespace
// ---------------------------------------------------------------------------

/** The first category with listed documents, else "changed". */
function firstCategory(namespace: PreviewNamespaceView): PreviewCategory {
  return (
    (["changed", "backup-only", "live-only"] as const).find(
      (category) => namespace.listed[category] > 0,
    ) ?? "changed"
  );
}

/** The total of a category, for "4 listed of 37". */
function totalOf(namespace: PreviewNamespaceView, category: PreviewCategory): number {
  switch (category) {
    case "changed":
      return namespace.documents.changed;
    case "backup-only":
      return namespace.documents.backupOnly;
    case "live-only":
      return namespace.documents.liveOnly;
  }
}

function NamespaceDetails(props: {
  view: RestorePreviewView;
  namespace: PreviewNamespaceView;
  request: RestoreRequest;
}) {
  const client = useApi();
  const { view, namespace } = props;
  const [category, setCategory] = useState<PreviewCategory>(firstCategory(namespace));
  /** `cursors[n]` is the `after` value of page n (page 0 has none). */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [page, setPage] = useState<PreviewDocumentPage | undefined>(undefined);
  const [pageError, setPageError] = useState<unknown>(undefined);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const after = cursors[cursors.length - 1];

  // Opening a namespace moves focus to it, so keyboard users land on what they asked for.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    if (!view.documentsVisible) return;
    const controller = new AbortController();
    setPage(undefined);
    setPageError(undefined);
    client
      .call("GET /api/restore/preview/:id/documents", undefined, {
        params: { id: view.jobId },
        query: { ns: namespace.from, category, limit: PAGE_SIZE, after },
        signal: controller.signal,
      })
      .then(
        (result) => {
          if (!controller.signal.aborted) setPage(result);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setPageError(failure);
        },
      );
    return () => controller.abort();
  }, [client, view.jobId, view.documentsVisible, namespace.from, category, after]);

  const { indexes, options } = namespace;
  return (
    <>
      <Panel titleRef={heading} title={`Documents of ${namespace.from}`}>
        <dl className="key-value-list">
          <div className="key-value-row">
            <dt>Restored into</dt>
            <dd className="mono">{namespace.to}</dd>
          </div>
          <div className="key-value-row">
            <dt>Indexes only in the backup</dt>
            <dd>{nameList(indexes.backupOnly)}</dd>
          </div>
          <div className="key-value-row">
            <dt>Indexes only in the target</dt>
            <dd>{nameList(indexes.liveOnly)}</dd>
          </div>
          <div className="key-value-row">
            <dt>Indexes defined differently</dt>
            <dd>{nameList(indexes.different)}</dd>
          </div>
          <div className="key-value-row">
            <dt>Collection options that differ</dt>
            <dd>{nameList(options)}</dd>
          </div>
        </dl>

        {view.documentsVisible ? (
          <>
            <SelectField<PreviewCategory>
              label="Show documents"
              value={category}
              options={(["changed", "backup-only", "live-only"] as const).map((value) => ({
                value,
                label: `${CATEGORY_LABELS[value]} (${formatNumber(namespace.listed[value])} listed of ${count(namespace, totalOf(namespace, value))})`,
              }))}
              onValue={(value) => {
                setCategory(value);
                setCursors([undefined]);
                setOpenId(undefined);
              }}
            />
            {pageError === undefined ? null : (
              <ErrorNotice error={pageError} title="Could not list the documents" />
            )}
            {page === undefined && pageError === undefined ? <Loading /> : null}
            {page === undefined ? null : page.documents.length === 0 ? (
              <EmptyState title="No documents in this category" />
            ) : (
              <ul
                className="plain-list preview-ids"
                aria-label={`${CATEGORY_LABELS[category]}: ids`}
              >
                {page.documents.map((entry) => (
                  <li key={entry.id}>
                    <Button
                      size="small"
                      variant="ghost"
                      aria-pressed={openId === entry.id}
                      onClick={() => setOpenId(entry.id)}
                    >
                      <span className="mono">_id {formatValue(entry.label)}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="pager">
              <Button
                size="small"
                disabled={cursors.length === 1}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                size="small"
                disabled={page?.next === undefined}
                onClick={() => setCursors([...cursors, page?.next])}
              >
                Next
              </Button>
              {page === undefined || page.listed >= totalOf(namespace, category) ? null : (
                <span className="muted">
                  The preview keeps the first {formatNumber(view.limits.listedPerCategory)} ids of
                  each kind.
                </span>
              )}
            </div>
          </>
        ) : (
          <Notice tone="info" title="Document contents are hidden for your role">
            Listing documents needs the role that may browse backup documents.
          </Notice>
        )}
      </Panel>
      {openId === undefined ? null : (
        <DocumentComparison
          key={openId}
          jobId={view.jobId}
          ns={namespace.from}
          id={openId}
          request={props.request}
        />
      )}
    </>
  );
}

function nameList(names: readonly string[]) {
  if (names.length === 0) return <span className="muted">none</span>;
  return (
    <span className="comma-list">
      {names.map((name) => (
        <span key={name} className="mono">
          {name}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

/** A relaxed Extended JSON value as MongoDB users know it (`ObjectId("…")`), else as given. */
export function formatValue(text: string | undefined): string {
  if (text === undefined) return "";
  const value = parseDocument(text);
  if (value === undefined) return text;
  return describeWrapper(value)?.text ?? (typeof value === "string" ? value : text);
}

/** How each kind of field change is labelled (word and tone, never color alone). */
const CHANGE_BADGES: Readonly<
  Record<PreviewDocumentDiff["fields"][number]["change"], { status: string; label: string }>
> = {
  added: { status: "ok", label: "Only in backup" },
  removed: { status: "failed", label: "Only in target" },
  changed: { status: "incomplete", label: "Changed" },
};

function DocumentComparison(props: {
  jobId: string;
  ns: string;
  id: string;
  request: RestoreRequest;
}) {
  const client = useApi();
  const [diff, setDiff] = useState<PreviewDocumentDiff | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const { jobId, ns, id } = props;
  const { passphrase, identities } = props.request;

  useEffect(() => {
    let current = true;
    client
      .call(
        "POST /api/restore/preview/:id/document",
        {
          ns,
          id,
          ...(passphrase === undefined ? {} : { passphrase }),
          ...(identities === undefined ? {} : { identities }),
        },
        { params: { id: jobId } },
      )
      .then(
        (result) => {
          if (current) setDiff(result);
        },
        (failure: unknown) => {
          if (current) setError(failure);
        },
      );
    return () => {
      current = false;
    };
  }, [client, jobId, ns, id, passphrase, identities]);

  // Focus follows the user to the document they opened, once it is there.
  useEffect(() => {
    if (diff !== undefined) heading.current?.focus();
  }, [diff]);

  if (error !== undefined) return <ErrorNotice error={error} title="Could not open the document" />;
  if (diff === undefined) return <Loading />;
  return (
    <Panel titleRef={heading} title={`Document _id ${formatValue(diff.label)}`}>
      {diff.fields.length === 0 ? (
        <Notice tone="info" title="No field differs now">
          The documents may differ only in the order of their fields, or the target changed since
          the preview.
        </Notice>
      ) : (
        <Table
          caption="Fields that differ"
          rows={diff.fields}
          rowKey={(field) => field.path}
          columns={[
            {
              key: "path",
              header: "Field",
              render: (field) => <span className="mono">{field.path}</span>,
            },
            {
              key: "change",
              header: "Difference",
              render: (field) => <StatusBadge {...CHANGE_BADGES[field.change]} />,
            },
            {
              key: "live",
              header: "In the target now",
              render: (field) => <FieldValue text={field.live} redacted={field.redacted} />,
            },
            {
              key: "backup",
              header: "In the backup",
              render: (field) => <FieldValue text={field.backup} redacted={field.redacted} />,
            },
          ]}
        />
      )}
      {diff.truncated ? <p className="muted">More fields differ than are listed here.</p> : null}
      {diff.fields.some((field) => field.redacted === true) ? (
        <p className="muted">
          Values of fields that look like secrets (passwords, tokens, keys) are hidden.
        </p>
      ) : null}
      {diff.documentsOmitted === true ? (
        <p className="muted">The documents are too large to show whole.</p>
      ) : (
        <div className="diff-columns">
          <DocumentSide title={`In the target now (${diff.to})`} json={diff.live} />
          <DocumentSide title={`In the backup (${diff.ns})`} json={diff.backup} />
        </div>
      )}
    </Panel>
  );
}

function FieldValue(props: { text: string | undefined; redacted: boolean | undefined }) {
  if (props.text === undefined) return <span className="muted">(missing)</span>;
  if (props.redacted === true) return <span className="muted">hidden</span>;
  return <span className="mono preview-value">{formatValue(props.text)}</span>;
}

/** One version of the document as an Extended JSON tree (or a note that it does not exist). */
function DocumentSide(props: { title: string; json: string | undefined }) {
  const value = props.json === undefined ? undefined : parseDocument(props.json);
  return (
    <figure className="diff-side">
      <figcaption className="code-block-header">{props.title}</figcaption>
      {value === undefined ? (
        <p className="muted diff-missing">No such document.</p>
      ) : (
        <EjsonTree value={value} label="document" />
      )}
    </figure>
  );
}
