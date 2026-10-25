/**
 * Component tests for the record views: type-aware values (every BSON type), the table
 * (columns from nested fields, server sort, resize, reorder, keyboard rows, selection,
 * value menus, nested popovers, virtualization), the document tree (expand/collapse all,
 * keyboard, copy, quick filters), the JSON text, the cards and the detail panel.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../ejson.ts";
import { toViewerDocuments, type ViewerDocument } from "../viewer-model.ts";
import { BsonValue, objectIdTitle, TypeBadge, typeGroup } from "./bson-value.tsx";
import { cardFields, DocumentCards } from "./document-cards.tsx";
import { DocumentDetail } from "./document-detail.tsx";
import { DocumentGrid, ROW_HEIGHT, visibleRange } from "./document-grid.tsx";
import { branchPaths, DocumentTree } from "./document-tree.tsx";
import { highlightJson, JsonText, prettyJson } from "./json-view.tsx";

// Vitest runs without globals, so Testing Library's own cleanup is not registered.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** A product with every BSON type, like the mock's `shop.products`. */
const PRODUCT = {
  _id: { $oid: "65f1c2a0e4b0a1b2c3d4e5f6" },
  name: "Compact Kettle",
  price: { $numberDecimal: "9.99" },
  stock: 3,
  active: true,
  retired: false,
  discontinuedAt: null,
  tags: ["sale", "new", "eco", "gift"],
  dimensions: { width: 10, unit: "cm" },
  variants: [{ color: "red" }, { color: "blue" }],
  views: { $numberLong: "9007199254740993" },
  externalId: { $binary: { base64: "AAECAwQFBgcICQoLDA0ODw==", subType: "04" } },
  thumbnail: { $binary: { base64: "AAEC", subType: "00" } },
  pattern: { $regularExpression: { pattern: "^S", options: "i" } },
  lastSync: { $timestamp: { t: 1_700_000_000, i: 1 } },
  updatedAt: { $date: "2026-10-24T14:18:56.911Z" },
};

/** Viewer documents for some plain documents. */
function viewerDocuments(documents: readonly JsonValue[]): ViewerDocument[] {
  return toViewerDocuments(documents.map((document) => JSON.stringify(document)));
}

describe("BsonValue", () => {
  it("renders every type for what it is", () => {
    render(
      <ul>
        {Object.entries(PRODUCT).map(([key, value]) => (
          <li key={key} data-testid={key}>
            <BsonValue value={value} />
          </li>
        ))}
        <li data-testid="missing">
          <BsonValue value={undefined} />
        </li>
      </ul>,
    );
    const cell = (id: string) => screen.getByTestId(id);
    expect(cell("_id").textContent).toBe("65f1c2a0e4b0a1b2c3d4e5f6");
    expect(cell("_id").firstElementChild?.getAttribute("title")).toMatch(/^ObjectId · created /);
    expect(cell("price").textContent).toBe("9.99 D");
    expect(cell("views").textContent).toBe("9007199254740993 L");
    expect(cell("stock").textContent).toBe("3");
    // Booleans carry a shape as well as their word and color.
    expect(cell("active").textContent).toBe("✓ true");
    expect(cell("retired").textContent).toBe("✕ false");
    // null and a missing field look different, as they mean different things.
    expect(cell("discontinuedAt").textContent).toBe("null");
    expect(cell("missing").textContent).toBe("—");
    expect(cell("missing").firstElementChild?.getAttribute("title")).toMatch(/no such field/);
    // Arrays: count, the first items as chips, then how many more.
    expect(within(cell("tags")).getByText("[4]")).toBeTruthy();
    expect(within(cell("tags")).getByText("sale")).toBeTruthy();
    expect(within(cell("tags")).getByText("+1 more")).toBeTruthy();
    expect(cell("dimensions").textContent).toBe("{ 2 fields }");
    expect(cell("externalId").textContent).toBe("00010203-0405-0607-0809-0a0b0c0d0e0f");
    expect(cell("thumbnail").textContent).toBe("Binary · 3 bytes");
    expect(cell("pattern").textContent).toBe("/^S/i");
    expect(cell("lastSync").textContent).toBe("Timestamp(1700000000, 1)");
    expect(cell("updatedAt").firstElementChild?.getAttribute("title")).toBe(
      "2026-10-24T14:18:56.911Z",
    );
  });

  it("shows whole quoted strings in full mode, clipped ones with a tooltip otherwise", () => {
    const long = "y".repeat(200);
    const { rerender } = render(<BsonValue value={long} />);
    expect(screen.getByTitle(long).textContent).toHaveLength(120);
    rerender(<BsonValue value={long} full />);
    expect(screen.getByText(`"${long}"`)).toBeTruthy();
  });

  it("turns arrays and documents into buttons when they can be opened", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <>
        <BsonValue value={[1, 2]} onOpenNested={open} nestedLabel="Show tags" />
        <BsonValue value={{ a: 1 }} onOpenNested={open} />
        <BsonValue value={[]} onOpenNested={open} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Show tags" }));
    await user.click(screen.getByRole("button", { name: "Show { 1 field }" }));
    expect(open).toHaveBeenCalledTimes(2);
    // An empty array has nothing to open.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("names types in badges and groups them for their colors", () => {
    render(<TypeBadge type="decimal" />);
    expect(screen.getByText("Decimal128").className).toContain("type-number");
    expect(typeGroup("uuid")).toBe("id");
    expect(typeGroup("timestamp")).toBe("date");
    expect(typeGroup("regex")).toBe("string");
    expect(typeGroup("array")).toBe("nested");
    expect(typeGroup("minKey")).toBe("other");
    expect(typeGroup("boolean")).toBe("boolean");
    expect(objectIdTitle("nope")).toBe("ObjectId");
  });
});

