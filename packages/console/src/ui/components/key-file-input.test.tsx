/**
 * Tests for KeyFileInput: the button opens the file picker; a key file's private keys
 * reach onKeys (comments and other lines skipped); files without keys, oversized files
 * and unreadable files explain themselves instead of calling onKeys.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ageKeyFileText, generateAgeKeyPair } from "../age-keys.ts";
import { KeyFileInput } from "./key-file-input.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

afterEach(() => {
  vi.restoreAllMocks();
});

/** Renders the input with a spy, and a user-event session. */
function renderInput() {
  const onKeys = vi.fn<(keys: string[]) => void>();
  const user = userEvent.setup();
  render(<KeyFileInput onKeys={onKeys} />);
  // The hidden picker, found by its accessible name.
  const picker = screen.getByLabelText("Key file") as HTMLInputElement;
  return { onKeys, user, picker };
}

describe("KeyFileInput", () => {
  it("opens the file picker from its button", async () => {
    const { user, picker } = renderInput();
    const click = vi.spyOn(picker, "click");
    await user.click(screen.getByRole("button", { name: "Load key from file" }));
    expect(click).toHaveBeenCalled();
  });

  it("hands over the private keys in a key file, and says how many", async () => {
    const { onKeys, user, picker } = renderInput();
    const one = await generateAgeKeyPair();
    const two = await generateAgeKeyPair();
    const text = `${ageKeyFileText(one)}\n${ageKeyFileText(two)}`;
    await user.upload(picker, new File([text], "backup-key.txt", { type: "text/plain" }));

    expect(await screen.findByText("Loaded 2 private keys from backup-key.txt.")).toBeTruthy();
    expect(onKeys).toHaveBeenCalledWith([one.privateKey, two.privateKey]);
    // The picker is cleared, so the same file can be chosen again.
    expect(picker.value).toBe("");
  });

  it("says so when the file holds no private key", async () => {
    const { onKeys, user, picker } = renderInput();
    const { publicKey } = await generateAgeKeyPair();
    await user.upload(picker, new File([`${publicKey}\n`], "public.txt", { type: "text/plain" }));

    const status = await screen.findByText(
      "No private key (AGE-SECRET-KEY-1…) found in public.txt.",
    );
    expect(status.getAttribute("role")).toBe("status");
    expect(status.className).toContain("key-file-input-error");
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("refuses files far bigger than a key file", async () => {
    const { onKeys, user, picker } = renderInput();
    const big = new File(["x".repeat(70 * 1024)], "backup.dump", { type: "text/plain" });
    await user.upload(picker, big);

    expect(await screen.findByText("backup.dump is too big to be an age key file.")).toBeTruthy();
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("says so when the file cannot be read", async () => {
    vi.spyOn(FileReader.prototype, "readAsText").mockImplementation(function (this: FileReader) {
      // Fire the error handler as a failing read would.
      this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
    });
    const { onKeys, user, picker } = renderInput();
    await user.upload(picker, new File(["AGE-SECRET-KEY-1X"], "key.txt", { type: "text/plain" }));

    expect(await screen.findByText("key.txt could not be read.")).toBeTruthy();
    expect(onKeys).not.toHaveBeenCalled();
  });

  it("can use another label", () => {
    render(<KeyFileInput onKeys={() => {}} label="Load keys" />);
    expect(screen.getByRole("button", { name: "Load keys" })).toBeTruthy();
  });
});
