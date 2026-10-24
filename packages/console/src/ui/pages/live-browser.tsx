/**
 * The live data browser (`#/connections/:id/data?ns=db.collection`): a navigation tree of
 * connections, databases and collections on the left, and the chosen collection on the
 * right, read straight from MongoDB.
 *
 * - The tree shows every connection; the current one is open, others load their
 *   databases when opened. It remembers the last collection opened per connection, and
 *   opening the page without one goes back to it.
 * - The collection's documents are shown by the shared document viewer
 *   (components/document-viewer.tsx) as a table, trees, JSON, cards, a schema or a chart,
 *   with the shared query bar (filter with suggestions, sort, projection, history, quick
 *   filters from any value) and an export of the current result.
 * - Reading needs the operator role (customer data, like the backup document browser);
 *   the server audits every page read. Paging uses skip/limit; the count is the
 *   collection's estimate without a filter, else counted up to a limit.
 * - Schema samples and field suggestions are background work: requested only when
 *   needed and paced per connection (slower on Atlas Free/Flex, which the server reports
 *   as `sharedTier`), see pacer.ts.
 * - Changing documents is opt-in: the buttons appear only when the server says the
 *   collection is writable for this user (`data:write` permission AND live edits allowed
 *   on the connection). Otherwise the page says why it is read-only. Documents read with
 *   a projection are partial and never editable. Every write is conditional and
 *   journaled by the server (live-editor.tsx has the dialogs).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ConnectionView,
  type DatabaseNode,
  LIVE_SAMPLE_DEFAULT_SIZE,
  type LiveCollectionInfo,
  type LiveCount,
  type LiveDocument,
} from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { columnsOf } from "../bson.ts";
import { Button } from "../components/button.tsx";
import { CollectionTree, type CollectionTreeNode } from "../components/collection-tree.tsx";
import { DocumentViewer } from "../components/document-viewer.tsx";
import { ExportButton } from "../components/export-button.tsx";
import { collectionIcon, Icon } from "../components/icons.tsx";
import {
  EmptyState,
  ErrorNotice,
  KeyValueList,
  Loading,
  Notice,
  PageHeader,
  Tabs,
} from "../components/layout.tsx";
import { QueryBar } from "../components/query-bar.tsx";
import { Table } from "../components/table.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { describeSample, useDocumentQuery, useSample } from "../document-query.ts";
import { formatBytes, formatCompact, formatNumber } from "../format.ts";
import { DEFAULT_GAP_MS, pacerFor, SHARED_TIER_GAP_MS, SUGGESTION_DEBOUNCE_MS } from "../pacer.ts";
import { buildHref, navigate, replaceQuery, segment } from "../router.ts";
import { fieldPaths } from "../schema.ts";
import {
  lastCollection,
  loadPrefs,
  rememberCollection,
  updatePrefs,
  type ViewMode,
} from "../view-prefs.ts";
import { toViewerDocuments, type ViewerDocument } from "../viewer-model.ts";
import { BackupActions } from "./backup-actions.tsx";
import {
  BulkEditDialog,
  DeleteDocumentDialog,
  DocumentEditorDialog,
  type EditorMode,
} from "./live-editor.tsx";

/** Page sizes offered; the API allows at most 100. */
const PAGE_SIZES = ["20", "50", "100"] as const;
/** Up to this many databases, all of them start open in the tree. */
const SMALL_DEPLOYMENT_DATABASES = 4;
/** Documents sampled for the schema on an Atlas shared tier (the server caps it at 200). */
const SHARED_TIER_SAMPLE_SIZE = 100;

/** Props for `LiveBrowserPage`. */
export interface LiveBrowserPageProps {
  readonly connectionId: string;
  /** The selected namespace (`db.collection`), from the `ns` query parameter. */
  readonly ns?: string | undefined;
}