describe("DocumentGrid (table view)", () => {
  const documents = viewerDocuments([
    { _id: 1, plan: "pro", address: { city: "Colombo" }, tags: ["a"], logins: 5 },
    { _id: 2, plan: "free", address: { city: "Berlin" }, tags: [], logins: 7 },
    { _id: 3, plan: "free" },
  ]);
  const columns = ["_id", "plan", "address.city", "tags", "logins"];

  function renderGrid(overrides: Partial<Parameters<typeof DocumentGrid>[0]> = {}) {
    const props = {
      documents,
      firstNumber: 21,
      columns,
      widths: {},
      onResize: vi.fn(),
      onReorder: vi.fn(),
      onOpen: vi.fn(),
      onSort: vi.fn(),
      onQuickFilter: vi.fn(),
      caption: "Documents",
      ...overrides,
    };
    render(<DocumentGrid {...props} />);
    return props;
  }

  it("shows one column per flattened field, values by type, and missing fields as —", () => {
    renderGrid();
    const table = screen.getByRole("table", { name: "Documents" });
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headers).toEqual(["Row#", "_id", "plan", "address.city", "tags", "logins"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    // Row numbers continue from the page's first document.
    expect(within(rows[0] as HTMLElement).getByRole("rowheader").textContent).toContain("21");
    expect(within(rows[2] as HTMLElement).getAllByText("—")).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Berlin")).toBeTruthy();
  });

  it("sorts on the server from the headers and shows the direction", async () => {
    const user = userEvent.setup();
    const props = renderGrid({ sort: { path: "plan", direction: -1 } });
    const plan = screen.getByRole("columnheader", { name: /plan/ });
    expect(plan.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /logins/ }).getAttribute("aria-sort")).toBe(
      "none",
    );
    await user.click(screen.getByRole("button", { name: "Sort by logins" }));
    expect(props.onSort).toHaveBeenCalledWith("logins");
  });

  it("has no sort buttons where the server cannot sort (backups)", () => {
    renderGrid({ onSort: undefined });
    expect(screen.queryByRole("button", { name: /^Sort by/ })).toBeNull();
    expect(screen.getByRole("columnheader", { name: /plan/ }).hasAttribute("aria-sort")).toBe(
      false,
    );
  });

  it("resizes columns with the keyboard and the mouse, within bounds", () => {
    const props = renderGrid({ widths: { plan: 100 } });
    const handle = screen.getByRole("separator", { name: "Resize column plan" });
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(props.onResize).toHaveBeenLastCalledWith("plan", 116);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(props.onResize).toHaveBeenLastCalledWith("plan", 84);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(props.onResize).toHaveBeenCalledTimes(2);
    // The `_id` column starts wide enough for an ObjectId.
    expect(
      screen.getByRole("separator", { name: "Resize column _id" }).getAttribute("aria-valuenow"),
    ).toBe("232");
    // Dragging the handle.
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 5000, pointerId: 1 });
    expect(props.onResize).toHaveBeenLastCalledWith("plan", 1200);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 140, pointerId: 1 });
    expect(props.onResize).toHaveBeenLastCalledWith("plan", 1200);
  });

  it("reorders columns by dragging one header onto another", () => {
    const props = renderGrid();
    const logins = screen.getByRole("columnheader", { name: /logins/ });
    const plan = screen.getByRole("columnheader", { name: /plan/ });
    const dataTransfer = { setData: vi.fn(), getData: () => "logins", effectAllowed: "" };
    fireEvent.dragStart(logins, { dataTransfer });
    expect(logins.className).toContain("grid-head-dragging");
    fireEvent.dragOver(plan, { dataTransfer });
    fireEvent.drop(plan, { dataTransfer });
    expect(props.onReorder).toHaveBeenCalledWith("logins", "plan");
    fireEvent.dragEnd(logins);
    // Dropping a header on itself changes nothing.
    fireEvent.dragStart(plan, { dataTransfer: { ...dataTransfer, getData: () => "plan" } });
    fireEvent.drop(plan, { dataTransfer: { ...dataTransfer, getData: () => "plan" } });
    expect(props.onReorder).toHaveBeenCalledTimes(1);
  });

  it("moves between rows with the keyboard and opens a document with Enter", async () => {
    const user = userEvent.setup();
    const props = renderGrid();
    const rows = screen.getAllByRole("row").slice(1);
    // One row is in the Tab order (roving tabindex).
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    (rows[0] as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rows[2]);
    await user.keyboard("{Home}{PageDown}{ArrowUp}");
    await user.keyboard("{Enter}");
    expect(props.onOpen).toHaveBeenCalledWith(0);
    await user.keyboard("{PageUp}x");
    await user.dblClick(rows[2] as HTMLElement);
    expect(props.onOpen).toHaveBeenLastCalledWith(2);
    await user.click(screen.getByRole("button", { name: "Open document 2" }));
    expect(props.onOpen).toHaveBeenLastCalledWith(1);
  });

  it("ticks documents with a checkbox or Space when the page offers selection", async () => {
    const user = userEvent.setup();
    const selected = new Set<string>();
    const toggle = vi.fn((document: ViewerDocument) => {
      if (selected.has(document.key)) selected.delete(document.key);
      else selected.add(document.key);
    });
    renderGrid({
      selection: {
        isSelected: (document) => selected.has(document.key),
        canSelect: (document) => document.key !== "3",
        toggle,
      },
    });
    await user.click(screen.getByRole("checkbox", { name: "Select document 1" }));
    expect(toggle).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByRole("row").slice(1);
    (rows[1] as HTMLElement).focus();
    await user.keyboard(" ");
    expect(toggle).toHaveBeenCalledTimes(2);
    // A document that cannot be selected ignores Space.
    (rows[2] as HTMLElement).focus();
    await user.keyboard(" ");
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByRole("checkbox", { name: "Select document 3" }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("offers quick filters, copy and open from a clicked cell", async () => {
    const user = userEvent.setup();
    const props = renderGrid();
    await user.click(screen.getByText("pro"));
    const menu = screen.getByRole("menu", { name: "Actions for plan" });
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Show documents where plan is "pro"',
      'Show documents where plan is not "pro"',
      "Show documents that have plan",
      "Copy valueAs Extended JSON",
      "Copy pathplan",
      "Open document",
    ]);
    // The first item has focus; arrows move through the menu.
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
    await user.keyboard("{ArrowDown}{ArrowUp}{End}{Home}{Enter}");
    expect(props.onQuickFilter).toHaveBeenCalledWith({ path: "plan", op: "equals", value: "pro" });
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByText("Berlin"));
    await user.click(screen.getByRole("menuitem", { name: "Open document" }));
    expect(props.onOpen).toHaveBeenCalledWith(1);
  });

  it("opens arrays and nested documents in a popover tree", async () => {
    const user = userEvent.setup();
    renderGrid({ columns: ["tags"] });
    await user.click(screen.getByRole("button", { name: "Show tags of document 21" }));
    const popover = screen.getByRole("dialog", { name: "tags of document 21" });
    expect(within(popover).getByRole("tree")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders only the rows in view (and all of them before layout)", () => {
    expect(visibleRange(1000, 0, 0)).toEqual({ start: 0, end: 1000 });
    const range = visibleRange(1000, ROW_HEIGHT * 100, ROW_HEIGHT * 10);
    expect(range.start).toBe(92);
    expect(range.end).toBe(118);
    expect(visibleRange(5, 0, 1000)).toEqual({ start: 0, end: 5 });
    // Short pages are never windowed.
    expect(visibleRange(20, ROW_HEIGHT * 10, ROW_HEIGHT * 5)).toEqual({ start: 0, end: 20 });
  });

  it("shows documents that are not JSON as their raw text", () => {
    renderGrid({ documents: toViewerDocuments(["not json"]) });
    expect(screen.getByText("not json")).toBeTruthy();
  });
});

