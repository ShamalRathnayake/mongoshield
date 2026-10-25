/**
 * Plan editor tests for the checks that used to slip through, and for "Generate a key
 * pair" on the Security step:
 * - values the server would refuse are caught next to their field: retention counts
 *   like 0, "1e2" or 1001, a passphrase of spaces, a missing time zone, KMS keys, too
 *   many public keys, a name another plan has, more than ten notifications;
 * - pasted URLs are trimmed;
 * - the generator fills the Recipients field (and replaces its own earlier key), and
 *   the plan is held on Security until "I saved the private key somewhere safe" is ticked.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, requestsTo } from "../testing.tsx";
import { isClosed, isOpen, openNewPlanStep, openStep, RECIPIENT } from "./plan-editor.testkit.tsx";
import {
  emptyPlanForm,
  MAX_NOTIFY,
  notifyUrlProblem,
  passphraseProblem,
  recipientsProblem,
  UNSAVED_PRIVATE_KEY,
  validatePlanForm,
  withGeneratedRecipient,
} from "./plan-editor.tsx";

/** A form that passes validation, to vary one field at a time. */
const validForm = () => ({
  ...emptyPlanForm(),
  name: "Plan",
  connectionId: "c",
  storageId: "s",
  encryptionKind: "none" as const,
});

/** Custom retention with one bucket set to `text`. */
const withLast = (text: string) => ({
  ...validForm(),
  retentionPreset: "custom" as const,
  retention: { last: text, daily: "", weekly: "", monthly: "", yearly: "" },
});

describe("plan form checks", () => {
  it.each(["0", "-1", "1e2", "0x10", "1.5", "abc", "1001"])(
    "refuses a retention count of %j",
    (text) => {
      expect(validatePlanForm(withLast(text)).errors?.["retention.last"]).toBe(
        "Use a whole number from 1 to 1000, or leave empty.",
      );
    },
  );

  it("takes retention counts from 1 to 1000, with spaces around them", () => {
    expect(validatePlanForm(withLast(" 1000 ")).input?.retention).toEqual({ last: 1000 });
  });

  it("refuses passphrases of spaces, short ones and huge ones", () => {
    expect(passphraseProblem("", false)).toBe("Enter a passphrase.");
    expect(passphraseProblem("", true)).toBeUndefined();
    expect(passphraseProblem(" ".repeat(14), false)).toBe("A passphrase cannot be only spaces.");
    expect(passphraseProblem("x".repeat(1025), false)).toBe("Use at most 1024 characters.");
    expect(passphraseProblem("correct horse battery", false)).toBeUndefined();
  });

  it("asks for at least one and at most 20 age public keys", () => {
    expect(recipientsProblem([])).toBe("Add at least one age recipient (age1…).");
    expect(recipientsProblem(Array.from({ length: 21 }, () => RECIPIENT))).toBe(
      "Use at most 20 public keys.",
    );
    expect(recipientsProblem([RECIPIENT])).toBeUndefined();
  });

  it("needs a URL for new notifications, trims pasted ones and keeps stored ones", () => {
    expect(notifyUrlProblem({ type: "slack", url: "   " })).toBe("Enter the webhook URL.");
    expect(notifyUrlProblem({ type: "slack", url: "", storedPreview: "configured" })).toBe(
      undefined,
    );
    expect(notifyUrlProblem({ type: "slack", url: `https://x/${"a".repeat(2048)}` })).toBe(
      "Use at most 2048 characters.",
    );
    const result = validatePlanForm({
      ...validForm(),
      notify: [{ type: "slack", url: " https://hooks.slack.com/x \n" }],
    });
    expect(result.input?.notify).toEqual([{ type: "slack", url: "https://hooks.slack.com/x" }]);
  });

  it("refuses an empty time zone, a long name and a name another plan has", () => {
    expect(validatePlanForm({ ...validForm(), timezone: " " }).errors?.timezone).toBe(
      "Choose a time zone, e.g. UTC or Europe/Berlin.",
    );
    expect(validatePlanForm({ ...validForm(), name: "x".repeat(101) }).errors?.name).toBe(
      "Use at most 100 characters.",
    );
    expect(
      validatePlanForm({ ...validForm(), name: " Plan " }, { takenNames: ["Plan"] }).errors?.name,
    ).toBe('Another plan is already called "Plan". Choose another name.');
  });

  it("holds back a plan whose generated private key was not marked as saved", () => {
    const recipients = {
      ...validForm(),
      encryptionKind: "recipients" as const,
      recipients: RECIPIENT,
    };
    expect(validatePlanForm(recipients, { unsavedPrivateKey: true }).errors?.generatedKey).toBe(
      UNSAVED_PRIVATE_KEY,
    );
    // Only for public-key encryption: another choice does not use the key at all.
    expect(validatePlanForm(validForm(), { unsavedPrivateKey: true }).input).toBeDefined();
  });

  it("puts a generated key in place of the one generated before it, or adds it", () => {
    expect(withGeneratedRecipient("", "age1new", undefined)).toBe("age1new");
    expect(withGeneratedRecipient("age1mine\n", "age1new", undefined)).toBe("age1mine\nage1new");
    expect(withGeneratedRecipient("age1mine\n age1old \nage1other", "age1new", "age1old")).toBe(
      "age1mine\nage1new\nage1other",
    );
    // The earlier key was removed by hand: the new one is added.
    expect(withGeneratedRecipient("age1mine", "age1new", "age1old")).toBe("age1mine\nage1new");
  });
});

