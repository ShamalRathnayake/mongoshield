/**
 * Tests for RadioCards: a labelled radio group in a fieldset, descriptions announced
 * with each option, the optional hint, a visually hidden legend, disabled options and
 * keyboard selection.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RadioCards } from "./radio-cards.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

/** A controlled RadioCards, as a page would use it. */
function Harness(props: { hint?: string; hideLegend?: boolean }) {
  const [value, setValue] = useState<"a" | "b" | "c">("a");
  return (
    <RadioCards
      legend="Pick one"
      value={value}
      onValue={setValue}
      {...(props.hint === undefined ? {} : { hint: props.hint })}
      {...(props.hideLegend === undefined ? {} : { hideLegend: props.hideLegend })}
      options={[
        { value: "a", label: "Alpha", description: "The first." },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma", description: "Not now.", disabled: true },
      ]}
    />
  );
}

describe("RadioCards", () => {
  it("can hide its legend visually and still name the group", () => {
    render(<Harness hideLegend />);
    expect(screen.getByText("Pick one").className).toBe("visually-hidden");
    expect(screen.getByRole("group", { name: "Pick one" })).toBeTruthy();
  });

  it("is a named group of radios with descriptions", () => {
    render(<Harness hint="Choose carefully." />);
    const group = screen.getByRole("group", { name: "Pick one" });
    expect(group.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByText("Choose carefully.")).toBeTruthy();
    const alpha = screen.getByRole("radio", { name: "Alpha" });
    expect(alpha).toHaveProperty("checked", true);
    expect(alpha.getAttribute("aria-describedby")).not.toBeNull();
    // An option without a description has nothing to point at.
    expect(screen.getByRole("radio", { name: "Beta" }).getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByRole("radio", { name: "Gamma" })).toHaveProperty("disabled", true);
  });

  it("changes the value when an option is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(
      screen.getByRole("group", { name: "Pick one" }).getAttribute("aria-describedby"),
    ).toBeNull();
    await user.click(screen.getByText("Beta"));
    expect(screen.getByRole("radio", { name: "Beta" })).toHaveProperty("checked", true);
    // Clicking the description chooses the card too (the whole card is the label).
    await user.click(screen.getByText("The first."));
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveProperty("checked", true);
  });
});
