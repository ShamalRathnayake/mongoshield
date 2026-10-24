/**
 * The document browser: read-only paging through the documents of one namespace inside
 * a backup (`GET …/documents`, which uses the library's `findInBackup`).
 *
 * - The filter box takes an Extended JSON query; it is validated in the browser before
 *   any request (ejson.ts), with the problem shown under the box.
 * - Paging is cursor based: the server returns `next`, and the browser keeps the
 *   cursors of earlier pages so "Previous" works without the server going backwards.
 * - Documents render as collapsible trees. Selecting documents and choosing "Restore
 *   selected" opens the restore wizard limited to those `_id`s.
 */

import { type FormEvent, useState } from "react";
import { describeError } from "../api.ts";
import { Button } from "../components/button.tsx";
import { EjsonTree } from "../components/code-block.tsx";
import { SelectField, TextAreaField } from "../components/field.tsx";
import { EmptyState, ErrorNotice, Loading, Notice } from "../components/layout.tsx";
import { useApi, useLoad, useSession } from "../context.tsx";
import {
  checkFilter,
  documentIdLabel,
  isJsonObject,
  type JsonValue,
  parseDocument,
} from "../ejson.ts";
import { formatNumber } from "../format.ts";
import type { ManifestNamespace } from "../manifest.ts";
import { navigate, segment } from "../router.ts";

/** Page sizes offered; the API allows at most 100. */
const PAGE_SIZES = ["20", "50", "100"] as const;
type PageSize = (typeof PAGE_SIZES)[number];

/** Props for `DocumentBrowser`. */
export interface DocumentBrowserProps {
  readonly storageId: string;
  readonly backupId: string;
  /** Namespaces in the backup (views are skipped: they hold no documents). */
  readonly namespaces: readonly ManifestNamespace[];
  /** Encrypted backups need a key on the server; shown as a hint when browsing fails. */
  readonly encrypted: boolean;
}

/** A parsed document plus the JSON of its `_id`, used for selection. */
interface BrowsedDocument {
  readonly raw: string;
  readonly value: JsonValue | undefined;
  readonly idLabel: string;
  /** Extended JSON of the `_id`, or undefined when the document has none. */
  readonly idJson: string | undefined;
}

function toBrowsed(raw: string): BrowsedDocument {
  const value = parseDocument(raw);
  const id = value !== undefined && isJsonObject(value) ? value._id : undefined;
  return {
    raw,
    value,
    idLabel: documentIdLabel(value),
    idJson: id === undefined ? undefined : JSON.stringify(id),
  };
}

