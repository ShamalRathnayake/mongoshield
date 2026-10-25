/**
 * Tests for shared components: StatusBadge (word + shape, never color alone), the
 * Dialog focus trap, and Table sorting and keyboard navigation.
 */

import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import "../testing.tsx";
import { Dialog } from "./dialog.tsx";
import { StatusBadge, statusStyle } from "./status-badge.tsx";
import { Table } from "./table.tsx";

describe("StatusBadge", () => {
  it("shows a word and a shape for every status", () => {
    for (const status of ["succeeded", "failed", "running", "queued", "cancelled", "incomplete"]) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.textContent).toBe(statusStyle(status).label);
      // The shape is decorative (the word carries the meaning) and hidden from screen readers.
      const svg = container.querySelector("svg");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.children.length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("uses a different shape for success and failure, so color is not the only cue", () => {
    const success = render(<StatusBadge status="succeeded" />).container.querySelector(
      "svg",
    )?.innerHTML;
    const failure = render(<StatusBadge status="failed" />).container.querySelector(
      "svg",
    )?.innerHTML;
    expect(success).not.toBe(failure);
  });

  it("shows unknown statuses as neutral text and accepts a custom label", () => {
    const { container } = render(<StatusBadge status="weird" />);
    expect(container.textContent).toBe("weird");
    expect(container.querySelector(".status-neutral")).not.toBeNull();
    render(<StatusBadge status="failed" label="Conflict: fail" />);
    expect(screen.getByText("Conflict: fail")).toBeTruthy();
  });
});

/** A page with an opener button and a dialog containing two inputs. */
function DialogHarness(props: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        title="Edit thing"
        onClose={() => {
          props.onClose?.();
          setOpen(false);
        }}
        footer={<button type="button">Save</button>}
      >
        <input aria-label="First field" data-autofocus />
        <input aria-label="Second field" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("moves focus into the dialog, to the data-autofocus element", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Edit thing" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("First field"));
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    const closeButton = within(dialog).getByRole("button", { name: "Close dialog" });
    const saveButton = within(dialog).getByRole("button", { name: "Save" });

    // Order inside: close (×), first field, second field, save.
    saveButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(closeButton);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(saveButton);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("First field"));
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

const ROWS: readonly Row[] = [
  { id: "a", name: "orders", size: 30 },
  { id: "b", name: "users", size: 10 },
  { id: "c", name: "carts", size: 20 },
];

function renderTable(onRowActivate?: (row: Row) => void) {
  return render(
    <Table<Row>
      caption="Collections"
      rows={ROWS}
      rowKey={(row) => row.id}
      {...(onRowActivate === undefined ? {} : { onRowActivate })}
      columns={[
        { key: "name", header: "Name", render: (row) => row.name, sortValue: (row) => row.name },
        {
          key: "size",
          header: "Size",
          align: "end",
          render: (row) => String(row.size),
          sortValue: (row) => row.size,
        },
      ]}
    />,
  );
}

function bodyNames(): string[] {
  const rows = screen.getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

describe("Table", () => {
  it("renders a captioned table with a row per item", () => {
    renderTable();
    expect(screen.getByRole("table", { name: "Collections" })).toBeTruthy();
    expect(bodyNames()).toEqual(["orders", "users", "carts"]);
  });

  it("sorts by a column, toggling direction and aria-sort", async () => {
    const user = userEvent.setup();
    renderTable();
    const sizeHeader = screen.getByRole("columnheader", { name: /Size/ });
    expect(sizeHeader.getAttribute("aria-sort")).toBe("none");
    await user.click(within(sizeHeader).getByRole("button"));
    expect(sizeHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(bodyNames()).toEqual(["users", "carts", "orders"]);
    await user.click(within(sizeHeader).getByRole("button"));
    expect(sizeHeader.getAttribute("aria-sort")).toBe("descending");
    expect(bodyNames()).toEqual(["orders", "carts", "users"]);
  });

  it("moves between rows with the arrow keys and opens a row with Enter", async () => {
    const user = userEvent.setup();
    const onRowActivate = vi.fn();
    renderTable(onRowActivate);
    const [, first, second, third] = screen.getAllByRole("row");
    first?.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(third);
    await user.keyboard("{Home}{Enter}");
    expect(onRowActivate).toHaveBeenCalledWith(ROWS[0]);
  });

  it("shows the empty state when there are no rows", () => {
    render(
      <Table<Row>
        caption="Empty"
        rows={[]}
        rowKey={(row) => row.id}
        columns={[{ key: "name", header: "Name", render: (row) => row.name }]}
        empty="Nothing yet"
      />,
    );
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });
});
