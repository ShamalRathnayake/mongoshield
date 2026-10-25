/**
 * Tests for the show/hide (eye) button of password fields in TextField: it toggles
 * between hidden and plain text, says what it does in words, keeps acronyms in its name,
 * follows a disabled field, and is absent on ordinary text fields.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { TextField } from "./field.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

/** A controlled field, as a page would hold it. */
function Harness(props: { label: string; type?: string; disabled?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <TextField
      label={props.label}
      value={value}
      onValue={setValue}
      {...(props.type === undefined ? {} : { type: props.type })}
      {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
    />
  );
}

describe("password fields", () => {
  it("show and hide what was typed with the eye button", async () => {
    const user = userEvent.setup();
    render(<Harness label="Password" type="password" />);
    const field = screen.getByLabelText("Password") as HTMLInputElement;
    await user.type(field, "correct horse");
    expect(field.type).toBe("password");

    const show = screen.getByRole("button", { name: "Show password" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    expect(show.getAttribute("aria-controls")).toBe(field.id);
    await user.click(show);
    expect(field.type).toBe("text");
    expect(field.value).toBe("correct horse");

    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    await user.click(hide);
    expect(field.type).toBe("password");
  });

  it("names the button after the field, keeping acronyms", () => {
    render(<Harness label="URL" type="password" />);
    expect(screen.getByRole("button", { name: "Show URL" })).toBeTruthy();
    cleanup();
    render(<Harness label="Secret access key" type="password" />);
    expect(screen.getByRole("button", { name: "Show secret access key" })).toBeTruthy();
  });

  it("is disabled with its field, and absent on ordinary text fields", () => {
    render(<Harness label="Passphrase" type="password" disabled />);
    expect(screen.getByRole("button", { name: "Show passphrase" })).toHaveProperty(
      "disabled",
      true,
    );
    cleanup();
    render(<Harness label="Name" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