/** Browse documents inside a backup. */
export function DocumentBrowser(props: DocumentBrowserProps) {
  const client = useApi();
  const { hasRole } = useSession();
  const browsable = props.namespaces.filter((entry) => entry.type !== "view");
  const [ns, setNs] = useState(browsable[0]?.ns ?? "");
  const [filterText, setFilterText] = useState("");
  const [filterError, setFilterError] = useState<string | undefined>(undefined);
  const [appliedFilter, setAppliedFilter] = useState<string | undefined>(undefined);
  const [pageSize, setPageSize] = useState<PageSize>("20");
  /** `cursors[n]` is the `after` value for page n; page 0 has none. */
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const pageIndex = cursors.length - 1;
  const after = cursors[pageIndex];

  const page = useLoad(
    ns === ""
      ? ""
      : JSON.stringify([props.storageId, props.backupId, ns, appliedFilter, pageSize, after]),
    (signal) =>
      client.call("GET /api/storage/:id/backups/:backupId/documents", undefined, {
        params: { id: props.storageId, backupId: props.backupId },
        query: { ns, filter: appliedFilter, limit: pageSize, after },
        signal,
      }),
  );

  /** Starts again from page 1, e.g. after changing the namespace or filter. */
  const resetPaging = () => {
    setCursors([undefined]);
    setSelected(new Map());
  };

  const applyFilter = (event: FormEvent) => {
    event.preventDefault();
    const result = checkFilter(filterText);
    if (!result.ok) {
      setFilterError(result.message);
      return;
    }
    setFilterError(undefined);
    setAppliedFilter(result.filter);
    resetPaging();
  };

  const toggle = (document: BrowsedDocument) => {
    if (document.idJson === undefined) return;
    const next = new Map(selected);
    if (next.has(document.idLabel)) next.delete(document.idLabel);
    else next.set(document.idLabel, document.idJson);
    setSelected(next);
  };

  const restoreSelected = () => {
    navigate(`/backups/${segment(props.storageId)}/${segment(props.backupId)}/restore`, {
      ns,
      // The selected `_id`s as one Extended JSON array; the wizard turns it into an $in filter.
      ids: `[${[...selected.values()].join(",")}]`,
    });
  };

  if (browsable.length === 0) {
    return (
      <EmptyState title="Nothing to browse">
        This backup has no collections with documents.
      </EmptyState>
    );
  }
  const documents = (page.data?.documents ?? []).map(toBrowsed);
  const namespaceInfo = browsable.find((entry) => entry.ns === ns);

  return (
    <div className="document-browser">
      <form className="browser-controls" onSubmit={applyFilter} noValidate>
        <SelectField
          label="Namespace"
          value={ns}
          options={browsable.map((entry) => ({
            value: entry.ns,
            label: `${entry.ns} (${formatNumber(entry.documents)})`,
          }))}
          onValue={(value) => {
            setNs(value);
            resetPaging();
          }}
        />
        <TextAreaField
          label="Filter (Extended JSON)"
          className="browser-filter"
          value={filterText}
          onValue={setFilterText}
          rows={2}
          spellCheck={false}
          placeholder='{"status": "paid", "userId": {"$oid": "65f…"}}'
          hint={
            'Read-only query on the backup. Use Extended JSON for types, e.g. {"$oid": "…"} or {"$date": "…"}.'
          }
          error={filterError}
        />
        <SelectField<PageSize>
          label="Per page"
          value={pageSize}
          options={PAGE_SIZES.map((size) => ({ value: size, label: size }))}
          onValue={(value) => {
            setPageSize(value);
            resetPaging();
          }}
        />
        <div className="browser-buttons">
          <Button type="submit" variant="primary">
            Apply filter
          </Button>
          {appliedFilter === undefined ? null : (
            <Button
              onClick={() => {
                setFilterText("");
                setFilterError(undefined);
                setAppliedFilter(undefined);
                resetPaging();
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </form>

      <div className="browser-status" aria-live="polite">
        <span>
          Page {pageIndex + 1}
          {namespaceInfo === undefined
            ? ""
            : ` of ${ns} · ${formatNumber(namespaceInfo.documents)} documents in the backup`}
          {appliedFilter === undefined ? "" : " · filtered"}
        </span>
        {hasRole("operator") ? (
          <Button
            size="small"
            variant="primary"
            disabled={selected.size === 0}
            onClick={restoreSelected}
          >
            Restore selected ({selected.size})
          </Button>
        ) : null}
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
      {page.loading ? <Loading label="Reading documents from the backup…" /> : null}
      {!page.loading && page.data !== undefined && documents.length === 0 ? (
        <EmptyState title="No documents">
          {appliedFilter === undefined
            ? "This namespace is empty."
            : "No documents match the filter."}
        </EmptyState>
      ) : null}

      <ol className="document-list" aria-label={`Documents on page ${pageIndex + 1}`}>
        {documents.map((document) => (
          <li key={document.idLabel + document.raw.length} className="document-card">
            <label className="document-select">
              <input
                type="checkbox"
                className="checkbox"
                checked={selected.has(document.idLabel)}
                disabled={document.idJson === undefined}
                onChange={() => toggle(document)}
              />
              <span className="mono">{document.idLabel}</span>
            </label>
            {document.value === undefined ? (
              <pre className="mono">{document.raw}</pre>
            ) : (
              <EjsonTree value={document.value} />
            )}
          </li>
        ))}
      </ol>

      <nav className="pager" aria-label="Document pages">
        <Button
          disabled={pageIndex === 0 || page.loading}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          Previous page
        </Button>
        <span className="numeric">Page {pageIndex + 1}</span>
        <Button
          disabled={page.data?.next === undefined || page.loading}
          onClick={() => {
            const next = page.data?.next;
            if (next !== undefined) setCursors([...cursors, next]);
          }}
        >
          Next page
        </Button>
      </nav>
    </div>
  );
}
