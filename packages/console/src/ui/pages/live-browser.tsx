/**
 * The live data browser (`#/connections/:id/data?ns=db.collection`): the databases and
 * collections of a connection on the left, and on the right the chosen collection's
 * documents, indexes and statistics, read straight from MongoDB.
 *
 * - Reading needs the operator role (customer data, like the backup document browser),
 *   and every page read is recorded in the audit log by the server.
 * - The query form takes a filter, projection and sort as Extended JSON, checked in the
 *   browser before any request. Paging uses skip/limit; the count is the collection's
 *   estimate without a filter, else counted (up to a limit).
 * - Changing documents is opt-in: the buttons appear only when the server says the
 *   collection is writable for this user (`data:write` permission AND live edits allowed
 *   on the connection). Otherwise the page says why it is read-only. Documents read with
 *   a projection are partial and never editable.
 * - Every write is conditional and journaled by the server, so it can be undone from
 *   the Edit history page; see live-editor.tsx for the dialogs.
 */

import { type FormEvent, useState } from "react";
import type {
  DatabaseNode,
  LiveCollectionInfo,
  LiveCount,
  LiveDocument,
} from "../../shared/api.ts";
import { Button } from "../components/button.tsx";
import { EjsonTree } from "../components/code-block.tsx";
import { SelectField, TextAreaField } from "../components/field.tsx";
import {
  EmptyState,
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Panel,
  Tabs,
} from "../components/layout.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad } from "../context.tsx";
import { checkFilter, documentIdLabel, isJsonObject, parseDocument } from "../ejson.ts";
import { formatBytes, formatNumber } from "../format.ts";
import { checkProjection, checkSort } from "../live-query.ts";
import { buildHref, navigate, segment } from "../router.ts";
import {
  BulkEditDialog,
  DeleteDocumentDialog,
  DocumentEditorDialog,
  type EditorMode,
} from "./live-editor.tsx";

/** Page sizes offered; the API allows at most 100. */
const PAGE_SIZES = ["20", "50", "100"] as const;
type PageSize = (typeof PAGE_SIZES)[number];

/** Props for `LiveBrowserPage`. */
export interface LiveBrowserPageProps {
  readonly connectionId: string;
  /** The selected namespace (`db.collection`), from the `ns` query parameter. */
  readonly ns?: string | undefined;
}

