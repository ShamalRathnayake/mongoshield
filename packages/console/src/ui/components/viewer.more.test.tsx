/**
 * More component tests for the document browsers: the schema and chart views (statistics,
 * click-to-filter), the navigation tree (search, keyboard, lazy states), the column
 * picker, the query bar (suggestions, pickers, history, chips, cancel), the export button
 * and the viewer shell (switching views, remembered columns, JSON options, sample states).
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState as useStateValue } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportResult } from "../../shared/api.ts";
import { analyzeSchema } from "../schema.ts";
import { loadPrefs } from "../view-prefs.ts";
import { toViewerDocuments } from "../viewer-model.ts";
import { ChartView, chartableFields } from "./chart-view.tsx";
import { CollectionTree, type CollectionTreeNode } from "./collection-tree.tsx";
import { ColumnPicker, moveColumn, moveColumnBefore } from "./column-picker.tsx";
import { DocumentViewer, type DocumentViewerProps } from "./document-viewer.tsx";
import { downloadFile, ExportButton } from "./export-button.tsx";
import { QueryBar, type QueryBarProps, type QueryText } from "./query-bar.tsx";
import { binFilter, boundLabel, boundValue, percent, SchemaView } from "./schema-view.tsx";

// Vitest runs without globals, so Testing Library's own cleanup is not registered.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/** A small sample: statuses, totals, dates and a nested field. */
const SAMPLE = [
  {
    _id: 1,
    status: "paid",
    total: 10,
    at: { $date: "2026-01-01T00:00:00.000Z" },
    address: { city: "Colombo" },
  },
  {
    _id: 2,
    status: "paid",
    total: 20,
    at: { $date: "2026-01-02T00:00:00.000Z" },
    address: { city: "Berlin" },
  },
  { _id: 3, status: "open", total: 35.5, at: { $date: "2026-01-09T00:00:00.000Z" } },
  { _id: 4, status: "open", total: null },
];
const SUMMARY = analyzeSchema(SAMPLE);

describe("SchemaView", () => {
  it("shows presence, types and values per field, and builds filters from clicks", async () => {
    const user = userEvent.setup();
    const onQuickFilter = vi.fn();
    const onResample = vi.fn();
    render(
      <SchemaView
        summary={SUMMARY}
        sampleDescription="a random sample of 4 documents"
        onQuickFilter={onQuickFilter}
        onResample={onResample}
      />,
    );
    expect(screen.getByText(/fields in a random sample of 4 documents/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Fields of the sample" });
    const total = within(table).getByRole("row", { name: /^total/ });
    expect(within(total).getByText("100%")).toBeTruthy();
    expect(within(total).getByRole("list", { name: "Types of total" }).textContent).toContain(
      "Number 75%",
    );
    const city = within(table).getByRole("row", { name: /address\.city/ });
    expect(within(city).getByText("50%")).toBeTruthy();

    await user.click(within(table).getByRole("button", { name: "status" }));
    expect(onQuickFilter).toHaveBeenLastCalledWith({ path: "status", op: "exists" });
    await user.click(within(table).getByRole("button", { name: /^paid/ }));
    expect(onQuickFilter).toHaveBeenLastCalledWith({ path: "status", op: "equals", value: "paid" });
    // A histogram bar filters on its range; the last bar includes the maximum.
    const bars = within(total).getAllByRole("button", { name: /Filter on this range/ });
    await user.click(bars[bars.length - 1] as HTMLElement);
    expect(onQuickFilter).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "total", op: "range", to: 35.5, inclusive: true }),
    );
    await user.click(screen.getByRole("button", { name: "Sample again" }));
    expect(onResample).toHaveBeenCalled();
  });

  it("is read-only without quick filters, and formats bounds", () => {
    render(<SchemaView summary={SUMMARY} sampleDescription="the first 4 documents" resampling />);
    expect(screen.queryByRole("button", { name: "status" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Filter on this range/ })).toBeNull();
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0.5)).toBe("50%");
    expect(boundLabel("number", 10, 1)).toBe("10");
    expect(boundLabel("number", 1.23456, 1)).toBe("1.235");
    expect(boundLabel("date", Date.parse("2026-01-01T10:30:00Z"), 1000)).toBe("2026-01-01 10:30");
    expect(boundLabel("date", Date.parse("2026-01-01T10:30:00Z"), 1e12)).toBe("2026-01-01");
    expect(boundValue("date", 0)).toEqual({ $date: "1970-01-01T00:00:00.000Z" });
    const range = SUMMARY.fields.find((field) => field.path === "at")?.range;
    if (range === undefined) throw new Error("no range");
    expect(binFilter("at", range, 0)).toMatchObject({ op: "range", inclusive: false });
  });
});

