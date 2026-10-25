/**
 * Tests for StepFlow: tabs per step with their state in words, one visible panel (the
 * others stay mounted), Back / Next / finish, clicking and arrow keys between tabs, and
 * focus moving to the new step's panel after Back / Next.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { type FlowStep, StepFlow } from "./step-flow.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

type Id = "one" | "two" | "three";

/** A three-step flow with its own current step, as a page would hold it. */
function Harness(props: {
  states?: Partial<Record<Id, "done" | "error">>;
  lockThird?: boolean;
  finishOnEveryStep?: boolean;
}) {
  const [current, setCurrent] = useState<Id>("one");
  const steps: FlowStep<Id>[] = [
    { id: "one", title: "First", hint: "Start here", content: <input aria-label="Field one" /> },
    { id: "two", title: "Second", content: <p>Second step</p> },
    { id: "three", title: "Third", content: <p>Third step</p> },
  ].map((step) => ({
    ...step,
    state: props.states?.[step.id as Id],
    locked: props.lockThird === true && step.id === "three",
  })) as FlowStep<Id>[];
  return (
    <StepFlow
      label="Steps"
      steps={steps}
      current={current}
      onStep={setCurrent}
      // The shared Button, as the pages pass it (the same component as Next).
      finish={<Button type="submit">Finish</Button>}
      extra={<button type="button">Cancel</button>}
      {...(props.finishOnEveryStep === undefined
        ? {}
        : { finishOnEveryStep: props.finishOnEveryStep })}
    />
  );
}

describe("StepFlow", () => {
  it("shows one step at a time and keeps the others mounted", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Steps" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
    // The second step's text exists but is hidden.
    expect(screen.getByText("Second step").closest("[role=tabpanel]")?.hasAttribute("hidden")).toBe(
      true,
    );
    // What was typed survives a trip to another step.
    await user.type(screen.getByLabelText("Field one"), "kept");
    await user.click(screen.getByRole("button", { name: /Next: Second/ }));
    expect(screen.getByRole("tab", { name: /Second/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Back/ }));
    expect((screen.getByLabelText("Field one") as HTMLInputElement).value).toBe("kept");
  });

  it("offers the finish button on the last step, and Back everywhere but the first", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /Third/ }));
    expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    render(<Harness />);
    const first = screen.getByRole("tab", { name: /First/ });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Second/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Second/ }));
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("tab", { name: /Third/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /Third/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(first, { key: "Home" });
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
    // Other keys do nothing.
    fireEvent.keyDown(first, { key: "a" });
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("says each step's state in words and moves focus to the new step", async () => {
    const user = userEvent.setup();
    render(<Harness states={{ one: "done", two: "error" }} />);
    expect(screen.getByRole("tab", { name: /First.*\(done\)/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Second.*\(needs attention\)/ })).toBeTruthy();
    // Next moves focus to the new step; clicking a tab leaves it on the tab.
    await user.click(screen.getByRole("button", { name: /Next: Second/ }));
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    expect(document.activeElement?.textContent).toBe("Second step");
    await user.click(screen.getByRole("tab", { name: /Third/ }));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Third/ }));
  });

  it("keeps locked steps closed: no click, no arrow key, and the finish button before them", async () => {
    const user = userEvent.setup();
    render(<Harness lockThird />);
    const third = screen.getByRole("tab", { name: /Third/ });
    expect(third.getAttribute("aria-disabled")).toBe("true");
    await user.click(third);
    expect(third.getAttribute("aria-selected")).toBe("false");
    // The arrow keys go round the open steps only.
    const first = screen.getByRole("tab", { name: /First/ });
    fireEvent.keyDown(first, { key: "End" });
    expect(screen.getByRole("tab", { name: /Second/ }).getAttribute("aria-selected")).toBe("true");
    // On the step before a locked one, the page's own button replaces Next.
    expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Next/ })).toBeNull();
  });

  it("never submits the form from Next, even when the finish button takes its place", async () => {
    const user = userEvent.setup();
    let submits = 0;
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submits += 1;
        }}
      >
        <Harness />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: /Next: Second/ }));
    const next = screen.getByRole("button", { name: /Next: Third/ });
    await user.click(next);
    // The finish button is a new element: the clicked Next <button> was not reused as a
    // submit button (which made the browser submit the form during that click).
    const finish = screen.getByRole("button", { name: "Finish" });
    expect(finish).not.toBe(next);
    expect(submits).toBe(0);
    // Only the finish button itself submits.
    await user.click(finish);
    expect(submits).toBe(1);
  });

  it("can offer the finish button on every step, with a quieter Next", () => {
    render(<Harness finishOnEveryStep />);
    expect(screen.getByRole("button", { name: "Finish" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next: Second/ }).className).toContain(
      "button-secondary",
    );
  });

  it("does not move past an incomplete step: Next and later tabs show what is missing", async () => {
    const user = userEvent.setup();
    const incomplete: string[] = [];
    /** A flow whose first step needs "Field one" filled in. */
    function Gated() {
      const [current, setCurrent] = useState<Id>("one");
      const [value, setValue] = useState("");
      return (
        <StepFlow
          label="Steps"
          current={current}
          onStep={setCurrent}
          isComplete={(id) => id !== "one" || value !== ""}
          onIncomplete={(id) => incomplete.push(id)}
          finish={<Button type="submit">Finish</Button>}
          steps={[
            {
              id: "one",
              title: "First",
              content: (
                <input
                  aria-label="Field one"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              ),
            },
            { id: "two", title: "Second", content: <p>Second step</p> },
            { id: "three", title: "Third", content: <p>Third step</p> },
          ]}
        />
      );
    }
    render(<Gated />);
    const second = screen.getByRole("tab", { name: /Second/ });
    // Later tabs are closed, with a reason, while the first step is incomplete.
    expect(second.getAttribute("aria-disabled")).toBe("true");
    expect(second.getAttribute("title")).toBe("Complete “First” first");
    await user.click(screen.getByRole("button", { name: /Next: Second/ }));
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: /Third/ }));
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");
    expect(incomplete).toEqual(["one", "one"]);
    // The arrow keys only reach open steps.
    fireEvent.keyDown(screen.getByRole("tab", { name: /First/ }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /First/ }).getAttribute("aria-selected")).toBe("true");

    // Filled in: everything opens and Next moves on.
    await user.type(screen.getByLabelText("Field one"), "x");
    expect(second.getAttribute("aria-disabled")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Next: Second/ }));
    expect(second.getAttribute("aria-selected")).toBe("true");
  });
});
