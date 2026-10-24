/**
 * The document browser of a backup (Backups → a backup → "Browse documents"): the same
 * viewer as the live data browser, read-only, so browsing a backup feels like browsing
 * live data.
 *
 * - The namespaces of the backup are a tree (databases → collections, with document
 *   counts and sizes from the manifest) on the left; views are skipped (no documents).
 * - Documents are read with the library's `findInBackup` (`GET …/documents`) and shown as
 *   a table, trees, JSON, cards, a schema of the first documents, or a chart. The filter
 *   box is the shared one (suggestions, quick filters, history), validated in the
 *   browser before any request (ejson.ts). Backups are read in storage order, so there
 *   is no sort or projection.
 * - Paging is cursor based: the server returns `next`, and the browser keeps the cursors
 *   of earlier pages so "Previous" works without the server going backwards.
 * - Ticking documents and choosing "Restore selected" opens the restore wizard limited to
 *   those `_id`s (operator role).
 * - "Export" downloads the current result (`GET …/export`, bounded and audited).
 */

import { useMemo, useState } from "react";
import { LIVE_SAMPLE_DEFAULT_SIZE } from "../../shared/api.ts";
import { describeError } from "../api.ts";
import { columnsOf } from "../bson.ts";
import { Button } from "../components/button.tsx";
import { CollectionTree, type CollectionTreeNode } from "../components/collection-tree.tsx";
import { DocumentViewer } from "../components/document-viewer.tsx";
import { ExportButton } from "../components/export-button.tsx";
import { EmptyState, ErrorNotice, Notice } from "../components/layout.tsx";
import { QueryBar } from "../components/query-bar.tsx";
import { useToast } from "../components/toast.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import { describeSample, useDocumentQuery, useSample } from "../document-query.ts";
import { formatBytes, formatCompact, formatNumber } from "../format.ts";
import type { ManifestNamespace } from "../manifest.ts";
import { pacerFor } from "../pacer.ts";
import { navigate, segment } from "../router.ts";
import { fieldPaths } from "../schema.ts";
import { loadPrefs, updatePrefs, type ViewMode } from "../view-prefs.ts";
import { toViewerDocuments, type ViewerDocument, type ViewerSelection } from "../viewer-model.ts";
import { Pager, splitNamespace } from "./live-browser.tsx";

/** Page sizes offered; the API allows at most 100. */
const PAGE_SIZES = ["20", "50", "100"] as const;

/** Props for `DocumentBrowser`. */
export interface DocumentBrowserProps {
  readonly storageId: string;
  readonly backupId: string;
  /** Namespaces in the backup (views are skipped: they hold no documents). */
  readonly namespaces: readonly ManifestNamespace[];
  /** Encrypted backups need a key on the server; shown as a hint when browsing fails. */
  readonly encrypted: boolean;
}

/** The namespaces of a backup as tree nodes: databases with their collections. */
function namespaceNodes(namespaces: readonly ManifestNamespace[]): CollectionTreeNode[] {
  const databases = new Map<string, ManifestNamespace[]>();
  for (const entry of namespaces) {
    const [db] = splitNamespace(entry.ns);
    databases.set(db, [...(databases.get(db) ?? []), entry]);
  }
  return [...databases.entries()].map(([db, entries]) => ({
    id: `db:${db}`,
    label: db,
    icon: "database",
    kind: "database",
    meta: String(entries.length),
    title: `${db}: ${entries.length} ${entries.length === 1 ? "collection" : "collections"} in this backup`,
    children: entries.map((entry) => ({
      id: `ns:${entry.ns}`,
      label: splitNamespace(entry.ns)[1],
      icon: entry.type === "timeseries" ? "timeseries" : "collection",
      kind: "collection",
      meta: formatCompact(entry.documents),
      title: `${entry.ns}: ${formatNumber(entry.documents)} documents, ${formatBytes(entry.bytesRaw)} in the backup`,
    })),
  }));
}

