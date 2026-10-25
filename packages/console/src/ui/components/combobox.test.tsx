/**
 * Tests for ComboboxField (combobox.tsx): which suggestions match the text, and the
 * WAI-ARIA combobox keyboard and mouse behaviour (arrows, Enter, Escape, Tab, the ▾
 * button), rendered on its own with a little stateful wrapper.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
// Registers the cleanup after each test (Vitest runs without globals).
import "../testing.tsx";
import { ComboboxField, type ComboboxOption, matchingOptions } from "./combobox.tsx";

/** The suggestions used by most tests: plan names, one with a nicer label. */
const PLANS: readonly ComboboxOption[] = [
  { value: "Nightly production", description: "updates it" },
  { value: "Staging hourly" },
  { value: "local", label: "Local dev snapshot" },
];

/** Renders the field with its own state, as a page would; returns the input and spies. */
function renderCombobox(
  props: { options?: readonly ComboboxOption[]; disabled?: boolean; mono?: boolean } = {},
) {
  const onValue = vi.fn();
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  function Harness() {
    const [value, setValue] = useState("");
    return (
      <form onSubmit={onSubmit}>
        <ComboboxField
          label="Plan name"
          value={value}
          onValue={(next) => {
            setValue(next);
            onValue(next);
          }}
          options={props.options ?? PLANS}
          listLabel="Existing plans"
          hint="Pick or type."
          {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
          {...(props.mono === undefined ? {} : { mono: props.mono })}
        />
      </form>
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  const input = screen.getByRole("combobox", { name: "Plan name" }) as HTMLInputElement;
  return { user, input, onValue, onSubmit };
}

/** The listbox the box controls; it exists (hidden) even while closed. */
function listbox(): HTMLElement {
  const input = screen.getByRole("combobox", { name: "Plan name" });
  const list = document.getElementById(input.getAttribute("aria-controls") ?? "");
  if (list === null) throw new Error("no listbox");
  return list;
}

/** The texts of the options shown now. */
function optionTexts(): (string | null)[] {
  return within(listbox())
    .queryAllByRole("option", { hidden: true })
    .map((option) => option.textContent);
}

describe("matchingOptions", () => {
  it("offers everything for an empty text or an exact choice", () => {
    expect(matchingOptions(PLANS, "  ")).toBe(PLANS);
    expect(matchingOptions(PLANS, "staging HOURLY")).toBe(PLANS);
  });

  it("narrows by value or label, ignoring case", () => {
    expect(matchingOptions(PLANS, "NIGHT").map((option) => option.value)).toEqual([
      "Nightly production",
    ]);
    expect(matchingOptions(PLANS, "dev").map((option) => option.value)).toEqual(["local"]);
    expect(matchingOptions(PLANS, "zzz")).toEqual([]);
  });
});

describe("ComboboxField", () => {
  it("is a labelled combobox controlling a closed listbox at first", () => {
    const { input } = renderCombobox();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(listbox().getAttribute("role")).toBe("listbox");
    expect(listbox().getAttribute("aria-label")).toBe("Existing plans");
    expect(listbox().hidden).toBe(true);
    // The hint is announced with the box.
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("narrows the list while typing and takes a highlighted option with Enter", async () => {
    const { user, input, onSubmit } = renderCombobox();
    await user.type(input, "ly");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(optionTexts()).toEqual(["Nightly productionupdates it", "Staging hourly"]);
    // Nothing highlighted yet (manual selection): no active descendant.
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const active = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(active ?? "")?.textContent).toBe("Staging hourly");
    expect(document.getElementById(active ?? "")?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Enter}");
    expect(input.value).toBe("Staging hourly");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    // Enter chose an option; it did not submit the form.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("wraps the highlight around and starts from the end with Up", async () => {
    const { user, input } = renderCombobox();
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    const lastId = input.getAttribute("aria-activedescendant") ?? "";
    expect(document.getElementById(lastId)?.textContent).toBe("Local dev snapshot");
    await user.keyboard("{ArrowDown}");
    const firstId = input.getAttribute("aria-activedescendant") ?? "";
    expect(document.getElementById(firstId)?.textContent).toBe("Nightly productionupdates it");
    await user.keyboard("{ArrowUp}{Enter}");
    // The value of an option with a label is its value, not the label.
    expect(input.value).toBe("local");
  });

  it("lets Enter submit the form when nothing is highlighted", async () => {
    const { user, input, onSubmit } = renderCombobox();
    await user.type(input, "Brand new{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("Brand new");
  });

  it("opens with Alt+Down without highlighting, and closes with Escape and Tab", async () => {
    const { user, input } = renderCombobox();
    await user.click(input);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    // Escape closes the list only: it must not reach a surrounding dialog.
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    await user.keyboard("{Escape}");
    document.removeEventListener("keydown", outer);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(outer).not.toHaveBeenCalled();
    // A second Escape (list closed) is left alone for others to handle.
    const second = fireEvent.keyDown(input, { key: "Escape" });
    expect(second).toBe(true);

    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await user.tab();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows every option from the ▾ button, closes again, and picks with the mouse", async () => {
    const { user, input, onValue } = renderCombobox();
    await user.type(input, "Night");
    expect(optionTexts()).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "Show all suggestions" });
    // Not a Tab stop: the arrow keys already open the list from the box.
    expect(toggle.tabIndex).toBe(-1);
    await user.click(toggle);
    expect(optionTexts()).toHaveLength(3);
    expect(document.activeElement).toBe(input);
    await user.click(toggle);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    await user.click(screen.getByRole("option", { name: "Local dev snapshot" }));
    expect(onValue).toHaveBeenLastCalledWith("local");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays closed when nothing matches, and the arrows do nothing then", async () => {
    const { user, input } = renderCombobox();
    await user.type(input, "zzz");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(input.value).toBe("zzz");
  });

  it("disables the ▾ button without options, and everything when disabled", () => {
    renderCombobox({ options: [] });
    expect(
      (screen.getByRole("button", { name: "Show all suggestions" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    const { input } = renderCombobox({ disabled: true, mono: true });
    expect(input.disabled).toBe(true);
    expect(input.className).toContain("input-code");
  });

  it("closes when the box loses focus", async () => {
    const { user, input } = renderCombobox();
    await user.type(input, "S");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(input);
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
});