describe("ChartView", () => {
  it("charts a few-valued field as bars by default, and filters from a bar", async () => {
    const user = userEvent.setup();
    const onQuickFilter = vi.fn();
    const onField = vi.fn();
    render(
      <ChartView
        summary={SUMMARY}
        sampleDescription="a sample"
        field={undefined}
        onField={onField}
        onQuickFilter={onQuickFilter}
      />,
    );
    expect(screen.getByRole("heading", { name: /Documents by status/ })).toBeTruthy();
    const bars = screen.getByRole("list", { name: "Documents by status" });
    expect(within(bars).getAllByRole("listitem")).toHaveLength(2);
    await user.click(within(bars).getByRole("button", { name: /^status open: 2 \(50%\)/ }));
    expect(onQuickFilter).toHaveBeenCalledWith({ path: "status", op: "equals", value: "open" });
    await user.selectOptions(screen.getByLabelText("Field"), "at");
    expect(onField).toHaveBeenCalledWith("at");
  });

  it("says what kind of chart each field makes in the Field select", () => {
    // One field per kind: a few values (one of them alone), numbers, dates.
    const summary = analyzeSchema(
      Array.from({ length: 20 }, (_, index) => ({
        status: index % 2 === 0 ? "open" : "paid",
        kind: "order",
        total: index * 1.5,
        at: { $date: new Date(Date.UTC(2026, 0, index + 1)).toISOString() },
      })),
    );
    render(
      <ChartView
        summary={summary}
        sampleDescription="a sample"
        field={undefined}
        onField={vi.fn()}
      />,
    );
    const labels = within(screen.getByLabelText("Field"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(labels).toEqual([
      "status · 2 values",
      "kind · 1 value",
      "total · numbers",
      "at · dates",
    ]);
  });

  it("charts numbers and dates as a histogram with counts, and says when nothing fits", () => {
    // Twenty different days: too many values for bars, so a histogram.
    const days = analyzeSchema(
      Array.from({ length: 20 }, (_, day) => ({
        at: { $date: new Date(Date.UTC(2026, 0, day + 1)).toISOString() },
      })),
    );
    const { rerender } = render(
      <ChartView summary={days} sampleDescription="a sample" field="at" onField={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: /Distribution of at/ })).toBeTruthy();
    const figure = screen.getByRole("figure", { name: "Distribution of at" });
    expect(within(figure).getByText("2026-01-01")).toBeTruthy();
    expect(within(figure).getAllByText(/^\d+$/).length).toBeGreaterThan(0);
    rerender(
      <ChartView
        summary={analyzeSchema([
          { _id: 1, payload: {} },
          { _id: 2, payload: {} },
        ])}
        sampleDescription="a sample"
        field={undefined}
        onField={vi.fn()}
      />,
    );
    expect(screen.getByText("Nothing to chart")).toBeTruthy();
    // Few-valued fields come first among the chartable ones.
    expect(chartableFields(SUMMARY).map((field) => field.path)[0]).toBe("status");
  });
});

describe("CollectionTree", () => {
  const roots: CollectionTreeNode[] = [
    {
      id: "conn:a",
      label: "Staging",
      icon: "server",
      kind: "connection",
      children: [
        {
          id: "db:a:shop",
          label: "shop",
          icon: "database",
          kind: "database",
          meta: "2",
          children: [
            {
              id: "ns:a:shop.orders",
              label: "orders",
              icon: "collection",
              kind: "collection",
              meta: "25K",
            },
            {
              id: "ns:a:shop.audit",
              label: "audit",
              icon: "capped",
              kind: "collection",
              note: "capped",
            },
          ],
        },
      ],
    },
    { id: "conn:b", label: "Other", icon: "server", kind: "connection", loading: true },
    {
      id: "conn:c",
      label: "Broken",
      icon: "server",
      kind: "connection",
      error: "Refused",
      children: [],
    },
  ];

  it("filters collections by name, opening their databases and marking the match", async () => {
    const user = userEvent.setup();
    render(<CollectionTree label="Collections" roots={roots} />);
    expect(screen.queryByRole("treeitem", { name: /^orders/ })).toBeNull();
    await user.type(screen.getByLabelText("Find a collection"), "ORD");
    const match = screen.getByRole("treeitem", { name: /^orders/ });
    expect(match.querySelector("mark")?.textContent).toBe("ord");
    expect(screen.queryByRole("treeitem", { name: /^audit/ })).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toMatch(/^Staging/);
    await user.clear(screen.getByLabelText("Find a collection"));
    await user.type(screen.getByLabelText("Find a collection"), "zzz");
    expect(screen.getByText("No collection matches “zzz”.")).toBeTruthy();
  });

  it("moves, opens and closes with the keyboard, and selects collections", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <CollectionTree
        label="Collections"
        roots={roots}
        defaultExpanded={["conn:a"]}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );
    const staging = screen.getByRole("treeitem", { name: /^Staging/ });
    staging.focus();
    await user.keyboard("{ArrowDown}");
    const shop = screen.getByRole("treeitem", { name: /^shop/ });
    expect(document.activeElement).toBe(shop);
    await user.keyboard("{ArrowRight}");
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "db:a:shop" }), true);
    await user.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "ns:a:shop.audit" }));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(shop);
    await user.keyboard("{ArrowLeft}");
    expect(shop.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{End}");
    expect(document.activeElement?.textContent).toMatch(/^Broken/);
    await user.click(screen.getByRole("treeitem", { name: /^Other/ }));
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "conn:b" }), true);
    expect(screen.getByRole("treeitem", { name: /^Other/ }).textContent).toContain("Loading…");
    expect(screen.getByRole("treeitem", { name: /^Broken/ }).getAttribute("title")).toBe("Refused");
  });

  it("says when there is nothing at all", () => {
    render(<CollectionTree label="Collections" roots={[]} empty="No connections." />);
    expect(screen.getByText("No connections.")).toBeTruthy();
  });
});