/** Browse documents inside a backup. */
export function DocumentBrowser(props: DocumentBrowserProps) {
  const browsable = props.namespaces.filter((entry) => entry.type !== "view");
  const [ns, setNs] = useState(browsable[0]?.ns ?? "");
  const roots = useMemo(() => namespaceNodes(browsable), [browsable]);

  if (browsable.length === 0) {
    return (
      <EmptyState title="Nothing to browse">
        This backup has no collections with documents.
      </EmptyState>
    );
  }
  const [db] = splitNamespace(ns);
  return (
    <div className="browser-layout browser-layout-embedded">
      <nav className="browser-nav panel" aria-label="Namespaces in the backup">
        <CollectionTree
          label="Databases and collections in the backup"
          roots={roots}
          selectedId={`ns:${ns}`}
          defaultExpanded={[`db:${db}`]}
          onSelect={(node) => setNs(node.id.slice("ns:".length))}
        />
      </nav>
      <div className="browser-main">
        {/* Keyed by namespace: query, paging and selection start fresh per collection. */}
        <NamespaceDocuments
          key={ns}
          {...props}
          entry={browsable.find((entry) => entry.ns === ns) ?? (browsable[0] as ManifestNamespace)}
        />
      </div>
    </div>
  );
}

/** The documents of one namespace of the backup. */
function NamespaceDocuments(props: DocumentBrowserProps & { entry: ManifestNamespace }) {
  const client = useApi();
  const toast = useToast();
  const { hasRole } = useSession();
  const { storageId, backupId, entry } = props;
  const ns = entry.ns;
  // Every backup of a namespace shares its viewer preferences (view, columns, history).
  const scope = `backup:${storageId}:${ns}`;
  const [view, setViewState] = useState<ViewMode>(() => loadPrefs(scope).view ?? "table");
  const [pageSize, setPageSize] = useState<string>("20");
  /** `cursors[n]` is the `after` value for page n; page 0 has none. */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  /** Ticked documents: label → `_id` as Extended JSON. */
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const [canonical, setCanonical] = useState(false);
  const [wantFields, setWantFields] = useState(false);
  const pageIndex = cursors.length - 1;
  const after = cursors[pageIndex];

  /** Starts again from page 1, e.g. after changing the filter. */
  const resetPaging = () => {
    setCursors([undefined]);
    setSelected(new Map());
  };
  const query = useDocumentQuery(scope, { sortAndProjection: false, onApplied: resetPaging });
  const filter = query.applied.filter;
  const setView = (next: ViewMode) => {
    setViewState(next);
    updatePrefs(scope, { view: next });
  };

  const wantCanonical = canonical && view === "json";
  const page = useLoad(
    JSON.stringify([storageId, backupId, ns, filter, pageSize, after, wantCanonical]),
    (signal) =>
      client.call("GET /api/storage/:id/backups/:backupId/documents", undefined, {
        params: { id: storageId, backupId },
        query: {
          ns,
          filter,
          limit: pageSize,
          after,
          ejson: wantCanonical ? "canonical" : undefined,
        },
        signal,
      }),
  );
  const sample = useSample(
    JSON.stringify([storageId, backupId, ns, filter]),
    view === "schema" || view === "chart" || wantFields,
    pacerFor(`backup:${storageId}`),
    (signal) =>
      client.call("GET /api/storage/:id/backups/:backupId/sample", undefined, {
        params: { id: storageId, backupId },
        query: { ns, filter, size: LIVE_SAMPLE_DEFAULT_SIZE },
        signal,
      }),
  );

  const documents = useMemo(
    () => toViewerDocuments(page.data?.documents ?? [], page.data?.canonical),
    [page.data],
  );
  const fields = useMemo(
    () => [
      ...new Set([
        ...columnsOf(documents.map((document) => document.value)),
        ...fieldPaths(sample.summary),
      ]),
    ],
    [documents, sample.summary],
  );

  const selection: ViewerSelection | undefined = hasRole("operator")
    ? {
        isSelected: (document: ViewerDocument) => selected.has(document.label),
        canSelect: (document: ViewerDocument) => document.idJson !== undefined,
        toggle: (document: ViewerDocument) => {
          if (document.idJson === undefined) return;
          const next = new Map(selected);
          if (next.has(document.label)) next.delete(document.label);
          else next.set(document.label, document.idJson);
          setSelected(next);
        },
      }
    : undefined;

  const restoreSelected = () => {
    navigate(`/backups/${segment(storageId)}/${segment(backupId)}/restore`, {
      ns,
      // The selected `_id`s as one Extended JSON array; the wizard turns it into an $in filter.
      ids: `[${[...selected.values()].join(",")}]`,
    });
  };
  const onCopied = (ok: boolean, what: string) =>
    toast.show(
      ok ? "success" : "error",
      ok
        ? `Copied the ${what}.`
        : "The browser refused to copy. Select the text and copy it by hand.",
    );
  const firstNumber = pageIndex * Number(pageSize) + 1;

  return (
    <section className="panel collection-panel" aria-label={`Documents of ${ns}`}>
      <header className="collection-header">
        <div className="collection-heading">
          <h3 className="collection-title">{ns}</h3>
          <span className="badge badge-neutral">Read-only backup</span>
        </div>
        <p className="collection-facts muted">
          {formatNumber(entry.documents)} documents · {formatBytes(entry.bytesRaw)} in the backup
        </p>
      </header>
      <div className="panel-body document-browser">
        <QueryBar
          text={query.text}
          onText={query.setText}
          problems={query.problems}
          onApply={() => void query.apply()}
          onReset={query.reset}
          fields={fields}
          onWantFields={() => setTimeout(() => setWantFields(true), 400)}
          sortAndProjection={false}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          onPageSize={(size) => {
            setPageSize(size);
            resetPaging();
          }}
          history={query.history}
          onHistory={query.applyHistory}
          chips={query.chips}
          onRemoveChip={query.removeChip}
          busy={page.loading}
          onCancel={page.cancel}
        />

        <div className="results-bar">
          <p className="browser-status" aria-live="polite">
            Page {pageIndex + 1} of {ns} · {formatNumber(entry.documents)} documents in the backup
            {filter === undefined ? "" : " · filtered"}
          </p>
          <div className="results-actions">
            {selection === undefined ? null : (
              <Button
                size="small"
                variant="primary"
                disabled={selected.size === 0}
                onClick={restoreSelected}
              >
                Restore selected ({selected.size})
              </Button>
            )}
            <Pager
              page={pageIndex + 1}
              hasPrevious={pageIndex > 0}
              hasNext={page.data?.next !== undefined}
              busy={page.loading}
              onPrevious={() => setCursors(cursors.slice(0, -1))}
              onNext={() => {
                const next = page.data?.next;
                if (next !== undefined) setCursors([...cursors, next]);
              }}
              label="Document pages"
            />
          </div>
        </div>

        {page.error !== undefined ? (
          <ErrorNotice error={page.error} title="Could not read documents" onRetry={page.reload} />
        ) : null}
        {page.error !== undefined && props.encrypted ? (
          <Notice tone="info">
            Encrypted backups can only be browsed when the console stores a matching key (
            {describeError(page.error)}).
          </Notice>
        ) : null}

        <DocumentViewer
          scope={scope}
          view={view}
          onView={setView}
          documents={documents}
          firstNumber={firstNumber}
          loading={page.loading}
          empty={
            <EmptyState title="No documents">
              {filter === undefined ? "This namespace is empty." : "No documents match the filter."}
            </EmptyState>
          }
          onQuickFilter={(quick) => {
            const problem = query.quickFilter(quick);
            if (problem !== undefined) toast.show("error", problem);
          }}
          sample={{
            summary: sample.summary,
            description: describeSample(sample.sample, filter !== undefined),
            loading: sample.loading,
            error: sample.error,
            reload: sample.reload,
          }}
          canonical={{ on: canonical, onToggle: setCanonical }}
          selection={selection}
          onCopied={onCopied}
          toolbar={
            hasRole("operator") ? (
              <ExportButton
                disabled={page.data === undefined}
                run={(choice) =>
                  client.call("GET /api/storage/:id/backups/:backupId/export", undefined, {
                    params: { id: storageId, backupId },
                    query: {
                      ns,
                      filter,
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
      </div>
    </section>
  );
}
