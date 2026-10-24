/**
 * The document detail panel: one document in a panel on the right, with every way to
 * look at it, so a single record can be read in full without leaving the list.
 *
 * - Tree: the expandable tree with types, copy and quick filters (document-tree.tsx).
 * - JSON: the Extended JSON text (canonical too, when the page loaded it) with copy.
 * - Fields: every field path with its type and value in a plain table.
 * - "Previous" / "Next" (or the [ and ] keys) step through the documents of the page;
 *   the panel stays open, so a page can be read record by record.
 * - "Copy as JSON" copies the relaxed Extended JSON; `actions` adds the page's own
 *   buttons (the live data browser's Edit / Duplicate / Delete, when allowed).
 *
 * It is a modal dialog (focus stays inside, Escape closes, focus returns to the row).
 */

import { type KeyboardEvent, type ReactNode, useState } from "react";
import { bsonTypeOf, flattenDocument, isPlainObject } from "../bson.ts";
import { formatNumber } from "../format.ts";
import type { ViewerDocument } from "../viewer-model.ts";
import { BsonValue, TypeBadge } from "./bson-value.tsx";
import { Button } from "./button.tsx";
import { CopyButton } from "./copy-button.tsx";
import { Dialog } from "./dialog.tsx";
import { DocumentTree } from "./document-tree.tsx";
import { Icon } from "./icons.tsx";
import { JsonText } from "./json-view.tsx";
import { Tabs } from "./layout.tsx";
import type { QuickFilterHandler } from "./value-menu.tsx";

/** The panel's tabs. */
type DetailTab = "tree" | "json" | "fields";

/** Props for `DocumentDetail`. */
export interface DocumentDetailProps {
  readonly documents: readonly ViewerDocument[];
  /** The open document's index in `documents`. */
  readonly index: number;
  readonly onIndex: (index: number) => void;
  readonly onClose: () => void;
  /** Row number of the first document (skip + 1), for "Document 21 of …". */
  readonly firstNumber: number;
  /** The page's own actions for this document (edit, delete, …). */
  readonly actions?: ((document: ViewerDocument) => ReactNode) | undefined;
  /** Quick filters: the panel closes and the filter is applied. */
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
}

/** The detail panel (see the file header). */
export function DocumentDetail(props: DocumentDetailProps) {
  const [tab, setTab] = useState<DetailTab>("tree");
  const [canonical, setCanonical] = useState(false);
  const { documents, index } = props;
  const document = documents[index];
  if (document === undefined) return null;
  const hasPrevious = index > 0;
  const hasNext = index < documents.length - 1;

  /** [ and ] step through the documents, anywhere in the panel except text fields. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select") !== null) return;
    if (event.key === "[" && hasPrevious) props.onIndex(index - 1);
    else if (event.key === "]" && hasNext) props.onIndex(index + 1);
  };

  const quickFilter =
    props.onQuickFilter === undefined
      ? undefined
      : (filter: Parameters<QuickFilterHandler>[0]) => {
          props.onClose();
          props.onQuickFilter?.(filter);
        };

  const jsonText =
    canonical && document.canonical !== undefined ? document.canonical : document.text;

  return (
    <Dialog
      open
      size="drawer"
      title={
        <span className="detail-title">
          <span className="mono">{document.label}</span>
        </span>
      }
      description={`Document ${formatNumber(props.firstNumber + index)} on this page (${formatNumber(index + 1)} of ${formatNumber(documents.length)}).`}
      onClose={props.onClose}
      onKeyDown={onKeyDown}
      footer={
        <div className="detail-footer">
          <div className="detail-nav">
            <Button
              size="small"
              disabled={!hasPrevious}
              onClick={() => props.onIndex(index - 1)}
              title="Previous document ([)"
            >
              <Icon name="chevronLeft" size={14} />
              Previous
            </Button>
            <Button
              size="small"
              disabled={!hasNext}
              onClick={() => props.onIndex(index + 1)}
              title="Next document (])"
            >
              Next
              <Icon name="chevronRight" size={14} />
            </Button>
          </div>
          <div className="detail-actions">
            <CopyButton text={document.text} label="Copy as JSON" size="small" />
            {props.actions?.(document)}
          </div>
        </div>
      }
    >
      <div className="detail-body">
        {document.value === undefined ? (
          <pre className="json-text json-wrap">{document.text}</pre>
        ) : (
          <Tabs
            label="Document views"
            idPrefix="detail-tab"
            tabs={[
              { id: "tree", label: "Tree" },
              { id: "json", label: "JSON" },
              { id: "fields", label: "Fields" },
            ]}
            selected={tab}
            onSelect={(id) => setTab(id as DetailTab)}
          >
            {tab === "tree" ? (
              <DocumentTree
                // A new document starts with a fresh tree (open levels, focus).
                key={document.key}
                value={document.value}
                label={`Fields of ${document.label}`}
                openDepth={2}
                onQuickFilter={quickFilter}
                onCopied={props.onCopied}
              />
            ) : tab === "json" ? (
              <div className="detail-json">
                {document.canonical === undefined ? null : (
                  <label className="toggle">
                    <input
                      type="checkbox"
                      className="checkbox"
                      checked={canonical}
                      onChange={(event) => setCanonical(event.currentTarget.checked)}
                    />
                    Canonical Extended JSON (every type explicit)
                  </label>
                )}
                <JsonText text={jsonText} wrap label={`Extended JSON of ${document.label}`} />
              </div>
            ) : (
              <FieldsTable document={document} />
            )}
          </Tabs>
        )}
      </div>
    </Dialog>
  );
}

/** Every field path of a document with its type and value. */
function FieldsTable(props: { document: ViewerDocument }) {
  const value = props.document.value;
  const fields = value !== undefined && isPlainObject(value) ? flattenDocument(value, 8) : [];
  return (
    <div className="table-wrapper">
      <table className="table table-compact">
        <caption className="visually-hidden">Fields of {props.document.label}</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Type</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {fields.map(([path, field]) => (
            <tr key={path}>
              <td className="mono">{path}</td>
              <td>
                <TypeBadge type={bsonTypeOf(field)} />
              </td>
              <td className="detail-field-value">
                <BsonValue value={field} full />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