describe("DocumentTree", () => {
  it("expands and collapses with the toolbar and the keyboard", async () => {
    const user = userEvent.setup();
    render(<DocumentTree value={PRODUCT} label="Product" />);
    const tree = screen.getByRole("tree", { name: "Product" });
    const dimensions = within(tree).getByRole("treeitem", { name: /^dimensions/ });
    expect(dimensions.getAttribute("aria-expanded")).toBe("false");
    expect(within(tree).queryByText("width")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(dimensions.getAttribute("aria-expanded")).toBe("true");
    expect(within(tree).getByText("width")).toBeTruthy();
    expect(within(tree).getAllByText("color")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(within(tree).queryByText("width")).toBeNull();

    // Keyboard: → opens, → again moves into it, ← goes back to the parent and closes it.
    dimensions.focus();
    await user.keyboard("{ArrowRight}");
    expect(dimensions.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement?.textContent).toMatch(/^width/);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(dimensions);
    await user.keyboard("{ArrowLeft}");
    expect(dimensions.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{Enter}");
    expect(dimensions.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Home}");
    expect(document.activeElement?.textContent).toMatch(/^_id/);
    await user.keyboard("{End}{ArrowUp}{ArrowDown}");
    expect(document.activeElement?.textContent).toMatch(/^updatedAt/);
  });

  it("copies values and paths, and offers quick filters from a row", async () => {
    const user = userEvent.setup();
    const onCopied = vi.fn();
    const onQuickFilter = vi.fn();
    render(
      <DocumentTree
        value={PRODUCT}
        label="Product"
        onQuickFilter={onQuickFilter}
        onCopied={onCopied}
        openDepth={2}
      />,
    );
    const unit = screen.getByRole("treeitem", { name: /^unit/ });
    unit.focus();
    await user.keyboard("c");
    expect(await navigator.clipboard.readText()).toBe('"cm"');
    await user.keyboard("p");
    expect(await navigator.clipboard.readText()).toBe("dimensions.unit");
    expect(onCopied).toHaveBeenCalledWith(true, "path");

    await user.keyboard("f");
    const menu = screen.getByRole("menu", { name: "Actions for dimensions.unit" });
    await user.click(within(menu).getByRole("menuitem", { name: /is not "cm"/ }));
    expect(onQuickFilter).toHaveBeenCalledWith({
      path: "dimensions.unit",
      op: "notEquals",
      value: "cm",
    });
    // Array elements filter on the array field itself ("tags" contains "sale").
    await user.click(screen.getByRole("button", { name: "More actions for tags.0" }));
    await user.click(screen.getByRole("menuitem", { name: 'Show documents where tags is "sale"' }));
    expect(onQuickFilter).toHaveBeenLastCalledWith({ path: "tags", op: "equals", value: "sale" });
    await user.click(screen.getByRole("button", { name: "Copy the value of stock" }));
    expect(await navigator.clipboard.readText()).toBe("3");
  });

  it("shows empty documents and single values without a toolbar", () => {
    const { rerender } = render(<DocumentTree value={{}} label="Empty" />);
    expect(screen.getByText("An empty document.")).toBeTruthy();
    rerender(<DocumentTree value="just text" label="Value" />);
    expect(screen.getByText('"just text"')).toBeTruthy();
    rerender(<DocumentTree value={{ a: 1 }} label="Flat" />);
    expect(screen.queryByRole("button", { name: "Expand all" })).toBeNull();
    expect(branchPaths({ a: { b: [1, { c: 2 }] } })).toEqual(["a", "a.b", "a.b.1"]);
  });
});

describe("JSON text", () => {
  it("highlights keys, type wrappers, strings, numbers, literals and punctuation", () => {
    const { container } = render(
      <JsonText text='{"a":"x","b":1.5,"c":true,"d":null,"e":{"$oid":"65"}}' wrap label="Doc" />,
    );
    const classes = [...container.querySelectorAll("code span")].map((span) => span.className);
    for (const kind of ["key", "wrapper", "string", "number", "boolean", "null", "punctuation"]) {
      expect(classes).toContain(`json-${kind}`);
    }
    expect(screen.getByLabelText("Doc").querySelector("pre")?.className).toContain("json-wrap");
    expect(prettyJson("not json")).toBe("not json");
    expect(highlightJson("plain")).toEqual(["plain"]);
  });
});

describe("DocumentCards", () => {
  const documents = viewerDocuments([
    {
      _id: 1,
      name: "Ada",
      email: "ada@example.com",
      plan: "pro",
      logins: 3,
      a: 1,
      b: 2,
      c: 3,
      d: 4,
    },
    { _id: 2, name: "Bo", email: "bo@example.com", plan: "free" },
  ]);

  it("guesses readable title and subtitle fields, or uses the chosen ones", () => {
    expect(cardFields(documents, {})).toEqual({ title: "name", subtitle: "email" });
    expect(cardFields(documents, { title: "plan", subtitle: null })).toEqual({
      title: "plan",
      subtitle: undefined,
    });
    expect(cardFields(viewerDocuments([{ _id: 1, x: 1 }]), {})).toEqual({
      title: "_id",
      subtitle: undefined,
    });
    expect(cardFields(documents, { title: "email" }).subtitle).toBeUndefined();
  });

  it("shows a summary per document, opens it, and filters from a value", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onQuickFilter = vi.fn();
    render(
      <DocumentCards
        documents={documents}
        firstNumber={1}
        titleField="name"
        subtitleField="email"
        onOpen={onOpen}
        onQuickFilter={onQuickFilter}
      />,
    );
    const cards = within(screen.getByRole("list", { name: "Documents" })).getAllByRole("listitem");
    expect(within(cards[0] as HTMLElement).getByText("Ada")).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("ada@example.com")).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText("+1 more fields")).toBeTruthy();
    // Each card's "Open" button opens its document (and is the keyboard path to it).
    await user.click(
      within(cards[1] as HTMLElement).getByRole("button", { name: "Open document 2" }),
    );
    expect(onOpen).toHaveBeenCalledWith(1);
    await user.click(
      within(cards[0] as HTMLElement).getByRole("button", { name: "Open document 1" }),
    );
    expect(onOpen).toHaveBeenLastCalledWith(0);
    await user.click(
      within(cards[0] as HTMLElement).getByRole("button", { name: "plan: actions" }),
    );
    await user.click(screen.getByRole("menuitem", { name: 'Show documents where plan is "pro"' }));
    expect(onQuickFilter).toHaveBeenCalledWith({ path: "plan", op: "equals", value: "pro" });
  });
});

