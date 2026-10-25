/**
 * Tests for FillSuggestions: unique non-empty chips, the group named after the field,
 * clicking fills, the chip matching the current value is pressed, and an empty list
 * renders nothing.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FillSuggestions, uniqueSuggestions } from "./fill-suggestions.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

describe("uniqueSuggestions", () => {
  it("drops empty, missing and repeated values and keeps labels", () => {
    expect(
      uniqueSuggestions([
        "a",
        "",
        undefined,
        " ",
        { value: "b", label: "Bee" },
        "a",
        { value: "b" },
      ]),
    ).toEqual([{ value: "a" }, { value: "b", label: "Bee" }]);
  });
});

describe("FillSuggestions", () => {
  it("fills the field on click and marks the current value", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <FillSuggestions
        field="Name"
        items={["Production", { value: "Staging", hint: "From the host" }]}
        current="Staging"
        onPick={onPick}
        mono
      />,
    );
    const group = screen.getByRole("group", { name: "Suggestions for Name" });
    expect(group.textContent).toContain("Suggestions:");
    await user.click(screen.getByRole("button", { name: "Production" }));
    expect(onPick).toHaveBeenCalledWith("Production");
    const staging = screen.getByRole("button", { name: "Staging" });
    expect(staging.getAttribute("aria-pressed")).toBe("true");
    expect(staging.getAttribute("title")).toBe("From the host");
    expect(staging.className).toContain("fill-suggestion-mono");
    expect(screen.getByRole("button", { name: "Production" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("renders nothing without suggestions, and takes another lead word", () => {
    const { container } = render(
      <FillSuggestions field="Name" items={["", undefined]} onPick={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
    render(<FillSuggestions field="Folder" items={["backups"]} lead="Common" onPick={() => {}} />);
    expect(screen.getByRole("group", { name: "Suggestions for Folder" }).textContent).toContain(
      "Common:",
    );
  });
});
