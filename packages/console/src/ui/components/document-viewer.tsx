/**
 * The document viewer: one page of documents in the view the user picks, shared by the
 * live data browser and the backup document browser, so both work the same way.
 *
 *   View as:  Table · Tree · JSON · Cards · Schema · Chart
 *
 * - Table, Tree, JSON and Cards show the documents of the current page; Schema and Chart
 *   show what a sample of the collection says (fields, types, values), with the sample's
 *   size always stated.
 * - The choice of view, the table's columns, the cards' title fields and the chart field
 *   are remembered per collection (view-prefs.ts).
 * - Opening a document (Enter on a row, "Open", double click) shows the detail panel with
 *   Previous / Next.
 * - Clicking a value anywhere offers quick filters; the page turns them into the filter
 *   (`onQuickFilter`). Pages that cannot filter simply leave it out.
 *
 * The page owns the data: it fetches the documents and the sample and passes them in;
 * the viewer only decides how to show them.
 */

import { type ReactNode, useId, useMemo, useState } from "react";
import { columnsOf, MAX_AUTO_COLUMNS } from "../bson.ts";
import type { SchemaSummary } from "../schema.ts";
import { loadPrefs, updatePrefs, type ViewMode } from "../view-prefs.ts";
import type { SortState, ViewerDocument, ViewerSelection } from "../viewer-model.ts";
import { ChartView } from "./chart-view.tsx";
import { ColumnPicker, moveColumnBefore } from "./column-picker.tsx";
import { CopyButton } from "./copy-button.tsx";
import { cardFields, DocumentCards } from "./document-cards.tsx";
import { DocumentDetail } from "./document-detail.tsx";
import { DocumentGrid } from "./document-grid.tsx";
import { DocumentTree } from "./document-tree.tsx";
import { SelectField } from "./field.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { JsonText } from "./json-view.tsx";
import { ErrorNotice } from "./layout.tsx";
import { SchemaView } from "./schema-view.tsx";
import { Skeleton } from "./skeleton.tsx";
import type { QuickFilterHandler } from "./value-menu.tsx";

/** The views in the switcher, with their icon and a one-line explanation (tooltip). */
const VIEWS: readonly { id: ViewMode; label: string; icon: IconName; hint: string }[] = [
  {
    id: "table",
    label: "Table",
    icon: "table",
    hint: "One row per document, one column per field",
  },
  {
    id: "tree",
    label: "Tree",
    icon: "tree",
    hint: "Each document as an expandable tree with types",
  },
  { id: "json", label: "JSON", icon: "json", hint: "Extended JSON text, ready to copy" },
  { id: "cards", label: "Cards", icon: "cards", hint: "A short summary card per document" },
  { id: "schema", label: "Schema", icon: "schema", hint: "Fields, types and values in a sample" },
  { id: "chart", label: "Chart", icon: "chart", hint: "Count documents by a field" },
];

/** The sample behind the schema and chart views, as the page loaded it. */
export interface SampleState {
  readonly summary: SchemaSummary | undefined;
  /** e.g. "a random sample of 200 documents". */
  readonly description: string;
  readonly loading: boolean;
  readonly error: unknown;
  readonly reload: () => void;
}

/** Props for `DocumentViewer`. */
export interface DocumentViewerProps {
  /** Preferences scope: `live:<connection>:<ns>` or `backup:<storage>:<ns>`. */
  readonly scope: string;
  readonly view: ViewMode;
  readonly onView: (view: ViewMode) => void;
  readonly documents: readonly ViewerDocument[];
  /** Row number of the first document (skip + 1). */
  readonly firstNumber: number;
  /** True while the page of documents loads (the old page stays visible, dimmed). */
  readonly loading: boolean;
  /** Shown instead of the documents when the page is empty. */
  readonly empty: ReactNode;
  readonly sort?: SortState | undefined;
  readonly onSort?: ((path: string) => void) | undefined;
  readonly onQuickFilter?: QuickFilterHandler | undefined;
  readonly sample: SampleState;
  /** The JSON view's canonical toggle; the page reloads with canonical text when on. */
  readonly canonical?:
    | { readonly on: boolean; readonly onToggle: (on: boolean) => void }
    | undefined;
  readonly selection?: ViewerSelection | undefined;
  /** The page's actions in the detail panel (edit, duplicate, delete). */
  readonly detailActions?: ((document: ViewerDocument) => ReactNode) | undefined;
  /** Per-document actions in the tree and JSON views' headers. */
  readonly documentActions?: ((document: ViewerDocument) => ReactNode) | undefined;
  /** Buttons at the end of the view bar (export, insert, …). */
  readonly toolbar?: ReactNode;
  readonly onCopied?: ((ok: boolean, what: string) => void) | undefined;
}