describe("DocumentDetail", () => {
  const documents = toViewerDocuments(
    [JSON.stringify(PRODUCT), '{"_id": 2, "name": "Lamp"}'],
    ['{"canonical": true}'],
  );

  it("shows one document with tree, JSON and fields tabs, and steps through the page", async () => {
    const user = userEvent.setup();
    let index = 0;
    const onIndex = vi.fn((next: number) => {
      index = next;
    });
    const props = {
      documents,
      firstNumber: 41,
      onIndex,
      onClose: vi.fn(),
      onQuickFilter: vi.fn(),
      actions: () => <button type="button">Edit</button>,
    };
    const { rerender } = render(<DocumentDetail {...props} index={index} />);
    const dialog = screen.getByRole("dialog", { name: 'ObjectId("65f1c2a0e4b0a1b2c3d4e5f6")' });
    expect(within(dialog).getByText("Document 41 on this page (1 of 2).")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: /Previous/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(within(dialog).getByRole("tab", { name: "JSON" }));
    const canonical = within(dialog).getByRole("checkbox", { name: /Canonical Extended JSON/ });
    await user.click(canonical);
    expect(within(dialog).getByText('"canonical"')).toBeTruthy();
    await user.click(within(dialog).getByRole("tab", { name: "Fields" }));
    expect(within(dialog).getByRole("cell", { name: "dimensions.width" })).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: /Next/ }));
    expect(onIndex).toHaveBeenCalledWith(1);
    rerender(<DocumentDetail {...props} index={index} />);
    expect(screen.getByRole("dialog", { name: "2" })).toBeTruthy();
    // [ goes back (outside text fields).
    fireEvent.keyDown(screen.getByRole("tabpanel"), { key: "[" });
    expect(onIndex).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(screen.getByRole("tabpanel"), { key: "]" });
    expect(onIndex).toHaveBeenCalledTimes(2);
  });

  it("closes before applying a quick filter, and shows unparseable documents raw", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onQuickFilter = vi.fn();
    const { rerender } = render(
      <DocumentDetail
        documents={documents}
        index={1}
        firstNumber={1}
        onIndex={vi.fn()}
        onClose={onClose}
        onQuickFilter={onQuickFilter}
      />,
    );
    await user.click(screen.getByRole("button", { name: "More actions for name" }));
    await user.click(screen.getByRole("menuitem", { name: "Show documents that have name" }));
    expect(onClose).toHaveBeenCalled();
    expect(onQuickFilter).toHaveBeenCalledWith({ path: "name", op: "exists" });
    rerender(
      <DocumentDetail
        documents={toViewerDocuments(["not json"])}
        index={0}
        firstNumber={1}
        onIndex={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("not json")).toBeTruthy();
    rerender(
      <DocumentDetail
        documents={[]}
        index={0}
        firstNumber={1}
        onIndex={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
