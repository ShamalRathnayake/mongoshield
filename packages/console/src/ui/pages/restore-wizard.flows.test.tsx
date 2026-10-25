/**
 * More restore wizard tests: rename rule parsing, conflict detection, the tab hints,
 * the form's own validation (marking and opening the step with the problem), request
 * errors at each step, going back, the passphrase field for encrypted backups, restoring
 * selected documents (and refusing a plan that ignored the selection), and the load
 * error. Locking, invalidation and focus have their own file
 * (restore-wizard.steps.test.tsx).
 */

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ageKeyFileText, generateAgeKeyPair } from "../age-keys.ts";
import { type FailureRule, renderFailingApp } from "../failing-backend.testkit.tsx";
import { DEFAULT_RESTORE_AS, NEW_DATABASE, parseRenameRules } from "../restore-rename.ts";
import { renderApp, requestsTo } from "../testing.tsx";
import {
  currentStep,
  isLocked,
  newestBackupId,
  openStep,
  reviewPlan,
  stepTab,
} from "./restore-wizard.testkit.tsx";
import { describeRestoreAs, isConflict, keysHint, planHint, whereHint } from "./restore-wizard.tsx";

async function openWizard(
  signedInAs: string,
  options: {
    query?: string;
    failures?: FailureRule[];
    prepare?: Parameters<typeof renderApp>[0];
  } = {},
) {
  const hash = `#/backups/st-s3/${newestBackupId()}/restore${options.query ?? ""}`;
  const rendered =
    options.failures === undefined
      ? renderApp({ signedInAs, hash, ...options.prepare })
      : renderFailingApp({ signedInAs, hash, failures: options.failures, ...options.prepare });
  await screen.findByRole("heading", { name: "Restore" });
  return rendered;
}

describe("parseRenameRules", () => {
  it("reads from=to lines", () => {
    expect(parseRenameRules("shop.*=shop_restored.*\n\nanalytics.x = a2.x")).toEqual({
      "shop.*": "shop_restored.*",
      "analytics.x": "a2.x",
    });
  });

  it("explains lines without = and invalid patterns", () => {
    expect(parseRenameRules("shop.*")).toBe('"shop.*" is not from=to, e.g. shop.*=shop_restored.*');
    expect(parseRenameRules("=x.y")).toMatch(/is not from=to/);
    expect(parseRenameRules("shop=other.x")).toMatch(/^"shop=other.x": /);
  });
});

describe("isConflict", () => {
  it("flags blocking actions and existing data", () => {
    expect(isConflict({ from: "a.b", to: "a.b", documents: 1, action: "fail" })).toBe(true);
    expect(
      isConflict({ from: "a.b", to: "a.b", documents: 1, action: "drop", existingDocuments: 3 }),
    ).toBe(true);
    expect(isConflict({ from: "a.b", to: "a.b", documents: 1, action: "create" })).toBe(false);
  });
});

describe("tab hints", () => {
  it("say the Restore as choice, the target and the keys in a few words", () => {
    const settings = DEFAULT_RESTORE_AS;
    expect(describeRestoreAs(settings)).toBe("original names");
    expect(describeRestoreAs({ ...settings, kind: "copy" })).toBe("copy (_restored)");
    expect(describeRestoreAs({ ...settings, kind: "copy", suffix: " " })).toBe("copy (no suffix)");
    expect(describeRestoreAs({ ...settings, kind: "database" })).toBe("into another database");
    expect(describeRestoreAs({ ...settings, kind: "database", database: "archive" })).toBe(
      "into archive",
    );
    expect(
      describeRestoreAs({
        ...settings,
        kind: "database",
        database: NEW_DATABASE,
        newDatabase: "shop_new",
      }),
    ).toBe("into shop_new");
    expect(describeRestoreAs({ ...settings, kind: "custom" })).toBe("custom rules");
    expect(whereHint({ name: "Staging" }, { ...settings, kind: "copy" })).toBe(
      "Staging · copy (_restored)",
    );
    expect(whereHint(undefined, settings)).toBe("Choose a target");
    expect(keysHint(false, "", 0)).toBe("Not needed");
    expect(keysHint(true, "", 0)).toBe("Optional");
    expect(keysHint(true, "secret", 0)).toBe("Passphrase entered");
    expect(keysHint(true, "", 2)).toBe("2 private keys");
    expect(
      planHint({
        entries: [
          { from: "a.b", to: "a.b", documents: 1_200_000, action: "create" },
          { from: "a.c", to: "a.c", documents: 4_000, action: "create" },
          { from: "a.d", to: "a.d", documents: 0, action: "create" },
        ],
      }),
    ).toBe("Plan: 3 namespaces, 1.2M documents");
  });

  it("follow the choices in the wizard", async () => {
    const { user } = await openWizard("maya");
    expect(stepTab("What").textContent).toContain("6 collections");
    expect(stepTab("Where").textContent).toContain("Staging · original names");
    // The fixture backup is encrypted: keys are optional.
    expect(stepTab("Keys").textContent).toContain("Optional");
    await user.click(screen.getByRole("checkbox", { name: "shop.users" }));
    expect(stepTab("What").textContent).toContain("5 collections");
    await openStep(user, "Where");
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    expect(stepTab("Where").textContent).toContain("Staging · copy (_restored)");
    await openStep(user, "Keys");
    await user.type(screen.getByLabelText("Passphrase (optional)"), "x");
    expect(stepTab("Keys").textContent).toContain("Passphrase entered");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(stepTab("Review").textContent).toMatch(/Plan: 5 namespaces, [\d.]+[KM]? documents/);
  });
});

