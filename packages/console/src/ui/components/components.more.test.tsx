/**
 * More component tests: copying code (allowed and denied clipboard), the EJSON tree for
 * every value kind, indeterminate and overflowing progress, table sorting with missing
 * values and row clicks, toasts (dismiss, auto-dismiss, outside a provider), closing a
 * dialog from its backdrop, the namespace tree, relative times that refresh, and the
 * context hooks outside their providers.
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, type FetchLike } from "../api.ts";
import { ApiProvider, SessionProvider, useApi, useSession } from "../context.tsx";
import { LinkButton } from "./button.tsx";
import { CodeBlock, EjsonTree } from "./code-block.tsx";
import { Dialog } from "./dialog.tsx";
import { EmptyState, PageHeader, Panel, Time } from "./layout.tsx";
import { NamespaceTree } from "./namespace-tree.tsx";
import { ProgressBar } from "./progress-bar.tsx";
import { Table } from "./table.tsx";
import { ToastProvider, useToast } from "./toast.tsx";

afterEach(() => {
  // Vitest runs without globals, so Testing Library cannot register its own cleanup.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodeBlock", () => {
  it("copies the code and says so", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CodeBlock label="manifest.json" code="{}" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("{}");
  });

  it("stays quiet when the clipboard is denied", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => Promise.reject(new Error("denied")) },
    });
    render(<CodeBlock label="x" code="y" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("EjsonTree", () => {
  it("renders scalars, wrappers, arrays and nested objects", async () => {
    const user = userEvent.setup();
    render(
      <EjsonTree
        value={{
          _id: { $oid: "65f0" },
          name: "Ada",
          age: 36,
          active: true,
          deleted: null,
          tags: ["a", "b"],
          address: { city: "Colombo" },
        }}
      />,
    );
    expect(screen.getByText('ObjectId("65f0")')).toBeTruthy();
    expect(screen.getByText('"Ada"')).toBeTruthy();
    expect(screen.getByText("36")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.getByText("null")).toBeTruthy();
    expect(screen.getByText("Array(2)")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /tags/ });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText('"b"')).toBeTruthy();
  });

  it("renders a bare scalar and an empty object", () => {
    const { rerender } = render(<EjsonTree value="plain" label="value" />);
    expect(screen.getByText('"plain"')).toBeTruthy();
    rerender(<EjsonTree value={{}} />);
    expect(screen.getByText("{ 0 fields }")).toBeTruthy();
  });
});

describe("ProgressBar", () => {
  it("is indeterminate without a total and clamps values above it", () => {
    const { rerender } = render(<ProgressBar label="Documents" value={5} />);
    const bar = screen.getByLabelText("Documents") as HTMLProgressElement;
    expect(bar.hasAttribute("value")).toBe(false);
    rerender(<ProgressBar label="Documents" value={150} max={100} detail="150 of 100" />);
    expect(screen.getByText("150 of 100 · 100%")).toBeTruthy();
    expect((screen.getByLabelText("Documents") as HTMLProgressElement).value).toBe(100);
  });
});

interface Row {
  readonly id: string;
  readonly size?: number;
}

describe("Table", () => {
  const rows: readonly Row[] = [{ id: "a", size: 2 }, { id: "b" }, { id: "c", size: 1 }];

  function renderTable(onRowActivate: (row: Row) => void) {
    return render(
      <Table<Row>
        caption="Things"
        showCaption
        rows={rows}
        rowKey={(row) => row.id}
        onRowActivate={onRowActivate}
        rowClassName={(row) => (row.size === undefined ? "row-dimmed" : undefined)}
        columns={[
          {
            key: "id",
            header: "Id",
            render: (row) => <a href={`#/${row.id}`}>{row.id}</a>,
          },
          {
            key: "size",
            header: "Size",
            sortValue: (row) => row.size,
            render: (row) => String(row.size ?? "–"),
          },
        ]}
      />,
    );
  }

  const ids = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.textContent?.charAt(0));

  it("sorts missing values last in both directions", async () => {
    const user = userEvent.setup();
    renderTable(() => undefined);
    expect(screen.getByText("Things").className).toBe("table-caption");
    await user.click(screen.getByRole("button", { name: /Size/ }));
    expect(ids()).toEqual(["c", "a", "b"]);
    await user.click(screen.getByRole("button", { name: /Size/ }));
    expect(ids()[0]).toBe("b");
  });

  it("activates a row on click but not when a link inside it is clicked", async () => {
    const user = userEvent.setup();
    const activate = vi.fn();
    renderTable(activate);
    const [first] = screen.getAllByRole("row").slice(1);
    if (first === undefined) throw new Error("no rows");
    await user.click(within(first).getAllByRole("cell")[1] as HTMLElement);
    expect(activate).toHaveBeenCalledWith({ id: "a", size: 2 });
    await user.click(within(first).getByRole("link"));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("jumps to the first and last rows with Home and End, and moves up", async () => {
    const user = userEvent.setup();
    renderTable(() => undefined);
    const body = screen.getAllByRole("row").slice(1);
    body[1]?.focus();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(body[2]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(body[0]);
    await user.keyboard("{ArrowDown}{ArrowUp}");
    expect(document.activeElement).toBe(body[0]);
    expect(body[1]?.className).toContain("row-dimmed");
  });
});

function ToastButtons() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.show("info", "Heads up.")}>
        Info
      </button>
      <button type="button" onClick={() => toast.show("error", "Broken.")}>
        Error
      </button>
    </>
  );
}

describe("toasts", () => {
  it("dismisses on request and hides info toasts after a while, but keeps errors", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <ToastProvider>
        <ToastButtons />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    fireEvent.click(screen.getByRole("button", { name: "Error" }));
    expect(screen.getByText("Note")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Broken.");
    act(() => {
      vi.advanceTimersByTime(5_100);
    });
    expect(screen.queryByText("Heads up.")).toBeNull();
    expect(screen.getByText("Broken.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Broken.")).toBeNull();
  });

  it("refuses to work outside its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<ToastButtons />)).toThrow(
      "useToast() must be used inside <ToastProvider>.",
    );
  });
});

describe("Dialog backdrop", () => {
  it("closes on a press that starts on the backdrop only", () => {
    const onClose = vi.fn();
    render(
      <Dialog open title="Hi" description="Explained" onClose={onClose}>
        <p>Body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Hi" });
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = dialog.parentElement;
    if (backdrop === null) throw new Error("no backdrop");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("NamespaceTree", () => {
  it("explains an empty deployment", () => {
    render(<NamespaceTree tree={[]} />);
    expect(screen.getByText("This connection has no user databases.")).toBeTruthy();
  });

  it("marks included and excluded collections and counts them", () => {
    render(
      <NamespaceTree
        tree={[
          {
            name: "shop",
            collections: [
              { name: "users", type: "collection", estimatedDocuments: 5, indexes: 1 },
              { name: "carts", type: "collection", estimatedDocuments: 2, indexes: 1 },
            ],
          },
        ]}
        isSelected={(ns) => ns === "shop.users"}
        annotate={(ns) => <span>note {ns}</span>}
      />,
    );
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    expect(screen.getByText("Included")).toBeTruthy();
    expect(screen.getByText("Excluded")).toBeTruthy();
    expect(screen.getByText("Notes")).toBeTruthy();
    expect(screen.getByText("note shop.carts")).toBeTruthy();
  });
});

describe("layout pieces", () => {
  it("renders headers, panels and empty states with and without their extras", () => {
    render(
      <>
        <PageHeader title="Title" breadcrumbs={[]} />
        <Panel actions={<button type="button">Act</button>}>body</Panel>
        <EmptyState title="Empty" action={<LinkButton href="#/x">Go</LinkButton>} />
      </>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("button", { name: "Act" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go" }).className).toContain("button-secondary");
  });

  it("shows a dash for missing times and refreshes relative ones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    const { rerender } = render(<Time value={undefined} />);
    expect(screen.getByText("–")).toBeTruthy();
    rerender(<Time value="2026-10-21T11:59:00Z" relativeOnly />);
    const before = document.querySelector("time")?.textContent;
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(document.querySelector("time")?.textContent).not.toBe(before);
  });
});

describe("context hooks", () => {
  function UsesApi() {
    useApi();
    return null;
  }
  function UsesSession() {
    useSession();
    return null;
  }

  it("refuse to work outside their providers", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<UsesApi />)).toThrow("useApi() must be used inside <ApiProvider>.");
    const client = new ApiClient({ fetch: async () => ({ status: 200, text: async () => "" }) });
    expect(() =>
      render(
        <ApiProvider client={client}>
          <UsesSession />
        </ApiProvider>,
      ),
    ).toThrow("useSession() must be used inside <SessionProvider>.");
  });

  it("signs out locally even when the server cannot be reached", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("offline");
    };
    const client = new ApiClient({ fetch });
    const onChange = vi.fn();
    function SignOut() {
      const { logout } = useSession();
      return (
        <button type="button" onClick={() => void logout().catch(() => undefined)}>
          Out
        </button>
      );
    }
    render(
      <ApiProvider client={client}>
        <SessionProvider
          session={{
            setupComplete: true,
            authMethods: ["password"],
            user: {
              id: "u",
              username: "a",
              role: "viewer",
              signIn: "password",
              createdAt: "x",
              permissions: [],
            },
          }}
          onChange={onChange}
        >
          <SignOut />
        </SessionProvider>
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Out" }));
    await act(async () => undefined);
    expect(onChange).toHaveBeenCalledWith({ setupComplete: true, authMethods: ["password"] });
  });
});