/** The viewer (see the file header). */
export function DocumentViewer(props: DocumentViewerProps) {
  const { documents, view } = props;
  const switcherName = useId();
  const [prefs, setPrefs] = useState(() => loadPrefs(props.scope));
  const [detail, setDetail] = useState<number | undefined>(undefined);
  const [wrap, setWrap] = useState(true);

  const savePrefs = (change: Parameters<typeof updatePrefs>[1]) =>
    setPrefs(updatePrefs(props.scope, change));

  // ---- table columns: document order, then the user's order and hidden set ----------------
  const autoColumns = useMemo(
    () => columnsOf(documents.map((document) => document.value)),
    [documents],
  );
  const order = prefs.columns?.order ?? [];
  const ordered = [
    ...order.filter((path) => autoColumns.includes(path)),
    ...autoColumns.filter((path) => !order.includes(path)),
  ];
  // Without saved choices, very wide documents start with the first columns only.
  const hidden = new Set(
    prefs.columns === undefined ? ordered.slice(MAX_AUTO_COLUMNS) : prefs.columns.hidden,
  );
  const visibleColumns = ordered.filter((path) => !hidden.has(path));
  const widths = prefs.columns?.widths ?? {};
  const saveColumns = (next: {
    order?: readonly string[];
    hidden?: ReadonlySet<string>;
    widths?: Readonly<Record<string, number>>;
  }) =>
    savePrefs({
      columns: {
        order: next.order ?? ordered,
        hidden: [...(next.hidden ?? hidden)],
        widths: next.widths ?? widths,
      },
    });

  const cards = cardFields(documents, {
    title: prefs.cardTitle,
    subtitle: prefs.cardSubtitle === NO_SUBTITLE ? null : prefs.cardSubtitle,
  });
  const sampleView = view === "schema" || view === "chart";

  /** The body of the chosen view. */
  const body = (): ReactNode => {
    if (sampleView) {
      const { sample } = props;
      if (sample.error !== undefined) {
        return (
          <ErrorNotice
            error={sample.error}
            title="Could not read a sample"
            onRetry={sample.reload}
          />
        );
      }
      if (sample.summary === undefined)
        return <Skeleton label="Reading a sample of the documents…" />;
      if (sample.summary.sampleSize === 0) return props.empty;
      return view === "schema" ? (
        <SchemaView
          summary={sample.summary}
          sampleDescription={sample.description}
          onQuickFilter={props.onQuickFilter}
          onResample={sample.reload}
          resampling={sample.loading}
        />
      ) : (
        <ChartView
          summary={sample.summary}
          sampleDescription={sample.description}
          field={prefs.chartField}
          onField={(chartField) => savePrefs({ chartField })}
          onQuickFilter={props.onQuickFilter}
        />
      );
    }
    if (documents.length === 0) {
      return props.loading ? <Skeleton label="Reading documents…" /> : props.empty;
    }
    switch (view) {
      case "table":
        return (
          <DocumentGrid
            documents={documents}
            firstNumber={props.firstNumber}
            columns={visibleColumns}
            widths={widths}
            onResize={(path, width) => saveColumns({ widths: { ...widths, [path]: width } })}
            onReorder={(path, before) =>
              saveColumns({ order: moveColumnBefore(ordered, path, before) })
            }
            sort={props.sort}
            onSort={props.onSort}
            onOpen={setDetail}
            onQuickFilter={props.onQuickFilter}
            selection={props.selection}
            onCopied={props.onCopied}
            caption="Documents"
          />
        );
      case "cards":
        return (
          <DocumentCards
            documents={documents}
            firstNumber={props.firstNumber}
            titleField={cards.title}
            subtitleField={cards.subtitle}
            onOpen={setDetail}
            onQuickFilter={props.onQuickFilter}
            selection={props.selection}
            onCopied={props.onCopied}
          />
        );
      default:
        return (
          <ol className="doc-blocks" aria-label="Documents">
            {documents.map((document, index) => (
              <li key={document.key} className="doc-block">
                <DocumentBlockHeader
                  document={document}
                  number={props.firstNumber + index}
                  onOpen={() => setDetail(index)}
                  selection={props.selection}
                  actions={props.documentActions}
                  extra={
                    view === "json" ? (
                      <CopyButton
                        text={displayedJson(document, props.canonical?.on === true)}
                        label="Copy"
                        iconOnly
                        ariaLabel={`Copy document ${document.label}`}
                      />
                    ) : null
                  }
                />
                {view === "json" || document.value === undefined ? (
                  <JsonText
                    text={displayedJson(document, props.canonical?.on === true)}
                    wrap={wrap}
                    label={`Extended JSON of ${document.label}`}
                  />
                ) : (
                  <DocumentTree
                    value={document.value}
                    label={`Document ${document.label}`}
                    onQuickFilter={props.onQuickFilter}
                    onCopied={props.onCopied}
                  />
                )}
              </li>
            ))}
          </ol>
        );
    }
  };

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <fieldset className="view-switch">
          <legend className="visually-hidden">View as</legend>
          {VIEWS.map((option) => (
            <label key={option.id} className="view-option" title={option.hint}>
              <input
                type="radio"
                name={switcherName}
                value={option.id}
                checked={view === option.id}
                onChange={() => props.onView(option.id)}
              />
              <Icon name={option.icon} size={14} />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="viewer-tools">
          {view === "table" && autoColumns.length > 0 ? (
            <ColumnPicker
              columns={ordered}
              hidden={hidden}
              onChange={(nextOrder, nextHidden) =>
                saveColumns({ order: nextOrder, hidden: nextHidden })
              }
              onReset={() => savePrefs({ columns: { order: [], hidden: [], widths: {} } })}
            />
          ) : null}
          {view === "cards" && autoColumns.length > 0 ? (
            <CardFieldPickers
              columns={autoColumns}
              title={cards.title}
              subtitle={cards.subtitle}
              onChange={(cardTitle, cardSubtitle) =>
                savePrefs({
                  cardTitle,
                  // An empty choice means "no subtitle"; stored as a marker so it sticks.
                  cardSubtitle: cardSubtitle ?? NO_SUBTITLE,
                })
              }
            />
          ) : null}
          {view === "json" ? (
            <>
              <label className="toggle">
                <input
                  type="checkbox"
                  className="checkbox"
                  checked={wrap}
                  onChange={(event) => setWrap(event.currentTarget.checked)}
                />
                Wrap lines
              </label>
              {props.canonical === undefined ? null : (
                <label
                  className="toggle"
                  title={'Canonical Extended JSON names every BSON type, e.g. {"$numberInt": "42"}'}
                >
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={props.canonical.on}
                    onChange={(event) => props.canonical?.onToggle(event.currentTarget.checked)}
                  />
                  Canonical
                </label>
              )}
              <CopyButton
                text={() =>
                  `[\n${documents.map((document) => displayedJson(document, props.canonical?.on === true)).join(",\n")}\n]`
                }
                label="Copy page"
                ariaLabel="Copy every document of this page as a JSON array"
              />
            </>
          ) : null}
          {props.toolbar}
        </div>
      </div>

      <div
        className={
          props.loading && documents.length > 0 && !sampleView
            ? "viewer-body viewer-busy"
            : "viewer-body"
        }
        aria-busy={props.loading}
      >
        {body()}
      </div>

      {detail === undefined ? null : (
        <DocumentDetail
          documents={documents}
          index={Math.min(detail, Math.max(0, documents.length - 1))}
          onIndex={setDetail}
          onClose={() => setDetail(undefined)}
          firstNumber={props.firstNumber}
          actions={props.detailActions}
          onQuickFilter={props.onQuickFilter}
          onCopied={props.onCopied}
        />
      )}
    </div>
  );
}

/** Stored as the subtitle when the user chose "none", so the guess does not come back. */
const NO_SUBTITLE = "\u0000none";

/** The relaxed or (when loaded and asked for) canonical text of a document. */
function displayedJson(document: ViewerDocument, canonical: boolean): string {
  return canonical && document.canonical !== undefined ? document.canonical : document.text;
}

/** The header of one document in the tree and JSON views. */
function DocumentBlockHeader(props: {
  document: ViewerDocument;
  number: number;
  onOpen: () => void;
  selection?: ViewerSelection | undefined;
  actions?: ((document: ViewerDocument) => ReactNode) | undefined;
  extra?: ReactNode;
}) {
  const { document, selection } = props;
  return (
    <div className="doc-block-head">
      {selection === undefined ? null : (
        <input
          type="checkbox"
          className="checkbox"
          checked={selection.isSelected(document)}
          disabled={!selection.canSelect(document)}
          aria-label={`Select document ${document.label}`}
          onChange={() => selection.toggle(document)}
        />
      )}
      <span className="doc-block-number" aria-hidden="true">
        {props.number}
      </span>
      <span className="mono doc-block-label">{document.label}</span>
      <span className="doc-block-actions">
        {props.extra}
        {props.actions?.(document)}
        <button
          type="button"
          className="button button-ghost button-small"
          onClick={props.onOpen}
          aria-label={`Open document ${document.label}`}
        >
          Open
          <Icon name="open" size={12} />
        </button>
      </span>
    </div>
  );
}

/** The cards view's "Title" and "Subtitle" field choices. */
function CardFieldPickers(props: {
  columns: readonly string[];
  title: string;
  subtitle: string | undefined;
  onChange: (title: string, subtitle: string | undefined) => void;
}) {
  const options = props.columns.map((path) => ({ value: path, label: path }));
  const subtitle = props.subtitle ?? "";
  return (
    <div className="card-pickers">
      <SelectField
        label="Title"
        value={props.title}
        options={options}
        onValue={(title) => props.onChange(title, props.subtitle)}
        className="field-inline"
      />
      <SelectField
        label="Subtitle"
        value={subtitle}
        options={[{ value: "", label: "(none)" }, ...options]}
        onValue={(value) => props.onChange(props.title, value === "" ? undefined : value)}
        className="field-inline"
      />
    </div>
  );
}