describe("restore wizard", () => {
  it("requires a namespace and valid rename rules before planning", async () => {
    const { user, backend } = await openWizard("maya");
    await user.click(screen.getByRole("button", { name: "Select none" }));
    // Nothing is said before the user tries to move on; the later steps are closed.
    expect(screen.queryByText("Choose at least one namespace.")).toBeNull();
    expect(isLocked("Where")).toBe(true);
    expect(stepTab("Where").getAttribute("title")).toBe("Complete “What” first");
    await openStep(user, "Where");
    expect(currentStep()).toBe("What");
    expect(screen.getByText("Choose at least one namespace.")).toBeTruthy();
    expect(stepTab("What").textContent).toContain("(needs attention)");
    // No field to focus for the list: its panel, which holds the message.
    expect(document.activeElement?.getAttribute("role")).toBe("tabpanel");
    expect(
      document.activeElement?.contains(screen.getByText("Choose at least one namespace.")),
    ).toBe(true);
    // The errors follow what is fixed from then on.
    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.queryByText("Choose at least one namespace.")).toBeNull();
    expect(stepTab("What").textContent).not.toContain("(needs attention)");

    // Rules that do not parse hold the flow on Where, focus on them.
    await openStep(user, "Where");
    expect(stepTab("What").textContent).toContain("(done)");
    await user.click(screen.getByRole("radio", { name: /Custom rules/ }));
    await user.type(screen.getByLabelText("Rename rules"), "nonsense");
    await user.click(screen.getByRole("button", { name: /Next: Keys/ }));
    expect(currentStep()).toBe("Where");
    expect(screen.getByText(/is not from=to/)).toBeTruthy();
    expect(stepTab("Where").textContent).toContain("(needs attention)");
    expect(document.activeElement).toBe(screen.getByLabelText("Rename rules"));
    // So do rules the library would refuse, and no rules at all.
    await user.clear(screen.getByLabelText("Rename rules"));
    await user.type(screen.getByLabelText("Rename rules"), "shop.*=archive.users");
    expect(screen.getByText(/a whole-database rule needs a whole-database target/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Rename rules"));
    expect(screen.getByText(/Type at least one from=to rule/)).toBeTruthy();
    expect(requestsTo(backend, "POST", "/api/restore/plan")).toHaveLength(0);
  });

  it("restores only the chosen namespaces, with the passphrase, and can go back", async () => {
    const { user, backend } = await openWizard("maya");
    await user.click(screen.getByRole("checkbox", { name: "shop.users" }));
    await user.type(screen.getByLabelText("Passphrase (optional)"), "open sesame please");
    await user.selectOptions(
      screen.getByLabelText("If a target collection already has data"),
      "upsert",
    );
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({ passphrase: "open sesame please", mode: "upsert" });
    expect(plan?.body).toHaveProperty("include", [
      "shop.orders",
      "shop.products",
      "shop.carts",
      "analytics.daily_rollups",
      "analytics.funnel_view",
    ]);

    // Back returns to Keys; the plan is still current, so Next goes to it again.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(currentStep()).toBe("Keys");
    expect(screen.getByRole("button", { name: /Next: Review/ })).toBeTruthy();
  });

  it("sends typed age private keys with the plan and refuses anything else", async () => {
    const { user, backend } = await openWizard("maya");
    await openStep(user, "Keys");
    const keyField = screen.getByLabelText("Private key (optional)");
    await user.type(keyField, "not-a-key");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    expect(screen.getByText(/not an age private key/)).toBeTruthy();
    expect(stepTab("Keys").textContent).toContain("(needs attention)");
    expect(requestsTo(backend, "POST", "/api/restore/plan")).toHaveLength(0);

    await user.clear(keyField);
    await user.type(keyField, "AGE-SECRET-KEY-1ABC AGE-SECRET-KEY-1DEF");
    expect(stepTab("Keys").textContent).toContain("2 private keys");
    // Enter in the key field asks for the plan, like the button.
    await user.type(keyField, "{Enter}");
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({
      identities: ["AGE-SECRET-KEY-1ABC", "AGE-SECRET-KEY-1DEF"],
    });
  });

  it("adds the private keys of a key file to the typed ones, each once", async () => {
    const { user, backend } = await openWizard("maya");
    await openStep(user, "Keys");
    const keyField = screen.getByLabelText("Private key (optional)") as HTMLInputElement;
    const one = await generateAgeKeyPair();
    const two = await generateAgeKeyPair();
    await user.type(keyField, one.privateKey);
    // A file holding the typed key again and another one.
    const file = `${ageKeyFileText(one)}\n${ageKeyFileText(two)}`;
    await user.upload(
      screen.getByLabelText("Key file"),
      new File([file], "backup-key.txt", { type: "text/plain" }),
    );
    expect(await screen.findByText("Loaded 2 private keys from backup-key.txt.")).toBeTruthy();
    expect(keyField.value).toBe(`${one.privateKey} ${two.privateKey}`);
    expect(stepTab("Keys").textContent).toContain("2 private keys");
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await screen.findByRole("table", { name: "Dry-run plan" });
    expect(requestsTo(backend, "POST", "/api/restore/plan")[0]?.body).toMatchObject({
      identities: [one.privateKey, two.privateKey],
    });
  });

  it("shows a planning error on the Review step, and plans again", async () => {
    const { user } = await openWizard("maya", {
      failures: [
        { method: "POST", path: "/api/restore/plan", status: 422, message: "Bad key.", times: 1 },
      ],
    });
    await reviewPlan(user);
    expect(await screen.findByText("Could not plan the restore")).toBeTruthy();
    expect(screen.getByText("Bad key.")).toBeTruthy();
    // Review opens to show it, marked, with its heading focused.
    expect(currentStep()).toBe("Review");
    expect(stepTab("Review").textContent).toContain("Could not plan");
    expect(stepTab("Review").textContent).toContain("(needs attention)");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "No plan yet" }));
    // Trying again from there (the failure was once only) shows the plan.
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    const planHeading = await screen.findByRole("heading", { name: /^Plan: / });
    expect(document.activeElement).toBe(planHeading);
    expect(stepTab("Review").textContent).toContain("Plan: 6 namespaces");
  });

  it("shows an error when the restore cannot start", async () => {
    const { user } = await openWizard("maya", {
      failures: [{ method: "POST", path: /\/api\/restore$/, status: 409, message: "Target busy." }],
    });
    await openStep(user, "Where");
    await user.click(screen.getByRole("radio", { name: /A copy next to the original/ }));
    await user.clear(screen.getByLabelText("Suffix"));
    await user.type(screen.getByLabelText("Suffix"), "_copy");
    await reviewPlan(user);
    await user.click(await screen.findByRole("button", { name: "Skip preview" }));
    await user.click(screen.getByRole("button", { name: "Start restore" }));
    expect(await screen.findByText("Could not start the restore")).toBeTruthy();
    expect(screen.getByText("Target busy.")).toBeTruthy();
    expect(stepTab("Confirm").textContent).toContain("(needs attention)");
  });

  it("asks for a target when there are no connections", async () => {
    const { user } = await openWizard("admin", {
      prepare: {
        prepare: (mock) => {
          mock.data.connections = [];
        },
      },
    });
    // Keys stays closed until there is a target; trying to open it says so.
    await openStep(user, "Keys");
    expect(screen.getByText("Choose a target connection.")).toBeTruthy();
    expect(stepTab("Where").textContent).toContain("Choose a target");
    expect(currentStep()).toBe("Where");
  });

  it("restores selected documents with an $in filter", async () => {
    const { user, backend } = await openWizard("maya", { query: "?ns=shop.users&ids=[1,2]" });
    expect(screen.getByText("Restoring 2 selected documents")).toBeTruthy();
    expect(stepTab("What").textContent).toContain("2 selected documents");
    expect(
      (screen.getByLabelText("If a target collection already has data") as HTMLSelectElement).value,
    ).toBe("upsert");
    await reviewPlan(user);
    await screen.findByRole("table", { name: "Dry-run plan" });
    const [plan] = requestsTo(backend, "POST", "/api/restore/plan");
    expect(plan?.body).toMatchObject({ filter: '{"_id":{"$in":[1,2]}}', include: ["shop.users"] });
  });

  it("refuses to start when the server ignored the selection", async () => {
    const { user } = await openWizard("maya", {
      query: "?ns=shop.users&ids=[1]",
      failures: [
        {
          method: "POST",
          path: "/api/restore/plan",
          status: 200,
          body: {
            backupId: newestBackupId(),
            mode: "upsert",
            entries: [{ from: "shop.users", to: "shop.users", documents: 500, action: "upsert" }],
          },
        },
      ],
    });
    await reviewPlan(user);
    expect(
      await screen.findByText("The server did not limit the restore to the selected documents"),
    ).toBeTruthy();
    // Selected documents have no preview step; the review refuses to go on.
    expect(screen.getByRole("button", { name: /Next: Confirm/ })).toHaveProperty("disabled", true);
    expect(stepTab("Review").textContent).toContain("(needs attention)");
  });

  it("ignores a selection that is not a JSON array", async () => {
    await openWizard("maya", { query: "?ns=shop.users&ids=nope" });
    expect(screen.queryByText(/selected document/)).toBeNull();
  });

  it("shows a load error and retries", async () => {
    const { user } = renderFailingApp({
      signedInAs: "maya",
      hash: `#/backups/st-s3/${newestBackupId()}/restore`,
      failures: [
        { method: "GET", path: "/api/connections", status: 500, message: "Down.", times: 1 },
      ],
    });
    expect(await screen.findByText("Down.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Restore" })).toBeTruthy();
  });
});