describe("the notifications limit", () => {
  it(`stops "Add notification" at ${MAX_NOTIFY}`, async () => {
    const { user } = renderApp({ signedInAs: "admin", hash: "#/plans/plan-local?step=retention" });
    await screen.findByRole("heading", { name: "Local dev snapshot" });
    const add = screen.getByRole("button", { name: "Add notification" }) as HTMLButtonElement;
    while (!add.disabled) await user.click(add);
    expect(document.querySelectorAll(".notify-row")).toHaveLength(MAX_NOTIFY);
    expect(add.title).toBe(`A plan can report to at most ${MAX_NOTIFY} places.`);
  });
});

describe("generating a key pair on the Security step", () => {
  /** The Recipients field's text. */
  const recipients = () => (screen.getByLabelText("Recipients") as HTMLTextAreaElement).value;

  /** Clicks "Generate a (new) key pair" and waits for the private key box. */
  async function generate(user: ReturnType<typeof renderApp>["user"]) {
    // The key box of an earlier generation is still on screen while the new key is
    // being made (WebCrypto is asynchronous): wait for a different key, not just a box.
    const before = screen.queryByLabelText(/^Private key for age1/) as HTMLTextAreaElement | null;
    const previous = before?.value;
    await user.click(screen.getByRole("button", { name: /Generate a (new )?key pair/ }));
    let box: HTMLTextAreaElement | undefined;
    await waitFor(() => {
      box = screen.getByLabelText(/^Private key for age1/) as HTMLTextAreaElement;
      expect(box.value).not.toBe(previous);
    });
    return box as HTMLTextAreaElement;
  }

  it("fills Recipients, replaces its own key, and holds the plan until the key is saved", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Security", "Generated");
    expect(screen.getByText("One per line.")).toBeTruthy();

    // A key typed by hand stays; the generated one goes on its own line.
    await user.type(screen.getByLabelText("Recipients"), RECIPIENT);
    await generate(user);
    const [mine, first] = recipients().split("\n");
    expect(mine).toBe(RECIPIENT);
    expect(first).toMatch(/^age1[0-9a-z]{58}$/);

    // Generating again replaces the first generated key, whose private key is gone.
    await generate(user);
    const lines = recipients().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(RECIPIENT);
    expect(lines[1]).not.toBe(first);

    // Not ticked yet: Next stays on Security, says why and moves focus to the reason.
    expect(isClosed("Review")).toBe(true);
    await user.click(screen.getByRole("button", { name: /Next: Schedule/ }));
    expect(isOpen("Security")).toBe(true);
    const reason = screen.getByText(UNSAVED_PRIVATE_KEY);
    expect(document.activeElement).toBe(reason.closest("p"));
    expect(screen.getByRole("tab", { name: /^Security/ }).getAttribute("data-state")).toBe("error");

    // Ticked: the steps open and the plan can be created with both keys.
    const saved = screen.getByRole("checkbox", { name: "I saved the private key somewhere safe" });
    await user.click(saved);
    expect(screen.queryByText(UNSAVED_PRIVATE_KEY)).toBeNull();
    await openStep(user, "Review");
    await user.click(screen.getByRole("button", { name: "Create plan" }));
    expect(await screen.findByRole("heading", { name: "Backup plans" })).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")[0]?.body).toMatchObject({
      encryption: { kind: "recipients", recipients: lines },
    });
  });

  it("keeps the generated key while another encryption is looked at, and asks again when unticked", async () => {
    const { user, backend } = renderApp({ signedInAs: "admin", hash: "#/plans/new" });
    await screen.findByRole("heading", { name: "New backup plan" });
    await openNewPlanStep(user, "Security");
    const box = await generate(user);
    const privateKey = box.value;
    const saved = screen.getByRole("checkbox", { name: "I saved the private key somewhere safe" });
    await user.click(saved);

    // Another choice hides the panel (and needs no key); coming back shows the same key.
    await user.selectOptions(screen.getByLabelText("Encryption"), "managed");
    expect(screen.getByLabelText(/^Private key for age1/).closest("[hidden]")).not.toBeNull();
    await user.selectOptions(screen.getByLabelText("Encryption"), "recipients");
    expect((screen.getByLabelText(/^Private key for age1/) as HTMLTextAreaElement).value).toBe(
      privateKey,
    );

    // Unticked again: the plan cannot be created, and saving would open Security.
    await user.click(saved);
    expect(isClosed("Review")).toBe(true);
    await openStep(user, "Review");
    expect(isOpen("Security")).toBe(true);
    expect(within(screen.getByRole("tabpanel")).getByText(UNSAVED_PRIVATE_KEY)).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/plans")).toHaveLength(0);
  });

  it("holds an existing plan's Save on Security until the new key is saved", async () => {
    const { user, backend } = renderApp({
      signedInAs: "admin",
      hash: "#/plans/plan-nightly?step=retention",
    });
    await screen.findByRole("heading", { name: "Nightly production" });
    await openStep(user, "Security");
    await generate(user);
    // The later steps wait for the key; an earlier one still opens.
    expect(isClosed("Retention & alerts")).toBe(true);
    await openStep(user, "Basics");
    // Save from another step goes back to Security.
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(isOpen("Security")).toBe(true);
    expect(screen.getByText(UNSAVED_PRIVATE_KEY)).toBeTruthy();
    expect(requestsTo(backend, "PUT", "/api/plans/plan-nightly")).toHaveLength(0);
  });
});
