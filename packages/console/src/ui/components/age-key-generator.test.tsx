/**
 * Tests for AgeKeyGenerator: generating hands the public key to the page and shows the
 * private key once; copying (and a refused clipboard); downloading an age key file; the
 * "I saved the private key" box driving onSavedChange; generating again replacing the key;
 * and the explanation for browsers (or http:// pages) that cannot make keys.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { identityToRecipient } from "mongoshield";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgeKeyGenerator } from "./age-key-generator.tsx";

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

beforeEach(() => {
  // jsdom has no Blob URLs: the key file download needs these two.
  URL.createObjectURL = vi.fn(() => "blob:backup-key");
  URL.revokeObjectURL = vi.fn();
  // jsdom cannot navigate to a download link; clicking it is all the test needs.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders the panel with spy callbacks, and a user-event session. */
function renderGenerator() {
  const onRecipient = vi.fn<(recipient: string, replaces: string | undefined) => void>();
  const onSavedChange = vi.fn<(saved: boolean) => void>();
  const user = userEvent.setup();
  render(<AgeKeyGenerator onRecipient={onRecipient} onSavedChange={onSavedChange} />);
  return { onRecipient, onSavedChange, user };
}

/** Reads a Blob as text (jsdom's Blob has no `.text()`, but FileReader works). */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** Clicks "Generate a key pair" and waits for the private key box. */
async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Generate a (new )?key pair/ }));
  return (await screen.findByLabelText(/^Private key for age1/)) as HTMLTextAreaElement;
}