/** The live data browser page. */
export function LiveBrowserPage(props: LiveBrowserPageProps) {
  const client = useApi();
  const { connectionId } = props;
  const connections = useLoad("connections", (signal) =>
    client.call("GET /api/connections", undefined, { signal }),
  );
  const tree = useLoad<readonly DatabaseNode[]>(`namespaces:${connectionId}`, (signal) =>
    client.call("GET /api/connections/:id/namespaces", undefined, {
      params: { id: connectionId },
      signal,
    }),
  );
  const connection = connections.data?.find((candidate) => candidate.id === connectionId);
  const breadcrumbs = [
    { label: "Connections", href: "#/connections" },
    ...(connection === undefined
      ? []
      : [{ label: connection.name, href: buildHref(`/connections/${segment(connectionId)}`) }]),
  ];

  if (connections.error !== undefined) {
    return <ErrorNotice error={connections.error} onRetry={connections.reload} />;
  }
  if (connections.data === undefined) return <Loading />;
  if (connection === undefined) {
    return (
      <>
        <PageHeader title="Connection not found" breadcrumbs={breadcrumbs} />
        <p>
          It may have been deleted. <a href="#/connections">Back to connections</a>
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${connection.name}: live data`}
        breadcrumbs={breadcrumbs}
        description="Documents read straight from the databases of this connection. Changes, where allowed, are journaled and can be undone from Edit history."
        actions={
          <a
            className="button button-secondary"
            href={buildHref("/edit-history", { connection: connectionId })}
          >
            Edit history of this connection
          </a>
        }
      />
      {connection.production ? (
        <Notice tone="warning" title="Production connection">
          These are live production documents.
        </Notice>
      ) : null}
      <div className="live-layout">
        <nav className="live-tree panel" aria-label="Collections">
          {tree.error !== undefined ? (
            <ErrorNotice error={tree.error} onRetry={tree.reload} />
          ) : null}
          {tree.data === undefined ? (
            tree.error === undefined ? (
              <Loading label="Listing databases…" />
            ) : null
          ) : (
            <CollectionList connectionId={connectionId} tree={tree.data} selected={props.ns} />
          )}
        </nav>
        <div className="live-main">
          {props.ns === undefined || props.ns === "" ? (
            <EmptyState title="Choose a collection">
              Pick a collection on the left to see its documents, indexes and statistics.
            </EmptyState>
          ) : (
            // Keyed by namespace so the query form and paging start fresh per collection.
            <CollectionView key={props.ns} connectionId={connectionId} ns={props.ns} />
          )}
        </div>
      </div>
    </>
  );
}

/** Databases with their collections as links (the selected one marked `aria-current`). */
function CollectionList(props: {
  connectionId: string;
  tree: readonly DatabaseNode[];
  selected: string | undefined;
}) {
  if (props.tree.length === 0) {
    return (
      <EmptyState title="No databases">This connection has no databases you can read.</EmptyState>
    );
  }
  return (
    <ul className="live-databases">
      {props.tree.map((database) => (
        <li key={database.name}>
          <span className="live-database-name">{database.name}</span>
          <ul className="live-collections">
            {database.collections.map((collection) => {
              const ns = `${database.name}.${collection.name}`;
              return (
                <li key={ns}>
                  <a
                    href={buildHref(`/connections/${segment(props.connectionId)}/data`, { ns })}
                    aria-current={props.selected === ns ? "page" : undefined}
                    className="live-collection-link"
                  >
                    {collection.name}
                    {collection.type === "collection" ? null : (
                      <span className="muted"> ({collection.type})</span>
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** One collection: header, then the Documents / Indexes / Stats tabs. */
function CollectionView(props: { connectionId: string; ns: string }) {
  const client = useApi();
  const [tab, setTab] = useState("documents");
  const info = useLoad(`collection:${props.connectionId}:${props.ns}`, (signal) =>
    client.call("GET /api/live/:id/collection", undefined, {
      params: { id: props.connectionId },
      query: { ns: props.ns },
      signal,
    }),
  );
  if (info.error !== undefined) {
    return (
      <ErrorNotice error={info.error} title="Could not read the collection" onRetry={info.reload} />
    );
  }
  if (info.data === undefined) return <Loading label="Reading the collection…" />;
  const collection = info.data;
  return (
    <Panel title={collection.ns}>
      <p className="muted live-summary">
        {collection.type === "collection"
          ? "Collection"
          : collection.type === "view"
            ? "View"
            : "Time series"}
        {" · about "}
        {formatNumber(collection.estimatedDocuments)} documents
        {collection.sizeBytes === undefined ? "" : ` · ${formatBytes(collection.sizeBytes)}`}
        {` · ${collection.indexes.length === 1 ? "1 index" : `${collection.indexes.length} indexes`}`}
      </p>
      <Tabs
        label="Collection"
        tabs={[
          { id: "documents", label: "Documents" },
          { id: "indexes", label: "Indexes" },
          { id: "stats", label: "Stats" },
        ]}
        selected={tab}
        onSelect={setTab}
      >
        {tab === "documents" ? (
          <DocumentsTab connectionId={props.connectionId} collection={collection} />
        ) : tab === "indexes" ? (
          <IndexesTab collection={collection} />
        ) : (
          <StatsTab collection={collection} />
        )}
      </Tabs>
    </Panel>
  );
}

/** The applied query of the Documents tab (compact JSON strings, or undefined). */
interface AppliedQuery {
  readonly filter: string | undefined;
  readonly projection: string | undefined;
  readonly sort: string | undefined;
}

/** "about 45", "45" or "at least 10,000" documents. */
export function describeCount(count: LiveCount): string {
  const value = formatNumber(count.value);
  if (count.kind === "estimated") return `about ${value}`;
  if (count.kind === "at-least") return `at least ${value}`;
  return value;
}

/** What is open on top of the Documents tab. */
type Overlay =
  | { readonly kind: "editor"; readonly mode: EditorMode }
  | { readonly kind: "delete"; readonly document: LiveDocument }
  | { readonly kind: "bulk"; readonly op: "update" | "delete" };

/** The documents of a collection: query form, documents, paging and the write actions. */
function DocumentsTab(props: { connectionId: string; collection: LiveCollectionInfo }) {
  const client = useApi();
  const toast = useToast();
  const { collection } = props;
  const ns = collection.ns;
  const [text, setText] = useState({ filter: "", projection: "", sort: "" });
  const [problems, setProblems] = useState<{ filter?: string; projection?: string; sort?: string }>(
    {},
  );
  const [applied, setApplied] = useState<AppliedQuery>({
    filter: undefined,
    projection: undefined,
    sort: undefined,
  });
  const [pageSize, setPageSize] = useState<PageSize>("20");
  const [skip, setSkip] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const limit = Number(pageSize);

  const page = useLoad(
    JSON.stringify([props.connectionId, ns, applied, pageSize, skip]),
    (signal) =>
      client.call("GET /api/live/:id/documents", undefined, {
        params: { id: props.connectionId },
        query: {
          ns,
          filter: applied.filter,
          projection: applied.projection,
          sort: applied.sort,
          skip: skip === 0 ? undefined : skip,
          limit: pageSize,
        },
        signal,
      }),
  );

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const filter = checkFilter(text.filter);
    const projection = checkProjection(text.projection);
    const sort = checkSort(text.sort);
    const next = {
      ...(filter.ok ? {} : { filter: filter.message }),
      ...(projection.ok ? {} : { projection: projection.message }),
      ...(sort.ok ? {} : { sort: sort.message }),
    };
    setProblems(next);
    if (!filter.ok || !projection.ok || !sort.ok) return;
    setApplied({ filter: filter.filter, projection: projection.value, sort: sort.value });
    setSkip(0);
  };

  /** After a write: say so, close the dialog and read the page again. */
  const saved = (message: string) => {
    setOverlay(undefined);
    toast.show("success", message);
    page.reload();
  };
  /** "Reload document" after a conflict: close the dialog and show the current state. */
  const reloadAfterConflict = () => {
    setOverlay(undefined);
    page.reload();
  };

  const writable = collection.writable;
  const projected = page.data?.projected === true;
  const documents = page.data?.documents ?? [];
  const first = documents.length === 0 ? 0 : skip + 1;
  const last = skip + documents.length;

  return (
    <div className="live-documents">
      <form className="live-query" onSubmit={apply} noValidate>
        <TextAreaField
          label="Filter (Extended JSON)"
          value={text.filter}
          onValue={(value) => setText({ ...text, filter: value })}
          rows={2}
          spellCheck={false}
          placeholder='{"status": "paid"}'
          error={problems.filter}
        />
        <TextAreaField
          label="Projection"
          value={text.projection}
          onValue={(value) => setText({ ...text, projection: value })}
          rows={2}
          spellCheck={false}
          placeholder='{"name": 1, "email": 1}'
          hint="Projected documents are partial and read-only."
          error={problems.projection}
        />
        <TextAreaField
          label="Sort"
          value={text.sort}
          onValue={(value) => setText({ ...text, sort: value })}
          rows={2}
          spellCheck={false}
          placeholder='{"_id": -1}'
          error={problems.sort}
        />
        <SelectField<PageSize>
          label="Per page"
          value={pageSize}
          options={PAGE_SIZES.map((size) => ({ value: size, label: size }))}
          onValue={(value) => {
            setPageSize(value);
            setSkip(0);
          }}
        />
        <div className="browser-buttons">
          <Button type="submit" variant="primary">
            Apply
          </Button>
        </div>
      </form>

      {writable ? (
        <div className="live-actions">
          <Button onClick={() => setOverlay({ kind: "editor", mode: { kind: "insert" } })}>
            Insert document
          </Button>
          <Button onClick={() => setOverlay({ kind: "bulk", op: "update" })}>Update many…</Button>
          <Button variant="danger" onClick={() => setOverlay({ kind: "bulk", op: "delete" })}>
            Delete many…
          </Button>
        </div>
      ) : (
        <Notice tone="info">
          Read-only: {collection.readOnlyReason ?? "changing documents is not allowed here."}
        </Notice>
      )}
      {writable && projected ? (
        <Notice tone="info">
          A projection is applied: these documents are partial, so they cannot be edited. Clear the
          projection to edit them.
        </Notice>
      ) : null}

      <p className="browser-status" aria-live="polite">
        {page.data === undefined
          ? ""
          : `Showing ${formatNumber(first)}–${formatNumber(last)} of ${describeCount(page.data.count)} documents`}
        {applied.filter === undefined ? "" : " · filtered"}
      </p>
      {page.error !== undefined ? (
        <ErrorNotice error={page.error} title="Could not read documents" onRetry={page.reload} />
      ) : null}
      {page.loading ? <Loading label="Reading documents…" /> : null}
      {!page.loading && page.data !== undefined && documents.length === 0 ? (
        <EmptyState title="No documents">
          {applied.filter === undefined
            ? "This collection is empty."
            : "No documents match the filter."}
        </EmptyState>
      ) : null}

      <ol className="document-list" aria-label="Documents">
        {documents.map((document, index) => {
          const parsed = parseDocument(document.json);
          const label = documentIdLabel(parsed);
          const editable = writable && document.version !== undefined;
          return (
            <li key={document.id ?? `${skip + index}`} className="document-card">
              <div className="live-document-header">
                <span className="mono">{label}</span>
                {editable ? (
                  <span className="row-actions">
                    <Button
                      size="small"
                      aria-label={`Edit document ${label}`}
                      onClick={() =>
                        setOverlay({ kind: "editor", mode: { kind: "edit", document } })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="small"
                      aria-label={`Duplicate document ${label}`}
                      onClick={() =>
                        setOverlay({ kind: "editor", mode: { kind: "duplicate", document } })
                      }
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="small"
                      variant="danger"
                      aria-label={`Delete document ${label}`}
                      onClick={() => setOverlay({ kind: "delete", document })}
                    >
                      Delete
                    </Button>
                  </span>
                ) : null}
              </div>
              {parsed === undefined || !isJsonObject(parsed) ? (
                <pre className="mono">{document.json}</pre>
              ) : (
                <EjsonTree value={parsed} />
              )}
            </li>
          );
        })}
      </ol>

      <nav className="pager" aria-label="Document pages">
        <Button
          disabled={skip === 0 || page.loading}
          onClick={() => setSkip(Math.max(0, skip - limit))}
        >
          Previous page
        </Button>
        <span className="numeric">Page {formatNumber(Math.floor(skip / limit) + 1)}</span>
        <Button
          disabled={page.data?.hasMore !== true || page.loading}
          onClick={() => setSkip(skip + limit)}
        >
          Next page
        </Button>
      </nav>

      {overlay?.kind === "editor" ? (
        <DocumentEditorDialog
          connectionId={props.connectionId}
          ns={ns}
          mode={overlay.mode}
          onClose={() => setOverlay(undefined)}
          onSaved={saved}
          onReload={reloadAfterConflict}
        />
      ) : null}
      {overlay?.kind === "delete" ? (
        <DeleteDocumentDialog
          connectionId={props.connectionId}
          ns={ns}
          document={overlay.document}
          onClose={() => setOverlay(undefined)}
          onSaved={saved}
          onReload={reloadAfterConflict}
        />
      ) : null}
      {overlay?.kind === "bulk" ? (
        <BulkEditDialog
          connectionId={props.connectionId}
          ns={ns}
          op={overlay.op}
          {...(applied.filter === undefined ? {} : { initialFilter: applied.filter })}
          onClose={() => setOverlay(undefined)}
          onStarted={(job) => {
            setOverlay(undefined);
            toast.show("info", "The bulk edit is running as a job. Undo it from Edit history.");
            navigate(`/jobs/${segment(job.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}

/** The indexes of a collection. */
function IndexesTab(props: { collection: LiveCollectionInfo }) {
  return (
    <Table
      caption={`Indexes of ${props.collection.ns}`}
      rows={props.collection.indexes}
      rowKey={(index) => index.name}
      empty={<EmptyState title="No indexes">Views have no indexes of their own.</EmptyState>}
      columns={[
        {
          key: "name",
          header: "Name",
          sortValue: (index) => index.name,
          render: (index) => index.name,
        },
        { key: "key", header: "Key", render: (index) => <code>{index.key}</code> },
        {
          key: "options",
          header: "Options",
          render: (index) => {
            const options = [
              index.unique ? "unique" : "",
              index.sparse ? "sparse" : "",
              index.hidden ? "hidden" : "",
              index.expireAfterSeconds === undefined
                ? ""
                : `TTL ${formatNumber(index.expireAfterSeconds)} s`,
              index.partialFilter === undefined ? "" : `partial ${index.partialFilter}`,
            ].filter((option) => option !== "");
            return options.length === 0 ? <span className="muted">–</span> : options.join(", ");
          },
        },
        {
          key: "size",
          header: "Size",
          align: "end",
          sortValue: (index) => index.sizeBytes,
          render: (index) => formatBytes(index.sizeBytes),
        },
      ]}
    />
  );
}

/** Size statistics of a collection. */
function StatsTab(props: { collection: LiveCollectionInfo }) {
  const { collection } = props;
  return (
    <KeyValueList
      items={[
        ["Type", collection.type],
        ["Documents (estimate)", formatNumber(collection.estimatedDocuments)],
        ["Data size", formatBytes(collection.sizeBytes)],
        ["Storage size", formatBytes(collection.storageSizeBytes)],
        ["Average document", formatBytes(collection.averageDocumentBytes)],
        ["Index size", formatBytes(collection.totalIndexBytes)],
        ["Capped", collection.capped ? "Yes" : "No"],
        [
          "Changes from the console",
          collection.writable ? "Allowed for you" : (collection.readOnlyReason ?? "Not allowed"),
        ],
      ]}
    />
  );
}