/** `"shop.orders"` → `["shop", "orders"]` (collection names may contain dots). */
export function splitNamespace(ns: string): [string, string] {
  const dot = ns.indexOf(".");
  return dot === -1 ? [ns, ""] : [ns.slice(0, dot), ns.slice(dot + 1)];
}

/** The live data browser page. */
export function LiveBrowserPage(props: LiveBrowserPageProps) {
  const client = useApi();
  const { connectionId, ns } = props;
  const connections = useLoad("connections", (signal) =>
    client.call("GET /api/connections", undefined, { signal }),
  );
  const trees = useNamespaceTrees(connectionId);
  const treeData = trees.get(connectionId)?.data;
  const connection = connections.data?.find((candidate) => candidate.id === connectionId);

  // Opening the page without a collection goes back to the last one opened here.
  useEffect(() => {
    if (ns !== undefined && ns !== "") {
      rememberCollection(connectionId, ns);
      return;
    }
    const last = lastCollection(connectionId);
    if (last === undefined || treeData === undefined) return;
    const [db, name] = splitNamespace(last);
    const exists = treeData.some(
      (database) =>
        database.name === db && database.collections.some((entry) => entry.name === name),
    );
    if (exists) replaceQuery({ ns: last });
  }, [connectionId, ns, treeData]);

  const selected = ns === undefined || ns === "" ? undefined : ns;
  const [db, collectionName] = selected === undefined ? ["", ""] : splitNamespace(selected);
  const dataHref = buildHref(`/connections/${segment(connectionId)}/data`);
  const breadcrumbs = [
    { label: "Connections", href: "#/connections" },
    ...(connection === undefined
      ? []
      : [{ label: connection.name, href: buildHref(`/connections/${segment(connectionId)}`) }]),
    selected === undefined ? { label: "Live data" } : { label: "Live data", href: dataHref },
    ...(selected === undefined ? [] : [{ label: db }, { label: collectionName }]),
  ];

  if (connections.error !== undefined) {
    return <ErrorNotice error={connections.error} onRetry={connections.reload} />;
  }
  if (connections.data === undefined) return <Loading />;
  if (connection === undefined) {
    return (
      <>
        <PageHeader title="Connection not found" breadcrumbs={breadcrumbs.slice(0, 1)} />
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
        description="Read straight from MongoDB. Pick a collection on the left."
        actions={
          <a
            className="button button-secondary"
            href={buildHref("/edit-history", { connection: connectionId })}
          >
            <Icon name="history" size={14} />
            Edit history of this connection
          </a>
        }
      />
      {connection.production ? (
        <Notice tone="warning" title="Production connection">
          These are live production documents.
        </Notice>
      ) : null}
      {/* Back up now / progress / next steps for this connection (backup-actions.tsx). */}
      <BackupActions connectionId={connectionId} />
      <div className="browser-layout">
        <nav className="browser-nav panel" aria-label="Collections">
          <ConnectionTree
            connections={connections.data}
            currentId={connectionId}
            trees={trees}
            selectedNs={selected}
          />
        </nav>
        <div className="browser-main">
          {selected === undefined ? (
            <div className="panel">
              <EmptyState title="Choose a collection">
                Pick a collection on the left to see its documents, indexes and statistics.
              </EmptyState>
            </div>
          ) : (
            // Keyed by namespace so the query, paging and views start fresh per collection.
            <CollectionView key={selected} connectionId={connectionId} ns={selected} />
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The navigation tree
// ---------------------------------------------------------------------------

/** One connection's namespace tree as loaded so far (empty object: loading). */
interface TreeLoad {
  readonly data?: readonly DatabaseNode[];
  readonly error?: unknown;
}

/** The trees of the connections that were opened, with a `load(id)` for more. */
interface NamespaceTrees {
  get(id: string): TreeLoad | undefined;
  load(id: string): void;
  /** Reads a tree again after it failed. */
  retry(id: string): void;
}

/**
 * Namespace trees per connection: the current connection's at once, others on demand
 * (opening them in the tree), one request each per visit to the page.
 */
function useNamespaceTrees(currentId: string): NamespaceTrees {
  const client = useApi();
  const [loads, setLoads] = useState<ReadonlyMap<string, TreeLoad>>(new Map());
  const [wanted, setWanted] = useState<ReadonlySet<string>>(() => new Set([currentId]));
  if (!wanted.has(currentId)) setWanted(new Set([...wanted, currentId]));

  /** Ids already requested (a ref, so a re-render or a second effect run never repeats one). */
  const started = useRef(new Set<string>());
  useEffect(() => {
    for (const id of wanted) {
      if (started.current.has(id)) continue;
      started.current.add(id);
      setLoads((current) => new Map(current).set(id, {}));
      // Not aborted on unmount: the tree is small, and a late answer is simply dropped.
      client.call("GET /api/connections/:id/namespaces", undefined, { params: { id } }).then(
        (data) => setLoads((current) => new Map(current).set(id, { data })),
        (error: unknown) => setLoads((current) => new Map(current).set(id, { error })),
      );
    }
  }, [client, wanted]);

  return {
    get: (id) => loads.get(id),
    load: (id) => {
      if (!wanted.has(id)) setWanted(new Set([...wanted, id]));
    },
    retry: (id) => {
      started.current.delete(id);
      setLoads((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      // A new set re-runs the loading effect, which starts the request again.
      setWanted(new Set(wanted));
    },
  };
}

/** "3 collections, 12 MiB on disk". */
function databaseTitle(database: DatabaseNode): string {
  const count = database.collections.length;
  const size =
    database.sizeBytes === undefined ? "" : `, ${formatBytes(database.sizeBytes)} on disk`;
  return `${database.name}: ${count} ${count === 1 ? "collection" : "collections"}${size}`;
}

/** Tree nodes of one connection's databases and collections. */
function databaseNodes(
  connectionId: string,
  databases: readonly DatabaseNode[],
): CollectionTreeNode[] {
  return databases.map((database) => ({
    id: `db:${connectionId}:${database.name}`,
    label: database.name,
    icon: "database",
    kind: "database",
    meta:
      database.sizeBytes === undefined
        ? String(database.collections.length)
        : `${database.collections.length} · ${formatBytes(database.sizeBytes)}`,
    title: databaseTitle(database),
    children: database.collections.map((collection): CollectionTreeNode => {
      const ns = `${database.name}.${collection.name}`;
      const note =
        collection.type === "view"
          ? "view"
          : collection.type === "timeseries"
            ? "time series"
            : collection.capped === true
              ? "capped"
              : undefined;
      const details =
        collection.type === "view"
          ? "a view"
          : `about ${formatNumber(collection.estimatedDocuments)} documents, ${collection.indexes} ${collection.indexes === 1 ? "index" : "indexes"}`;
      const size =
        collection.sizeBytes === undefined ? "" : `, ${formatBytes(collection.sizeBytes)}`;
      return {
        id: `ns:${connectionId}:${ns}`,
        label: collection.name,
        icon: collectionIcon(collection.type, collection.capped),
        kind: "collection",
        href: buildHref(`/connections/${segment(connectionId)}/data`, { ns }),
        ...(note === undefined ? {} : { note }),
        ...(collection.type === "view"
          ? {}
          : { meta: formatCompact(collection.estimatedDocuments) }),
        title: `${ns}: ${details}${size}`,
      };
    }),
  }));
}

/** The sidebar: every connection, the current one open. */
function ConnectionTree(props: {
  connections: readonly ConnectionView[];
  currentId: string;
  trees: NamespaceTrees;
  selectedNs: string | undefined;
}) {
  const { trees, currentId } = props;
  const roots: CollectionTreeNode[] = props.connections.map((connection) => {
    const load = trees.get(connection.id);
    const loading = load !== undefined && load.data === undefined && load.error === undefined;
    return {
      id: `conn:${connection.id}`,
      label: connection.name,
      icon: "server",
      kind: "connection",
      ...(connection.production ? { note: "production" } : {}),
      ...(load?.data === undefined ? {} : { children: databaseNodes(connection.id, load.data) }),
      ...(loading ? { loading: true } : {}),
      ...(load?.error === undefined ? {} : { error: describeError(load.error), children: [] }),
    };
  });
  const [db] = props.selectedNs === undefined ? [""] : splitNamespace(props.selectedNs);
  // Open by default: the current connection, and the selected collection's database (or,
  // with nothing selected yet, every database of a small deployment).
  const databases = trees.get(currentId)?.data ?? [];
  const openDatabases =
    db !== ""
      ? [`db:${currentId}:${db}`]
      : databases.length <= SMALL_DEPLOYMENT_DATABASES
        ? databases.map((database) => `db:${currentId}:${database.name}`)
        : [];
  const currentError = trees.get(currentId)?.error;
  return (
    <>
      {currentError === undefined ? null : (
        <ErrorNotice
          error={currentError}
          title="Could not list the databases"
          onRetry={() => trees.retry(currentId)}
        />
      )}
      <CollectionTree
        label="Connections, databases and collections"
        roots={roots}
        selectedId={
          props.selectedNs === undefined ? undefined : `ns:${currentId}:${props.selectedNs}`
        }
        defaultExpanded={[`conn:${currentId}`, ...openDatabases]}
        onToggle={(node, open) => {
          if (open && node.kind === "connection") trees.load(node.id.slice("conn:".length));
        }}
        empty="No connections."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// One collection
// ---------------------------------------------------------------------------

/** The type of a collection in words. */
function typeLabel(info: LiveCollectionInfo): string {
  if (info.type === "view") return "View";
  if (info.type === "timeseries") return "Time series";
  return info.capped ? "Capped collection" : "Collection";
}

/** A size, or "—" with the reason as tooltip when MongoDB would not say (Atlas shared tiers). */
function SizeValue(props: { bytes: number | undefined; reason: string | undefined }) {
  if (props.bytes !== undefined) return <>{formatBytes(props.bytes)}</>;
  const reason = props.reason ?? "Not reported by MongoDB";
  return (
    <span className="muted" title={reason}>
      —<span className="visually-hidden"> ({reason})</span>
    </span>
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
    <section className="panel collection-panel" aria-labelledby="collection-title">
      <header className="collection-header">
        <div className="collection-heading">
          <Icon
            name={collectionIcon(collection.type, collection.capped)}
            size={18}
            className="collection-icon"
          />
          <h2 id="collection-title" className="collection-title">
            {collection.ns}
          </h2>
          <span
            className={collection.writable ? "badge badge-success" : "badge badge-neutral"}
            title={
              collection.writable
                ? "You may change documents here; every change is journaled and can be undone."
                : collection.readOnlyReason
            }
          >
            {collection.writable ? "Editable" : "Read-only"}
          </span>
          {collection.sharedTier === true ? (
            <span
              className="badge badge-neutral"
              title="Atlas Free and Flex clusters are throttled, so the console samples fewer documents and spaces out the queries it runs on its own."
            >
              Atlas shared tier
            </span>
          ) : null}
        </div>
        <p className="collection-facts muted">
          {typeLabel(collection)}
          {" · about "}
          {formatNumber(collection.estimatedDocuments)} documents
          {collection.sizeBytes === undefined ? "" : ` · ${formatBytes(collection.sizeBytes)}`}
          {` · ${collection.indexes.length === 1 ? "1 index" : `${collection.indexes.length} indexes`}`}
        </p>
      </header>
      <div className="panel-body">
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
      </div>
    </section>
  );
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

/** The documents of a collection: query bar, viewer, paging and the write actions. */
function DocumentsTab(props: { connectionId: string; collection: LiveCollectionInfo }) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { collection, connectionId } = props;
  const ns = collection.ns;
  const scope = `live:${connectionId}:${ns}`;
  const [view, setViewState] = useState<ViewMode>(() => loadPrefs(scope).view ?? "table");
  const [pageSize, setPageSize] = useState<string>("20");
  const [skip, setSkip] = useState(0);
  const [canonical, setCanonical] = useState(false);
  const [wantFields, setWantFields] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const query = useDocumentQuery(scope, { sortAndProjection: true, onApplied: () => setSkip(0) });
  const { applied } = query;
  const limit = Number(pageSize);

  const setView = (next: ViewMode) => {
    setViewState(next);
    updatePrefs(scope, { view: next });
  };

  // Background queries of this connection go one at a time, slower on Atlas shared tiers.
  const pacer = pacerFor(`live:${connectionId}`);
  pacer.setGap(collection.sharedTier === true ? SHARED_TIER_GAP_MS : DEFAULT_GAP_MS);

  const wantCanonical = canonical && view === "json";
  const page = useLoad(
    JSON.stringify([connectionId, ns, applied, pageSize, skip, wantCanonical]),
    (signal) =>
      client.call("GET /api/live/:id/documents", undefined, {
        params: { id: connectionId },
        query: {
          ns,
          filter: applied.filter,
          projection: applied.projection,
          sort: applied.sort,
          skip: skip === 0 ? undefined : skip,
          limit: pageSize,
          ejson: wantCanonical ? "canonical" : undefined,
        },
        signal,
      }),
  );

  const sample = useSample(
    JSON.stringify([connectionId, ns, applied.filter]),
    view === "schema" || view === "chart" || wantFields,
    pacer,
    (signal) =>
      client.call("GET /api/live/:id/sample", undefined, {
        params: { id: connectionId },
        query: {
          ns,
          filter: applied.filter,
          size: collection.sharedTier === true ? SHARED_TIER_SAMPLE_SIZE : LIVE_SAMPLE_DEFAULT_SIZE,
        },
        signal,
      }),
  );

  // Field suggestions: sample once the filter box has had focus for a moment.
  const [suggestTimer, setSuggestTimer] = useState<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(suggestTimer), [suggestTimer]);
  const onWantFields = () => {
    if (wantFields || suggestTimer !== undefined) return;
    setSuggestTimer(setTimeout(() => setWantFields(true), SUGGESTION_DEBOUNCE_MS));
  };

  const liveDocuments = page.data?.documents;
  const documents = useMemo(
    () =>
      toViewerDocuments(
        (liveDocuments ?? []).map((document) => document.json),
        (liveDocuments ?? []).map((document) => document.canonical),
      ),
    [liveDocuments],
  );
  /** The live document behind a viewer document (same position on the page). */
  const liveOf = (document: ViewerDocument) => liveDocuments?.[documents.indexOf(document)];

  const fields = useMemo(() => {
    const paths = new Set([
      ...columnsOf(documents.map((document) => document.value)),
      ...fieldPaths(sample.summary),
    ]);
    return [...paths];
  }, [documents, sample.summary]);

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
  const onCopied = (ok: boolean, what: string) =>
    toast.show(
      ok ? "success" : "error",
      ok
        ? `Copied the ${what}.`
        : "The browser refused to copy. Select the text and copy it by hand.",
    );

  const writable = collection.writable;
  const projected = page.data?.projected === true;
  const first = documents.length === 0 ? 0 : skip + 1;
  const last = skip + documents.length;

  /** Edit / Duplicate / Delete for one document, when allowed. */
  const writeActions = (document: ViewerDocument) => {
    const live = liveOf(document);
    if (!writable || live === undefined || live.version === undefined) return null;
    return (
      <>
        <Button
          size="small"
          aria-label={`Edit document ${document.label}`}
          onClick={() => setOverlay({ kind: "editor", mode: { kind: "edit", document: live } })}
        >
          <Icon name="edit" size={12} />
          Edit
        </Button>
        <Button
          size="small"
          aria-label={`Duplicate document ${document.label}`}
          onClick={() =>
            setOverlay({ kind: "editor", mode: { kind: "duplicate", document: live } })
          }
        >
          <Icon name="duplicate" size={12} />
          Duplicate
        </Button>
        <Button
          size="small"
          variant="danger"
          aria-label={`Delete document ${document.label}`}
          onClick={() => setOverlay({ kind: "delete", document: live })}
        >
          <Icon name="trash" size={12} />
          Delete
        </Button>
      </>
    );
  };

  const pager = (label?: string) => (
    <Pager
      page={Math.floor(skip / limit) + 1}
      hasPrevious={skip > 0}
      hasNext={page.data?.hasMore === true}
      busy={page.loading}
      onPrevious={() => setSkip(Math.max(0, skip - limit))}
      onNext={() => setSkip(skip + limit)}
      {...(label === undefined ? {} : { label })}
    />
  );

  return (
    <div className="live-documents">
      <QueryBar
        text={query.text}
        onText={query.setText}
        problems={query.problems}
        onApply={() => void query.apply()}
        onReset={query.reset}
        fields={fields}
        onWantFields={onWantFields}
        sortAndProjection
        pageSize={pageSize}
        pageSizes={PAGE_SIZES}
        onPageSize={(size) => {
          setPageSize(size);
          setSkip(0);
        }}
        history={query.history}
        onHistory={query.applyHistory}
        chips={query.chips}
        onRemoveChip={query.removeChip}
        busy={page.loading}
        onCancel={page.cancel}
      />

      {writable ? (
        <div className="live-actions">
          <Button
            size="small"
            variant="primary"
            onClick={() => setOverlay({ kind: "editor", mode: { kind: "insert" } })}
          >
            <Icon name="plus" size={14} />
            Insert document
          </Button>
          <Button size="small" onClick={() => setOverlay({ kind: "bulk", op: "update" })}>
            Update many…
          </Button>
          <Button
            size="small"
            variant="danger"
            onClick={() => setOverlay({ kind: "bulk", op: "delete" })}
          >
            Delete many…
          </Button>
          <span className="muted live-actions-note">
            Every change is journaled and can be undone from Edit history.
          </span>
        </div>
      ) : (
        <p className="read-only-note">
          <Icon name="key" size={14} />
          <span>
            Read-only: {collection.readOnlyReason ?? "changing documents is not allowed here."}
          </span>
        </p>
      )}
      {writable && projected ? (
        <Notice tone="info">
          A projection is applied: these documents are partial, so they cannot be edited. Clear the
          projection to edit them.
        </Notice>
      ) : null}

      <div className="results-bar">
        <p className="browser-status" aria-live="polite">
          {page.data === undefined
            ? ""
            : `Showing ${formatNumber(first)}–${formatNumber(last)} of ${describeCount(page.data.count)} documents`}
          {applied.filter === undefined ? "" : " · filtered"}
        </p>
        {pager("Document pages")}
      </div>
      {page.error !== undefined ? (
        <ErrorNotice error={page.error} title="Could not read documents" onRetry={page.reload} />
      ) : null}

      <DocumentViewer
        scope={scope}
        view={view}
        onView={setView}
        documents={documents}
        firstNumber={skip + 1}
        loading={page.loading}
        empty={
          <EmptyState title="No documents">
            {applied.filter === undefined
              ? "This collection is empty."
              : "No documents match the filter."}
          </EmptyState>
        }
        sort={query.sort}
        onSort={query.sortBy}
        onQuickFilter={(filter) => {
          const problem = query.quickFilter(filter);
          if (problem !== undefined) toast.show("error", problem);
        }}
        sample={{
          summary: sample.summary,
          description: describeSample(sample.sample, applied.filter !== undefined),
          loading: sample.loading,
          error: sample.error,
          reload: sample.reload,
        }}
        canonical={{ on: canonical, onToggle: setCanonical }}
        detailActions={writeActions}
        documentActions={writeActions}
        onCopied={onCopied}
        toolbar={
          hasRole("operator") ? (
            <ExportButton
              disabled={page.data === undefined}
              run={(choice) =>
                client.call("GET /api/live/:id/export", undefined, {
                  params: { id: connectionId },
                  query: {
                    ns,
                    filter: applied.filter,
                    projection: applied.projection,
                    sort: applied.sort,
                    format: choice.format,
                    limit: choice.limit,
                    ejson: choice.ejson === "canonical" ? "canonical" : undefined,
                  },
                })
              }
              onDone={(message, tone) => toast.show(tone, message)}
            />
          ) : null
        }
      />

      {overlay?.kind === "editor" ? (
        <DocumentEditorDialog
          connectionId={connectionId}
          ns={ns}
          mode={overlay.mode}
          onClose={() => setOverlay(undefined)}
          onSaved={saved}
          onReload={reloadAfterConflict}
        />
      ) : null}
      {overlay?.kind === "delete" ? (
        <DeleteDocumentDialog
          connectionId={connectionId}
          ns={ns}
          document={overlay.document}
          onClose={() => setOverlay(undefined)}
          onSaved={saved}
          onReload={reloadAfterConflict}
        />
      ) : null}
      {overlay?.kind === "bulk" ? (
        <BulkEditDialog
          connectionId={connectionId}
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

/** Previous / next page buttons with the page number between them. */
export function Pager(props: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Accessible name; the pager with one is a navigation landmark (one per page). */
  label?: string;
}) {
  const buttons = (
    <>
      <Button
        size="small"
        disabled={!props.hasPrevious || props.busy}
        onClick={props.onPrevious}
        aria-label="Previous page"
      >
        <Icon name="chevronLeft" size={14} />
        Previous
      </Button>
      <span className="numeric pager-page">Page {formatNumber(props.page)}</span>
      <Button
        size="small"
        disabled={!props.hasNext || props.busy}
        onClick={props.onNext}
        aria-label="Next page"
      >
        Next
        <Icon name="chevronRight" size={14} />
      </Button>
    </>
  );
  return props.label === undefined ? (
    <div className="pager">{buttons}</div>
  ) : (
    <nav className="pager" aria-label={props.label}>
      {buttons}
    </nav>
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
          render: (index) => (
            <SizeValue bytes={index.sizeBytes} reason={props.collection.statsUnavailable} />
          ),
        },
      ]}
    />
  );
}

/** Size statistics of a collection ("—" with the reason when MongoDB would not report them). */
function StatsTab(props: { collection: LiveCollectionInfo }) {
  const { collection } = props;
  const reason = collection.statsUnavailable;
  return (
    <>
      {reason === undefined ? null : <p className="muted">Sizes are not available: {reason}</p>}
      <KeyValueList
        items={[
          ["Type", collection.type],
          ["Documents (estimate)", formatNumber(collection.estimatedDocuments)],
          ["Data size", <SizeValue key="data" bytes={collection.sizeBytes} reason={reason} />],
          [
            "Storage size",
            <SizeValue key="storage" bytes={collection.storageSizeBytes} reason={reason} />,
          ],
          [
            "Average document",
            <SizeValue key="average" bytes={collection.averageDocumentBytes} reason={reason} />,
          ],
          [
            "Index size",
            <SizeValue key="index" bytes={collection.totalIndexBytes} reason={reason} />,
          ],
          ["Capped", collection.capped ? "Yes" : "No"],
          [
            "Changes from the console",
            collection.writable ? "Allowed for you" : (collection.readOnlyReason ?? "Not allowed"),
          ],
        ]}
      />
    </>
  );
}