describe("AgeKeyGenerator", () => {
  it("explains which key goes in the field before anything is generated", () => {
    renderGenerator();
    expect(screen.getByText("Which key goes here?")).toBeTruthy();
    expect(screen.getByText("mongoshield keygen")).toBeTruthy();
    expect(screen.getByText("age-keygen")).toBeTruthy();
    // No key yet: no private key box and no acknowledgement box.
    expect(screen.queryByLabelText(/^Private key for/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("hands the public key to the page and shows the matching private key once", async () => {
    const { onRecipient, onSavedChange, user } = renderGenerator();
    const box = await generate(user);

    expect(onRecipient).toHaveBeenCalledTimes(1);
    const [publicKey, replaces] = onRecipient.mock.calls[0] ?? [];
    expect(publicKey).toMatch(/^age1[0-9a-z]{58}$/);
    expect(replaces).toBeUndefined();
    // A key is waiting to be saved: the page is told it is not saved yet.
    expect(onSavedChange).toHaveBeenLastCalledWith(false);

    // The box holds a private key the library accepts, and it belongs to that public key.
    expect(box.readOnly).toBe(true);
    expect(box.value).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    expect(identityToRecipient(box.value)).toBe(publicKey);
    expect(screen.getByText(publicKey as string)).toBeTruthy();
    expect(screen.getByText("not stored anywhere")).toBeTruthy();
    expect(screen.getByText("cannot be restored")).toBeTruthy();
  });

  it("copies the private key to the clipboard and says so", async () => {
    const { user } = renderGenerator();
    const box = await generate(user);
    const writeText = vi.fn(async (_text: string) => {});
    // user-event installs its own clipboard on setup; replace it after that.
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await user.click(screen.getByRole("button", { name: "Copy private key" }));
    expect(writeText).toHaveBeenCalledWith(box.value);
    expect(screen.getByRole("status").textContent).toMatch(/^Copied the private key/);
  });

  it("explains how to copy by hand when the clipboard is refused", async () => {
    const { user } = renderGenerator();
    await generate(user);
    const writeText = vi.fn(async () => {
      throw new DOMException("Denied.", "NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    await user.click(screen.getByRole("button", { name: "Copy private key" }));
    expect(screen.getByRole("status").textContent).toMatch(/copy it by hand/);
  });

  it("downloads the private key as an age key file", async () => {
    const { onRecipient, user } = renderGenerator();
    const box = await generate(user);
    const publicKey = onRecipient.mock.calls[0]?.[0];
    let blob: Blob | undefined;
    vi.mocked(URL.createObjectURL).mockImplementation((value) => {
      blob = value as Blob;
      return "blob:backup-key";
    });

    await user.click(screen.getByRole("button", { name: "Download as file" }));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    const text = await blobText(blob as Blob);
    // age-keygen's format: when, which public key, then the private key.
    expect(text).toMatch(
      new RegExp(
        `^# created: \\d{4}-\\d\\d-\\d\\dT[^\\n]+Z\\n# public key: ${publicKey}\\n${box.value}\\n$`,
      ),
    );
    expect(screen.getByRole("status").textContent).toMatch(
      /^Downloaded mongoshield-backup-key-\d{4}-\d\d-\d\d\.txt/,
    );
  });

  it("reports the acknowledgement box to the page", async () => {
    const { onSavedChange, user } = renderGenerator();
    await generate(user);
    const box = screen.getByRole("checkbox", { name: "I saved the private key somewhere safe" });
    expect((box as HTMLInputElement).checked).toBe(false);

    await user.click(box);
    expect(onSavedChange).toHaveBeenLastCalledWith(true);
    await user.click(box);
    expect(onSavedChange).toHaveBeenLastCalledWith(false);
  });

  it("replaces the shown key when generating again, and unticks the box", async () => {
    const { onRecipient, onSavedChange, user } = renderGenerator();
    const first = (await generate(user)).value;
    const firstPublic = onRecipient.mock.calls[0]?.[0];
    await user.click(screen.getByRole("checkbox"));
    expect(onSavedChange).toHaveBeenLastCalledWith(true);

    await user.click(screen.getByRole("button", { name: "Generate a new key pair" }));
    await waitFor(() => expect(onRecipient).toHaveBeenCalledTimes(2));
    const [secondPublic, replaces] = onRecipient.mock.calls[1] ?? [];
    // The page learns which public key the new one replaces.
    expect(replaces).toBe(firstPublic);
    expect(secondPublic).not.toBe(firstPublic);

    const box = screen.getByLabelText(/^Private key for age1/) as HTMLTextAreaElement;
    expect(box.value).not.toBe(first);
    expect(identityToRecipient(box.value)).toBe(secondPublic);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(onSavedChange).toHaveBeenLastCalledWith(false);
  });

  it("explains the command-line way when the browser has no X25519", async () => {
    vi.spyOn(globalThis.crypto.subtle, "generateKey").mockRejectedValue(
      new DOMException("Unrecognized name.", "NotSupportedError"),
    );
    const { onRecipient, onSavedChange, user } = renderGenerator();
    await user.click(screen.getByRole("button", { name: "Generate a key pair" }));

    expect(await screen.findByText("A key cannot be made in this browser")).toBeTruthy();
    expect(screen.getByText(/needs a recent Chrome or Edge/)).toBeTruthy();
    expect(screen.getByText(/npx mongoshield keygen --output backup-key.txt/)).toBeTruthy();
    expect(onRecipient).not.toHaveBeenCalled();
    expect(onSavedChange).not.toHaveBeenCalled();
  });

  it("asks for HTTPS when the page has no Web Crypto at all", async () => {
    // Browsers leave out crypto.subtle on plain http:// pages (other than localhost).
    vi.stubGlobal("crypto", {});
    const { onRecipient, user } = renderGenerator();
    await user.click(screen.getByRole("button", { name: "Generate a key pair" }));

    expect(await screen.findByText(/Open the console over HTTPS/)).toBeTruthy();
    expect(onRecipient).not.toHaveBeenCalled();
  });

  it("says something went wrong when the browser returns keys it should not", async () => {
    vi.spyOn(globalThis.crypto.subtle, "exportKey").mockResolvedValue(new ArrayBuffer(3));
    const { user } = renderGenerator();
    await user.click(screen.getByRole("button", { name: "Generate a key pair" }));
    expect(await screen.findByText("Something went wrong while making the key.")).toBeTruthy();
  });
});