describe("ColumnPicker", () => {
  it("hides, shows, moves and resets columns", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onReset = vi.fn();
    render(
      <ColumnPicker
        columns={["_id", "a", "b"]}
        hidden={new Set(["b"])}
        onChange={onChange}
        onReset={onReset}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Columns (2/3)" }));
    const picker = screen.getByRole("dialog", { name: "Columns" });
    await user.click(within(picker).getByRole("checkbox", { name: "a" }));
    /** The hidden set of the last change. */
    const lastHidden = () => [...((onChange.mock.lastCall?.[1] as Set<string> | undefined) ?? [])];
    expect(lastHidden().sort()).toEqual(["a", "b"]);
    await user.click(within(picker).getByRole("checkbox", { name: "b" }));
    expect(lastHidden()).toEqual([]);
    await user.click(within(picker).getByRole("button", { name: "Move a up" }));
    expect(onChange.mock.lastCall?.[0]).toEqual(["a", "_id", "b"]);
    await user.click(within(picker).getByRole("button", { name: "Move a down" }));
    expect(onChange.mock.lastCall?.[0]).toEqual(["_id", "b", "a"]);
    // While searching, the list is filtered and moving is off.
    await user.type(within(picker).getByLabelText("Find a column"), "zz");
    expect(within(picker).getByText("No matching columns.")).toBeTruthy();
    await user.click(within(picker).getByRole("button", { name: "Reset columns" }));
    expect(onReset).toHaveBeenCalled();
    expect(moveColumn(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveColumnBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveColumnBefore(["a", "b"], "a", "missing")).toEqual(["b", "a"]);
  });
});

describe("QueryBar", () => {
  /** A query bar that keeps its own text, like the pages do. */
  function Harness(props: Partial<QueryBarProps> & { initial?: QueryText }) {
    const [text, setText] = useStateValue(
      props.initial ?? { filter: "", projection: "", sort: "" },
    );
    return (
      <QueryBar
        text={text}
        onText={setText}
        problems={{}}
        onApply={vi.fn()}
        onReset={vi.fn()}
        fields={["plan", "planCode", "address.city", "_id"]}
        sortAndProjection
        pageSize="20"
        pageSizes={["20", "50"]}
        onPageSize={vi.fn()}
        history={[]}
        onHistory={vi.fn()}
        chips={[]}
        onRemoveChip={vi.fn()}
        busy={false}
        {...props}
      />
    );
  }

  it("suggests field names while typing a key, accepted with Enter or a click", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onWantFields = vi.fn();
    render(<Harness onApply={onApply} onWantFields={onWantFields} />);
    const filter = screen.getByRole("combobox", { name: "Filter (Extended JSON)" });
    await user.click(filter);
    expect(onWantFields).toHaveBeenCalled();
    await user.type(filter, '{{"pl');
    const list = screen.getByRole("listbox", { name: "Matching field names" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["plan", "planCode"]);
    expect(filter.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowDown}{ArrowUp}{ArrowDown}");
    expect(filter.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    await user.keyboard("{Enter}");
    expect((filter as HTMLInputElement).value).toBe('{"planCode": ');
    expect(onApply).not.toHaveBeenCalled();
    // With no list open, Enter applies the query.
    await user.type(filter, '"x"}');
    await user.keyboard("{Enter}");
    expect(onApply).toHaveBeenCalledTimes(1);
    // Escape closes the list without touching the text; a click accepts a suggestion.
    await user.clear(filter);
    await user.type(filter, '{{"addr');
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(filter, "e");
    fireEvent.mouseDown(
      within(screen.getByRole("listbox", { name: "Matching field names" })).getByRole("option", {
        name: "address.city",
      }),
    );
    expect((filter as HTMLInputElement).value).toBe('{"address.city": ');
    await user.tab();
  });

  it("picks a sort and the fields to show", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ filter: "", projection: '{"plan": 1}', sort: "" }} />);
    await user.click(screen.getByRole("button", { name: "Pick a sort field" }));
    const sortPicker = screen.getByRole("dialog", { name: "Sort by" });
    await user.selectOptions(within(sortPicker).getByLabelText("Field"), "address.city");
    await user.selectOptions(within(sortPicker).getByLabelText("Order"), "-1");
    await user.click(within(sortPicker).getByRole("button", { name: "Use this sort" }));
    expect((screen.getByLabelText("Sort") as HTMLInputElement).value).toBe('{"address.city":-1}');

    await user.click(screen.getByRole("button", { name: "Pick fields to show" }));
    const projection = screen.getByRole("dialog", { name: "Fields to show" });
    expect(
      (within(projection).getByRole("checkbox", { name: "plan" }) as HTMLInputElement).checked,
    ).toBe(true);
    await user.click(within(projection).getByRole("checkbox", { name: "_id" }));
    await user.click(within(projection).getByRole("button", { name: "Show 2 fields" }));
    expect((screen.getByLabelText("Projection") as HTMLInputElement).value).toBe(
      '{"plan":1,"_id":1}',
    );

    await user.click(screen.getByRole("button", { name: "Pick fields to show" }));
    const again = screen.getByRole("dialog", { name: "Fields to show" });
    await user.click(within(again).getByRole("checkbox", { name: "plan" }));
    await user.click(within(again).getByRole("checkbox", { name: "_id" }));
    await user.type(within(again).getByLabelText("Find a field"), "nothing");
    expect(within(again).getByText("No matching fields.")).toBeTruthy();
    await user.click(within(again).getByRole("button", { name: "Show all fields" }));
    expect((screen.getByLabelText("Projection") as HTMLInputElement).value).toBe("");
  });

  it("reapplies a query from the history, removes chips and cancels a slow query", async () => {
    const user = userEvent.setup();
    const onHistory = vi.fn();
    const onRemoveChip = vi.fn();
    const onCancel = vi.fn();
    render(
      <Harness
        history={[{ filter: '{"plan":"pro"}', sort: '{"_id":-1}' }, { projection: '{"a":1}' }]}
        onHistory={onHistory}
        chips={[{ path: "plan", label: 'plan is "pro"' }]}
        onRemoveChip={onRemoveChip}
        busy
        onCancel={onCancel}
        sortAndProjection={false}
      />,
    );
    expect(screen.queryByLabelText("Sort")).toBeNull();
    await user.click(screen.getByRole("button", { name: "History" }));
    const menu = screen.getByRole("menu", { name: "Recent queries" });
    expect(within(menu).getAllByRole("menuitem")[1]?.textContent).toContain("projection");
    await user.click(within(menu).getAllByRole("menuitem")[0] as HTMLElement);
    expect(onHistory).toHaveBeenCalledWith({ filter: '{"plan":"pro"}', sort: '{"_id":-1}' });
    await user.click(screen.getByRole("button", { name: "Remove the condition on plan" }));
    expect(onRemoveChip).toHaveBeenCalledWith("plan");
    await user.click(screen.getByRole("button", { name: "Cancel query" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("ExportButton", () => {
  const result: ExportResult = {
    filename: "shop.orders.csv",
    contentType: "text/csv;charset=utf-8",
    content: "_id\n1\n",
    documents: 1000,
    truncated: true,
  };

  it("asks for format and size, downloads the file and reports what it contains", async () => {
    const user = userEvent.setup();
    const created = vi.fn(() => "blob:test");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const run = vi.fn(async () => result);
    const onDone = vi.fn();
    render(<ExportButton run={run} onDone={onDone} />);
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = screen.getByRole("dialog", { name: "Export the result" });
    await user.selectOptions(within(dialog).getByLabelText("Extended JSON"), "canonical");
    await user.selectOptions(within(dialog).getByLabelText("Format"), "csv");
    // CSV has no Extended JSON flavour.
    expect(within(dialog).queryByLabelText("Extended JSON")).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("At most"), "10000");
    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(run).toHaveBeenCalledWith({ format: "csv", limit: 10_000, ejson: "canonical" });
    expect(created).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledWith(
      "Downloaded shop.orders.csv: 1,000 documents (stopped at the limit; there are more).",
      "success",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows why an export failed, inside the popover", async () => {
    const user = userEvent.setup();
    render(
      <ExportButton
        run={async () => {
          throw new Error("MongoDB refused the request.");
        }}
        onDone={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("MongoDB refused the request.")).toBeTruthy();
    // Without Blob URLs (old DOMs) downloading is a no-op rather than an error.
    Object.assign(URL, { createObjectURL: undefined });
    expect(() => downloadFile("a.txt", "x", "text/plain")).not.toThrow();
  });
});

describe("DocumentViewer", () => {
  const documents = toViewerDocuments(
    ['{"_id": 1, "name": "Ada", "address": {"city": "Colombo"}}', '{"_id": 2, "name": "Bo"}'],
    ['{"_id": {"$numberInt": "1"}}'],
  );

  /** The viewer with its view kept in state, like the pages do. */
  function Viewer(props: Partial<DocumentViewerProps>) {
    const [view, setView] = useStateValue<DocumentViewerProps["view"]>(props.view ?? "table");
    return (
      <DocumentViewer
        scope="live:test:db.c"
        documents={documents}
        firstNumber={1}
        loading={false}
        empty={<p>Nothing here</p>}
        sample={{
          summary: SUMMARY,
          description: "a sample",
          loading: false,
          error: undefined,
          reload: vi.fn(),
        }}
        {...props}
        view={view}
        onView={(next) => {
          setView(next);
          props.onView?.(next);
        }}
      />
    );
  }

  it("switches between every view with the radio buttons", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    render(<Viewer onView={onView} />);
    expect(screen.getByRole("table", { name: "Documents" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Tree" }));
    expect(screen.getAllByRole("tree")).toHaveLength(2);
    await user.click(screen.getByRole("radio", { name: "JSON" }));
    expect(screen.getByLabelText("Extended JSON of 1")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Cards" }));
    expect(screen.getByLabelText("Title")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    expect(screen.getByRole("table", { name: "Fields of the sample" })).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Chart" }));
    expect(screen.getByRole("heading", { name: /Documents by status/ })).toBeTruthy();
    expect(onView).toHaveBeenLastCalledWith("chart");
    // Arrow keys between the views are native radio behaviour (jsdom cannot simulate it,
    // it lacks CSS.escape); e2e/keyboard.spec.ts covers it in a real browser.
  });

  it("remembers hidden columns, card fields and the chart field per collection", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Viewer />);
    await user.click(screen.getByRole("button", { name: /^Columns/ }));
    await user.click(screen.getByRole("checkbox", { name: "address.city" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("columnheader", { name: /address\.city/ })).toBeNull();
    unmount();
    render(<Viewer view="cards" />);
    expect(loadPrefs("live:test:db.c").columns?.hidden).toEqual(["address.city"]);
    await user.selectOptions(screen.getByLabelText("Subtitle"), "");
    expect(loadPrefs("live:test:db.c").cardSubtitle).toBe("\u0000none");
    await user.selectOptions(screen.getByLabelText("Title"), "_id");
    expect(loadPrefs("live:test:db.c").cardTitle).toBe("_id");
    await user.click(screen.getByRole("radio", { name: "Chart" }));
    await user.selectOptions(screen.getByLabelText("Field"), "total");
    expect(loadPrefs("live:test:db.c").chartField).toBe("total");
  });

  it("offers wrapping, canonical text and copying the page in the JSON view", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<Viewer view="json" canonical={{ on: true, onToggle }} />);
    expect(screen.getByLabelText("Extended JSON of 1").textContent).toContain("$numberInt");
    await user.click(screen.getByRole("checkbox", { name: "Wrap lines" }));
    expect(
      screen.getByLabelText("Extended JSON of 1").querySelector("pre")?.className,
    ).not.toContain("json-wrap");
    await user.click(screen.getByRole("checkbox", { name: "Canonical" }));
    expect(onToggle).toHaveBeenCalledWith(false);
    await user.click(
      screen.getByRole("button", { name: "Copy every document of this page as a JSON array" }),
    );
    expect(await navigator.clipboard.readText()).toMatch(/^\[\n/);
    await user.click(screen.getByRole("button", { name: "Copy document 2" }));
    expect(await navigator.clipboard.readText()).toBe('{"_id": 2, "name": "Bo"}');
    await user.click(screen.getByRole("button", { name: "Open document 2" }));
    expect(screen.getByRole("dialog", { name: "2" })).toBeTruthy();
  });

  it("shows loading, error and empty states of the documents and the sample", async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const { rerender } = render(<Viewer documents={[]} loading />);
    expect(screen.getByRole("status").textContent).toBe("Reading documents…");
    rerender(<Viewer documents={[]} />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    rerender(
      <Viewer
        view="schema"
        sample={{ summary: undefined, description: "", loading: true, error: undefined, reload }}
      />,
    );
    await user.click(screen.getByRole("radio", { name: "Schema" }));
    expect(screen.getByRole("status").textContent).toBe("Reading a sample of the documents…");
    rerender(
      <Viewer
        view="schema"
        sample={{
          summary: undefined,
          description: "",
          loading: false,
          error: new Error("refused"),
          reload,
        }}
      />,
    );
    expect(screen.getByText("Could not read a sample")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalled();
    rerender(
      <Viewer
        view="schema"
        sample={{
          summary: analyzeSchema([]),
          description: "",
          loading: false,
          error: undefined,
          reload,
        }}
      />,
    );
    expect(screen.getByText("Nothing here")).toBeTruthy();
  });
});
